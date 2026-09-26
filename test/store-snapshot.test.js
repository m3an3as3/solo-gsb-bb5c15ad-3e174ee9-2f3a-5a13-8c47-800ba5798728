'use strict';

/* 存储快照提交单元测试：node test/store-snapshot.test.js
 * 覆盖：成功提交单次落盘 / rev 只增一次；多部分变更同一快照；
 * 临时文件写入失败（fsync）、重命名失败、mutator 抛错三种情况下
 * 缓存 / 正式数据文件 / rev 全部保持请求前状态、临时文件被清理；
 * 恢复写入后可再次提交；重新加载模块（模拟重启）读到同一完整快照。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-snapshot-store.json');
const TMP_FILE = `${DATA_FILE}.tmp`;
process.env.DATA_FILE = DATA_FILE;

for (const f of fs.readdirSync(__dirname).filter((n) => n.startsWith('tmp-snapshot-store'))) {
  fs.unlinkSync(path.join(__dirname, f));
}

const store = require('../src/store');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function snapshotOnDisk() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

/** 临时把 fs 的某方法替换为故障实现，返回还原函数 */
function patchFs(method, impl) {
  const orig = fs[method];
  fs[method] = impl;
  return () => { fs[method] = orig; };
}

function main() {
  // 首次加载：自动初始化演示数据，落盘为完整快照
  const initial = store.getData();
  assert.ok(Array.isArray(initial.props) && initial.props.length === 4);
  assert.strictEqual(initial.rev, 1); // 初始化落盘计一次版本
  assert.ok(fs.existsSync(DATA_FILE));
  assert.ok(!fs.existsSync(TMP_FILE));

  // 1. 成功提交：rev 只增加一次，缓存与磁盘均为新快照
  test('成功提交：单次落盘、rev 只增加一次', () => {
    const before = store.getData();
    const beforeRef = before;
    const beforeBytes = fs.readFileSync(DATA_FILE, 'utf8');
    const { data, result } = store.commit((draft) => {
      draft.props.push({ id: 'p_x', name: '快照道具', note: '', createdAt: 1 });
      return 'ok';
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(data.rev, before.rev + 1);
    assert.strictEqual(store.getData(), data); // 发布后缓存即新快照
    assert.strictEqual(store.getData().props.length, before.props.length + 1);
    assert.strictEqual(snapshotOnDisk().rev, before.rev + 1);
    assert.ok(beforeRef !== store.getData()); // 旧快照未被原地改动
    assert.ok(!fs.existsSync(TMP_FILE));
    assert.notStrictEqual(fs.readFileSync(DATA_FILE, 'utf8'), beforeBytes);
  });

  // 2. 道具 / 记录 / 签收多部分变更在同一快照内：只增一次 rev
  test('多部分整体提交：props + records + signoffs 一次落盘，rev 只增一次', () => {
    const before = store.getData();
    store.commit((draft) => {
      draft.props.push({ id: 'p_y', name: '整体道具', note: '', createdAt: 2 });
      draft.records.push({ id: 'r_y', propId: 'p_y', minute: 1, from: store.WAREHOUSE, to: '甲', note: '', createdAt: 2 });
      draft.signoffs.push({ recordId: 'r_y', side: 'from', name: store.WAREHOUSE, recordHash: 'h', signedAt: 2 });
    });
    const after = store.getData();
    assert.strictEqual(after.rev, before.rev + 1);
    assert.strictEqual(after.props.length, before.props.length + 1);
    assert.strictEqual(after.records.length, before.records.length + 1);
    assert.strictEqual(after.signoffs.length, before.signoffs.length + 1);
    const disk = snapshotOnDisk();
    assert.strictEqual(disk.props.length, after.props.length);
    assert.strictEqual(disk.records.length, after.records.length);
    assert.strictEqual(disk.signoffs.length, after.signoffs.length);
  });

  // 3. 临时文件写入失败（fsync 抛错）：缓存 / 正式文件 / rev 不变，临时文件清理，可重试
  test('临时文件写入失败：缓存 / 正式数据文件 / rev 保持请求前状态，清理临时文件', () => {
    const before = store.getData();
    const beforeRef = before;
    const beforeBytes = fs.readFileSync(DATA_FILE, 'utf8');
    const restore = patchFs('fsyncSync', () => { throw new Error('EIO: 模拟落盘失败'); });
    try {
      assert.throws(() => store.commit((draft) => {
        draft.props.push({ id: 'p_fail', name: '不该存在', note: '', createdAt: 3 });
      }), /EIO/);
    } finally {
      restore();
    }
    // 缓存仍是请求前的同一对象，rev 未变
    assert.strictEqual(store.getData(), beforeRef);
    assert.strictEqual(store.getData().rev, before.rev);
    assert.ok(!store.getData().props.some((p) => p.id === 'p_fail'));
    // 正式数据文件字节级不变，临时文件已清理
    assert.strictEqual(fs.readFileSync(DATA_FILE, 'utf8'), beforeBytes);
    assert.ok(!fs.existsSync(TMP_FILE));
  });

  // 4. 重命名失败：同样整体保持请求前状态；恢复后同内容可再次提交成功
  test('原子重命名失败：状态不变且临时文件清理；恢复写入后可再次提交', () => {
    const before = store.getData();
    const beforeBytes = fs.readFileSync(DATA_FILE, 'utf8');
    const realRename = fs.renameSync;
    const restore = patchFs('renameSync', (from, to) => {
      if (from === TMP_FILE && to === DATA_FILE) throw new Error('EIO: 模拟重命名失败');
      return realRename.call(fs, from, to);
    });
    try {
      assert.throws(() => store.commit((draft) => {
        draft.props.push({ id: 'p_retry', name: '重试道具', note: '', createdAt: 4 });
      }), /重命名失败/);
    } finally {
      restore();
    }
    assert.strictEqual(store.getData().rev, before.rev);
    assert.ok(!store.getData().props.some((p) => p.id === 'p_retry'));
    assert.strictEqual(fs.readFileSync(DATA_FILE, 'utf8'), beforeBytes);
    assert.ok(!fs.existsSync(TMP_FILE));

    // 恢复写入后用相同内容再次提交：成功，rev 恰好增加一次
    store.commit((draft) => {
      draft.props.push({ id: 'p_retry', name: '重试道具', note: '', createdAt: 4 });
    });
    const after = store.getData();
    assert.strictEqual(after.rev, before.rev + 1);
    assert.ok(after.props.some((p) => p.id === 'p_retry'));
    assert.strictEqual(snapshotOnDisk().rev, before.rev + 1);
  });

  // 5. mutator 自身抛错：完全不触碰磁盘，状态不变
  test('变更逻辑抛错：不发起任何落盘，缓存 / rev 不变', () => {
    const before = store.getData();
    const origOpen = fs.openSync;
    let opened = false;
    fs.openSync = function (...args) {
      opened = true;
      return origOpen.apply(fs, args);
    };
    try {
      assert.throws(() => store.commit(() => {
        throw new Error('业务变更炸了');
      }), /业务变更炸了/);
    } finally {
      fs.openSync = origOpen;
    }
    assert.strictEqual(opened, false); // mutator 失败后没有进入临时文件写入阶段
    assert.strictEqual(store.getData().rev, before.rev);
    assert.strictEqual(store.getData(), before);
  });

  // 6. 重启读取同一完整状态（清模块缓存后重新加载，模拟进程重启）
  test('重新加载（模拟重启）：读到提交后的同一完整快照与 rev', () => {
    const before = store.getData();
    delete require.cache[require.resolve('../src/store')];
    const reloaded = require('../src/store');
    const after = reloaded.getData();
    assert.strictEqual(after.rev, before.rev);
    assert.deepStrictEqual(after.props, before.props);
    assert.deepStrictEqual(after.records, before.records);
    assert.deepStrictEqual(after.signoffs, before.signoffs);
    assert.ok(!fs.existsSync(TMP_FILE));
  });

  for (const f of fs.readdirSync(__dirname).filter((n) => n.startsWith('tmp-snapshot-store'))) {
    fs.unlinkSync(path.join(__dirname, f));
  }
  console.log(`\n全部 ${passed} 个存储快照提交测试通过 ✔`);
}

main();
