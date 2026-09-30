/*
 * 0.3.9 供应商配置保护：预览不落盘、确认签名、只读保护、每次改动留历史、一键还原、接管前原件、密钥打码。
 * 全部在临时 HOME / 数据目录里跑，不碰真实的 ~/.claude、~/.codex、~/.grok。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-guard-'));
const home = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];

const sw = require('../build/core/agent-switch');
const cfg = require('../build/core/agent-config');
const hist = require('../build/core/agent-history');

const claudeFile = path.join(home, '.claude', 'settings.json');
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const original = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.example', ANTHROPIC_AUTH_TOKEN: 'sk-my-own-secret-123456' }, theme: 'dark' }, null, 2) + '\n';
fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
fs.writeFileSync(claudeFile, original);
let readOnly = false;
cfg.configureReadOnly(() => readOnly);

(async () => {
  try {
    // 只改供应商列表：预览里没有工具文件的改动
    const storeOnly = await cfg.configPreview(() => sw.saveProvider({ app: 'claude', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: 'sk-relay-secret-abcdef', model: 'claude-sonnet-5', upstream: 'anthropic' }));
    assert.deepEqual(storeOnly, [], '保存供应商不碰工具配置');
    assert.equal(sw.agentView().providers.some(p => p.name === 'Relay'), false, '预览不会真的保存');
    const id = sw.saveProvider({ app: 'claude', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: 'sk-relay-secret-abcdef', model: 'claude-sonnet-5', upstream: 'anthropic' });

    // 切换：预览列出 settings.json 的改动，但文件一个字节都没变
    const changes = await cfg.configPreview(() => sw.activateProvider(id));
    assert.equal(changes.length, 1);
    assert.equal(path.resolve(changes[0].file), path.resolve(claudeFile));
    assert.equal(read(claudeFile), original, '预览不写文件');
    assert.equal(fs.existsSync(path.join(root, 'data', 'backups', 'agent-history')), false, '预览不留历史');
    const diff = hist.fileDiff(changes[0]);
    assert.equal(diff.tool, 'Claude Code');
    assert.ok(diff.added > 0 && diff.deleted > 0);
    const shown = JSON.stringify(diff.lines);
    assert.ok(!shown.includes('sk-my-own-secret-123456') && !shown.includes('sk-relay-secret-abcdef'), '对比里的密钥打码：' + shown);
    assert.match(shown, /relay\.example/);
    // 保持原来的 2 空格缩进：只改动相关的几行，不把整份文件重排（以前嵌套层有 4 空格就被当成 4 缩进）
    assert.ok(diff.deleted <= 4, '只改地址和密钥那几行，不整份重排：删 ' + diff.deleted + ' 行');

    // 确认之后文件又被别的程序改了：签名对不上，不写
    const signature = hist.changeSignature(changes);
    fs.writeFileSync(claudeFile, original.replace('dark', 'light'));
    cfg.configExpect(signature);
    await assert.rejects(sw.activateProvider(id), /确认之后配置又有变化|其他程序修改/);
    cfg.configExpect(null);
    assert.equal(read(claudeFile), original.replace('dark', 'light'), '没有写入');
    fs.writeFileSync(claudeFile, original);

    // 只读保护：切换被拦，文件不变；但只改供应商列表的操作照常
    readOnly = true;
    await assert.rejects(sw.activateProvider(id), /只读保护/);
    assert.equal(read(claudeFile), original);
    sw.setFailover(id, true);
    assert.equal(sw.agentView().providers.find(p => p.id === id).failover, true, '只读保护下供应商资料照常可以改');
    readOnly = false;

    // 确认签名一致：真正写入，并留一条历史
    cfg.configExpect(hist.changeSignature(await cfg.configPreview(() => sw.activateProvider(id))));
    cfg.configReason('切换到「Relay」');
    await sw.activateProvider(id);
    cfg.configExpect(null); cfg.configReason('');
    const switched = read(claudeFile);
    assert.match(switched, /relay\.example/);
    assert.match(switched, /"theme": "dark"/, '用户自己的设置保留');
    assert.match(switched, /^\{\n  "env": \{\n    "ANTHROPIC_BASE_URL"/, '缩进保持 2 空格');
    let history = hist.listHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].reason, '切换到「Relay」');
    assert.equal(history[0].files[0].before, original);
    assert.equal(history[0].files[0].after, switched);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'data', 'backups', 'agent-history', history[0].id + '.json')).mode & 0o777, 0o600);

    // 接管前的原件
    const originals = hist.listOriginals();
    assert.equal(originals.length, 1);
    assert.equal(originals[0].content, original);

    // 还原：只读保护开着也能还原（放回去），还原本身也留历史
    readOnly = true;
    assert.equal(sw.restoreConfigBackup('history', history[0].id), 1);
    assert.equal(read(claudeFile), original, '还原到切换之前');
    history = hist.listHistory();
    assert.equal(history.length, 2, '还原也记一条');
    assert.equal(history[0].files[0].before, switched);
    // 撤回还原
    sw.restoreConfigBackup('history', history[0].id);
    assert.equal(read(claudeFile), switched);
    // 恢复接管前的原件
    sw.restoreConfigBackup('original', originals[0].id);
    assert.equal(read(claudeFile), original);
    readOnly = false;
    assert.throws(() => sw.restoreConfigBackup('history', 'zzz-000000'), /找不到/);

    // 关闭路由属于放回去：只读保护下也要能做（这里没开路由，只验证不抛只读错误）
    readOnly = true;
    await sw.setAppProxy('claude', false);
    readOnly = false;

    // 打码和对比的细节
    assert.equal(hist.maskSecrets('  "ANTHROPIC_AUTH_TOKEN": "sk-abcdefghijklmnop",'), '  "ANTHROPIC_AUTH_TOKEN": "sk-a••••op",');
    assert.equal(hist.maskSecrets('experimental_bearer_token = "abcdefghijkl"'), 'experimental_bearer_token = "abcd••••kl"');
    assert.equal(hist.maskSecrets('OPENAI_API_KEY=sk-proj-1234567890'), 'OPENAI_API_KEY=sk-p••••90');
    assert.equal(hist.maskSecrets('model = "gpt-5"'), 'model = "gpt-5"');
    const big = hist.lineDiff(Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n'), Array.from({ length: 40 }, (_, i) => i === 20 ? 'changed' : 'line ' + i).join('\n'));
    assert.equal(big.added, 1); assert.equal(big.deleted, 1);
    assert.ok(big.lines.length <= 10 && big.lines[0].kind === '…' === false, '只留改动附近几行');
    assert.deepEqual(hist.lineDiff(null, 'a\nb').lines.map(l => l.kind), ['+', '+']);

    // 历史只留最近 50 次
    for (let i = 0; i < 55; i++) hist.recordHistory('test ' + i, [{ file: claudeFile, before: 'a', after: 'b' + i }], Date.now() + i * 1000);
    assert.equal(hist.listHistory().length, 50);
    console.log('PASS agent config guard: preview writes nothing, masked diff, signature mismatch refused, read-only blocks takeover but allows restore, history recorded with 0600, restore + undo restore, pre-takeover original, 50-entry cap');
  } finally {
    await sw.resetAgentSwitchForTests?.().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
