/*
 * Windows / Electron ASAR 句柄释放回归测试（v0.3.110）。
 *
 * 必须在真实 Electron 运行时下执行（带 Electron 默认 ASAR fs 补丁）：
 * 1. 验证 Electron 默认 `fs` 确实处于 ASAR 补丁状态，且本测试生成的临时 `.asar` 是合法二进制 ASAR 归档；
 * 2. 验证 Antigravity OAuth 提取（extractPersonalClientIdFromFile / extractAgyOAuthClientFromFile /
 *    resolveAntigravityOAuthClient / refreshAgyCredential）在正常、无匹配、损坏截断和缺失路径下都不会
 *    触发 Electron `cachedArchives` 句柄泄漏，执行结束后目标 `app.asar` 与 `language_server.exe` 可立即
 *    重命名、替换、删除，且在 Windows 上可被另一进程以 `FileShare.None` 独占打开；
 * 3. 验证模拟 Antigravity 2.34.0 → 2.35.0 覆盖更新恰好与刷新并发的场景（文件短暂缺失降级、写入新版后
 *    自动恢复、连续多轮并发读写与原子替换零冲突）；
 * 4. 验证 DeepSeek Harness `findCli("deepseek")` / `asarContainsFile()` 同样不锁定 `resources/app.asar`。
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const origFs = require('original-fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

function buildAsar(filePath, entries) {
  const chunks = [];
  let offset = 0;
  const rootFiles = {};

  for (const [relPath, text] of Object.entries(entries)) {
    const buf = Buffer.from(text, 'utf8');
    const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
    let cursor = rootFiles;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dirName = parts[i];
      if (!cursor[dirName]) cursor[dirName] = { files: {} };
      cursor = cursor[dirName].files;
    }
    cursor[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }

  const headerBuf = Buffer.from(JSON.stringify({ files: rootFiles }), 'utf8');
  const padLen = (4 - (headerBuf.length % 4)) % 4;
  const headerPicklePayload = 4 + headerBuf.length + padLen;
  const headerPickleSize = 4 + headerPicklePayload;
  const payloadBuf = Buffer.concat(chunks);
  const out = Buffer.alloc(8 + headerPickleSize + payloadBuf.length);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerPickleSize, 4);
  out.writeUInt32LE(headerPicklePayload, 8);
  out.writeUInt32LE(headerBuf.length, 12);
  headerBuf.copy(out, 16);
  payloadBuf.copy(out, 8 + headerPickleSize);
  origFs.writeFileSync(filePath, out);
}

/** Windows 跨进程独占打开检查（等同于安装器覆盖前检测 ERROR_SHARING_VIOLATION）。 */
function assertNotLockedExternally(filePath) {
  if (process.platform !== 'win32') return;
  const escaped = filePath.replace(/'/g, "''");
  const ps = `$f = [System.IO.File]::Open('${escaped}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); $f.Dispose(); Write-Output 'UNLOCKED'`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  }).trim();
  assert.equal(out, 'UNLOCKED', `外部进程必须能独占打开 ${filePath}`);
}

/** 验证目标文件可立即重命名、原地写入替换版本、再删除旧副本。 */
function assertCanRenameReplaceDelete(filePath, replacementEntries) {
  assertNotLockedExternally(filePath);
  const backup = `${filePath}.old.${Date.now()}`;
  origFs.renameSync(filePath, backup);
  assert.equal(origFs.existsSync(filePath), false, '重命名后原路径应已释放');
  buildAsar(filePath, replacementEntries);
  origFs.unlinkSync(backup);
  assert.equal(origFs.existsSync(backup), false, '旧版本 ASAR 必须可直接删除');
}

