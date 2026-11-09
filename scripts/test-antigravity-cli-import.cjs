/*
 * Antigravity 桌面端对话交给 CLI 继续（core/antigravity.ts 的 prepareAntigravityCliConversation）。
 * agy.exe --conversation <id> 只在 ~/.gemini/antigravity-cli 里找对话库，桌面端的对话要先快照过去。
 * 一次性目录，不碰真实的 ~/.gemini 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-import-'));
const ide = path.join(root, 'antigravity'), cli = path.join(root, 'antigravity-cli'), data = path.join(root, 'data');
Object.assign(process.env, { TOKENPULSE_DATA_DIR: data, TOKENPULSE_ANTIGRAVITY_DIR: ide, TOKENPULSE_ANTIGRAVITY_CLI_DIR: cli });
for (const dir of [path.join(ide, 'conversations'), path.join(cli, 'conversations'), data]) fs.mkdirSync(dir, { recursive: true });
const { DatabaseSync } = require('node:sqlite');
const a = require('../build/core/antigravity');

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const file = (dir, id) => path.join(dir, 'conversations', id + '.db');
/** 造一个 WAL 模式的对话库（和真实文件一样），n 步。 */
function makeDb(target, n, tag = 'ide') {
  const db = new DatabaseSync(target);
  db.exec('pragma journal_mode = wal; create table if not exists steps (idx integer primary key, step_type integer, status integer, metadata blob, step_payload blob); create table if not exists gen_metadata (idx integer primary key, data blob, size integer);');
  addSteps(db, n, tag);
  return db;
}
function addSteps(db, n, tag) {
  const start = Number(db.prepare('select count(*) c from steps').get().c);
  for (let i = 0; i < n; i++) db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)').run(start + i, 14, 3, Buffer.from(`${tag}-${start + i}`));
}
const count = target => { const db = new DatabaseSync(target, { readOnly: true }); try { return Number(db.prepare('select count(*) c from steps').get().c); } finally { db.close(); } };
const tags = target => { const db = new DatabaseSync(target, { readOnly: true }); try { return db.prepare('select step_payload p from steps order by idx').all().map(r => Buffer.from(r.p).toString()); } finally { db.close(); } };

(async () => {
  try {
    const A = 'aaaaaaaa-3333-4000-8000-000000000001', NATIVE = 'bbbbbbbb-3333-4000-8000-000000000002', BLANK = 'cccccccc-3333-4000-8000-000000000003';

    // 1. 桌面端对话（桌面端开着、内容还在 -wal 里）→ 导入 CLI，历史完整，附件跟着过去
    const ideDb = makeDb(file(ide, A), 4);
    fs.mkdirSync(path.join(ide, 'brain', A), { recursive: true });
    fs.writeFileSync(path.join(ide, 'brain', A, 'implementation_plan.md'), '# plan');
    fs.mkdirSync(path.join(ide, 'annotations'), { recursive: true });
    fs.writeFileSync(path.join(ide, 'annotations', A + '.pbtxt'), 'starred: true');
    assert.ok(fs.existsSync(file(ide, A) + '-wal'), '夹具应当是 WAL 模式、桌面端还开着');
    assert.equal(await a.prepareAntigravityCliConversation(A), 'imported');
    assert.equal(count(file(cli, A)), 4);
    assert.equal(fs.readFileSync(path.join(cli, 'brain', A, 'implementation_plan.md'), 'utf8'), '# plan');
    assert.equal(fs.readFileSync(path.join(cli, 'annotations', A + '.pbtxt'), 'utf8'), 'starred: true');
    assert.deepEqual(fs.readdirSync(path.join(cli, 'conversations')).filter(n => /tokenpulse/.test(n)), [], '不留临时文件');
    pass('desktop conversation (open, WAL) is snapshotted into the CLI dir with brain and annotations');

    // 2. 没变化 → current，不重复复制
    assert.equal(await a.prepareAntigravityCliConversation(A), 'current');
    pass('unchanged conversation is not re-imported');

    // 3. 桌面端接着聊了、CLI 那份没动 → 刷新
    addSteps(ideDb, 2, 'ide');
    assert.equal(await a.prepareAntigravityCliConversation(A), 'imported');
    assert.equal(count(file(cli, A)), 6);
    pass('desktop progress refreshes an untouched CLI copy');

    // 4. CLI 里接着聊过 → 保留 CLI 那份，不覆盖
    const cliDb = new DatabaseSync(file(cli, A));
    addSteps(cliDb, 1, 'cli');
    cliDb.close();
    addSteps(ideDb, 3, 'ide');
    assert.equal(await a.prepareAntigravityCliConversation(A), 'kept');
    assert.equal(count(file(cli, A)), 7);
    assert.equal(tags(file(cli, A)).at(-1), 'cli-6');
    pass('CLI copy with its own new steps is kept');
    ideDb.close();

    // 5. CLI 自己的对话（桌面端没有）→ native，什么都不动
    makeDb(file(cli, NATIVE), 2, 'cli').close();
    assert.equal(await a.prepareAntigravityCliConversation(NATIVE), 'native');
    assert.equal(count(file(cli, NATIVE)), 2);
    pass('CLI-native conversation is left alone');

    // 6. 之前恢复出来的空白同名对话（步数比桌面端少、不是 TokenPulse 导入的）→ 备份后导入
    makeDb(file(ide, BLANK), 5).close();
    makeDb(file(cli, BLANK), 1, 'blank').close();
    assert.equal(await a.prepareAntigravityCliConversation(BLANK), 'imported');
    assert.equal(count(file(cli, BLANK)), 5);
    const backups = fs.readdirSync(path.join(data, 'antigravity-cli-backup')).filter(n => n.startsWith(BLANK) && n.endsWith('.db'));
    assert.equal(backups.length, 1);
    assert.equal(count(path.join(data, 'antigravity-cli-backup', backups[0])), 1);
    pass('stale blank CLI conversation is backed up then replaced');

    // 7. 列表去重：两边同 ID 只出现一次
    const names = a.antigravityConversationFiles().map(f => path.basename(f));
    assert.equal(names.filter(n => n === A + '.db').length, 1);
    pass('conversation list keeps one entry per id');

    // 8. 非法 ID
    await assert.rejects(() => a.prepareAntigravityCliConversation('../evil'), /ID/);
    pass('invalid id rejected');

    console.log(`\n${checks}/${checks} PASSED`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄晚一点才释放 */ }
  }
})();
