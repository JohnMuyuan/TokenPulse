/*
 * Codex 降智检测（0.3.41，src/core/codex-state-probe.ts）。
 * 用本机假上游模拟 ChatGPT 的 Codex 接口，不联网、不用真实账号。
 * 覆盖：两发请求的形状（第一发不带门票和 Cookie，第二发带上第一发拿到的）、换了新门票 = 降智、没换 / 回原票 = 正常、
 * 登录失效 / 限流 / 回复没正常结束 / 没发门票 → 无法判断，结果里不含门票和凭据。
 */
const assert = require('node:assert/strict');
const http = require('node:http');
for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete process.env[key];
const { probeCodexState } = require('../build/core/codex-state-probe');

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const TICKET = 'T'.repeat(780);
const sse = (model, ok = true) => `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_' + 'a'.repeat(40), model } })}\n\n`
  + (ok ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_' + 'a'.repeat(40), model, status: 'completed' } })}\n\n`
    : `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'server_is_overloaded' } } })}\n\n`);

(async () => {
  const hits = [];
  // mode 决定假上游怎么回第二发
  let mode = 'healthy';
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const second = Boolean(req.headers['x-codex-turn-state']);
      hits.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (mode === 'unauthorized') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"token expired"}}'); return; }
      if (mode === 'limited') { res.writeHead(429); res.end('{}'); return; }
      const headers = { 'content-type': 'text/event-stream' };
      if (!second) {
        if (mode !== 'no-ticket') headers['x-codex-turn-state'] = TICKET;
        headers['set-cookie'] = ['__cflb=cf-route; Path=/; HttpOnly', '__oailb=oai-route; Path=/', 'other=ignored; Path=/'];
      } else if (mode === 'degraded') headers['x-codex-turn-state'] = 'N'.repeat(780);
      else if (mode === 'same-ticket') headers['x-codex-turn-state'] = TICKET;
      res.writeHead(200, headers);
      res.end(sse('gpt-qa-big', !(second && mode === 'overloaded')));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/backend-api/codex`;
  const run = next => { mode = next; hits.length = 0; return probeCodexState({ token: 'TEST-TOKEN', accountId: 'workspace-1' }, 'gpt-qa-big', { base }); };
  try {
    let result = await run('healthy');
    assert.deepEqual([result.verdict, result.newTicket, result.mintStatus, result.continueStatus, result.ticketLength, result.continueTicketLength, result.reportedModel, result.failure], ['healthy', false, 200, 200, 780, 0, 'gpt-qa-big', undefined]);
    assert.equal(hits.length, 2, '一次检测正好两发请求');
    const [first, second] = hits;
    assert.equal(first.url, '/backend-api/codex/responses');
    assert.deepEqual([first.headers.authorization, first.headers['chatgpt-account-id'], first.headers.originator, first.headers.accept, first.headers['openai-beta']], ['Bearer TEST-TOKEN', 'workspace-1', 'codex_cli_rs', 'text/event-stream', 'responses=experimental']);
    assert.match(first.headers['user-agent'], /^codex_cli_rs\/\d+\.\d+\.\d+ /);
    assert.deepEqual([first.headers['x-codex-turn-state'], first.headers.cookie], [undefined, undefined], '第一发不带门票和 Cookie');
    assert.deepEqual([second.headers['x-codex-turn-state'], second.headers.cookie], [TICKET, '__cflb=cf-route; __oailb=oai-route'], '第二发带上第一发拿到的门票和两枚路由 Cookie');
    assert.notEqual(first.headers.session_id, second.headers.session_id, '每发一个新的 session_id');
    assert.deepEqual([first.body.model, first.body.stream, first.body.store, first.body.input[0].content[0].text], ['gpt-qa-big', true, false, 'Reply with OK.']);
    assert.equal(/TEST-TOKEN|T{20}|cf-route/.test(JSON.stringify(result)), false, '结果里没有凭据、门票和 Cookie');
    assert.match(result.reason, /没有换新门票/);
    pass('two shots shaped like the reference probe; no new ticket on the second means healthy');

    result = await run('same-ticket');
    assert.deepEqual([result.verdict, result.newTicket], ['healthy', false], '回的是原票也算正常');
    result = await run('degraded');
    assert.deepEqual([result.verdict, result.newTicket, result.continueTicketLength], ['degraded', true, 780]);
    assert.match(result.reason, /换了一张新门票.*降智/);
    pass('a different ticket on the second shot means degraded; the same ticket does not');

    for (const [next, failure, shots] of [['unauthorized', 'account_error', 1], ['limited', 'rate_limited', 1], ['no-ticket', 'no_ticket', 1], ['overloaded', 'stream_error', 2]]) {
      result = await run(next);
      assert.deepEqual([result.verdict, result.failure, hits.length], ['inconclusive', failure, shots], next);
    }
    result = await probeCodexState({ token: '' }, 'gpt-qa-big', { base });
    assert.deepEqual([result.verdict, result.failure], ['inconclusive', 'account_error']);
    result = await probeCodexState({ token: 'x' }, 'gpt-qa-big', { base: 'http://127.0.0.1:9/none' });
    assert.deepEqual([result.verdict, result.failure], ['inconclusive', 'network_error']);
    pass('anything short of two clean replies is inconclusive, never a false "degraded"');

    console.log(`${checks}/${checks} codex state probe checks passed`);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    server.closeAllConnections?.(); server.close();
  }
})();
