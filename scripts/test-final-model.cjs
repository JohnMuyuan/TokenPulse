/*
 * 返回型号以回复结束时报的为准（0.3.41）。
 * 起因：Codex 账号被官方降级时，回复开头的 response.created 仍然照着请求报型号，结束的 response.completed 才报实际用的；
 * 以前只读第一次出现的型号，核验结果是「型号一致」。
 * 覆盖：Grab 分段读（开头 / 结束、标记和型号被切在两段里、没有结束事件、提示词里带同名的键）、
 * 透明转发 HTTP 流记下两个型号、转发记录索引和请求核验标成「型号不一致」并写出两个名字。
 * 全部用本机假上游，不联网。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-final-model-'));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
const { Grab } = require('../build/core/ws-sniff');
const { verifyRequest } = require('../build/core/request-verify');
const { startAgentProxy } = require('../build/core/agent-proxy');
const ledger = require('../build/core/route-ledger');

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const ID = 'resp_' + '0123456789abcdef'.repeat(3);
const event = (type, model, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, response: { id: ID, object: 'response', instructions: 'You are Codex. Config says \\"model\\": \\"fake-in-prompt\\".' + 'x'.repeat(900), model, ...extra } })}\n\n`;
const delta = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`;
const feedIn = (text, size) => { const grab = new Grab(); for (let i = 0; i < text.length; i += size) grab.feed(text.slice(i, i + size)); return grab; };

(async () => {
  let proxy, upstream;
  try {
    /* ---------- Grab ---------- */
    const downgraded = event('response.created', 'gpt-qa-big') + delta + event('response.completed', 'gpt-qa-small', { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens: 5 } });
    for (const size of [1 << 20, 4096, 97, 13]) {
      const grab = feedIn(downgraded, size);
      assert.deepEqual([grab.first, grab.final, grab.model, grab.declared, grab.responseId, grab.usage?.output], ['gpt-qa-big', 'gpt-qa-small', 'gpt-qa-small', 'gpt-qa-big', ID, 5], `每段 ${size} 个字符`);
    }
    const same = feedIn(event('response.created', 'gpt-qa-big') + delta + event('response.completed', 'gpt-qa-big'), 61);
    assert.deepEqual([same.model, same.declared], ['gpt-qa-big', ''], '前后一样：没有「开头报的」');
    const noEnd = feedIn(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_' + 'a'.repeat(24), model: 'claude-qa' } })}\n\n`, 40);
    assert.deepEqual([noEnd.model, noEnd.final, noEnd.declared], ['claude-qa', '', ''], '没有结束事件（Anthropic）：用第一次出现的');
    const failed = feedIn(event('response.created', 'gpt-qa-big') + event('response.failed', 'gpt-qa-small'), 50);
    assert.equal(failed.model, 'gpt-qa-small', '失败的结束事件同样算');
    pass('Grab: the model in the terminal event wins over the first one, across any chunking; prompt text and streams without a terminal event are unaffected');

    /* ---------- 透明转发：HTTP 流 ---------- */
    upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = req.url.includes('same') ? [event('response.created', 'gpt-qa-big'), delta, event('response.completed', 'gpt-qa-big')] : [event('response.created', 'gpt-qa-big'), delta, event('response.completed', 'gpt-qa-small')];
      let i = 0; const next = () => { if (i < parts.length) { res.write(parts[i++]); setTimeout(next, 20); } else res.end(); }; next();
    }); });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const logs = [];
    proxy = startAgentProxy({ host: '127.0.0.1', port: 0, targets: () => [], log: entry => { logs.push(entry); ledger.appendRouteLog(entry); }, fail: () => {}, succeed: () => {}, open: () => true,
      pass: app => (app === 'codex' ? `http://127.0.0.1:${upstream.address().port}` : null) });
    const port = await proxy.listen();
    const call = url => new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: url, headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(JSON.stringify({ model: 'gpt-qa-big', stream: true })); });
    assert.equal(await call('/pass/codex/responses'), 200);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual([logs[0].requestModel, logs[0].returnedModel, logs[0].declaredModel, logs[0].responseId], ['gpt-qa-big', 'gpt-qa-small', 'gpt-qa-big', ID]);
    pass('pass-through: the forwarding log records the model reported at the end, plus the one reported at the start when they differ');

    /* ---------- 转发记录索引 + 核验 ---------- */
    ledger.resetRouteLedgerCache();
    const hit = ledger.routeReturned(ID, logs[0].at);
    assert.deepEqual([hit.requested, hit.returned, hit.declared], ['gpt-qa-big', 'gpt-qa-small', 'gpt-qa-big']);
    const verdict = verifyRequest({ kind: 'codex', requested: 'gpt-qa-big', responseId: ID, official: true, proxy: { requested: hit.requested, returned: hit.returned, declared: hit.declared, via: 'tokenpulse' } });
    assert.equal(verdict.status, 'mismatch');
    assert.deepEqual(verdict.reasons.slice(0, 2), ['请求的是 gpt-qa-big，上游返回的是 gpt-qa-small', '上游回复开头报的是 gpt-qa-big，结束时报的是 gpt-qa-small']);
    // 以前的做法（只看开头报的）会判成一致
    assert.equal(verifyRequest({ kind: 'codex', requested: 'gpt-qa-big', responseId: ID, official: true, proxy: { requested: 'gpt-qa-big', returned: 'gpt-qa-big', via: 'tokenpulse' } }).status, 'match');
    pass('verification: a response that starts as the requested model and ends as another is a mismatch, with both names in the reasons');

    console.log(`${checks}/${checks} final model checks passed`);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    await proxy?.close();
    upstream?.closeAllConnections?.(); upstream?.close();
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
