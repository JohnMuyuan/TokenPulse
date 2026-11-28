/*
 * 桌宠读 Antigravity 会话状态的扫描开销（0.4.7，core/antigravity.ts 的 readAntigravityActivity）。
 * 用户反馈：两小时内动过的对话有 400+ 个时，阶段缓存上限 128、满了整表清空，命中率归零，
 * 桌宠每 0.9～1.5 秒一轮的扫描都把所有对话库同步重开一遍，主进程持续 85%+ 单核、100 MB/s 读盘。
 * 这里数 node:sqlite 的打开次数，确认缓存真的命中、早已停下的历史对话不再每轮打开；同时确认状态判断没有因此变错。
 * 另测原子写遗留临时文件的清理（core/paths.ts 的 cleanStaleTempFiles）。一次性目录，不碰真实的 ~/.gemini 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-scan-'));
const home = path.join(root, 'home');
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), TOKENPULSE_ANTIGRAVITY_DIR: path.join(root, 'agy-default'), USERPROFILE: home, HOME: home });
fs.mkdirSync(home, { recursive: true });
const sqlite = require('node:sqlite');
const { DatabaseSync } = sqlite;
const agy = require('../build/core/antigravity');
const paths = require('../build/core/paths');

// 数对话库被打开了几次（antigravity.ts 每次打开都现取 require('node:sqlite').DatabaseSync）
let opens = 0;
sqlite.DatabaseSync = class extends DatabaseSync { constructor(...args) { super(...args); opens++; } };
const countOpens = fn => { opens = 0; const value = fn(); return { value, opens }; };

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
const KEEP_MS = 2 * 60 * 60_000;
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '0000+00:00');
const uuid = (group, i) => `${group}${String(i).padStart(7, '0')}-1111-4000-8000-${String(i).padStart(12, '0')}`;

/** 造一个 Antigravity 数据目录：摘要库 + 每个对话一份 steps 库，库文件的改动时间按 at 设好。 */
function makeDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  const sum = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
  sum.exec('create table conversation_summaries (conversation_id text primary key, title text, workspace_uris text, status text, nesting_depth integer, killed numeric, last_modified_time datetime, last_user_input_time datetime, not_fully_idle integer default 0, parent_conversation_id text, agent_name text)');
  const put = (id, status, at) => sum.prepare('insert or replace into conversation_summaries (conversation_id, title, workspace_uris, status, nesting_depth, killed, last_modified_time, last_user_input_time) values (?, ?, ?, ?, 0, 0, ?, ?)')
    .run(id, '对话 ' + id.slice(0, 8), JSON.stringify(['file:///d:/demo/app']), status, sqlTime(at), sqlTime(at - 30_000));
  const dbFile = id => path.join(dir, 'conversations', id + '.db');
  const steps = (id, list, at) => {
    const db = new DatabaseSync(dbFile(id));
    db.exec('create table if not exists steps (idx integer primary key, step_type integer, status integer, metadata blob); delete from steps;');
    list.forEach(([type, status], idx) => db.prepare('insert into steps (idx, step_type, status) values (?, ?, ?)').run(idx, type, status));
    db.close();
    if (at) fs.utimesSync(dbFile(id), at / 1000, at / 1000);
  };
  return { dir, sum, put, steps, dbFile };
}
const DONE = [[14, 3], [15, 3]];
const opened = [];

