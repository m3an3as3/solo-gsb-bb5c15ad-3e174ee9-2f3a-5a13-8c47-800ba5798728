'use strict';

/* 写入失败一致性接口集成测试：node test/write-failure-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP；通过故障注入让
 * 临时文件写入（openSync / fsyncSync）或原子重命名（renameSync）失败，
 * 验证每个写接口在任一步落盘失败时：
 * - 返回 JSON 500；
 * - 缓存 / 正式数据文件 / rev 均保持请求前状态；
 * - 临时文件被清理；
 * - 恢复写入后同一请求可再次提交成功，且成功提交只落盘一次（rev 恰好 +1）。
 * 重点覆盖：删除道具的「道具 + 级联记录 + 签收清理」整体提交、
 * 编辑/删除记录的「记录变更 + 签收清理」整体提交、签收、批量提交。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-write-fail-api-store.json');
const TMP_FILE = `${DATA_FILE}.tmp`;
process.env.DATA_FILE = DATA_FILE;

for (const f of fs.readdirSync(__dirname).filter((n) => n.startsWith('tmp-write-fail-api-store'))) {
  fs.unlinkSync(path.join(__dirname, f));
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function diskSnapshot() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

/** 注入故障：仅对快照临时文件写入路径（或其 rename）生效，不影响其他 fs 调用 */
function failNextWrite(mode) {
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;

  if (mode === 'open') {
    fs.openSync = function (p, ...rest) {
      if (p === TMP_FILE) throw new Error('EIO: 模拟临时文件打开失败');
      return realOpen.call(fs, p, ...rest);
    };
  } else if (mode === 'fsync') {
    fs.fsyncSync = function () { throw new Error('EIO: 模拟临时文件 fsync 失败'); };
  } else if (mode === 'rename') {
    fs.renameSync = function (from, to) {
      if (from === TMP_FILE && to === DATA_FILE) throw new Error('EIO: 模拟原子重命名失败');
      return realRename.call(fs, from, to);
    };
  }

  return function restore() {
    fs.openSync = realOpen;
    fs.fsyncSync = realFsync;
    fs.renameSync = realRename;
  };
}

async function addPropWithSignedRecord(name, minute) {
  const prop = (await api('/api/props', { method: 'POST', body: JSON.stringify({ name }) })).body;
  const rec = (await api('/api/records', {
    method: 'POST',
    body: JSON.stringify({ propId: prop.id, minute, from: '仓库', to: '甲' }),
  })).body;
  const cur = (await api(`/api/records/${rec.id}/signoff`)).body;
  for (const side of ['from', 'to']) {
    const r = await api(`/api/records/${rec.id}/signoff`, {
      method: 'POST',
      body: JSON.stringify({ side, name: side === 'from' ? '仓库' : '甲', recordHash: cur.recordHash }),
    });
    assert.strictEqual(r.status, 200);
  }
  return { prop, rec };
}

