/*
 * 按会话日志时间戳估算速度（0.3.53，usage-scan.ts 的 estimateOf / callBoundary，pass-speed.ts 的 estimatedRows）。
 * 在一次性的 HOME 里造 Claude Code 和 Codex 的会话文件，不碰真实数据。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-speed-est-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const build = path.join(__dirname, '..', 'build', 'core');
const { scanLocalUsage } = require(path.join(build, 'usage-scan.js'));
const { estimatedRows, speedSeries, accountSpeed } = require(path.join(build, 'pass-speed.js'));
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const iso = ms => new Date(ms).toISOString();
const t0 = Date.now() - 3600_000;

try {
  // Claude Code：提问 → 一次回复拆成两行（思考、正文）→ 工具结果 → 第二次回复；再来一条太短的
  const claude = path.join(process.env.HOME, '.claude', 'projects', 'p', 's.jsonl');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  const asst = (at, id, output, type) => ({ type: 'assistant', timestamp: iso(at), requestId: 'req-' + id, message: { id, model: 'claude-qa', usage: { input_tokens: 10, output_tokens: output }, content: [{ type }] } });
  fs.writeFileSync(claude, [
    { type: 'user', timestamp: iso(t0), message: { content: 'hi' } },
    { type: 'attachment', timestamp: iso(t0 + 5000) },
    asst(t0 + 8000, 'm1', 1000, 'thinking'),
    asst(t0 + 10000, 'm1', 1000, 'text'),           // 同一次回复的最后一行：用时 10 秒 → 100 t/s
    { type: 'user', timestamp: iso(t0 + 11000), message: { content: [{ type: 'tool_result' }] } },
    asst(t0 + 15000, 'm2', 400, 'text'),            // 4 秒 → 100 t/s
    { type: 'user', timestamp: iso(t0 + 16000), message: { content: 'ok' } },
    asst(t0 + 17000, 'm3', 5, 'text'),              // 太短：不算
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  // Codex：turn_context → token_usage_record（3 秒）→ 工具输出 → 第二个（2 秒）
  const codex = path.join(process.env.HOME, '.codex', 'sessions', '2026', '10', '14', 'rollout-x.jsonl');
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  const usage = (at, output) => ({ type: 'token_usage_record', timestamp: iso(at), payload: { usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: output } } });
  fs.writeFileSync(codex, [
    { type: 'session_meta', timestamp: iso(t0), payload: { id: 'x', cwd: 'C:\\qa' } },
    { type: 'turn_context', timestamp: iso(t0 + 1000), payload: { model: 'gpt-qa' } },
    usage(t0 + 4000, 300),
    { type: 'response_item', timestamp: iso(t0 + 6000), payload: { type: 'function_call_output' } },
    usage(t0 + 8000, 200),
  ].map(o => JSON.stringify(o)).join('\n') + '\n');

  scanLocalUsage();
  const rows = estimatedRows(0).sort((a, b) => a.at - b.at);
  const claudeRows = rows.filter(r => r.app === 'claude'), codexRows = rows.filter(r => r.app === 'codex');
  assert.deepEqual(claudeRows.map(r => r.speed), [100, 100], '同一次回复按最后一行算结束；太短的不算 ' + JSON.stringify(claudeRows));
  assert.deepEqual(codexRows.map(r => r.speed), [100, 100], 'Codex 从 turn_context / 工具输出算起 ' + JSON.stringify(codexRows));
  pass('estimates: Claude Code spans the whole multi-line reply, Codex starts at turn_context or tool output, short replies are skipped');

  const series = speedSeries(0);
  const est = series.lines.filter(l => l.estimated);
  assert.deepEqual(est.map(l => [l.app, l.model, l.tokensPerSec, l.firstTokenMs]).sort(), [['claude', 'claude-qa', 100, null], ['codex', 'gpt-qa', 100, null]]);
  assert.equal(speedSeries(0, Date.now(), false).lines.filter(l => l.estimated).length, 0, '可以不要估算的');
  const account = accountSpeed('claude', '', 0);
  assert.ok(account.models.every(m => m.estimated) || account.models.length === 0);
  pass('speed lines: estimated lines are separate (marked, no first-token), and can be left out');
  console.log(`test-speed-estimate: ${checks} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