try {
  check('lruGet / lruSet: hits move to the back, overflow evicts only the oldest entry (no whole-table clear)', () => {
    const map = new Map();
    for (const key of ['a', 'b', 'c']) agy.lruSet(map, key, key.toUpperCase(), 3);
    assert.equal(agy.lruGet(map, 'a'), 'A');
    agy.lruSet(map, 'd', 'D', 3);
    assert.deepEqual([...map.keys()], ['c', 'a', 'd'], '最久没用的 b 被淘汰，其余保留');
    agy.lruSet(map, 'c', 'C2', 3);
    assert.deepEqual([...map.entries()], [['a', 'A'], ['d', 'D'], ['c', 'C2']], '覆盖写挪到队尾，不重复');
    assert.equal(agy.lruGet(map, 'missing'), undefined);
  });

  check('antigravity scan: more than 128 recently idle conversations stay cached — the second scan opens no conversation database', () => {
    const now = Date.now();
    const d = makeDir('many-recent'); opened.push(d);
    const N = 200;
    for (let i = 0; i < N; i++) {
      const at = now - 5 * 60_000 - i * 1000;
      const id = uuid('a', i);
      d.put(id, 'CASCADE_RUN_STATUS_IDLE', at);
      d.steps(id, DONE, at);
    }
    const first = countOpens(() => agy.readAntigravityActivity(now - KEEP_MS, [d.dir], now));
    assert.equal(first.value.length, N);
    assert.ok(first.opens >= N, `第一轮要读每个刚停下的对话的最后几步（实际打开 ${first.opens} 次）`);
    assert.ok(first.value.every(item => !item.running && item.ended === 'ok'));
    const second = countOpens(() => agy.readAntigravityActivity(now + 1000 - KEEP_MS, [d.dir], now + 1000));
    assert.equal(second.value.length, N);
    assert.equal(second.opens, 0, `对话库没变时全部命中缓存（旧版超过 128 个就整表清空，这里会是 ${N} 次）`);
    assert.ok(second.value.every(item => item.ended === 'ok'), '命中缓存的结果和第一轮一样');
  });

  check('antigravity scan: conversations idle for longer than 15 minutes are listed without opening their databases', () => {
    const now = Date.now();
    const d = makeDir('old-idle'); opened.push(d);
    const N = 300;
    for (let i = 0; i < N; i++) {
      const at = now - 30 * 60_000 - (i % 80) * 60_000;
      const id = uuid('b', i);
      d.put(id, 'CASCADE_RUN_STATUS_IDLE', at);
      d.steps(id, DONE, at);
    }
    const scan = countOpens(() => agy.readAntigravityActivity(now - KEEP_MS, [d.dir], now));
    assert.equal(scan.value.length, N, '两小时内动过的照样列出来');
    assert.ok(scan.value.every(item => !item.running));
    assert.equal(scan.opens, 1, `只打开摘要库，不再逐个打开早已停下的对话库（实际 ${scan.opens} 次）`);
  });

  check('antigravity scan: a long-silent conversation that just stopped with an error still reports ended=error', () => {
    const now = Date.now();
    const d = makeDir('stopped'); opened.push(d);
    const id = uuid('c', 1);
    const quietAt = now - 40 * 60_000;
    // 一个工具跑了 40 分钟没写库，摘要库说还在跑
    d.put(id, 'CASCADE_RUN_STATUS_RUNNING', quietAt);
    d.steps(id, [[14, 3], [15, 3], [132, 2]], quietAt);
    const first = agy.readAntigravityActivity(now - KEEP_MS, [d.dir], now);
    assert.equal(first.find(item => item.id === id)?.running, true);
    // 停下来了：最后一次回复出错（39 分钟前写进库），摘要库现在才改成空闲（last_modified_time 没刷新）
    d.put(id, 'CASCADE_RUN_STATUS_IDLE', quietAt);
    d.steps(id, [[14, 3], [15, 3], [132, 3], [15, 7]], quietAt + 60_000);
    const second = agy.readAntigravityActivity(now + 2000 - KEEP_MS, [d.dir], now + 2000);
    const item = second.find(it => it.id === id);
    assert.equal(item?.running, false);
    assert.equal(item?.ended, 'error', '上一轮还在跑的对话停下这一轮一定读最后几步：桌宠才能报「出错停下」而不是庆祝');
  });

  check('antigravity scan: quiet conversations reuse their file stamp briefly, and a watcher hint or the TTL picks up new writes', () => {
    const now = Date.now();
    const d = makeDir('cold'); opened.push(d);
    const Y = uuid('d', 1), Z = uuid('d', 2);
    const quietAt = now - 20 * 60_000;
    for (const id of [Y, Z]) { d.put(id, 'CASCADE_RUN_STATUS_IDLE', quietAt); d.steps(id, DONE, quietAt); }
    const first = agy.readAntigravityActivity(now - KEEP_MS, [d.dir], now);
    assert.deepEqual(first.map(item => item.running).sort(), [false, false]);
    // 两个对话库都开始写（新一轮回复生成中），摘要库还没跟上
    for (const id of [Y, Z]) d.steps(id, [[14, 3], [15, 3], [14, 3], [15, 8]]);
    // 桌宠的 fs.watch 看到 Y 的库变了：Y 立刻现查；Z 没收到提示，最多 15 秒后也会现查
    agy.noteAntigravityFileChanged(d.dbFile(Y) + '-wal');
    const t1 = Date.now();
    const second = agy.readAntigravityActivity(t1 - KEEP_MS, [d.dir], t1);
    assert.equal(second.find(item => item.id === Y)?.running, true, '收到文件变动提示的对话马上识别为在跑');
    const t2 = Date.now() + 16_000;
    const third = agy.readAntigravityActivity(t2 - KEEP_MS, [d.dir], t2);
    assert.equal(third.find(item => item.id === Z)?.running, true, '冷 stamp 过期后现查，没有 watcher 也不会漏掉');
  });

  check('cleanStaleTempFiles: removes only our own atomic-write leftovers older than a day', () => {
    const data = path.join(root, 'tmp-clean');
    fs.mkdirSync(path.join(data, 'requests'), { recursive: true });
    fs.mkdirSync(path.join(data, 'pets'), { recursive: true });
    fs.mkdirSync(path.join(data, 'x.1.2.tmp'));
    const old = Date.now() - 2 * 86_400_000;
    const make = (rel, aged) => { const file = path.join(data, rel); fs.writeFileSync(file, 'x'.repeat(10)); if (aged) fs.utimesSync(file, old / 1000, old / 1000); return file; };
    const gone = [make('usage-rollups.json.4120.0.tmp', true), make('usage-rollups.json.4120.3.tmp', true), make('route-log.tsv.88.tmp', true), make('.health-77.tmp', true), make(path.join('requests', '2026-11.jsonl.9.1.tmp'), true)];
    const kept = [make('usage-rollups.json.5000.0.tmp', false), make('usage-rollups.json', true), make('notes.tmp', true), make(path.join('pets', 'pet.json.1.2.tmp'), true)];
    const result = paths.cleanStaleTempFiles(data);
    assert.deepEqual(result, { removed: gone.length, bytes: gone.length * 10 });
    for (const file of gone) assert.equal(fs.existsSync(file), false, '应删：' + path.basename(file));
    for (const file of kept) assert.equal(fs.existsSync(file), true, '应留：' + path.basename(file));
    assert.equal(fs.statSync(path.join(data, 'x.1.2.tmp')).isDirectory(), true, '目录不碰');
    assert.deepEqual(paths.cleanStaleTempFiles(path.join(root, 'missing')), { removed: 0, bytes: 0 }, '目录不存在不报错');
  });

  console.log(`${checks}/${checks} antigravity scan perf checks passed`);
} catch (error) {
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  sqlite.DatabaseSync = DatabaseSync;
  for (const d of opened) { try { d.sum.close(); } catch { /* 已关 */ } }
  fs.rmSync(root, { recursive: true, force: true });
}
