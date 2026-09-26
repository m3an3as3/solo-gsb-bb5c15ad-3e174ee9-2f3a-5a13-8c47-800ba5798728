'use strict';

/**
 * 本地 JSON 数据存储（快照提交 / 原子落盘）。
 *
 * 数据文件路径由环境变量 DATA_FILE 指定（默认 ./data/store.json）。
 * 首次启动（文件不存在）时自动写入初始演示数据，实现“启动即初始化”。
 *
 * 写入一致性保证：
 * - 所有增删改统一走 commit() 快照提交：先克隆当前缓存快照，在草稿上完成
 *   本请求的全部变更（道具 + 记录 + 签收），再把「完整新快照」一次性写入
 *   临时文件、fsync 后原子重命名为正式数据文件；
 * - 只有落盘成功后才发布缓存、rev 只在此时自增一次——每个成功请求只落盘一次；
 * - 临时文件写入或重命名任一步失败：清理临时文件，缓存 / 正式数据文件 / rev
 *   全部保持请求前状态，调用方收到异常（路由层返回 JSON 500），恢复写入后可直接重试；
 * - 正式文件永远只由原子重命名产生，重启读到的必为某一完整快照，不会出现部分变更。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');
const TMP_FILE = `${DATA_FILE}.tmp`;

/** 仓库标识：每件道具的初始持有人恒为仓库 */
const WAREHOUSE = '仓库';

let cache = null;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/** 初始演示数据：覆盖正常链、同一分钟多接冲突、断链冲突、未归仓四种情况 */
function seedData() {
  const now = Date.now();
  const props = [
    { id: 'p_sword', name: '青龙剑', note: '开场武戏用', createdAt: now },
    { id: 'p_fan', name: '折扇', note: '第二场', createdAt: now },
    { id: 'p_lantern', name: '宫灯', note: '夜场', createdAt: now },
    { id: 'p_seal', name: '御印', note: '终场归还', createdAt: now },
  ];
  const records = [
    // 青龙剑：仓库 -> 张三 -> 李四 -> 张三 -> 仓库，完整闭环
    { id: 'r_sw1', propId: 'p_sword', minute: 0, from: WAREHOUSE, to: '张三', note: '开场领出', createdAt: now },
    { id: 'r_sw2', propId: 'p_sword', minute: 3, from: '张三', to: '李四', note: '侧台交接', createdAt: now + 1 },
    { id: 'r_sw3', propId: 'p_sword', minute: 8, from: '李四', to: '张三', note: '武戏结束', createdAt: now + 2 },
    { id: 'r_sw4', propId: 'p_sword', minute: 12, from: '张三', to: WAREHOUSE, note: '归仓', createdAt: now + 3 },

    // 折扇：第 5 分钟同一持有人张三同时要交给两个人 -> 多条可接续（歧义冲突）
    { id: 'r_fa1', propId: 'p_fan', minute: 1, from: WAREHOUSE, to: '张三', note: '', createdAt: now },
    { id: 'r_fa2', propId: 'p_fan', minute: 5, from: '张三', to: '王五', note: '', createdAt: now + 1 },
    { id: 'r_fa3', propId: 'p_fan', minute: 5, from: '张三', to: '赵六', note: '', createdAt: now + 2 },

    // 宫灯：第 4 分钟当前由王五持有，却出现 李四 -> 钱七 的记录 -> 无法接续（断链冲突）
    { id: 'r_la1', propId: 'p_lantern', minute: 2, from: WAREHOUSE, to: '王五', note: '', createdAt: now },
    { id: 'r_la2', propId: 'p_lantern', minute: 4, from: '李四', to: '钱七', note: '登记有误？', createdAt: now + 1 },
    { id: 'r_la3', propId: 'p_lantern', minute: 9, from: '钱七', to: WAREHOUSE, note: '', createdAt: now + 2 },

    // 御印：完整交接但演出结束仍在孙七手上 -> 未归仓提示
    { id: 'r_se1', propId: 'p_seal', minute: 1, from: WAREHOUSE, to: '周八', note: '', createdAt: now },
    { id: 'r_se2', propId: 'p_seal', minute: 6, from: '周八', to: '孙七', note: '', createdAt: now + 1 },
  ];
  return { version: 1, rev: 0, props, records, signoffs: [] };
}