app.whenReady().then(async () => {
  const root = origFs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-asar-lock-'));
  const prevEnv = {
    TOKENPULSE_DATA_DIR: process.env.TOKENPULSE_DATA_DIR,
    TOKENPULSE_AGY_OAUTH_BINARY: process.env.TOKENPULSE_AGY_OAUTH_BINARY,
    TOKENPULSE_AGY_CLI: process.env.TOKENPULSE_AGY_CLI,
    TOKENPULSE_DSH_CLI: process.env.TOKENPULSE_DSH_CLI,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    PROGRAMFILES: process.env.PROGRAMFILES,
    USERPROFILE: process.env.USERPROFILE,
  };

  let checks = 0;
  const pass = (msg) => { checks += 1; console.log('PASS ' + msg); };

  try {
    assert.ok(process.versions.electron, '本回归测试必须在 Electron 运行时下执行');
    const dataDir = path.join(root, 'data');
    origFs.mkdirSync(dataDir, { recursive: true });
    process.env.TOKENPULSE_DATA_DIR = dataDir;
    process.env.LOCALAPPDATA = root;
    process.env.APPDATA = path.join(root, 'roaming');
    process.env.PROGRAMFILES = path.join(root, 'pf');
    process.env.USERPROFILE = path.join(root, 'home');
    delete process.env.TOKENPULSE_AGY_CLI;

    const agyMod = require('../build/core/antigravity-accounts');
    const rawFsMod = require('../build/core/raw-fs');
    const sessionReplyMod = require('../build/main/session-reply');

    // 1. 验证运行环境确实带有 Electron ASAR fs 补丁，且 getRawFs() 返回的是未打补丁的 original-fs
    assert.equal(rawFsMod.getRawFs(), origFs, 'Electron 环境下 getRawFs() 必须返回 original-fs');
    const probeAsar = path.join(root, 'probe-only.asar');
    buildAsar(probeAsar, { 'hello.txt': 'ok' });
    assert.equal(origFs.statSync(probeAsar).isFile(), true, 'original-fs 视合法 .asar 为普通文件');
    assert.equal(rawFsMod.asarContainsFile(probeAsar, 'hello.txt'), true);
    assertCanRenameReplaceDelete(probeAsar, { 'hello.txt': 'v2' });
    origFs.unlinkSync(probeAsar);
    pass('Electron original-fs bypasses ASAR archive cache on valid .asar');

    // 2. 正常路径：构造模拟 Antigravity 2.34.0 安装目录（合法二进制 app.asar + language_server.exe）
    const hostTail = ['apps', 'googleusercontent', 'com'].join('.');
    const secHead = 'GOC' + 'SPX-';
    const bizId = ['888888888888-bizdecoywithoutaicode00000', hostTail].join('.');
    const v234Id = ['111111111111-personalv234aicodescope0', hostTail].join('.');
    const v235Id = ['222222222222-personalv235aicodescope0', hostTail].join('.');
    const bizSec = secHead + 'biz_decoy_secret_'.padEnd(28, '1');
    const v234Sec = secHead + 'v234_personal_sec'.padEnd(28, '2');
    const v235Sec = secHead + 'v235_personal_sec'.padEnd(28, '3');

    const ideRes = path.join(root, 'Programs', 'antigravity', 'resources');
    origFs.mkdirSync(path.join(ideRes, 'bin'), { recursive: true });
    const agyAsar = path.join(ideRes, 'app.asar');
    const agyLs = path.join(ideRes, 'bin', 'language_server.exe');

    const writeFakeAgyInstall = (personalId, personalSec) => {
      buildAsar(agyAsar, {
        'out/main.js': `const SIGN_IN={biz:{clientId:"${bizId}",scopes:["openid"]},personal:{clientId:"${personalId}",scopes:["openid","https://www.googleapis.com/auth/aicode"]}};`,
      });
      origFs.writeFileSync(agyLs, `go_rodata_${bizSec}_${personalSec}_ids_${bizId}_${personalId}_end`);
    };

    writeFakeAgyInstall(v234Id, v234Sec);
    process.env.TOKENPULSE_AGY_OAUTH_BINARY = agyLs;
    agyMod.clearCachedAgyOAuthClient();

    const extractedId = agyMod.extractPersonalClientIdFromFile(agyAsar);
    assert.equal(extractedId, v234Id, 'Electron 下也能从真实二进制 app.asar 正常提取 auth/aicode clientId');
    const resolved = agyMod.resolveAntigravityOAuthClient();
    assert.ok(resolved);
    assert.equal(resolved.clientId, v234Id);
    assert.equal(resolved.clientSecret, v234Sec);

    const refreshOk = await agyMod.refreshAgyCredential(
      { token: 'old', refreshToken: 'rt_v234', expiresAt: 0 },
      Date.now(),
      {
        postForm: async (_url, body) => {
          const p = new URLSearchParams(body);
          assert.equal(p.get('client_id'), v234Id);
          assert.equal(p.get('client_secret'), v234Sec);
          return { status: 200, json: { access_token: 'tok_v234', expires_in: 3600 } };
        },
      },
    );
    assert.equal(refreshOk.ok, true);

    // 关键断言：Electron 进程仍然存活时，app.asar 和 language_server.exe 均零锁定，可立即重命名/替换/删除
    assertCanRenameReplaceDelete(agyAsar, {
      'out/main.js': `const SIGN_IN={personal:{clientId:"${v234Id}",scopes:["https://www.googleapis.com/auth/aicode"]}};`,
    });
    assertNotLockedExternally(agyLs);
    pass('Antigravity OAuth extraction & refresh leave app.asar and language_server.exe unlocked for rename/replace/delete');

    // 3. 失败/异常路径：无匹配 ASAR、损坏/截断 ASAR、空文件与缺失文件
    const noMatchAsar = path.join(root, 'no-match.asar');
    buildAsar(noMatchAsar, { 'index.js': 'console.log("no oauth ids here");' });
    assert.equal(agyMod.extractPersonalClientIdFromFile(noMatchAsar), '');
    assert.equal(agyMod.extractAgyOAuthClientFromFile(noMatchAsar), null);
    assertCanRenameReplaceDelete(noMatchAsar, { 'index.js': 'replaced' });
    origFs.unlinkSync(noMatchAsar);

    const brokenAsar = path.join(root, 'broken.asar');
    origFs.writeFileSync(brokenAsar, Buffer.from([0x04, 0x00, 0x00, 0x00, 0xff]));
    assert.equal(agyMod.extractPersonalClientIdFromFile(brokenAsar), '');
    assert.equal(agyMod.extractAgyOAuthClientFromFile(brokenAsar), null);
    assert.equal(rawFsMod.asarContainsFile(brokenAsar, 'index.js'), false);
    assertNotLockedExternally(brokenAsar);
    origFs.unlinkSync(brokenAsar);

    const missingAsar = path.join(root, 'missing.asar');
    assert.equal(agyMod.extractPersonalClientIdFromFile(missingAsar), '');
    assert.equal(agyMod.extractAgyOAuthClientFromFile(missingAsar), null);
    pass('no-match, corrupt, and missing ASAR paths fail gracefully and release handles');

    // 4. 更新与刷新并发场景：模拟 2.34.0 卸载旧文件（短暂缺失）→ 刷新优雅降级 → 安装 2.35.0 → 下次刷新恢复并读取新版
    agyMod.clearCachedAgyOAuthClient();
    origFs.unlinkSync(agyAsar);
    origFs.unlinkSync(agyLs);
    const duringUpdate = await agyMod.refreshAgyCredential(
      { token: 'old', refreshToken: 'rt_mid', expiresAt: 0 },
      Date.now(),
      { postForm: async () => { throw new Error('should not post when client unavailable'); } },
    );
    assert.equal(duringUpdate.ok, false);
    assert.equal(duringUpdate.permanent, false, '更新期间目标文件短暂缺失应降级为临时失败而非永久失效');

    // 安装 2.35.0 新版文件后立即恢复，并连续 15 轮交替读取 + 原子替换验证无竞态锁定
    writeFakeAgyInstall(v235Id, v235Sec);
    for (let i = 0; i < 15; i += 1) {
      agyMod.clearCachedAgyOAuthClient();
      const refreshed = await agyMod.refreshAgyCredential(
        { token: 'old', refreshToken: 'rt_v235', expiresAt: 0 },
        Date.now(),
        {
          postForm: async (_url, body) => {
            const p = new URLSearchParams(body);
            assert.equal(p.get('client_id'), v235Id);
            assert.equal(p.get('client_secret'), v235Sec);
            return { status: 200, json: { access_token: `tok_v235_${i}`, expires_in: 3600 } };
          },
        },
      );
      assert.equal(refreshed.ok, true);
      const tmpSwap = `${agyAsar}.swap.${i}`;
      origFs.renameSync(agyAsar, tmpSwap);
      buildAsar(agyAsar, {
        'out/main.js': `const SIGN_IN={biz:{clientId:"${bizId}",scopes:["openid"]},personal:{clientId:"${v235Id}",scopes:["openid","https://www.googleapis.com/auth/aicode"]}};`,
      });
      origFs.unlinkSync(tmpSwap);
    }
    assertNotLockedExternally(agyAsar);
    pass('concurrent Antigravity 2.34.0 -> 2.35.0 upgrade degrades cleanly during absence and recovers immediately');

    // 5. DeepSeek Harness findCli("deepseek") 同样不锁定 resources/app.asar
    const fakeLocalAppData = path.join(root, 'fake-local');
    const dshRoot = path.join(fakeLocalAppData, 'Programs', 'DeepSeek Harness');
    origFs.mkdirSync(path.join(dshRoot, 'resources'), { recursive: true });
    origFs.writeFileSync(path.join(dshRoot, 'DeepSeek Harness.exe'), 'MZ');
    const dshAsar = path.join(dshRoot, 'resources', 'app.asar');
    buildAsar(dshAsar, {
      'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js': 'module.exports = {};',
    });
    delete process.env.TOKENPULSE_DSH_CLI;
    process.env.LOCALAPPDATA = fakeLocalAppData;

    const dshCli = sessionReplyMod.resolveCli('deepseek');
    assert.ok(dshCli, '应通过 raw-fs 正常识别 DeepSeek Harness app.asar 内的 cli.js');
    assert.equal(dshCli.file, path.join(dshRoot, 'DeepSeek Harness.exe'));
    assertCanRenameReplaceDelete(dshAsar, {
      'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js': 'module.exports = { v: 2 };',
    });
    pass('DeepSeek Harness resolveCli does not lock resources/app.asar');

    console.log(`\n${checks}/5 Electron ASAR handle release checks passed`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { origFs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    app.quit();
  }
});
