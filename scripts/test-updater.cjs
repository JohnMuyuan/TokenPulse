/**
 * 自动更新的端到端检查（用 Electron 跑：npm run test:update）。
 *
 * 真的静默安装会把 TokenPulse 装进用户电脑，所以这里：
 *   1. 起一个本地更新服务器，放一个假的 v99.0.0（latest.yml + 安装包，sha512 真实计算）；
 *   2. 让 updater.ts 真的走「检查 → 下载 → 校验」，看状态推送对不对；
 *   3. 窗口显示着时不装，窗口收起后才触发安装 —— 最后一步 quitAndInstall 替换成记录调用，不真的运行安装包；
 *   4. 再对真实的 GitHub 发布页检查一次：不崩、给出能看懂的提示；
 *   5. 「只有安装版能更新」的判断、托盘重启标记、错误文案。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-update-"));
process.env.TOKENPULSE_DATA_DIR = path.join(temp, "data");
app.setPath("userData", path.join(temp, "electron"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) return false;
    await pause(50);
  }
  return true;
};

app.whenReady().then(async () => {
  // Electron 的缓存文件退出前还被占着，临时目录删不干净不影响结果
  const exit = (code) => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} app.exit(code); };
  try {
    // ---- 本地更新服务器：一个假的 v99.0.0 ----
    const installer = crypto.randomBytes(256 * 1024);
    const sha512 = crypto.createHash("sha512").update(installer).digest("base64");
    const yml = `version: 99.0.0\nfiles:\n  - url: TokenPulse-99.0.0-Setup.exe\n    sha512: ${sha512}\n    size: ${installer.length}\npath: TokenPulse-99.0.0-Setup.exe\nsha512: ${sha512}\nreleaseDate: '2026-09-30T00:00:00.000Z'\n`;
    const server = http.createServer((req, res) => {
      const url = req.url.split("?")[0]; // electron-updater 会带防缓存参数
      if (url.endsWith("latest.yml")) { res.end(yml); return; }
      if (url.endsWith(".exe")) { res.setHeader("Content-Length", installer.length); res.end(installer); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const configFile = path.join(temp, "dev-app-update.yml");
    fs.writeFileSync(configFile, `provider: generic\nurl: http://127.0.0.1:${server.address().port}/\nupdaterCacheDirName: tokenpulse-updater-test\n`);

    const { autoUpdater } = require("electron-updater");
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = configFile;
    let installed = null;
    autoUpdater.quitAndInstall = (silent, runAfter) => { installed = { silent, runAfter }; };

    const updater = require("../build/main/updater.js");
    const win = new BrowserWindow({ show: true, width: 400, height: 300 });
    const pushed = [];
    win.webContents.on("ipc-message", () => undefined);
    const sendSpy = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, state) => { if (channel === "update-state") pushed.push(state.status); return sendSpy(channel, state); };
    updater.initUpdater({ window: () => win, autoUpdate: true, force: true });

    // ---- 检查 → 发现 → 下载 → 校验 ----
    await updater.checkForUpdates(true);
    const downloaded = await until(() => updater.updateState().status === "downloaded");
    const state = updater.updateState();
    check("发现新版本后自动在后台下载并校验完成", downloaded && state.version === "99.0.0" && state.progress === 100, JSON.stringify({ status: state.status, version: state.version }));
    check("状态依次推送给界面（检查 → 下载 → 已下载）", pushed.includes("checking") && pushed.includes("downloading") && pushed.at(-1) === "downloaded", pushed.join(" → "));

    // ---- 窗口显示着：不打断用户 ----
    await pause(500);
    check("窗口显示着时不安装", installed === null);

    // ---- 窗口收起：静默安装并重启 ----
    win.hide();
    updater.onWindowAway();
    const triggered = await until(() => installed !== null, 30_000);
    check("窗口收进托盘后静默安装并自动重启（NSIS /S）", triggered && installed.silent === true && installed.runAfter === true, JSON.stringify(installed));
    check("在托盘里被更新的，重启后也只进托盘", updater.consumeRelaunchHidden() === true);
    check("重启标记读过就删，下次正常启动不受影响", updater.consumeRelaunchHidden() === false);

    // ---- 关掉自动更新：发现了只提示，不下载 ----
    updater.setAutoUpdate(false);
    check("关闭自动更新后自动下载也关掉", autoUpdater.autoDownload === false && updater.updateState().autoUpdate === false);
    updater.setAutoUpdate(true);
    server.close();

    // ---- 真实 GitHub 发布页：配置能用，查不到时给能看懂的提示 ----
    const githubConfig = path.join(temp, "github-app-update.yml");
    fs.writeFileSync(githubConfig, "provider: github\nowner: JohnMuyuan\nrepo: TokenPulse\nupdaterCacheDirName: tokenpulse-updater-test\n");
    autoUpdater.updateConfigPath = githubConfig;
    autoUpdater.autoDownload = false;
    updater.updateState().status = "idle";
    const real = await updater.checkForUpdates(true);
    check("对真实 GitHub 发布页检查不会崩，结果或提示能看懂", ["latest", "available", "error", "idle", "downloading"].includes(real.status) && (real.status !== "error" || !/Error|at |yml/i.test(real.error)), JSON.stringify({ status: real.status, version: real.version, error: real.error }));

    // ---- 只有安装版能更新 ----
    const dir = path.join(temp, "app");
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, "TokenPulse.exe");
    fs.writeFileSync(exe, "");
    check("开发模式不检查更新", /开发模式/.test(updater.unsupportedReason({}, exe, false)));
    check("便携版不支持自动更新", /便携版/.test(updater.unsupportedReason({ PORTABLE_EXECUTABLE_FILE: "x.exe" }, exe, true)));
    check("免安装目录版（没有卸载程序）不支持", /免安装版/.test(updater.unsupportedReason({}, exe, true)));
    fs.writeFileSync(path.join(dir, "Uninstall TokenPulse.exe"), "");
    check("安装版（旁边有卸载程序）支持自动更新", updater.unsupportedReason({}, exe, true) === "");
    check("常见错误都换成能看懂的中文", /网络/.test(updater.friendlyError(new Error("net::ERR_INTERNET_DISCONNECTED"))) && /更新信息/.test(updater.friendlyError(new Error("Cannot find latest.yml in the latest release artifacts"))));

    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} 通过`);
    exit(passed === results.length ? 0 : 1);
  } catch (error) {
    console.error("FAIL", error);
    exit(1);
  }
});
