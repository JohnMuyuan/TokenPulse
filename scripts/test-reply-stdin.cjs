/**
 * 「在 TokenPulse 里回复」把提示词写进 CLI 的 stdin：CLI 启动即退出（参数不认、没登录）或用户中途点「停止」时，
 * 往已经关掉的管道继续写会抛 EOF / EPIPE。stdin 上没挂 error 监听的话是主进程的未捕获异常（弹错误框）。
 * 跑法（先 npm run compile）：node scripts/test-reply-stdin.cjs
 *
 * 用 node 自己当「CLI」：DeepSeek 的回复参数（--profile headless …）它不认，立刻带着 bad option 退出，
 * 同时往它的 stdin 灌 16 MB 提示词。全程只有本机进程，不碰真实 CLI、不联网。
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.TOKENPULSE_DSH_CLI = process.execPath;
const reply = require(path.join(__dirname, '..', 'build', 'main', 'session-reply.js'));

let crash = null;
process.on('uncaughtException', (error) => { crash = error; });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const events = [];
  reply.startReply({ kind: 'deepseek', id: 'session-demo', cwd: os.tmpdir(), prompt: 'x'.repeat(16 * 1024 * 1024), mode: 'readonly' }, (event) => events.push(event));
  const deadline = Date.now() + 15_000;
  while (!events.some((event) => event.type === 'done') && Date.now() < deadline) await delay(50);
  await delay(500); // stdin 的错误是异步抛的，多等一会儿
  const done = events.find((event) => event.type === 'done');
  assert(done, 'CLI 退出后必须收到 done 事件');
  assert.equal(done.ok, false, 'CLI 启动即退出：回复失败');
  assert.equal(crash, null, '往已关闭的 stdin 写提示词不能变成未捕获异常：' + (crash && crash.message));
  console.log('PASS 回复进程提前退出时，写 stdin 的错误被吞掉，只报回复失败');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
