/*
 * DeepSeek Harness 的用量（0.3.42，src/core/usage-scan.ts 的 deepseekRow / zstdFrames）。
 * 会话文件是 ~/.dsh/sessions/<工作目录>/session-<id>/session.v4.jsonl.zstd：一批事件一个 zstd 帧，追加写。
 * 覆盖：多个帧依次解开、输入 Token 把缓存命中加回去、型号 / 思考等级（中途换了等级）/ 工作目录 / 会话 ID、
 * 后来追加的帧只读新增的、最后一帧没写完时先不读、重扫不重复。
 * 用一次性的 HOME 和数据目录，不碰真实的 ~/.dsh 和 ~/.tokenpulse。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-dsh-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const build = path.join(__dirname, '..', 'build', 'core');
const { scanLocalUsage, readRollups } = require(path.join(build, 'usage-scan.js'));
const { queryRequests } = require(path.join(build, 'request-log.js'));

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const base = Date.now() - 3600_000;
const frame = rows => zlib.zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'));
const header = (seq, effort, reason) => ({ type: 'request/header', seq, time: base + seq, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-qa', reasoningEffort: effort, maxTokens: 1000 }, tools: [] }, reason } });
const reply = (seq, id, input, output, cacheRead) => ({ type: 'assistant/message', seq, time: base + seq * 1000, data: { turn: 1, step: seq, message: { role: 'assistant', id, content: [{ type: 'text', text: 'secret-reply-text' }], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-qa', replayState: { response: { kind: 'x', version: 1, model: 'deepseek-qa' } } } }, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, totalTokens: input + output + cacheRead } } });
const query = () => queryRequests({ from: '2000-01-01', to: '2999-01-01', source: 'DeepSeek Harness', status: 'all', search: '', sort: 'time', page: 0, pageSize: 50, all: true }).rows.sort((a, b) => a.at - b.at);

try {
  const file = path.join(process.env.HOME, '.dsh', 'sessions', '--D-qa-project--', 'session-qa-1234', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 三个帧：会话头；请求头 + 两次调用；用户消息（没有用量，不算请求）
  fs.writeFileSync(file, Buffer.concat([
    frame([{ type: 'session', version: 4, id: 'session-qa-1234', createdAt: base, cwd: 'D:\\qa\\project' }]),
    frame([header(1, 'high', 'initial'), reply(2, 'msg-a', 2000, 100, 0), reply(3, 'msg-b', 300, 50, 2048)]),
    frame([{ type: 'user/message', seq: 4, time: base + 4000, data: { content: [{ type: 'text', text: 'secret-user-text' }] } }]),
  ]));
  let scan = scanLocalUsage();
  assert.equal(scan.records.length, 2);
  let rows = query();
  assert.deepEqual(rows.map(row => [row.source, row.model, row.effort, row.input, row.output, row.cacheRead, row.session, row.cwd]), [
    ['DeepSeek Harness', 'deepseek-qa', 'high', 2000, 100, 0, 'qa-1234', 'D:\\qa\\project'],
    ['DeepSeek Harness', 'deepseek-qa', 'high', 2348, 50, 2048, 'qa-1234', 'D:\\qa\\project'],
  ], '输入 Token 把缓存命中的加回去（TokenPulse 的输入口径含缓存）');
  assert.deepEqual(rows.map(row => [row.status, row.channel, row.official ?? null, row.account]), [['match', 'DeepSeek', null, null], ['match', 'DeepSeek', null, null]]);
  assert.ok(rows[0].costUsd > 0, '按单价表算出参考费用');
  const saved = fs.readdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true }).filter(name => /\.jsonl?$|\.json$/.test(String(name))).map(name => fs.readFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, String(name)), 'utf8')).join('');
  assert.equal(/secret-reply-text|secret-user-text/.test(saved), false, '不保存对话内容');
  pass('zstd frames decoded in order; tokens, model, effort, cwd and session id read; nothing of the conversation is stored');

  // 追加：换了思考等级再问一次；最后一帧只写了一半
  const more = frame([header(5, 'max', 'change'), reply(6, 'msg-c', 500, 20, 4096)]);
  const half = frame([reply(7, 'msg-d', 900, 30, 0)]);
  fs.appendFileSync(file, Buffer.concat([more, half.subarray(0, half.length - 5)]));
  scan = scanLocalUsage();
  assert.deepEqual(scan.records.map(record => [record.id, record.effort]), [['msg-c', 'max']], '只读新增的完整帧，没写完的那一帧先不读');
  fs.appendFileSync(file, half.subarray(half.length - 5));
  scan = scanLocalUsage();
  assert.deepEqual(scan.records.map(record => record.id), ['msg-d'], '那一帧写完了再读，不丢不重');
  assert.equal(scanLocalUsage().records.length, 0);
  rows = query();
  assert.deepEqual(rows.map(row => row.effort), ['high', 'high', 'max', 'max']);
  const state = Object.values(readRollups().files).find(item => item.kind === 'deepseek-harness');
  const total = Object.values(state.days).flatMap(sources => Object.values(sources)).flatMap(models => Object.values(models)).reduce((sum, bucket) => ({ input: sum.input + bucket.input, output: sum.output + bucket.output, requests: sum.requests + bucket.requests }), { input: 0, output: 0, requests: 0 });
  assert.deepEqual(total, { input: 2000 + 2348 + 4596 + 900, output: 200, requests: 4 });
  pass('appended frames are read incrementally; a half-written frame waits; effort changes mid-session are followed; no double counting');

  console.log(`${checks}/${checks} deepseek harness checks passed`);
} catch (error) {
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
