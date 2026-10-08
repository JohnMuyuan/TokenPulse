/*
 * 测试用的「tokens.ci 工具」：只模拟 TokenPulse 会用到的几个命令，不联网、不开浏览器。
 * 用 TOKENPULSE_TOKENS_CLI 指向这个文件（见 src/core/tokens-ci.ts 的 commandLine）。
 * - version：打印一个版本号
 * - login [--private]：打印授权网址和一次性码，等 FAKE_TOKENS_LOGIN_MS 毫秒后写凭据文件；隐私模式再打印一个只读令牌
 * - submit [--dry-run]：没登录就像真的一样报「Not logged in.」；有 fail 标记文件就报服务器错误；否则记一笔
 * 凭据和记录都写在 TOKENS_CONFIG_DIR 里。
 */
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.TOKENS_CONFIG_DIR;
if (!dir) { console.error('TOKENS_CONFIG_DIR is required'); process.exit(9); }
fs.mkdirSync(dir, { recursive: true });
const credentials = path.join(dir, 'credentials.json');
const [command, ...rest] = process.argv.slice(2);
const log = (line) => fs.appendFileSync(path.join(dir, 'calls.log'), line + '\n');
log([command, ...rest].join(' '));

if (command === 'version') { console.log('27.1.3'); process.exit(0); }
if (command === 'login') {
  console.log('\n  \x1b[36mTokens - Login\x1b[0m\n');
  console.log('  Opening browser: \x1b]8;;https://tokens.ci/device\x07https://tokens.ci/device\x1b]8;;\x07');
  console.log('  Enter this code:');
  console.log('  \x1b[1;32mWXYZ-2468\x1b[0m\n');
  setTimeout(() => {
    fs.writeFileSync(credentials, JSON.stringify({ token: 'tk_fake_submit_token_123456', username: 'tester' }));
    console.log('  \x1b[32mLogged in as tester\x1b[0m');
    if (rest.includes('--private')) console.log('  Read token: tkr_fakeReadToken_abcdef123456');
    process.exit(0);
  }, Number(process.env.FAKE_TOKENS_LOGIN_MS) || 300);
  setInterval(() => {}, 1000);
} else if (command === 'submit') {
  if (!fs.existsSync(credentials)) { console.error('\n  \x1b[33mNot logged in.\x1b[0m'); console.error("  Run 'tokens login' or set TOKENS_API_TOKEN.\n"); process.exit(1); }
  console.log('\n  Tokens - Submit Usage Data\n');
  console.log('  Scanning local session data...');
  if (rest.includes('--dry-run')) {
    console.log('  2026-10-07  claude   claude-opus-5-5   1,234,567 tokens');
    console.log('  2026-10-08  codex    gpt-5.5             456,789 tokens');
    console.log('  Dry run: nothing was submitted.');
    process.exit(0);
  }
  if (fs.existsSync(path.join(dir, 'fail'))) { console.error('  Server error: 500 Internal Server Error'); process.exit(2); }
  if (fs.existsSync(path.join(dir, 'revoked'))) { console.error('  Error: 401 Unauthorized (token revoked)'); process.exit(1); }
  log('SUBMITTED');
  console.log('  \x1b[32mSubmitted 2 days of usage (1.69M tokens).\x1b[0m');
  process.exit(0);
} else {
  console.error('unknown command ' + command);
  process.exit(3);
}