/** 深拷贝快照：草稿上的任何变更都不得影响已发布缓存（JSON 可序列化的纯数据） */
function cloneSnapshot(data) {
  return JSON.parse(JSON.stringify(data));
}

/**
 * 把完整快照原子写入正式数据文件：
 * 1. 写入唯一固定临时文件并 fsync（内容完整落盘）；
 * 2. rename 原子替换正式文件（同目录内为原子操作），再尽力 fsync 目录；
 * 3. 任一步失败都清理临时文件并抛错，正式文件保持原状。
 */
function writeSnapshotAtomic(snapshot) {
  const payload = JSON.stringify(snapshot, null, 2);
  let fd = null;
  try {
    fd = fs.openSync(TMP_FILE, 'w');
    fs.writeSync(fd, payload, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(TMP_FILE, DATA_FILE);
    // 目录项变更尽力落盘（不支持的平台 / 文件系统忽略即可，rename 已原子完成）
    let dirFd = null;
    try {
      dirFd = fs.openSync(path.dirname(DATA_FILE), 'r');
      fs.fsyncSync(dirFd);
    } catch {
      /* 目录 fsync 非关键路径，忽略 */
    } finally {
      if (dirFd !== null) {
        try { fs.closeSync(dirFd); } catch { /* 忽略 */ }
      }
    }
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
    try { fs.unlinkSync(TMP_FILE); } catch { /* 临时文件本就不存在则忽略 */ }
    throw err;
  }
}

/**
 * 快照提交：在当前缓存的克隆草稿上执行 mutator（可同时改 props/records/signoffs），
 * 成功后把完整草稿原子落盘，落盘成功才发布缓存并把 rev 自增一次。
 *
 * 任一步失败都抛出异常：缓存仍指向请求前的旧快照，正式数据文件未被替换，
 * rev 保持请求前的值；临时文件已被清理，恢复写入后可用相同请求再次提交。
 *
 * @param {(draft: {version:number, rev:number, props:Array, records:Array, signoffs:Array}) => *} mutator
 *        在草稿上完成本请求的全部变更；其返回值作为 commit 的结果返回
 * @returns {object} { data: 发布后的新快照, result: mutator 的返回值 }
 */
function commit(mutator) {
  const current = ensureLoaded();
  const draft = cloneSnapshot(current);

  // 所有业务变更只作用于草稿；此处抛错时缓存与正式文件均未被触碰
  const result = mutator(draft);

  draft.rev = (typeof draft.rev === 'number' ? draft.rev : 0) + 1;

  // 先完整写临时文件并原子替换；失败时旧缓存与旧文件都原样保留
  writeSnapshotAtomic(draft);

  // 落盘成功后才发布缓存：此后任何读取看到的都是新快照
  cache = draft;
  return { data: cache, result };
}

function ensureLoaded() {
  if (cache) return cache;

  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    const seed = seedData();
    // 初始化同样是一次落盘：rev 自增为 1 后原子写入；失败直接抛出，不留半截文件
    seed.rev += 1;
    writeSnapshotAtomic(seed);
    cache = seed;
    console.log(`[store] 数据文件不存在，已初始化演示数据: ${DATA_FILE}`);
  } else {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.props) || !Array.isArray(parsed.records)) {
        throw new Error('数据结构无效：props/records 必须为数组');
      }
      // 数据版本号：每次成功落盘自增，批量预演以此核对数据是否在预演后被修改
      if (typeof parsed.rev !== 'number') parsed.rev = 0;
      // 签收列表：旧数据文件可能没有该字段，默认为空
      if (!Array.isArray(parsed.signoffs)) parsed.signoffs = [];
      cache = parsed;
    } catch (err) {
      const backup = `${DATA_FILE}.corrupt.${Date.now()}`;
      fs.renameSync(DATA_FILE, backup);
      const seed = seedData();
      seed.rev += 1; // 与首次初始化一致：重新初始化的落盘同样计一次版本
      writeSnapshotAtomic(seed);
      cache = seed;
      console.warn(`[store] 数据文件损坏（${err.message}），已备份至 ${backup} 并重新初始化`);
    }
  }
  return cache;
}

function getData() {
  return ensureLoaded();
}

module.exports = {
  WAREHOUSE,
  newId,
  getData,
  commit,
};
