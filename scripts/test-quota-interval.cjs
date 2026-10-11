/*
 * 额度查询间隔：官方订阅、DeepSeek、第三方 Key 共用 prefs 里的秒数。
 * 空值是 1 分钟；不是整分钟的收到最近的整分钟，再限制在 1 到 10 分钟。保存进文件后再读回来仍是收过界的数。
 * DeepSeekBalance.reschedule 用同一组边界，并且不在改间隔时立刻打接口。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-quota-every-'));
process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const { readPrefs, writePrefs, quotaEverySeconds } = require(path.join(__dirname, '..', 'build', 'main', 'prefs.js'));
const { DeepSeekBalance } = require(path.join(__dirname, '..', 'build', 'main', 'deepseek-balance.js'));

let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };

assert.equal(quotaEverySeconds(undefined), 60);
assert.equal(quotaEverySeconds(null), 60);
assert.equal(quotaEverySeconds(''), 60);
assert.equal(quotaEverySeconds('nope'), 60);
assert.equal(quotaEverySeconds(60), 60);
assert.equal(quotaEverySeconds(45.4), 60);
assert.equal(quotaEverySeconds(90), 120);
assert.equal(quotaEverySeconds(1), 60);
assert.equal(quotaEverySeconds(0), 60);
assert.equal(quotaEverySeconds(601), 600);
assert.equal(quotaEverySeconds(10 * 60), 600);
pass('bounds: default 1 minute, whole minutes from 1 to 10');

assert.equal(readPrefs().quotaEverySeconds, 60);
assert.equal(writePrefs({ quotaEverySeconds: 1 }).quotaEverySeconds, 60);
assert.equal(readPrefs().quotaEverySeconds, 60);
assert.equal(writePrefs({ notifyAt: 80 }).quotaEverySeconds, 60);
assert.equal(writePrefs({ quotaEverySeconds: 9999 }).quotaEverySeconds, 600);
assert.equal(readPrefs().quotaEverySeconds, 600);
assert.equal(writePrefs({ quotaEverySeconds: 180 }).quotaEverySeconds, 180);
pass('prefs.json keeps the clamped interval across unrelated saves');

const timers = [];
const originalSet = global.setInterval;
const originalClear = global.clearInterval;
global.setInterval = (fn, ms) => { const id = { fn, ms, unref() {} }; timers.push(id); return id; };
global.clearInterval = id => { const at = timers.indexOf(id); if (at >= 0) timers.splice(at, 1); };
try {
  let calls = 0;
  const service = new DeepSeekBalance({ fetcher: async () => { calls++; return { status: 200, body: '{}' }; }, now: () => 1 });
  service.start();
  assert.equal(timers.length, 0);
  assert.equal(service.state().everySeconds, 60);
  service.reschedule(45_000);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  assert.equal(service.state().everySeconds, 60);
  assert.equal(calls, 0, 'changing the interval does not query');
  service.reschedule(1000);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  service.reschedule(3 * 60_000);
  assert.equal(timers[0].ms, 180_000);
  assert.equal(service.state().everySeconds, 180);
  service.reschedule(11 * 60_000);
  assert.equal(timers[0].ms, 600_000);
  assert.equal(service.state().everySeconds, 600);
  service.stop();
  assert.equal(timers.length, 0);
  pass('api balance timer follows the same 1–10 minute interval and does not query on save');
} finally {
  global.setInterval = originalSet;
  global.clearInterval = originalClear;
}

console.log(checks + ' checks');