async function assertStateUnchanged(before, label) {
  const live = (await api('/api/state')).body;
  assert.strictEqual(live.rev, before.rev, `${label}: 缓存 rev 应不变`);
  assert.strictEqual(live.props.length, before.props.length, `${label}: 缓存 props 数应不变`);
  assert.strictEqual(live.records.length, before.records.length, `${label}: 缓存 records 数应不变`);
  assert.strictEqual(live.signoffs.length, before.signoffs.length, `${label}: 缓存 signoffs 数应不变`);
  const onDisk = diskSnapshot();
  assert.strictEqual(onDisk.rev, before.rev, `${label}: 磁盘 rev 应不变`);
  assert.strictEqual(onDisk.props.length, before.props.length, `${label}: 磁盘 props 数应不变`);
  assert.strictEqual(onDisk.records.length, before.records.length, `${label}: 磁盘 records 数应不变`);
  assert.strictEqual(onDisk.signoffs.length, before.signoffs.length, `${label}: 磁盘 signoffs 数应不变`);
  assert.ok(!fs.existsSync(TMP_FILE), `${label}: 临时文件应被清理`);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 1. 删除道具（道具 + 级联记录 + 签收）：临时文件写入失败 -> 500，整体不变；恢复后重试成功
  await test('删除道具落盘失败 -> JSON 500，缓存/磁盘/rev 不变、临时文件清理；重试整体提交成功', async () => {
    const { prop, rec } = await addPropWithSignedRecord('故障级联道具', 1);
    const before = (await api('/api/state')).body;
    assert.ok(before.signoffs.some((s) => s.recordId === rec.id));

    const restore = failNextWrite('open');
    let res;
    try {
      res = await api(`/api/props/${prop.id}`, { method: 'DELETE' });
    } finally {
      restore();
    }
    assert.strictEqual(res.status, 500);
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
    await assertStateUnchanged(before, '删除道具失败后');
    // 正式文件里仍能读到该道具 / 记录 / 签收
    const disk = diskSnapshot();
    assert.ok(disk.props.some((p) => p.id === prop.id));
    assert.ok(disk.records.some((r) => r.id === rec.id));
    assert.ok(disk.signoffs.some((s) => s.recordId === rec.id));

    // 恢复写入后同一请求重试：成功，三类变更随一次提交整体生效，rev 恰好 +1
    const retry = await api(`/api/props/${prop.id}`, { method: 'DELETE' });
    assert.strictEqual(retry.status, 204);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1); // 失败不计 rev，成功只增一次
    assert.ok(!after.props.some((p) => p.id === prop.id));
    assert.ok(!after.records.some((r) => r.id === rec.id));
    assert.ok(!after.signoffs.some((s) => s.recordId === rec.id));
    const diskAfter = diskSnapshot();
    assert.strictEqual(diskAfter.rev, before.rev + 1);
    assert.ok(!diskAfter.records.some((r) => r.id === rec.id));
    assert.ok(!diskAfter.signoffs.some((s) => s.recordId === rec.id));
  });

  // 2. 编辑记录（记录替换 + 旧签收清理）：重命名失败 -> 500，整体不变；恢复后重试成功
  await test('编辑记录落盘失败 -> JSON 500，记录与签收均不变；重试后记录变更与签收清理整体生效', async () => {
    const { rec } = await addPropWithSignedRecord('故障编辑道具', 2);
    const before = (await api('/api/state')).body;
    const editBody = JSON.stringify({ propId: rec.propId, minute: 2, from: '仓库', to: '甲', note: '改过的备注' });

    const restore = failNextWrite('rename');
    let res;
    try {
      res = await api(`/api/records/${rec.id}`, { method: 'PUT', body: editBody });
    } finally {
      restore();
    }
    assert.strictEqual(res.status, 500);
    await assertStateUnchanged(before, '编辑记录失败后');
    // 旧签收仍然有效（指纹仍对旧内容）
    const view = (await api(`/api/records/${rec.id}/signoff`)).body;
    assert.ok(view.from && view.to);
    assert.strictEqual(view.record.note, '');

    // 恢复后重试：备注已改、旧签收被清，rev 恰好 +1
    const retry = await api(`/api/records/${rec.id}`, { method: 'PUT', body: editBody });
    assert.strictEqual(retry.status, 200);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1);
    const edited = after.records.find((r) => r.id === rec.id);
    assert.strictEqual(edited.note, '改过的备注');
    assert.ok(!after.signoffs.some((s) => s.recordId === rec.id));
    assert.strictEqual(diskSnapshot().rev, before.rev + 1);
  });

  // 3. 删除记录（记录删除 + 旧签收清理）：fsync 失败 -> 500，整体不变；重试成功
  await test('删除记录落盘失败 -> JSON 500，记录与签收均不变；重试整体生效', async () => {
    const { rec } = await addPropWithSignedRecord('故障删记录道具', 3);
    const before = (await api('/api/state')).body;

    const restore = failNextWrite('fsync');
    let res;
    try {
      res = await api(`/api/records/${rec.id}`, { method: 'DELETE' });
    } finally {
      restore();
    }
    assert.strictEqual(res.status, 500);
    await assertStateUnchanged(before, '删除记录失败后');

    const retry = await api(`/api/records/${rec.id}`, { method: 'DELETE' });
    assert.strictEqual(retry.status, 204);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1);
    assert.ok(!after.records.some((r) => r.id === rec.id));
    assert.ok(!after.signoffs.some((s) => s.recordId === rec.id));
  });

  // 4. 签收确认：写入失败 -> 500，签收未落盘；持同一指纹重试成功
  await test('签收落盘失败 -> JSON 500，签收未写入；持原指纹重试成功（rev 只增一次）', async () => {
    const { rec } = await addPropWithSignedRecord('故障签收道具', 4);
    // 上面的辅助函数已双侧签收；新建一条未签收记录做签收故障
    const rec2 = (await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ propId: rec.propId, minute: 5, from: '甲', to: '仓库' }),
    })).body;
    const cur = (await api(`/api/records/${rec2.id}/signoff`)).body;
    const signBody = JSON.stringify({ side: 'from', name: '甲', recordHash: cur.recordHash });
    const before = (await api('/api/state')).body;

    const restore = failNextWrite('open');
    let res;
    try {
      res = await api(`/api/records/${rec2.id}/signoff`, { method: 'POST', body: signBody });
    } finally {
      restore();
    }
    assert.strictEqual(res.status, 500);
    await assertStateUnchanged(before, '签收失败后');

    const retry = await api(`/api/records/${rec2.id}/signoff`, { method: 'POST', body: signBody });
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.body.from.name, '甲');
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1);
    assert.ok(after.signoffs.some((s) => s.recordId === rec2.id && s.side === 'from'));
  });

  // 5. 批量提交：落盘失败 -> 500，整批不入盘且预演票据保留；恢复后重试整批一次写入（rev 只 +1）
  await test('批量提交落盘失败 -> JSON 500，整批不写入、票据保留；重试整批一次落盘', async () => {
    const rows = [
      { propId: 'p_sword', minute: 30, from: '仓库', to: '赵六' },
      { propId: 'p_sword', minute: 31, from: '赵六', to: '仓库' },
    ];
    const preview = (await api('/api/records/batch/preview', {
      method: 'POST', body: JSON.stringify({ rows }),
    })).body;
    assert.strictEqual(preview.canCommit, true);
    const before = (await api('/api/state')).body;

    const restore = failNextWrite('rename');
    let res;
    try {
      res = await api('/api/records/batch/commit', {
        method: 'POST', body: JSON.stringify({ previewId: preview.previewId, rows }),
      });
    } finally {
      restore();
    }
    assert.strictEqual(res.status, 500);
    await assertStateUnchanged(before, '批量提交失败后');

    // 同一预演票据在恢复写入后仍可提交（失败不消耗票据），整批 2 条随一次提交写入
    const retry = await api('/api/records/batch/commit', {
      method: 'POST', body: JSON.stringify({ previewId: preview.previewId, rows }),
    });
    assert.strictEqual(retry.status, 201);
    assert.strictEqual(retry.body.inserted, 2);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1); // 整批只算一次版本
    assert.strictEqual(after.records.length, before.records.length + 2);
    assert.strictEqual(retry.body.rev, before.rev + 1);

    // 票据已被成功提交消费：再次提交应 409 要求重新预演
    const again = await api('/api/records/batch/commit', {
      method: 'POST', body: JSON.stringify({ previewId: preview.previewId, rows }),
    });
    assert.strictEqual(again.status, 409);
  });

  // 6. 新增道具失败后可用同名再次提交（缓存未被污染，不会误报重名）
  await test('新增道具落盘失败后：同名重试不被当作重名，提交成功', async () => {
    const before = (await api('/api/state')).body;
    const restore = failNextWrite('fsync');
    let res;
    try {
      res = await api('/api/props', { method: 'POST', body: JSON.stringify({ name: '故障后同名道具' }) });
    } finally {
      restore();
    }
    assert.strictEqual(res.status, 500);
    await assertStateUnchanged(before, '新增道具失败后');

    const retry = await api('/api/props', { method: 'POST', body: JSON.stringify({ name: '故障后同名道具' }) });
    assert.strictEqual(retry.status, 201);
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev + 1);
    assert.ok(after.props.some((p) => p.name === '故障后同名道具'));
  });

  server.close();
  for (const f of fs.readdirSync(__dirname).filter((n) => n.startsWith('tmp-write-fail-api-store'))) {
    fs.unlinkSync(path.join(__dirname, f));
  }
  console.log(`\n全部 ${passed} 个写入失败一致性接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
