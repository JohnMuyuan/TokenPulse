// Synthetic logs and delayed renderer IPC: short replies, large history and range races.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-speed-regressions-'));
process.env.TOKENPULSE_DATA_DIR = root;
const { routeLogDir } = require('../build/core/route-ledger');
const { speedSeries, accountSpeed } = require('../build/core/pass-speed');
const now = new Date(2026, 9, 8, 12).getTime();
fs.mkdirSync(routeLogDir(), { recursive: true });
const file = path.join(routeLogDir(), '2026-10.jsonl');
const row = extra => ({ at: now - 1000, app: 'claude', pass: true, status: 200, requestModel: 'audit-model', ...extra });
let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } };
(async () => {
  try {
    await check('first latency includes short replies, with independent sample counts', () => {
      fs.writeFileSync(file, [row({ firstTokenMs: 100, tokensPerSec: 50, output: 200 }), row({ firstTokenMs: 5000, output: 5 }), row({ firstTokenMs: 9000, output: 5 }), row({ requestModel: 'short-only', firstTokenMs: 800, output: 5 })].map(JSON.stringify).join('\n') + '\n');
      const data = speedSeries(7, now), line = data.lines.find(x => x.model === 'audit-model');
      assert.equal(line.firstTokenMs, 5000);
      assert.equal(line.tokensPerSec, 50);
      assert.deepEqual([line.speedCount, line.firstCount], [1, 3]);
      assert.equal(data.lines.find(x => x.model === 'short-only').tokensPerSec, null);
      assert.equal(data.lines.find(x => x.model === 'short-only').firstTokenMs, 800);
      assert.equal(accountSpeed('claude', '', 7, now).models.find(x => x.model === 'audit-model').firstTokenMs, 5000);
    });
    await check('150000 records work in all-time and fixed ranges, including account chart', () => {
      fs.writeFileSync(file, (JSON.stringify(row({ tokensPerSec: 50, firstTokenMs: 800 })) + '\n').repeat(150000));
      for (const days of [0, 7]) {
        const data = speedSeries(days, now);
        assert.equal(data.total, 150000); assert.equal(data.lines[0].tokensPerSec, 50);
        const account = accountSpeed('claude', '', days, now);
        assert.equal(account.total, 150000); assert.equal(account.models[0].lastAt, now - 1000);
      }
    });
    await check('latest range wins even when an old range resolves or rejects last', async () => {
      for (const rejectOld of [false, true]) {
        const requests = [];
        const context = vm.createContext({ window: { PulseData: {} }, setTimeout: () => 0, api: { passSpeedSeries: days => new Promise((resolve, reject) => requests.push({ days, resolve, reject })) } });
        const source = fs.readFileSync(path.join(__dirname, '../renderer/usage-insights.js'), 'utf8').replace('window.PulseInsights = { render: draw };', 'window.PulseInsights = { render: draw }; window.audit = { speedView, loadSpeedLines };');
        vm.runInContext(source, context);
        const { speedView, loadSpeedLines } = context.window.audit;
        loadSpeedLines(); speedView.range = '7'; loadSpeedLines(true);
        assert.deepEqual(requests.map(x => x.days), [0, 7]);
        requests[1].resolve({ tag: 'SEVEN', lines: [] }); await new Promise(r => setImmediate(r));
        if (rejectOld) requests[0].reject(new Error('old range failed')); else requests[0].resolve({ tag: 'ALL', lines: [] });
        await new Promise(r => setImmediate(r));
        assert.equal(speedView.key, '7'); assert.equal(speedView.data.tag, 'SEVEN'); assert.equal(speedView.error, false);
      }
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
