// 必须第一个：之后注册的 IPC 都要被日志包上（见 app-log-setup.ts）
import { logAppStart } from "./app-log-setup";
import { ExitMonitor } from "./egress-monitor";
import { prepareAntigravityCliConversation } from '../core/antigravity';
import { DOMAINS } from "../core/egress";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, powerMonitor, session, shell, Tray } from "electron";
import { countRouteLog, passSpeed, readRouteLog, routeLogDir } from "../core/route-ledger";
import { accountSpeed, speedSeries } from "../core/pass-speed";
import { copyShareCard, renderShareCard, saveShareCard, shareMilestones, shareMonth, shareWeek } from "./share";
import { maybeWeeklySummary } from "../core/weekly-summary";
import { destroyTrayPanel, hideTrayPanel, pushTrayPanel, resizeTrayPanel, setupTrayPanel, toggleTrayPanel, trayPanelData, type TrayPanelAgent } from "./tray-panel";
import { deskPetAskAction, deskPetAskData, deskPetBubbleAction, deskPetBubbleData, deskPetClick, deskPetDrag, deskPetHit, deskPetMenu, deskPetReady, deskPetSnapshotChanged, deskPetView, deskPetWindows, destroyDeskPet, resetDeskPetPosition, resizeDeskPetAsk, resizeDeskPetBubble, setupDeskPet, syncDeskPet } from "./desk-pet";
import { importPetSound, listPetSounds, petSoundData, removePetSound } from "../core/pet-sound-file";
import { accountKey, normalizeDeskPet } from "../core/desk-pet-model";
import { importPetPack, listPetPacks, petPackImages, removePetPack } from "../core/pet-pack";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import { dataDir } from "../core/paths";
import { appLogFile, errorText, log } from "../core/app-log";
import { fetchOfficialQuota, quotaIssueNotice, quotaIssueTone, quotaRefreshSummary, type QuotaGlance } from "../core/quota";
import type { Snapshot } from "../core/report";
import { updateCalibration } from "../core/quota-calibration";
import { updateMark } from "../core/quota-offmachine";
import { parseModelStudyQuery } from "../core/model-study";
import { modelCandidates, parseStudyModels } from "../core/model-catalog";
import { FAMILY as STUDY_FAMILY } from "../core/quota-offmachine";
import { loadDeepSeek, loadModelStudy, loadPool, loadRequests, loadSessionDetail, loadSessions, loadSnapshot, searchSessionText } from "./snapshot";
import { sessionCommand, type AgentKind } from "../core/sessions";
import { cleanAgentEnv, deleteSession as deleteAgentSession, guardMode, openTerminal, resolveCli } from "./session-reply";
import { checkKnowledge, knowledgeState, scheduleKnowledgeChecks } from "./knowledge-update";
import type { RequestQuery } from "../core/request-log";
import { prefsExist, quotaEverySeconds, readPrefs, writePrefs, type Prefs } from "./prefs";
import { PRESSURE_DEFAULTS, isPressureLevel } from "../core/quota-pressure";
import { demoCall, endDemo } from "./demo";
import { envProxyFor, setSystemProxyResolver } from "../core/upstream-proxy";
import { tr } from "./i18n";
import { trayIcon, windowIcon } from "./icon";
import { checkForUpdates, consumeRelaunchHidden, downloadUpdate, initUpdater, installUpdate, onWindowAway, setAutoUpdate, updateState } from "./updater";
import { listOfficialOAuthStatus, addCliAccounts, loginOfficialOAuth, manageOfficialAccount, reorderOfficialAccountsOf, switchCliLogin } from "./oauth";
import { migrateLegacyGrokAccounts } from "../core/grok-migrate";
import { OFFICIAL_KINDS, type OfficialAccountKind } from "../core/credentials";
import { checkPrismProxy, fixPrismProxy, installPrism, loginPrism, onPrismChange, prismDiskUsage, prismEndpoint, prismHome, prismLogFile, prismState, releasePrism, removePrism, resumePrism, setPrismAutoStart, startPrism, stopPrism, prismModels, PRISM_ORIGIN, PRISM_PROVIDER_NAME } from "../core/prism-bridge";
import { autoSwitchCli, autoSwitchStale, describeAutoSwitch, normalizeRule, type AutoSwitchDeps, type AutoSwitchEvent } from "../core/cli-auto-switch";
import { foregroundAccounts, quietPick } from "../core/quota-quiet";
import { readQuotaChecks } from "../core/quota-history";
import { switchCliAccount } from "../core/cli-switch";
import { runHealthCheck } from "./health";
import { formatRemainingDuration, isAccountExpiringSoon } from "../core/health-check";
import { activateProvider, agentDrift, agentView as coreAgentView, usesOfficialLogin, poolAccountIds, deleteProvider, poolDef, importCcProviders, importCurrent, listPoolModels, listProviderModels, probeProvider, releaseAgentSwitch, restoreConfigBackup, waitAgentProxyClosed, reorderProviders, resumeAgentProxy, saveProvider, setAppPass, setAppProxy, setFailover, setProxyPort } from "../core/agent-switch";
import { configExpect, configPreview, configReason, configureReadOnly } from "../core/agent-config";
import { changeSignature, fileDiff, listHistory, listOriginals, type FileChange } from "../core/agent-history";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { TokensUploader } from "./tokens-ci";
import { DeepSeekBalance } from "./deepseek-balance";
import { setDeepSeekMark } from "../core/deepseek-insight";
import { AntigravityQuota, agyQuotaAccounts, type AgyQuotaState } from "./antigravity-quota";
import { addLocalAgyAccount, listAgyAccountStatus, loginAntigravityOAuth, manageAgyAccount, reorderAgyAccounts, resolveAgyLocalOwner } from "../core/antigravity-accounts";
import { readAgyKeyringEmailAsync, switchAntigravityAccount } from "../core/antigravity-switch";
import { antigravityHub } from "../core/antigravity";
import { AGENT_APPS, AGENT_LABEL, isAgentApp } from "../core/agent-types";


/**
 * TokenPulse 的主进程。
 *
 * 它是个**常驻后台的托盘程序**：窗口关掉照样在跑，因为这个工具的全部意义
 * 就是「电脑开着的时候一直记」。真要退出得从托盘菜单走。
 *
 * 两个定时器，节奏不一样：
 * - 扫本机会话文件：1 分钟一次。纯本地读文件，增量扫（只读新增的字节），很便宜。
 * - 问额度：官方订阅、DeepSeek 余额、第三方 Key 余额共用 prefs 里的间隔，默认 1 分钟。
 */

const SCAN_EVERY_MS = 60_000;
/** 窗口收进托盘或最小化时，用量扫描放慢到这个间隔（0.3.21）。额度查询仍按设置里的间隔，不放慢。 */
const AWAY_SCAN_EVERY_MS = 3 * 60_000;

let win: BrowserWindow | null = null;
/** 上次是在托盘里被自动更新重启的：这次启动也只进托盘，别弹窗口打扰用户。 */
let relaunchHidden = false;
let tray: Tray | null = null;
let quitting = false;
const exitMonitor = new ExitMonitor({
  publish: snapshot => { if (win && !win.isDestroyed()) win.webContents.send("egress-state", snapshot); },
  notify: event => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: tr("出口监控") + " · " + DOMAINS[event.provider].name, body: tr(event.message) + (event.ip ? " · " + event.ip : "") + (event.region ? " · " + event.region : ""), icon: windowIcon() });
    notification.on("click", () => { revealWindow(); win?.webContents.send("open-page", { page: "egress" }); });
    notification.show();
  },
});
/** DeepSeek 余额监控（0.3.42）：用户自己填的 API Key，只用来查余额，见 deepseek-balance.ts。 */
const deepseekBalance = new DeepSeekBalance({
  publish: state => { if (win && !win.isDestroyed()) win.webContents.send("deepseek-balance-state", state); },
  notify: (info, below, label, kind) => {
    if (!Notification.isSupported()) return;
    const sign = info.currency === "CNY" ? "¥" : info.currency === "USD" ? "$" : info.currency + " ";
    const note = new Notification({ title: tr(kind === "relay" ? "第三方 Key 余额不多了" : "DeepSeek 余额不多了") + (label ? " · " + label : ""), body: `${tr("当前余额")} ${sign}${info.total.toFixed(2)} · ${tr("提醒线")} ${sign}${below.toFixed(2)}`, icon: windowIcon() });
    note.on("click", () => { revealWindow(); win?.webContents.send("open-page", { page: "quota" }); }); note.show();
  },
});
let agyStateCache: AgyQuotaState | null = null;
/** Google Antigravity 的多账号与本机额度监控，见 antigravity-quota.ts。提醒线和官方订阅共用。 */
const antigravityQuota = new AntigravityQuota({
  publish: state => {
    agyStateCache = state;
    if (win && !win.isDestroyed()) win.webContents.send("antigravity-quota-state", state);
    if (lastSnapshot) updateTrayTip(lastSnapshot);
    pushTrayPanel();
    deskPetSnapshotChanged();
    if (win && !win.isDestroyed()) win.webContents.send("desk-pet-changed");
  },
  notifyAt: () => readPrefs().notifyAt,
  notify: (models, used, resetAt, accountLabel) => {
    if (!Notification.isSupported()) return;
    const prefix = accountLabel ? `Antigravity (${accountLabel})` : "Antigravity";
    const hasGemini = models.some((m) => /gemini|orchestrator/i.test(m));
    const has3p = models.some((m) => /claude|gpt/i.test(m));
    const poolLabel = hasGemini && !has3p
      ? "Gemini"
      : has3p && !hasGemini
        ? (models.some((m) => /claude/i.test(m)) && models.some((m) => /gpt/i.test(m)) ? "Claude / GPT" : models.some((m) => /claude/i.test(m)) ? "Claude" : "GPT")
        : models.length > 2 ? `${models.slice(0, 2).join("、")} 等` : models.join("、");
    const note = new Notification({ title: `${prefix} · ${poolLabel} ${tr("额度已用")} ${Math.round(used)}%`, body: resetAt ? `${new Date(resetAt).toLocaleString()} ${tr("重置")}` : tr("注意节奏"), icon: windowIcon() });
    note.on("click", () => { revealWindow(); win?.webContents.send("open-page", { page: "quota" }); }); note.show();
  },
});
function currentAgyState(): AgyQuotaState {
  if (!agyStateCache) agyStateCache = antigravityQuota.state();
  return agyStateCache;
}
function currentAgyLocalAccountId(): string {
  const state = currentAgyState();
  return state.accounts.find((acc) => acc.inLocal)?.id || resolveAgyLocalOwner(Date.now()) || state.accounts[0]?.id || "antigravity";
}
/** tokens.ci 自动上传（0.3.38）：由 TokenPulse 自己计时，见 tokens-ci.ts。 */
const tokensUploader = new TokensUploader({ publish: state => { if (win && !win.isDestroyed()) win.webContents.send("tokens-ci-state", state); } });
/** 「账号:窗口」→ 已经提醒过的那个窗口的重置时间。同一个窗口只提醒一次。 */
const notified = new Map<string, number>();
/** 两次重置时间差不到这么多，就当是同一个窗口（接口返回的时间有抖动，见 maybeNotify）。 */
const SAME_WINDOW_MS = 30 * 60_000;

const BACKGROUND = { light: "#f7f8fa", dark: "#15181c" } as const;

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const next = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // 跟界面主题一致，否则拉大窗口、首帧没画完时会闪一下反色的底。
    backgroundColor: BACKGROUND[readPrefs().theme],
    /*
     * 自己画标题栏（renderer 的 #titlebar）：系统那条跟着 Windows 的主题色走，
     * 软件切到夜间时顶上还是一条白的，关闭按钮那一行和界面对不上。
     */
    frame: false,
    title: "TokenPulse",
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 界面里没有需要拼写检查的输入；关掉就不加载词典
      spellcheck: false,
    },
  });
  win = next;
  // Windows 有时会忽略 BrowserWindow options 里的 PNG 图标，显式设置 ICO 可避免任务栏回退到 Electron 图标。
  if (process.platform === "win32") next.setIcon(windowIcon());
  next.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
  next.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden") && !readPrefs().startMinimized && !relaunchHidden) next.show();
  });
  // 外链走系统浏览器，别在应用里开一个没有地址栏的窗口。
  next.webContents.setWindowOpenHandler(({ url }) => {
    // 只放行网页链接：别让页面里的内容拿 file: / 自定义协议去启动本机程序
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  next.on("close", (event) => {
    if (quitting || !readPrefs().closeToTray) return;
    event.preventDefault();
    next.hide();
  });
  next.on("closed", () => {
    if (win === next) win = null;
    // 「关窗口就退出」：桌宠窗口还开着的话，window-all-closed 不会来，软件就退不掉
    if (!quitting && !readPrefs().closeToTray) destroyDeskPet();
  });
  // 用户不在看窗口了：下载好的更新趁这个时候静默装上（见 updater.ts）。
  next.on("hide", onWindowAway);
  next.on("minimize", onWindowAway);
  // 0.3.21：没人看窗口的时候少干活（见 setWindowAway）
  next.on("hide", () => setWindowAway(true));
  next.on("minimize", () => setWindowAway(true));
  next.on("show", () => setWindowAway(false));
  next.on("restore", () => setWindowAway(false));
  const sendState = () => next.webContents.send("window-state", { maximized: next.isMaximized() });
  next.on("maximize", sendState);
  next.on("unmaximize", sendState);
  return next;
}

function revealWindow() {
  if (!win) {
    // 窗口已经被销毁过（关窗口即退出关掉了、或者 macOS 上全关了）：重新建一个。
    const next = createWindow();
    next.once("ready-to-show", () => next.show());
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------------- 托盘 ---------------- */

function buildTrayMenu() {
  const prefs = readPrefs();
  return Menu.buildFromTemplate([
    { label: tr("打开 TokenPulse"), click: revealWindow },
    { type: "separator" },
    ...agentTrayItems(),
    { type: "separator" },
    {
      label: tr("立即刷新"),
      click: () => {
        backgroundRefresh(true);
      },
    },
    {
      label: tr("开机自启"),
      type: "checkbox",
      checked: prefs.autoLaunch,
      click: (item) => applyPrefs({ autoLaunch: item.checked }),
    },
    { label: tr("打开数据目录"), click: () => shell.openPath(dataDir()) },
    { type: "separator" },
    {
      label: tr("退出"),
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function agentTrayItems() {
  try {
    const view = agentView();
    return AGENT_APPS.map((app) => {
      const rows = view.providers.filter((item) => item.app === app && !item.locked);
      const current = rows.find((item) => item.active);
      return {
        label: (current ? `${AGENT_LABEL[app]} · ${current.name}` : AGENT_LABEL[app]) + (view.readOnly ? tr("（只读保护）") : ""),
        submenu: rows.length
          ? rows.map((item) => ({
              label: item.active ? `${item.name}  ✓` : item.name,
              enabled: !view.readOnly || item.active,
              // 切换会改工具配置：打开窗口，在供应商页里看过改动对比、确认后才写（只读保护开着时不能切）
              click: () => {
                revealWindow();
                win?.webContents.send("agent-activate-request", item.id);
              },
            }))
          : [{ label: tr("还没有供应商"), enabled: false }],
      };
    });
  } catch {
    return [];
  }
}

function publishAgent() {
  setTrayMenu();
  pushTrayPanel();
  if (win && !win.isDestroyed()) win.webContents.send("agent-switch", agentView());
}

/**
 * Electron 内核（自动更新、知识库更新用的 net）只认系统代理，不认 HTTPS_PROXY 这类环境变量。
 * 系统代理没开、环境变量里有 HTTP 代理（不带用户名密码）时，把它设成这个会话的代理；系统代理开着就不动，照系统的走。
 */
async function alignElectronProxy() {
  const probe = new URL("https://github.com/");
  const proxy = envProxyFor(probe);
  if (!proxy || proxy.auth) return;
  const system = await session.defaultSession.resolveProxy(probe.href);
  if (!/^\s*DIRECT\s*$/i.test(system)) return;
  const bypass = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((item) => item.trim()).filter((item) => item && item !== "*");
  await session.defaultSession.setProxy({ proxyRules: `http=${proxy.host}:${proxy.port};https=${proxy.host}:${proxy.port}`, proxyBypassRules: ["<local>", ...bypass].join(",") });
}

/** 界面上的供应商状态：多带一个「只读保护」开关。 */
function agentView() {
  return { ...coreAgentView(), readOnly: readPrefs().agentReadOnly === true };
}

async function agentCall<T>(work: () => T | Promise<T>, reason = "") {
  configReason(reason);
  try {
    const result = await work();
    publishAgent();
    return { ok: true as const, result, state: agentView() };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "操作失败" };
  } finally {
    configReason("");
  }
}

/*
 * 会改工具配置的操作先「预览」：同样的操作跑一遍，只收集改动、不写文件（agent-config.ts 的 configPreview）。
 * - 只改 TokenPulse 自己的供应商列表 → 直接做；
 * - 要改 Claude / Codex / Grok 的配置文件 → 把逐行对比（密钥打码）交给界面，用户确认后按 token 执行；
 *   执行时核对改动和确认时一模一样，中间文件被别的程序改过就不写。
 */
const confirms = new Map<string, { work: () => unknown; reason: string; signature: string; at: number }>();
async function agentWrite(reason: string, work: () => unknown, restoring = false) {
  let changes: FileChange[];
  configReason(reason);
  try { changes = await configPreview(work); }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "操作失败" }; }
  finally { configReason(""); }
  if (!changes.length) return agentCall(work, reason);
  // 只读保护只拦「接管」：关闭路由、还原备份这类把配置放回去的操作照常（仍要确认）
  if (readPrefs().agentReadOnly && !restoring) return { ok: false as const, error: "只读保护已开启：这个操作要改动工具的配置文件，已拦下。需要切换时，先在供应商页关闭只读保护。" };
  for (const [key, item] of confirms) if (Date.now() - item.at > 10 * 60000) confirms.delete(key);
  const token = randomUUID();
  confirms.set(token, { work, reason, signature: changeSignature(changes), at: Date.now() });
  return { ok: false as const, confirm: { token, reason, files: changes.map(fileDiff) } };
}
async function agentConfirm(token: unknown) {
  const item = typeof token === "string" ? confirms.get(token) : undefined;
  if (!item) return { ok: false as const, error: "这次确认已经过期，请重新操作" };
  confirms.delete(token as string);
  configExpect(item.signature);
  try { return await agentCall(item.work, item.reason); } finally { configExpect(null); }
}

/*
 * 配置被改走的提醒（0.3.10）：每 5 秒看一眼 TokenPulse 切换过的工具，配置不再指向设好的供应商 / 本地路由时提醒一次。
 * 同一次改动只提醒一次（按配置内容的指纹）；恢复正常后清掉记录，下次再被改走会再提醒。
 * 窗口开着：界面右上角弹窗（带「切回」按钮）；窗口在托盘里：系统通知，点开进供应商页。
 */
const driftSeen = new Map<string, string>();
function checkDrift() {
  let drifts: ReturnType<typeof agentDrift>;
  try { drifts = agentDrift(); } catch { return; }
  for (const app of [...driftSeen.keys()]) if (!drifts.some((d) => d.app === app)) driftSeen.delete(app);
  const fresh = drifts.filter((d) => driftSeen.get(d.app) !== d.key);
  if (!fresh.length) return;
  for (const d of fresh) driftSeen.set(d.app, d.key);
  win?.webContents.send("agent-drift", fresh);
  const away = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();
  if (away && Notification.isSupported()) for (const d of fresh) {
    const note = new Notification({ title: `${AGENT_LABEL[d.app]} · ${tr("没在用 TokenPulse 设好的供应商")}`, body: `${tr("现在连的是")}「${d.liveName}」${tr("，不是")}「${d.expectedName}」${tr("。点这里打开 TokenPulse 切回。")}`, icon: windowIcon() });
    note.on("click", () => { revealWindow(); win?.webContents.send("open-page", { page: "providers" }); win?.webContents.send("agent-drift", [d]); });
    note.show();
  }
}

/** 配置备份列表：历史每一次修改（前后对比），和接管前的原件（和现在的文件对比）。都打码。 */
function agentBackups() {
  const read = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  return {
    readOnly: readPrefs().agentReadOnly === true,
    entries: listHistory().map((entry) => ({ id: entry.id, at: entry.at, reason: entry.reason, files: entry.files.map(fileDiff) })),
    originals: listOriginals().map((item) => ({ id: item.id, at: item.at, ...fileDiff({ file: item.file, before: read(item.file), after: item.content }) })),
  };
}

function initTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("TokenPulse — Your AI usage, at a glance.");
  setTrayMenu();
  tray.on("click", revealWindow);
  tray.on("double-click", revealWindow);
  // 右键：额度小面板（见 tray-panel.ts）。用面板的平台不再有托盘菜单：切换供应商、刷新、退出都在面板里
  if (TRAY_PANEL) {
    setupTrayPanel({
      tray: () => tray,
      data: trayPanelView,
      background: () => BACKGROUND[readPrefs().theme],
      preload: path.join(__dirname, "preload.js"),
    });
    tray.on("right-click", toggleTrayPanel);
  }
}
/*
 * Windows 上给托盘设了菜单，右键就只弹菜单、收不到 right-click 事件，所以用面板的平台不设菜单
 * （用户决定旧菜单整个不要了：开机自启、打开数据目录在主窗口的设置里）。别的平台保持原来的右键菜单。
 */
const TRAY_PANEL = process.platform === "win32";
/** 面板要的全部数据：额度 + 各工具现在用的供应商。 */
function trayPanelView() {
  let agents: TrayPanelAgent[] = [];
  try {
    const view = agentView();
    agents = AGENT_APPS.map((app) => {
      const rows = view.providers.filter((item) => item.app === app && !item.locked);
      return { app, label: AGENT_LABEL[app], current: rows.find((item) => item.active)?.name ?? "", readOnly: view.readOnly, providers: rows.map((item) => ({ id: item.id, name: item.name, active: !!item.active })) };
    }).filter((item) => item.providers.length > 0);
  } catch { /* 供应商读不出来：面板只显示额度 */ }
  return trayPanelData(lastSnapshot, readPrefs().theme, accountTitle, agents, agyQuotaAccounts(currentAgyState()));
}
function setTrayMenu() { if (!TRAY_PANEL) tray?.setContextMenu(buildTrayMenu()); }

const KIND_NAMES: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok", antigravity: "Antigravity" };

/** 一家不止一个账号、或起过名字时带上短名，否则只写家名。短名在报表里算好。 */
function accountTitle(account: { kind: string; displayName?: string }) {
  const name = KIND_NAMES[account.kind] ?? account.kind;
  return account.displayName ? `${name} · ${account.displayName}` : name;
}

/**
 * 托盘悬停时显示各账号当前的额度，不用开窗口就能看一眼。
 * Windows 的托盘提示最多 127 个字符，多出来的直接被切掉。先翻译再按这个上限收：
 * 放得下的按原来的顺序留着，剩下的收成一行「还有 n 个」。
 */
const TRAY_TIP_MAX = process.platform === "win32" ? 127 : 1000;
function clipTip(text: string, max: number) {
  if (text.length <= max) return text;
  return max < 2 ? "" : `${text.slice(0, max - 1)}…`;
}
function updateTrayTip(snapshot: Snapshot) {
  if (!tray) return;
  const head = tr(`TokenPulse · 今日 ${formatTokens(snapshot.totals.today.tokens)} tokens`);
  const allAccounts = [...snapshot.accounts, ...agyQuotaAccounts(currentAgyState())];
  const lines = allAccounts.map((account) => {
    const week = account.week ? tr(`周 ${Math.round(account.week.used)}%`) : "";
    const five = account.five ? `5h ${Math.round(account.five.used)}%` : "";
    return [accountTitle(account), [five, week].filter(Boolean).join("  ")].filter(Boolean).join("  ");
  });
  const kept: string[] = [];
  let used = head.length;
  for (let i = 0; i < lines.length; i++) {
    const omitted = lines.length - i - 1;
    const reserve = omitted > 0 ? 1 + tr(`还有 ${omitted} 个`).length : 0;
    const extra = 1 + lines[i].length;
    if (used + extra + reserve <= TRAY_TIP_MAX) {
      kept.push(lines[i]);
      used += extra;
      continue;
    }
    if (!kept.length) {
      const clipped = clipTip(lines[i], TRAY_TIP_MAX - used - 1 - reserve);
      if (clipped) kept.push(clipped);
    }
    break;
  }
  const omitted = lines.length - kept.length;
  const body = omitted > 0 ? [...kept, tr(`还有 ${omitted} 个`)] : kept;
  tray.setToolTip([head, ...body].join(String.fromCharCode(10)));
}

function formatTokens(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

/* ---------------- 提醒 ---------------- */

/**
 * 额度过线弹一次通知。
 * 按「账号 + 窗口」记住提醒过的那个重置时间 —— 窗口一重置，重置时间往后跳，
 * 下个窗口再过线会重新提醒，但同一个窗口里不会反复吵。
 *
 * 不能拿重置时间原样当去重键：Claude 每次返回的 resets_at 都有几百毫秒抖动，
 * 键每次都不一样，过线之后就变成每 5 分钟弹一次。
 */
function maybeNotify(snapshot: Snapshot) {
  const limit = readPrefs().notifyAt;
  if (!limit || !Notification.isSupported()) return;
  const fresh: { title: string; body: string }[] = [];
  for (const account of snapshot.accounts) {
    for (const [label, report] of [
      ["5 小时", account.five],
      ["周", account.week],
    ] as const) {
      if (!report || report.used < limit) continue;
      const key = `${account.key ?? account.kind}:${label}`;
      const resetAt = report.resetAt ?? 0;
      const previous = notified.get(key);
      if (previous != null && Math.abs(resetAt - previous) < SAME_WINDOW_MS) continue;
      notified.set(key, resetAt);
      fresh.push({
        title: `${accountTitle(account)} ${label}额度已用 ${Math.round(report.used)}%`,
        body: report.resetAt ? `${new Date(report.resetAt).toLocaleString()} 重置` : "注意节奏",
      });
    }
  }
  if (!fresh.length) return;
  // 一家好几个账号同时过线时，每个窗口各弹一条会叠成一串。同一次刷新里多条合成一条。
  if (fresh.length === 1) {
    new Notification({ title: tr(fresh[0].title), body: tr(fresh[0].body), icon: windowIcon() }).show();
    return;
  }
  const shown = fresh.slice(0, 4);
  const rest = fresh.length - shown.length;
  new Notification({
    title: tr(`${fresh.length} 个额度窗口已过提醒线`),
    body: [...shown.map((item) => tr(item.title)), rest > 0 ? tr(`还有 ${rest} 个`) : ""].filter(Boolean).join(String.fromCharCode(10)),
    icon: windowIcon(),
  }).show();
}

const notifiedExpiry = new Map<string, number>();

/** 官方账号凭据距过期不足 24 小时时提前一天发系统通知（同一到期时间戳只提醒一次）。 */
async function maybeNotifyExpiringAccounts() {
  if (readPrefs().notifyAccountExpiry === false || !Notification.isSupported()) return;
  const now = Date.now();
  const [statuses, agyStatus] = await Promise.all([
    listOfficialOAuthStatus().catch(() => []),
    listAgyAccountStatus().catch(() => null),
  ]);
  const expiring: { id: string; label: string; expiresAt: number }[] = [];
  for (const status of statuses) {
    for (const acc of status.accounts) {
      if (!isAccountExpiringSoon(acc, now)) continue;
      const bucket = Math.floor(acc.expiresAt! / 3600_000);
      if (notifiedExpiry.get(acc.id) === bucket) continue;
      notifiedExpiry.set(acc.id, bucket);
      expiring.push({ id: acc.id, label: `${status.label} · ${acc.alias || acc.email || acc.label}`, expiresAt: acc.expiresAt! });
    }
  }
  if (agyStatus) {
    for (const acc of agyStatus.accounts) {
      if (!isAccountExpiringSoon(acc, now)) continue;
      const bucket = Math.floor(acc.expiresAt! / 3600_000);
      if (notifiedExpiry.get(acc.id) === bucket) continue;
      notifiedExpiry.set(acc.id, bucket);
      expiring.push({ id: acc.id, label: `${agyStatus.label} · ${acc.alias || acc.email || acc.label}`, expiresAt: acc.expiresAt! });
    }
  }
  if (!expiring.length) return;
  const openAccounts = () => { revealWindow(); win?.webContents.send("open-page", { page: "settings", tab: "accounts" }); };
  if (expiring.length === 1) {
    const one = expiring[0];
    const note = new Notification({
      title: tr(`${one.label} 将在 24 小时内过期`),
      body: tr(`还剩约 ${formatRemainingDuration(one.expiresAt - now)}，请提前重新登录或重新授权。`),
      icon: windowIcon(),
    });
    note.on("click", openAccounts);
    note.show();
    return;
  }
  const note = new Notification({
    title: tr(`${expiring.length} 个官方账号将在 24 小时内过期`),
    body: expiring.slice(0, 4).map((item) => `${item.label}（${tr(`还剩约 ${formatRemainingDuration(item.expiresAt - now)}`)}）`).join("\n"),
    icon: windowIcon(),
  });
  note.on("click", openAccounts);
  note.show();
}

/*
 * 额度用满自动切 CLI 登录（0.3.55，见 core/cli-auto-switch.ts）：每轮额度查询之后跑一次。
 * 切了、没有能切的号、切换失败都弹一条通知，点开是设置里的官方账号；界面开着就刷新账号列表。返回这一轮有没有真的切换。
 */
const AUTO_SWITCH_APP = { claude: "claude", chatgpt: "codex", grok: "grok" } as const;
/** 自动切号要的东西；哪家都没开返回 null。 */
function autoSwitchDeps(prefs = readPrefs()): AutoSwitchDeps | null {
  if (!Object.values(prefs.cliAutoSwitch ?? {}).some((rule) => rule?.on)) return null;
  return {
    rules: prefs.cliAutoSwitch,
    readOnly: prefs.agentReadOnly === true,
    usesOfficial: (kind) => usesOfficialLogin(AUTO_SWITCH_APP[kind]),
    switchTo: (id) => switchCliAccount(id),
  };
}
async function runAutoSwitch(): Promise<boolean> {
  const deps = autoSwitchDeps();
  if (!deps) return false;
  let events: AutoSwitchEvent[] = [];
  try {
    events = await autoSwitchCli(deps);
  } catch (error) {
    console.error("[TokenPulse] 自动切换 CLI 登录失败", error);
    return false;
  }
  if (!events.length) return false;
  for (const event of events) notifyAutoSwitch(event);
  win?.webContents.send("cli-auto-switch", events);
  return events.some((event) => event.result === "switched");
}
function notifyAutoSwitch(event: AutoSwitchEvent) {
  if (!Notification.isSupported()) return;
  const text = describeAutoSwitch(event);
  const note = new Notification({ title: tr(text.title), body: tr(text.body), icon: windowIcon() });
  note.on("click", () => { revealWindow(); win?.webContents.send("open-page", { page: "settings", tab: "accounts" }); });
  note.show();
}

const MAX_NOTIFIED_REQUESTS = 500;
/** 已经通知过的请求，免得同一条在下一轮扫描里又弹一次。上限 500 条 FIFO 淘汰，防止常驻内存无界增长。 */
const notifiedRequests = new Set<string>();

function recordNotifiedRequest(key: string) {
  if (notifiedRequests.size >= MAX_NOTIFIED_REQUESTS) {
    const oldest = notifiedRequests.values().next().value;
    if (oldest !== undefined) notifiedRequests.delete(oldest);
  }
  notifiedRequests.add(key);
}

/**
 * 型号核验出问题的请求，弹一条通知。一轮里有好几条就合成一条，点开直接跳到请求记录。
 * 扫描那边只交最近 15 分钟的，第一次运行补历史时不会刷屏。
 */
function notifyRequests(snapshot: Snapshot) {
  const alerts = (snapshot.requestAlerts ?? []).filter((row) => !notifiedRequests.has(row.key));
  if (!alerts.length || !readPrefs().notifyMismatch || !Notification.isSupported()) return;
  for (const row of alerts) recordNotifiedRequest(row.key);
  const mismatch = alerts.filter((row) => row.status === "mismatch");
  const first = mismatch[0] ?? alerts[0];
  const title = mismatch.length
    ? `${mismatch.length} 次请求的返回型号和请求的不一致`
    : `${alerts.length} 次请求的响应存疑`;
  const notification = new Notification({
    title: tr(title),
    body: tr(`${first.source}：${first.reasons[0] ?? first.statusLabel}`),
    icon: windowIcon(),
  });
  notification.on("click", () => {
    revealWindow();
    win?.webContents.send("open-page", { page: "requests", status: mismatch.length ? "mismatch" : "suspect" });
  });
  notification.show();
}

/** 界面传来的查询条件：只收认识的字段，日期格式不对就拒绝。 */
function parseRequestQuery(value: unknown): RequestQuery {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = day(input.from);
  const to = day(input.to);
  if (!from || !to) throw new Error("查询日期无效");
  const status = ["all", "match", "mismatch", "suspect", "unverified"].includes(String(input.status)) ? (input.status as RequestQuery["status"]) : "all";
  const sort = ["time", "tokens", "cost", "quota", "cache_low", "latency"].includes(String(input.sort)) ? (input.sort as RequestQuery["sort"]) : "time";
  const quotaWindows = Array.isArray(input.quotaWindows)
    ? input.quotaWindows.slice(0, 120).flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const w = raw as Record<string, unknown>;
        const account = typeof w.account === "string" ? w.account.slice(0, 200) : "";
        const startAt = Number(w.startAt);
        const endAt = Number(w.endAt);
        if (!account || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return [];
        const fiveTokens = Number(w.fiveTokens);
        const weekTokens = Number(w.weekTokens);
        const models = Array.isArray(w.models) ? w.models.filter((m): m is string => typeof m === "string" && m.length <= 160).slice(0, 40) : undefined;
        return [{
          account,
          startAt,
          endAt,
          ...(models?.length ? { models } : {}),
          ...(Number.isFinite(fiveTokens) && fiveTokens > 0 ? { fiveTokens } : {}),
          ...(Number.isFinite(weekTokens) && weekTokens > 0 ? { weekTokens } : {}),
        }];
      })
    : undefined;
  return {
    from,
    to,
    source: typeof input.source === "string" ? input.source.slice(0, 40) : "all",
    status,
    search: typeof input.search === "string" ? input.search.slice(0, 200) : "",
    sort,
    page: Math.max(0, Math.floor(Number(input.page) || 0)),
    pageSize: Math.min(200, Math.max(1, Math.floor(Number(input.pageSize) || 20))),
    all: input.all === true,
    account: typeof input.account === "string" && input.account ? input.account.slice(0, 300) : undefined,
    session: typeof input.session === "string" && input.session ? input.session.slice(0, 300) : undefined,
    since: Number.isFinite(input.since) ? Number(input.since) : undefined,
    aggregate: input.aggregate === true,
    filteredAggregate: input.filteredAggregate === true,
    models: Array.isArray(input.models) ? [...new Set(input.models.filter((v): v is string => typeof v === "string" && v.length <= 300))].slice(0, 200) : undefined,
    project: typeof input.project === "string" ? input.project.slice(0, 4096) : undefined,
    channel: ["official", "api", "unknown"].includes(String(input.channel)) ? input.channel as RequestQuery["channel"] : "all",
    until: Number.isFinite(input.until) ? Number(input.until) : undefined,
    projects: input.projects === true,
    sessions: input.sessions === true,
    cache: input.cache === true,
    ...(quotaWindows?.length ? { quotaWindows } : {}),
  };
}

/* ---------------- 刷新 ---------------- */

let lastSnapshot: Snapshot | null = null;
let refreshing: Promise<Snapshot> | null = null;
let initialSnapshot: Promise<Snapshot> | null = null;

/**
 * 现在在用的官方账号：各家 CLI 当前登录的、号池里的、桌宠固定看的（「后台账号少查一点」照常查它们）。
 * 每次发快照都要用，~/.claude.json 可能有好几 MB：10 秒内复用上次的结果。
 */
let foregroundMemo: { at: number; ids: Set<string> } | null = null;
function foregroundNow() {
  if (!foregroundMemo || Date.now() - foregroundMemo.at > 10_000) foregroundMemo = { at: Date.now(), ids: foregroundAccounts([...poolAccountIds(), readPrefs().deskPetAccount]) };
  return foregroundMemo.ids;
}

/** 「后台账号少查一点」开着时给后台账号标上 quiet：界面按半小时一查放宽「过期」，不误报。 */
function markQuiet(snapshot: Snapshot) {
  const on = readPrefs().quotaQuietBackground === true;
  const foreground = on ? foregroundNow() : null;
  for (const account of snapshot.accounts ?? []) {
    const quiet = !!foreground && !!account.accountId && !foreground.has(account.accountId);
    if (quiet) account.quiet = true;
    else delete account.quiet;
  }
}

function publishSnapshot(snapshot: Snapshot): Snapshot {
  markQuiet(snapshot);
  lastSnapshot = snapshot;
  if (snapshot.scannedAt) {
    try {
      maybeWeeklySummary({
        now: snapshot.now, usage: snapshot.usage, enabled: readPrefs().weeklySummary,
        notify: notice => {
          if (!Notification.isSupported()) return;
          const notification = new Notification({ title: tr(notice.title), body: tr(notice.body), icon: windowIcon() });
          notification.on("click", notice.onClick);
          notification.show();
        },
        openPage: target => { revealWindow(); win?.webContents.send("open-page", target); },
      });
    } catch (error) { console.error("[TokenPulse] 每周小结处理失败", error); }
  }
  updateTrayTip(snapshot);
  pushTrayPanel();
  deskPetSnapshotChanged();
  // 窗口收着的时候不往界面推（推了它就要把整页重画一遍，没人看）；再打开时补上最新的
  if (windowAway) snapshotHeld = true;
  else win?.webContents.send("snapshot", snapshot);
  return snapshot;
}

/*
 * 窗口被收进托盘或最小化之后（0.3.21）：
 * - 快照不再推给界面，托盘提示和通知照常更新；
 * - 用量扫描从每分钟一次放慢到每 3 分钟一次（每次扫描都要起一个统计线程，会把主进程的内存顶上去一截）。
 * 窗口再打开时：把攒着的最新快照交给界面，超过一分钟没扫就马上扫一次。
 * 只在窗口真的被隐藏 / 最小化过之后才算「收着」：开机直接进托盘、还没显示过的窗口不算，和以前一样。
 */
let windowAway = false, snapshotHeld = false, lastScanAt = 0;
let quotaTimer: ReturnType<typeof setInterval> | undefined;
/** 官方额度和 API 余额共用 prefs 里的间隔。改设置时清掉旧定时器再按新间隔排。 */
function scheduleQuotaChecks() {
  if (quotaTimer) clearInterval(quotaTimer);
  const every = readPrefs().quotaEverySeconds * 1000;
  quotaTimer = setInterval(() => backgroundRefresh(true, false, true), every);
  quotaTimer.unref?.();
  deepseekBalance.reschedule(every);
  antigravityQuota.reschedule(every);
}
function setWindowAway(away: boolean) {
  if (windowAway === away) return;
  windowAway = away;
  if (win && !win.isDestroyed()) {
    win.webContents.send("window-away", away);
  }
  if (away) {
    if (win && !win.isDestroyed()) {
      win.webContents.session.clearCache().catch(() => {});
    }
    session.defaultSession.clearCache().catch(() => {});
    if (typeof global.gc === "function") {
      global.gc();
    }
    return;
  }
  if (snapshotHeld && lastSnapshot) win?.webContents.send("snapshot", lastSnapshot);
  snapshotHeld = false;
  if (Date.now() - lastScanAt >= SCAN_EVERY_MS) backgroundRefresh(false);
}

function getInitialSnapshot(): Promise<Snapshot> {
  if (lastSnapshot) return Promise.resolve(lastSnapshot);
  if (!initialSnapshot) {
    initialSnapshot = loadSnapshot(false).then(publishSnapshot).finally(() => {
      initialSnapshot = null;
    });
  }
  return initialSnapshot;
}

/**
 * 下一轮额度查询是不是定时器发起的。「后台账号少查一点」只管定时的那轮：
 * 手动刷新、登录 / 切换 / 恢复账号之后的那轮照常全查（后发起的会把它清掉）。
 */
let quotaScheduled = false;

function backgroundRefresh(withQuota: boolean, notifyQuota = false, scheduled = false) {
  lastScanAt = Date.now();
  if (withQuota) quotaScheduled = scheduled;
  void refresh(withQuota, notifyQuota).catch((error) => {
    console.error("[TokenPulse] 刷新失败", error);
    win?.webContents.send("refresh-error", tr("刷新失败，请重试并检查数据目录是否可写。"));
  });
}

let lastQuotaNotice: string | undefined;
let lastQuotaNoticeKind: "success" | "warning" | "error" = "success";
/** 手动刷新撞上正在跑的一轮时，那一轮结束也要把额度没查到说出来。 */
let quotaNoticePending = false;
/** 同一次手动刷新只说一遍，避免正在跑的一轮和排队的一轮各弹一次。 */
let quotaNoticeSent: string | undefined;

function emitQuotaNotice(notice: string | undefined, kind: "success" | "warning" | "error") {
  lastQuotaNotice = notice;
  lastQuotaNoticeKind = kind;
  if (!notice || quotaNoticeSent === notice) return;
  quotaNoticeSent = notice;
  (kind === "success" ? log.info : log.warn)("refresh", `提示：${notice}`);
  const channel = kind === "error" ? "refresh-error" : kind === "warning" ? "refresh-warn" : "refresh-ok";
  win?.webContents.send(channel, tr(notice));
}

const QUOTA_KIND_LABEL: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };

function quotaGlances(snapshot: Snapshot | null): QuotaGlance[] {
  return (snapshot?.accounts ?? []).map((account) => ({
    id: account.accountId || account.key || account.kind,
    kind: account.kind,
    who: account.displayName || account.accountLabel || QUOTA_KIND_LABEL[account.kind] || account.kind,
    five: account.five?.used,
    week: account.week?.used,
  }));
}

/**
 * 跑一轮：扫会话文件 +（需要时）问官方额度，然后把新快照推给窗口。
 * `withQuota` 为 false 时只扫本地，用于那个 1 分钟的快节奏定时器。
 * 手动点刷新时 `notifyQuota` 为 true：额度没查到要说出来，不能当成刷新成功。
 */
async function runRefresh(withQuota: boolean, notifyQuota = false): Promise<Snapshot> {
  if (withQuota) await antigravityQuota.syncLocalLogin().catch(() => {});
  // 先展示已有统计，再更新本地文件；网络慢或断网时仍然可以使用界面。
  await getInitialSnapshot();
  let snapshot = publishSnapshot(await loadSnapshot(true));
  notifyRequests(snapshot);
  if (withQuota) {
    if (notifyQuota) void antigravityQuota.refresh(false).catch(() => {});
    const tell = notifyQuota || quotaNoticePending;
    quotaNoticePending = false;
    const before = quotaGlances(lastSnapshot);
    const quiet = quotaScheduled && !notifyQuota && readPrefs().quotaQuietBackground === true;
    quotaScheduled = false;
    try {
      // 设了出口 IP 白名单的那家，出口不对就不去问官方（见 egress-monitor.ts 的 gateQuota）
      const gate = (kind: Parameters<typeof exitMonitor.gateQuota>[0]) => exitMonitor.gateQuota(kind);
      // 后台账号少查一点：在用的照查，后台的半小时一次（见 core/quota-quiet.ts）
      const result = await fetchOfficialQuota(true, gate, quiet ? quietPick(foregroundNow(), readQuotaChecks().accounts) : undefined);
      const issues = [...(result.issues ?? [])];
      // 这一轮要自动切号、候选账号的额度又是半小时前的：先临时查一次候选账号
      const deps = quiet ? autoSwitchDeps() : null;
      const stale = deps ? autoSwitchStale(deps) : [];
      if (stale.length) issues.push(...((await fetchOfficialQuota(true, gate, (_kind, id) => stale.includes(id))).issues ?? []));
      snapshot = publishSnapshot(await loadSnapshot(false));
      lastQuotaNotice = issues.length ? quotaIssueNotice(issues) : quotaRefreshSummary(before, quotaGlances(snapshot));
      lastQuotaNoticeKind = issues.length ? quotaIssueTone(issues) : "success";
      if (tell) emitQuotaNotice(lastQuotaNotice, lastQuotaNoticeKind);
      if (await runAutoSwitch()) snapshot = publishSnapshot(await loadSnapshot(false));
    } catch (error) {
      console.error("[TokenPulse] 额度接口失败", error);
      lastQuotaNotice = "官方额度没查到，请稍后重试。";
      lastQuotaNoticeKind = "warning";
      if (tell) emitQuotaNotice(lastQuotaNotice, "warning");
    }
    maybeNotify(snapshot);
    void maybeNotifyExpiringAccounts().catch(() => {});
  }
  return snapshot;
}

let refreshingQuota = false;
let queuedQuota: Promise<Snapshot> | null = null;

/**
 * 同一时间只跑一轮，重入的调用共用这一次的结果 ——
 * 但正在跑的那轮只扫本地、而这次要问额度时不能共用：手动「刷新数据」
 * 正好撞上 1 分钟的本地扫描，就会拿回一份没问过额度的快照。这种情况排一轮在后面。
 */
function refresh(withQuota: boolean, notifyQuota = false): Promise<Snapshot> {
  if (notifyQuota) {
    quotaNoticePending = true;
    // 手动刷新排进了定时的那轮：那轮也要全查
    quotaScheduled = false;
    if (!refreshing) quotaNoticeSent = undefined;
  }
  if (refreshing) {
    if (!withQuota || refreshingQuota) {
      if (notifyQuota) {
        return refreshing.then((snapshot) => {
          if (quotaNoticePending && lastQuotaNotice) emitQuotaNotice(lastQuotaNotice, lastQuotaNoticeKind);
          return snapshot;
        });
      }
      return refreshing;
    }
    queuedQuota ??= refreshing
      .catch(() => undefined)
      .then(() => {
        queuedQuota = null;
        return refresh(true, notifyQuota);
      });
    return queuedQuota;
  }
  refreshingQuota = withQuota;
  // finally 里清状态，排在后面的那轮挂在它之后，看到的一定是已经空出来的 refreshing。
  refreshing = runRefresh(withQuota, notifyQuota).finally(() => {
    refreshing = null;
    refreshingQuota = false;
  });
  return refreshing;
}

/* ---------------- 设置 ---------------- */

function appVersion(): string {
  return (require("../../package.json") as { version: string }).version;
}

function applyPrefs(patch: Partial<Prefs>): Prefs {
  if ("agentReadOnly" in patch) patch = { ...patch, agentReadOnly: patch.agentReadOnly === true };
  if ("weeklySummary" in patch) patch = { ...patch, weeklySummary: patch.weeklySummary === true };
  if ("studyModels" in patch) {
    const raw = patch.studyModels && typeof patch.studyModels === "object" ? patch.studyModels as Record<string, unknown> : {};
    patch = { ...patch, studyModels: Object.fromEntries((["claude", "chatgpt", "grok"] as const).map((kind) => [kind, parseStudyModels(raw[kind])]).filter(([, list]) => (list as unknown[]).length)) };
  }
  if ("seenVersion" in patch) patch = { ...patch, seenVersion: typeof patch.seenVersion === "string" && /^\d+\.\d+\.\d+[\w.-]{0,20}$/.test(patch.seenVersion) ? patch.seenVersion : "" };
  if ("onboarding" in patch && !["", "pending", "done"].includes(patch.onboarding as string)) patch = { ...patch, onboarding: "done" };
  if ("localOnlyAccounts" in patch) {
    const list = Array.isArray(patch.localOnlyAccounts) ? patch.localOnlyAccounts : [];
    patch = { ...patch, localOnlyAccounts: [...new Set(list.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 400))].slice(0, 100) };
  }
  if ("quotaEverySeconds" in patch) patch = { ...patch, quotaEverySeconds: quotaEverySeconds(patch.quotaEverySeconds) };
  if ("quotaQuietBackground" in patch) patch = { ...patch, quotaQuietBackground: patch.quotaQuietBackground === true };
  if ("cliAutoSwitch" in patch) {
    const raw = patch.cliAutoSwitch && typeof patch.cliAutoSwitch === "object" ? patch.cliAutoSwitch as Record<string, unknown> : {};
    patch = { ...patch, cliAutoSwitch: Object.fromEntries((["claude", "chatgpt", "grok"] as const).filter((kind) => kind in raw).map((kind) => [kind, normalizeRule(raw[kind])])) };
  }
  const petKeys = Object.keys(patch).filter((key) => key.startsWith("deskPet"));
  if (petKeys.length) patch = { ...patch, ...normalizeDeskPet(patch as Record<string, unknown>) };
  const previousEvery = readPrefs().quotaEverySeconds;
  const next = writePrefs(patch);
  // 桌宠：开关、大小、透明度、换宠物都要落到窗口上；设置页开着的话也要知道（比如在宠物的右键菜单里点了隐藏）
  if (petKeys.length || "theme" in patch) { syncDeskPet(); win?.webContents.send("desk-pet-changed"); }
  // 保存之后才改定时器。这一轮不额外查，下一轮按新间隔走。
  if (next.quotaEverySeconds !== previousEvery) scheduleQuotaChecks();
  // 容量怎么折算变了：不重新查额度，只按新的口径重算一遍快照
  if ("localOnlyAccounts" in patch || "pressureWeek" in patch || "pressureFive" in patch) backgroundRefresh(false);
  // 后台账号少查一点：不额外查，下一轮定时查询按新设置走；哪些是后台账号在下一次发快照时重新标
  /*
   * 只有打好包的版本才去动开机启动项。
   * 开发时（`npm start`）跑的是 node_modules 里的 electron.exe，把它登记进启动项，
   * 开机会启动一个空的 Electron 而不是 TokenPulse —— 既没用又难找。
   */
  if ("autoUpdate" in patch) setAutoUpdate(next.autoUpdate);
  if ("autoLaunch" in patch && app.isPackaged && process.platform !== "linux") {
    app.setLoginItemSettings({
      openAtLogin: next.autoLaunch,
      /*
       * 免安装版（portable）每次运行都把自己解压到一个临时目录再启动，
       * process.execPath 指的是那个临时副本 —— 关机就没了，登记进启动项等于登记了个死路径。
       * electron-builder 把真正那个 .exe 的位置放在这个环境变量里，有就用它。
       */
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      // 自启的那次直接进托盘，别开机就糊一个窗口在脸上。
      args: ["--hidden"],
    });
  }
  setTrayMenu();
  return next;
}

function isOfficialAccountKind(value: unknown): value is OfficialAccountKind {
  return OFFICIAL_KINDS.includes(value as OfficialAccountKind);
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === "claude" || value === "codex" || value === "grok" || value === "deepseek" || value === "pi" || value === "antigravity";
}

/** 找到会话并确认参数：id 来自界面，只收三家之一、长度有限的字符串。 */
async function sessionOf(kind: unknown, id: unknown) {
  if (!isAgentKind(kind) || typeof id !== "string" || !id || id.length > 200) throw new Error("会话参数无效");
  const session = await loadSessionDetail(kind, id);
  if (!session) throw new Error("找不到这个会话");
  return { kind, id, session };
}

/** 在终端里接着这段会话（交互模式，能看到 CLI 自己的界面）。 */
async function openInTerminal(kind: unknown, id: unknown) {
  const hit = await sessionOf(kind, id);
  if (hit.kind === "deepseek") throw new Error("DeepSeek Harness 没有交互式命令行，不能在终端里继续");
  const session = hit.session;
  const cwd = session.cwd && fsSync.existsSync(session.cwd) ? session.cwd : undefined;
  // 终端里的 CLI 走的是那个 PowerShell 的网络环境：出口检测放在终端里做（见 session-reply.ts 的 exitGuardScript）
  const guard = hit.kind === "pi" || hit.kind === "antigravity" ? null : exitMonitor.launchRule(CLI_PROVIDER[hit.kind]);
  const imported = hit.kind === "antigravity" ? await prepareAntigravityCliConversation(hit.id) : undefined;
  openTerminal(hit.kind, hit.id, cwd, guard);
  return { ok: true, command: sessionCommand(hit.kind, hit.id), guarded: guardMode(guard), imported };
}
/** 「复制继续命令」之前：Antigravity 桌面端的对话先导入 CLI，粘贴命令才能接上历史。 */
async function prepareResume(kind: unknown, id: unknown) {
  const hit = await sessionOf(kind, id);
  return { imported: hit.kind === "antigravity" ? await prepareAntigravityCliConversation(hit.id) : undefined };
}
/** CLI 对应出口监控里的哪一家。 */
const CLI_PROVIDER = { claude: "claude", codex: "chatgpt", grok: "grok" } as const;
const CLI_NAME = { claude: "Claude Code", codex: "Codex", grok: "Grok" } as const;
/** 本机装了哪几家的 CLI（新对话只能用装了的）；guarded：哪几家设了出口 IP 白名单（启动前会先测出口）。 */
function installedClis() {
  const kinds = ["claude", "codex", "grok", "pi", "antigravity"] as const;
  return { ...Object.fromEntries(kinds.map((kind) => [kind, resolveCli(kind) !== null])), guarded: Object.fromEntries(kinds.map((kind) => [kind, kind === "pi" || kind === "antigravity" ? null : guardMode(exitMonitor.launchRule(CLI_PROVIDER[kind]))])) };
}
/** 项目文件夹：必须是已经存在的目录的绝对路径。 */
function projectFolder(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 1000 || !path.isAbsolute(value)) throw new Error("请选择一个项目文件夹");
  const folder = path.resolve(value);
  let stat: fsSync.Stats;
  try { stat = fsSync.statSync(folder); } catch { throw new Error("这个文件夹不存在：" + folder); }
  if (!stat.isDirectory()) throw new Error("这不是一个文件夹：" + folder);
  return folder;
}
/** 开一个新对话（0.3.16）：在项目文件夹里打开终端，启动选的那个 CLI。新会话由 CLI 自己建，之后会出现在会话列表里。 */
function startConversation(kind: unknown, folder: unknown) {
  if (kind === "deepseek") throw new Error("DeepSeek Harness 的新任务不从终端开始。打开已有会话后可以在这里回复。");
  if (kind !== "claude" && kind !== "codex" && kind !== "grok" && kind !== "pi" && kind !== "antigravity") throw new Error("请选择一个工具");
  const cwd = projectFolder(folder);
  if (!resolveCli(kind)) throw new Error("没有找到这个工具的命令行程序，请先安装它的 CLI");
  const guard = kind === "pi" || kind === "antigravity" ? null : exitMonitor.launchRule(CLI_PROVIDER[kind]);
  openTerminal(kind, null, cwd, guard);
  return { ok: true, cwd, guarded: guardMode(guard) };
}
/** 选（或者新建）一个项目文件夹。系统的选文件夹对话框里可以直接新建文件夹。 */
async function pickProjectFolder(start: unknown) {
  const defaultPath = typeof start === "string" && start && fsSync.existsSync(start) ? start : app.getPath("documents");
  const options: Electron.OpenDialogOptions = { title: "选择或新建项目文件夹", buttonLabel: "用这个文件夹", defaultPath, properties: ["openDirectory", "createDirectory", "promptToCreate"] };
  const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}
const DELETE_METHOD: Record<AgentKind, string> = {
  claude: "Claude Code 没有普通对话删除命令；TokenPulse 会删除本机的会话记录文件和同名附属目录。此操作无法撤销。",
  codex: "将调用 codex delete --force <会话 ID> 永久删除这段对话。此操作无法撤销。",
  grok: "将调用 grok sessions delete <会话 ID> 永久删除这段对话。此操作无法撤销。",
  deepseek: "DeepSeek Harness 没有删除功能；TokenPulse 会删除本机的会话记录和它派出的子代理记录。如果 Harness 正开着，请先关掉再删，否则它的列表要重启后才更新。此操作无法撤销。",
  pi: "TokenPulse 会删除本机的会话记录文件，和在 pi 的 /resume 列表里删除一样。如果这段对话还开着，请先退出。此操作无法撤销。",
  antigravity: "Antigravity CLI 的对话会直接删除本机的会话记录文件；Antigravity 桌面端的对话会请开着的 Antigravity 删除。此操作无法撤销。",
};

/** 永久删除一段对话：先由主进程弹确认框，再调用各家 CLI（Claude、pi、DeepSeek 删本机文件）。 */
async function deleteConversation(kind: unknown, id: unknown) {
  const hit = await sessionOf(kind, id);
  const method = DELETE_METHOD[hit.kind];
  const options = {
    type: "warning" as const,
    title: tr("删除对话"),
    message: tr("永久删除这段对话？"),
    detail: `${hit.session.title}\n\n${tr(method)}`,
    buttons: [tr("取消"), tr("删除")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (result.response !== 1) return { ok: false, cancelled: true };
  await deleteAgentSession(hit.kind, hit.id);
  return { ok: true, cancelled: false };
}

/* ---------------- 启动 ---------------- */

// 从某个 Agent 的终端里启动（比如在 Claude Code 里跑的命令）会继承它的会话变量和 NO_COLOR，
// TokenPulse 再起的 CLI 就不存对话记录、没有颜色。进程一开始就清掉，之后起的所有子进程都干净。
const cleanEnv = cleanAgentEnv();
for (const key of Object.keys(process.env)) if (!(key in cleanEnv)) delete process.env[key];

// 只允许一个实例：两个进程同时往同一个账本里写会互相覆盖。
/*
 * 内存（0.3.21）：界面的绘制放到 CPU 上做，合成仍然交给 GPU。
 * 实测（1380×920 窗口，逛过几个页面后空闲）：GPU 进程从约 295 MB 降到约 180 MB，全部进程合计从约 516 MB 降到约 407 MB。
 * 动画用的是 transform / opacity，仍由 GPU 合成，不受影响；整个关掉硬件加速能再省约 100 MB，但动画和滚动会变卡，没有采用。
 * 必须在 app ready 之前设置。
 */
app.commandLine.appendSwitch("disable-gpu-rasterization");
app.commandLine.appendSwitch("js-flags", "--expose-gc");

/**
 * 空闲内存修剪（0.3.56 / M2）：
 * 当系统空闲超过 300 秒（5 分钟）时，主动清理会话缓存并触发 V8 垃圾回收。
 * 当用户恢复操作后重置状态，等待下一次空闲。
 */
let idleTrimmed = false;
function setupIdleMonitor() {
  const IDLE_THRESHOLD_SECONDS = 300;
  const idleCheckInterval = setInterval(() => {
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      if (idleSeconds >= IDLE_THRESHOLD_SECONDS) {
        if (!idleTrimmed) {
          idleTrimmed = true;
          session.defaultSession.clearCache().catch(() => {});
          if (win && !win.isDestroyed()) win.webContents.session.clearCache().catch(() => {});
          if (typeof global.gc === "function") {
            global.gc();
          }
        }
      } else {
        idleTrimmed = false;
      }
    } catch {
      // 忽略部分无桌面会话环境中获取空闲时间的异常
    }
  }, 60_000);
  idleCheckInterval.unref?.();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", revealWindow);

  app.whenReady().then(() => {
    /*
     * 任务栏按这个 ID 分组，图标取「开始」菜单里带同一个 ID 的快捷方式的图标。Electron 为了发通知，
     * 发现没有这样的快捷方式就自己建一个，指向当前的 exe。开发 / 测试时跑的是 node_modules 里的 electron.exe，
     * 用同一个 ID 就会建出指向它的「Electron.lnk」，正式版的任务栏图标从此变成 Electron 的原子图标。
     * 所以没打包时换一个 ID，和正式版互不影响。
     */
    void logAppStart(appVersion());
    if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? "com.tokenpulse.app" : "com.tokenpulse.app.dev");
    // 0.3.3：Grok 账号改用用户 ID 当身份，旧数据搬一次（见 grok-migrate.ts）。必须在读账号、刷新之前。
    try {
      migrateLegacyGrokAccounts();
    } catch (error) {
      console.error("[TokenPulse] 迁移 Grok 账号失败", error);
    }
    // 必须在第一次写 prefs.json 之前判断：全新安装要走新手引导，而且不用再看「这版有什么新东西」
    configureReadOnly(() => readPrefs().agentReadOnly === true);
    setupIdleMonitor();
    const fresh = !prefsExist();
    const prefs = readPrefs();
    // --hidden 只影响本次自启，不能永久改掉用户手动启动时的偏好。
    applyPrefs(fresh ? { autoLaunch: prefs.autoLaunch, seenVersion: appVersion(), onboarding: "pending" } : { autoLaunch: prefs.autoLaunch });

    relaunchHidden = consumeRelaunchHidden();
    initTray();
    createWindow();
    // 桌宠（0.3.61）：默认关；开着时建宠物窗口、开始看会话状态
    setupDeskPet({
      preload: path.join(__dirname, "preload.js"),
      prefs: () => readPrefs(),
      savePos: (pos) => { writePrefs({ deskPetPos: pos }); },
      saveMini: (on, edge) => { writePrefs(edge ? { deskPetMini: on, deskPetEdge: edge } : { deskPetMini: on }); win?.webContents.send("desk-pet-changed"); },
      hide: () => applyPrefs({ deskPet: false }),
      snapshot: () => lastSnapshot,
      extraAccounts: () => agyQuotaAccounts(currentAgyState()),
      antigravityLogin: () => currentAgyLocalAccountId(),
      title: accountTitle,
      openMain: (target) => { revealWindow(); if (target) win?.webContents.send("open-page", target); },
      openSettings: () => { revealWindow(); win?.webContents.send("open-page", { page: "pet" }); },
      refresh: () => backgroundRefresh(true, true),
    });
    initUpdater({ window: () => win, autoUpdate: readPrefs().autoUpdate });
    // 知识库更新了（新型号的单价）：重算一遍，界面上的费用跟着变
    scheduleKnowledgeChecks(() => backgroundRefresh(false));

    ipcMain.handle("egress:state", () => exitMonitor.snapshot());
    ipcMain.handle("egress:save", (_event, value: unknown) => exitMonitor.save(value));
    ipcMain.handle("egress:check", () => exitMonitor.check(true));
    ipcMain.handle("egress:clear", () => exitMonitor.clearHistory());
    ipcMain.handle("egress:intel", (_event, ip: unknown) => exitMonitor.refreshIntel(ip));
    exitMonitor.start();
    ipcMain.handle("tokens-ci:state", () => tokensUploader.state());
    ipcMain.handle("tokens-ci:save", (_event, value: unknown) => tokensUploader.save(value));
    ipcMain.handle("tokens-ci:check", () => tokensUploader.check());
    ipcMain.handle("tokens-ci:use-latest", () => tokensUploader.useLatestVersion());
    ipcMain.handle("tokens-ci:upload", () => tokensUploader.upload("manual"));
    ipcMain.handle("tokens-ci:preview", () => tokensUploader.dryRun());
    ipcMain.handle("tokens-ci:login", (_event, privacy: unknown) => tokensUploader.login(privacy));
    ipcMain.handle("tokens-ci:cancel", () => tokensUploader.cancelJob());
    ipcMain.handle("tokens-ci:clear-login", () => tokensUploader.clearLogin());
    ipcMain.handle("tokens-ci:clear-preview", () => tokensUploader.clearPreview());
    ipcMain.handle("tokens-ci:resume", () => tokensUploader.resume());
    ipcMain.handle("tokens-ci:open", (_event, url: unknown) => { if (typeof url === "string" && /^https:\/\/[^\s]+$/i.test(url)) void shell.openExternal(url); });
    tokensUploader.start();
    ipcMain.handle("deepseek-balance:state", () => deepseekBalance.state());
    ipcMain.handle("deepseek-balance:add", (_event, value: unknown) => deepseekBalance.add(value));
    ipcMain.handle("deepseek-balance:update", (_event, id: unknown, value: unknown) => deepseekBalance.update(id, value));
    ipcMain.handle("deepseek-balance:remove", (_event, id: unknown) => deepseekBalance.remove(id));
    ipcMain.handle("deepseek-balance:refresh", (_event, id: unknown) => deepseekBalance.refresh(id, true));
    ipcMain.handle("deepseek-balance:refresh-all", () => deepseekBalance.refreshAll(true));
    ipcMain.handle("deepseek-balance:reorder", (_event, ids: unknown) => deepseekBalance.reorder(ids));
    // 账号页的分析（消耗、预测、模型换算、时间线、速度）：在 worker 里读余额历史和 DeepSeek Harness 的流水
    ipcMain.handle("deepseek-balance:insight", (_event, id: unknown) => {
      const owner = deepseekBalance.owner(id);
      if (!owner) throw new Error("找不到这个 DeepSeek 账号，可能已经删除了");
      return loadDeepSeek({ op: "insight", accountId: owner.id, local: owner.local });
    });
    ipcMain.handle("deepseek-balance:timeline", (_event, value: unknown) => {
      const query = (value ?? {}) as { accountId?: unknown; cycles?: { five?: unknown; week?: unknown } };
      const owner = deepseekBalance.owner(typeof query.accountId === "string" ? query.accountId.replace(/^deepseek:/, "") : "");
      if (!owner) throw new Error("找不到这个 DeepSeek 账号，可能已经删除了");
      const cycle = (item: unknown) => (typeof item === "string" && /^\d{1,16}:\d{1,16}$/.test(item) ? item : undefined);
      return loadDeepSeek({ op: "timeline", accountId: owner.id, local: owner.local, cycles: { five: cycle(query.cycles?.five), week: cycle(query.cycles?.week) } });
    });
    ipcMain.handle("deepseek-balance:speed", (_event, days: unknown) => loadDeepSeek({ op: "speed", days: Math.max(0, Math.min(3650, Number(days) || 0)) }));
    ipcMain.handle("deepseek-balance:mark", (_event, value: unknown) => {
      const input = (value ?? {}) as { accountId?: unknown; from?: unknown; to?: unknown; mode?: unknown; note?: unknown };
      const rawId = typeof input.accountId === "string" ? input.accountId.replace(/^deepseek:/, "") : "";
      const owner = deepseekBalance.owner(rawId);
      if (!owner) throw new Error("找不到这个 DeepSeek 账号，可能已经删除了");
      const from = Number(input.from), to = Number(input.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= 0) throw new Error("时间区间无效");
      const mode = input.mode === "local" || input.mode === "off" || input.mode === "auto" ? input.mode : "auto";
      return setDeepSeekMark(owner.id, from, to, mode, typeof input.note === "string" ? input.note : undefined);
    });
    deepseekBalance.start();
    ipcMain.handle("antigravity-quota:state", () => antigravityQuota.state());
    ipcMain.handle("antigravity-quota:refresh", (_event, accountId?: unknown) =>
      antigravityQuota.refresh(true, typeof accountId === "string" && accountId.startsWith("antigravity:") ? accountId : undefined),
    );
    ipcMain.handle("antigravity-quota:timeline", (_event, query: unknown) => antigravityQuota.timeline(query));
    ipcMain.handle("antigravity-quota:speed", (_event, days: unknown, accountId?: unknown) =>
      antigravityQuota.speed(
        Math.max(0, Math.min(3650, Number(days) || 0)),
        typeof accountId === "string" ? accountId : undefined,
      ),
    );
    ipcMain.handle("antigravity-accounts:list", async () => {
      const localEmail = antigravityHub() ? undefined : await readAgyKeyringEmailAsync();
      return listAgyAccountStatus(Date.now(), localEmail);
    });
    ipcMain.handle("antigravity-accounts:switch-local", async (_event, id: unknown) => {
      if (typeof id !== "string" || !id.startsWith("antigravity:") || id.length > 400) {
        throw new Error("Antigravity 账号参数无效");
      }
      const result = await switchAntigravityAccount(id);
      antigravityQuota.onAccountSwitched(result.email, result.restarted);
      backgroundRefresh(true);
      return result;
    });
    ipcMain.handle("antigravity-accounts:login", async (_event, replaceId?: unknown) => {
      if (replaceId !== undefined && (typeof replaceId !== "string" || replaceId.length > 400)) throw new Error("账号参数无效");
      const result = await loginAntigravityOAuth(typeof replaceId === "string" ? replaceId : undefined);
      if (result.ok) void antigravityQuota.refresh(true).catch(() => {});
      return result;
    });
    ipcMain.handle("antigravity-accounts:add-local", async () => {
      const result = await addLocalAgyAccount();
      void antigravityQuota.refresh(true).catch(() => {});
      return result;
    });
    ipcMain.handle("antigravity-accounts:manage", async (_event, action: unknown, id: unknown, value?: unknown) => {
      if (!["remove", "purge", "restore", "rename", "share-mode"].includes(String(action)) || typeof id !== "string" || !id.startsWith("antigravity:") || id.length > 400) {
        throw new Error("Antigravity 账号参数无效");
      }
      if (action === "rename" && typeof value === "string" && value.length > 200) throw new Error("名字无效");
      const status = await manageAgyAccount(
        action as "remove" | "purge" | "restore" | "rename" | "share-mode",
        id,
        typeof value === "string" ? value : "",
      );
      if (action === "purge") antigravityQuota.forgetAccount(id);
      else if (action === "restore") void antigravityQuota.refresh(true, id).catch(() => {});
      else antigravityQuota.publish();
      return status;
    });
    ipcMain.handle("antigravity-accounts:reorder", async (_event, ids: unknown) => {
      if (!Array.isArray(ids) || ids.length > 50 || !ids.every((id) => typeof id === "string" && id.startsWith("antigravity:") && id.length <= 400)) {
        throw new Error("Antigravity 账号排序参数无效");
      }
      reorderAgyAccounts(ids as string[]);
      antigravityQuota.publish();
      return listAgyAccountStatus();
    });
    antigravityQuota.start();
    // 额度详情的号池页（0.3.44）：号池定义从供应商数据里取（不带凭据），汇总在 worker 里读转发记录和额度采样
    const poolOf = (id: unknown) => {
      const pool = poolDef(typeof id === "string" ? id.replace(/^pool:/, "") : "");
      if (!pool) throw new Error("找不到这个号池，可能已经删除了");
      return pool;
    };
    ipcMain.handle("pool-insight:summary", (_event, id: unknown) => loadPool({ op: "summary", pool: poolOf(id) }));
    ipcMain.handle("pool-insight:speed", (_event, id: unknown, days: unknown) => loadPool({ op: "speed", pool: poolOf(id), days: Math.max(0, Math.min(3650, Number(days) || 0)) }));
    ipcMain.handle("pool-insight:timeline", (_event, value: unknown) => {
      const query = (value ?? {}) as { accountId?: unknown; cycles?: { five?: unknown; week?: unknown } };
      const cycle = (item: unknown) => (typeof item === "string" && /^\d{1,16}:\d{1,16}$/.test(item) ? item : undefined);
      return loadPool({ op: "timeline", pool: poolOf(query.accountId), cycles: { five: cycle(query.cycles?.five), week: cycle(query.cycles?.week) } });
    });
    ipcMain.handle("snapshot", () => getInitialSnapshot());
    ipcMain.handle("refresh", async () => refresh(true, true));
    ipcMain.handle("prefs:read", () => readPrefs());
    ipcMain.handle("prefs:write", (_event, patch: Partial<Prefs>) => applyPrefs(patch));
    ipcMain.handle("accounts:list", () => listOfficialOAuthStatus());
    ipcMain.handle("accounts:login", async (_event, kind: unknown, replaceId: unknown) => {
      if (!isOfficialAccountKind(kind)) throw new Error("官方账号类型无效");
      if (replaceId !== undefined && (typeof replaceId !== "string" || replaceId.length > 400)) throw new Error("官方账号参数无效");
      const result = await loginOfficialOAuth(kind, typeof replaceId === "string" ? replaceId : undefined);
      if (result.ok) backgroundRefresh(true);
      return result;
    });
    ipcMain.handle("accounts:add-cli", async (_event, kind: unknown) => {
      if (!isOfficialAccountKind(kind)) throw new Error("官方账号类型无效");
      const result = await addCliAccounts(kind);
      backgroundRefresh(true);
      return result;
    });
    ipcMain.handle("accounts:manage", async (_event, action: unknown, id: unknown, alias: unknown) => {
      if (!["remove", "purge", "restore", "rename"].includes(action as string) || typeof id !== "string" || id.length > 400) throw new Error("官方账号参数无效");
      if (action === "rename" && (typeof alias !== "string" || alias.length > 200)) throw new Error("名字无效");
      const statuses = await manageOfficialAccount(action as "remove" | "purge" | "restore" | "rename", id, typeof alias === "string" ? alias : "");
      // 名字、显示哪些账号都会变：重新汇总；删除 / 恢复还要重新查一轮额度
      backgroundRefresh(action !== "rename");
      return statuses;
    });
    ipcMain.handle("accounts:switch-cli", async (_event, id: unknown) => {
      if (typeof id !== "string" || !id || id.length > 400) throw new Error("官方账号参数无效");
      const result = await switchCliLogin(id);
      backgroundRefresh(true);
      return result;
    });
    ipcMain.handle("accounts:reorder", async (_event, kind: unknown, ids: unknown) => {
      if (!isOfficialAccountKind(kind) || !Array.isArray(ids) || ids.length > 50 || !ids.every((id) => typeof id === "string" && id.length <= 400)) throw new Error("官方账号参数无效");
      const statuses = await reorderOfficialAccountsOf(kind, ids as string[]);
      backgroundRefresh(false);
      return statuses;
    });
    ipcMain.handle("theme", (_event, theme: unknown) => {
      if (theme !== "light" && theme !== "dark") return;
      win?.setBackgroundColor(BACKGROUND[theme]);
      if (readPrefs().theme !== theme) { writePrefs({ theme }); syncDeskPet(); }
    });
    ipcMain.handle("open-data-dir", () => shell.openPath(dataDir()));
    // 还没登录过就没有日志文件：打开数据目录，返回 false 让界面说一句
    ipcMain.handle("open-log", () => { const file = appLogFile(); if (fsSync.existsSync(file)) { shell.showItemInFolder(file); return true; } void shell.openPath(dataDir()); return false; });
    ipcMain.handle("window:minimize", () => win?.minimize());
    ipcMain.handle("window:toggle-maximize", () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
    // 走 close() 而不是 destroy()：「关闭窗口时」的设置（收进托盘 / 直接退出）在 close 事件里处理。
    ipcMain.handle("window:close", () => win?.close());
    ipcMain.handle("window:state", () => ({ maximized: Boolean(win?.isMaximized()) }));
    // 直接读 package.json：app.getVersion() 在测试 / 截图脚本里（electron 加载的不是本应用目录）返回的是 Electron 自己的版本。
    ipcMain.handle("update:state", () => updateState());
    ipcMain.handle("update:check", () => checkForUpdates(true));
    ipcMain.handle("update:download", () => downloadUpdate());
    ipcMain.handle("update:install", () => installUpdate());
    ipcMain.handle("app:version", () => appVersion());
    // 转发记录的文件夹（route-log/，见 route-ledger.ts）。还没有转发过就先建出来，免得打开一个不存在的目录
    // total：顺便数一下一共多少条（翻页显示共几页，0.3.39）
    ipcMain.handle("agent:route-log", (_event, query: unknown) => { const q = (query && typeof query === "object" ? query : {}) as { limit?: unknown; before?: unknown; cursor?: unknown; total?: unknown }; return { ...readRouteLog({ limit: Number(q.limit) || 100, before: Number(q.before) || undefined, cursor: typeof q.cursor === "string" ? q.cursor : undefined }), ...(q.total === true ? { total: countRouteLog() } : {}) }; });
    ipcMain.handle("agent:open-route-log", async () => { await fs.mkdir(routeLogDir(), { recursive: true }); return shell.openPath(routeLogDir()); });
    // 托盘小面板：取数据、报告内容高度、几个按钮
    ipcMain.handle("tray-panel:data", () => trayPanelView());
    // 面板里点了别的供应商：和托盘菜单一样，打开主窗口，在供应商页里看过改动对比、确认后才写
    ipcMain.on("tray-panel:activate", (_event, id: unknown) => {
      if (typeof id !== "string" || !id || id.length > 200) return;
      hideTrayPanel(); revealWindow();
      win?.webContents.send("agent-activate-request", id);
    });
    ipcMain.on("tray-panel:size", (_event, height: unknown) => resizeTrayPanel(Number(height)));
    ipcMain.on("tray-panel:action", (_event, action: unknown) => {
      if (action === "open") { hideTrayPanel(); revealWindow(); }
      else if (action === "refresh") backgroundRefresh(true, true);
      else if (action === "quit") { quitting = true; app.quit(); }
      else if (action === "close") hideTrayPanel();
    });
    // 桌宠（0.3.61）：宠物窗口、点开的卡片、「桌宠」设置页
    ipcMain.handle("desk-pet:ready", () => deskPetReady());
    ipcMain.on("desk-pet:hit", (_event, on: unknown) => deskPetHit(on === true));
    ipcMain.on("desk-pet:drag", (_event, phase: unknown) => { if (phase === "start" || phase === "end") deskPetDrag(phase); });
    ipcMain.on("desk-pet:click", () => deskPetClick());
    ipcMain.on("desk-pet:menu", () => deskPetMenu());
    ipcMain.handle("desk-pet:bubble-data", () => deskPetBubbleData());
    ipcMain.on("desk-pet:bubble-size", (_event, width: unknown, height: unknown) => resizeDeskPetBubble(Number(width), Number(height)));
    ipcMain.on("desk-pet:bubble-action", (_event, action: unknown, value: unknown) => deskPetBubbleAction(action, value));
    ipcMain.handle("desk-pet:status", () => ({ on: readPrefs().deskPet, view: deskPetView(), shown: !!deskPetWindows().pet }));
    ipcMain.handle("desk-pet:accounts", () => {
      const state = antigravityQuota.state();
      agyStateCache = state;
      return [...(lastSnapshot?.accounts ?? []), ...agyQuotaAccounts(state)].filter((account) => account.five || account.week).map((account) => ({ id: accountKey(account), name: accountTitle(account) }));
    });
    ipcMain.handle("desk-pet:packs", () => listPetPacks());
    ipcMain.handle("desk-pet:pack-images", (_event, id: unknown) => petPackImages(id));
    ipcMain.handle("desk-pet:remove-pack", (_event, id: unknown) => {
      const removed = removePetPack(id);
      if (removed && readPrefs().deskPetKind === id) applyPrefs({ deskPetKind: "squirrel" });
      return listPetPacks();
    });
    ipcMain.handle("desk-pet:import-pack", async () => {
      const options = { title: tr("选择宠物文件夹（里面有 pet.json 或 theme.json）"), properties: ["openDirectory" as const] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths[0]) return { ok: false as const, canceled: true };
      try { return { ok: true as const, pack: importPetPack(picked.filePaths[0]), packs: listPetPacks() }; }
      catch (error) { return { ok: false as const, error: importError(error) }; }
    });
    ipcMain.handle("desk-pet:reset-position", () => { resetDeskPetPosition(); return true; });
    // 问题卡片（Agent 在问你）和自己选的提示音
    ipcMain.handle("desk-pet:ask-data", () => deskPetAskData());
    ipcMain.on("desk-pet:ask-size", (_event, width: unknown, height: unknown) => resizeDeskPetAsk(Number(width), Number(height)));
    ipcMain.on("desk-pet:ask-action", (_event, action: unknown, value: unknown) => deskPetAskAction(action, value));
    ipcMain.handle("desk-pet:sounds", () => listPetSounds());
    ipcMain.handle("desk-pet:sound-data", (_event, kind: unknown) => petSoundData(kind));
    ipcMain.handle("desk-pet:import-sound", async (_event, kind: unknown) => {
      const options = { title: tr("选择提示音（WAV、MP3、OGG、FLAC、M4A，2 MB 以内）"), properties: ["openFile" as const], filters: [{ name: tr("音频"), extensions: ["wav", "mp3", "ogg", "oga", "flac", "m4a", "aac", "mp4"] }] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths[0]) return { ok: false as const, canceled: true };
      try { const sound = importPetSound(kind, picked.filePaths[0]); syncDeskPet(); return { ok: true as const, sound, sounds: listPetSounds() }; }
      catch (error) { return { ok: false as const, error: importError(error) }; }
    });
    ipcMain.handle("desk-pet:remove-sound", (_event, kind: unknown) => { removePetSound(kind); syncDeskPet(); return listPetSounds(); });
    // 校验不过的是给用户看的中文说明；文件系统的错误（EPERM 之类）换成一句能看懂的，细节进日志
    function importError(error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code) { console.error("desk-pet import failed:", errorText(error)); return "复制失败，请检查数据目录权限"; }
      return error instanceof Error ? error.message : "导入失败";
    }
    ipcMain.handle("knowledge:state", () => knowledgeState());
    ipcMain.handle("knowledge:check", () => checkKnowledge(() => backgroundRefresh(false)));
    ipcMain.handle("ccswitch:sync", async () => publishSnapshot(await loadSnapshot(false, true)));
    ipcMain.handle("agent:state", () => agentView());
    const providerName = (id: unknown) => coreAgentView().providers.find((item) => item.id === id)?.name || "";
    ipcMain.handle("agent:save", (_event, input: unknown) => agentWrite(`保存供应商「${String((input as { name?: unknown })?.name || "").slice(0, 60)}」`, () => saveProvider(input)));
    ipcMain.handle("agent:delete", (_event, id: unknown) => agentWrite(`删除供应商「${providerName(id)}」`, () => deleteProvider(String(id || ""))));
    ipcMain.handle("agent:activate", (_event, id: unknown) => agentWrite(`切换到「${providerName(id)}」`, () => activateProvider(String(id || ""))));
    ipcMain.handle("agent:proxy", (_event, app: unknown, on: unknown) => agentWrite(`${on === true ? "启用" : "关闭"}本地路由（${isAgentApp(app) ? AGENT_LABEL[app] : ""}）`, () => {
      if (!isAgentApp(app)) throw new Error("不认识这个工具");
      return setAppProxy(app, on === true);
    }, on !== true));
    ipcMain.handle("agent:pass", (_event, app: unknown, on: unknown) => agentWrite(`${on === true ? "打开" : "关闭"}透明转发（${isAgentApp(app) ? AGENT_LABEL[app] : ""}）`, () => {
      if (!isAgentApp(app)) throw new Error("不认识这个工具");
      return setAppPass(app, on === true);
    }, on !== true));
    // days：最近多少天，0 = 全部（转发记录永久保存）
    ipcMain.handle("agent:pass-speed", (_event, days: unknown) => { try { const n = Number(days); return passSpeed(Number.isFinite(n) && n >= 0 ? n : 7); } catch { return []; } });
    // 额度详情里「模型速度」那张图：某个官方账号各模型的速度走势（透明转发量到的，来自永久保存的转发记录）
    ipcMain.handle("pass-speed:account", (_event, kind: unknown, account: unknown, days: unknown) => {
      if (kind !== "claude" && kind !== "chatgpt" && kind !== "grok") return null;
      try { return accountSpeed(kind, typeof account === "string" ? account.slice(0, 200) : "", Math.max(0, Math.min(3650, Number(days) || 0))); } catch { return null; }
    });
    // 全部模型的速度走势（用量明细的折线图，0.3.39）；days：0 = 全部
    ipcMain.handle("pass-speed:series", (_event, days: unknown) => { try { return speedSeries(Math.max(0, Math.min(3650, Number(days) || 0))); } catch { return null; } });
    // 分享卡片（0.3.51）：月报、周报、里程碑的数据，画成 PNG，保存 / 复制（见 share.ts）
    const shareSnapshot = () => getInitialSnapshot();
    ipcMain.handle("share:month", (_event, month: unknown) => shareMonth(shareSnapshot, month));
    ipcMain.handle("share:week", (_event, week: unknown) => shareWeek(shareSnapshot, week));
    ipcMain.handle("share:milestones", () => shareMilestones(shareSnapshot));
    ipcMain.handle("share:render", (_event, kind: unknown, data: unknown, options: unknown) => renderShareCard(kind, data, options));
    ipcMain.handle("share:save", (_event, dataUrl: unknown, name: unknown) => saveShareCard(win, dataUrl, name));
    ipcMain.handle("share:copy", (_event, dataUrl: unknown) => copyShareCard(dataUrl));
    ipcMain.handle("agent:port", (_event, port: unknown) => agentWrite("修改本地路由端口", () => setProxyPort(Number(port))));
    ipcMain.handle("agent:failover", (_event, id: unknown, on: unknown) => agentWrite("修改备用队列", () => setFailover(String(id || ""), on === true)));
    ipcMain.handle("agent:reorder", (_event, app: unknown, ids: unknown) => agentWrite("调整供应商顺序", () => {
      if (!isAgentApp(app) || !Array.isArray(ids)) throw new Error("排序参数不正确");
      return reorderProviders(app, ids.map(String));
    }));
    ipcMain.handle("agent:import-cc", () => agentWrite("从 CC Switch 导入", () => importCcProviders()));
    ipcMain.handle("agent:import-live", (_event, app: unknown) => agentWrite("导入当前配置", () => {
      if (!isAgentApp(app)) throw new Error("不认识这个工具");
      return importCurrent(app);
    }));
    ipcMain.handle("agent:confirm", (_event, token: unknown) => agentConfirm(token));
    ipcMain.handle("agent:backups", () => agentBackups());
    ipcMain.handle("agent:restore", (_event, kind: unknown, id: unknown) => {
      if ((kind !== "history" && kind !== "original") || typeof id !== "string" || id.length > 100) return { ok: false, error: "备份参数无效" };
      return agentWrite(kind === "original" ? "恢复到 TokenPulse 接管前" : "还原配置备份", () => restoreConfigBackup(kind, id), true);
    });
    ipcMain.handle("agent:drift", () => { try { return agentDrift(); } catch { return []; } });
    setInterval(checkDrift, 5000);
    ipcMain.handle("agent:readonly", (_event, on: unknown) => { applyPrefs({ agentReadOnly: on === true }); publishAgent(); return agentView(); });
    ipcMain.handle("agent:models", (_event, input: unknown) => agentCall(() => listProviderModels(input)));
    ipcMain.handle("agent:pool-models", (_event, input: unknown) => agentCall(() => listPoolModels(input)));
    ipcMain.handle("agent:probe", async (_event, id: unknown) => {
      try {
        return { ok: true, result: await probeProvider(String(id || "")) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "检测失败" };
      }
    });
    /*
     * Prism 桥（0.3.19）：随软件带的 Prism Bridge。安装、登录、启动都是用户点了才做；密钥不交给界面。
     * 加成 Codex 供应商走 agentWrite：这家正在用时会改到 Codex 配置，照常先让用户确认。
     */
    const prismProvider = () => {
      const baseUrl = `http://127.0.0.1:${prismState().port}/v1`;
      return coreAgentView().providers.find((item) => item.app === "codex" && !item.official && !item.pool && (item.baseUrl === baseUrl || item.name === PRISM_PROVIDER_NAME));
    };
    /** Codex 里那家供应商的模型和 Prism 现在提供的对不上（比如还留着已经下架的 gpt-6.1-sol）。 */
    const prismProviderStale = () => { const saved = prismProvider(); if (!saved) return false; const now = prismModels().map((item) => item[0]), had = saved.slots.map((slot) => slot.model).filter(Boolean); return !now.includes(saved.model) || had.some((model) => !now.includes(model)); };
    const prismView = () => ({ ...prismState(), provider: !!prismProvider(), providerStale: prismProviderStale(), models: prismModels().map((item) => item[1]) });
    const prismCall = async (work: () => unknown) => {
      try { await work(); return { ok: true as const, state: prismView() }; }
      catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "操作失败", state: prismView() }; }
    };
    onPrismChange(() => { if (win && !win.isDestroyed()) win.webContents.send("prism-bridge", prismView()); });
    ipcMain.handle("prism:state", async () => { await checkPrismProxy().catch(() => undefined); return prismView(); });
    // 0.3.20：代理冲突一键修复、日志文件、占用空间、一键删除（供应商由界面先走「切回官方 + 删除」，这里只删文件）
    ipcMain.handle("prism:fix-proxy", () => prismCall(() => fixPrismProxy()));
    ipcMain.handle("prism:open-log", () => { const file = prismLogFile(); if (file) shell.showItemInFolder(file); else void shell.openPath(prismHome()); return !!file; });
    ipcMain.handle("prism:usage", () => prismDiskUsage().catch(() => 0));
    ipcMain.handle("prism:remove", () => prismCall(() => removePrism()));
    ipcMain.handle("prism:install", () => prismCall(() => installPrism()));
    ipcMain.handle("prism:login", () => prismCall(() => loginPrism()));
    ipcMain.handle("prism:start", () => prismCall(() => startPrism()));
    ipcMain.handle("prism:stop", () => prismCall(() => stopPrism()));
    ipcMain.handle("prism:auto-start", (_event, on: unknown) => prismCall(() => setPrismAutoStart(on === true)));
    ipcMain.handle("prism:provider", () => agentWrite(`保存供应商「${PRISM_PROVIDER_NAME}」`, () => saveProvider({
      id: prismProvider()?.id || "",
      app: "codex",
      name: PRISM_PROVIDER_NAME,
      ...prismEndpoint(),
      upstream: "openai-responses",
      model: prismModels()[0][0],
      websiteUrl: PRISM_ORIGIN,
      notes: "经 TokenPulse 的 Prism 桥访问你自己的 Prism 账号。要先在「Prism 桥」里启动服务。",
      slots: prismModels().map(([model, displayName]) => ({ role: "catalog", model, displayName, contextWindow: 128000, reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "high" })),
    })));
    /*
     * 代理：让软件里所有往外发的请求走同一套规则（环境变量里的代理优先，没有就用系统代理）。
     * - Node 自己发的（本地路由转发、获取模型列表、检测地址）和 curl 发的（查额度、续期、出口检测、IP 数据库）：
     *   通过下面这个解析器问系统代理（见 upstream-proxy.ts）；
     * - Electron 内核发的（自动更新、模型知识库更新）：本来只认系统代理、不认环境变量。只设了环境变量、系统代理没开的机器上，
     *   把环境变量里的代理告诉它（alignElectronProxy）。
     */
    setSystemProxyResolver((url) => session.defaultSession.resolveProxy(url));
    void alignElectronProxy().catch(() => undefined);
    resumePrism();
    configReason("启动时恢复本地路由");
    // 0.3.15：启动时会顺手修复旧版本留下的坏配置（见 repairAgentConfigs）。修复说明等界面来取，免得界面还没加载好就发过去丢了
    let startupNotice = "";
    const resumed = resumeAgentProxy().finally(() => configReason("")).then(() => {
      const notice = agentView().notice || "";
      if (/已自动修复|发现需要修复|透明转发没有恢复/.test(notice)) startupNotice = notice;
      publishAgent();
    }).catch((error) => console.error("[TokenPulse] 本地路由没有恢复", error));
    ipcMain.handle("agent:startup-notice", async () => { await resumed; const notice = startupNotice; startupNotice = ""; return notice; });
    ipcMain.handle("models:calibration", (_event, value: unknown) => updateCalibration(value));
    // 时间线上标注「本机以外的使用」：改了之后容量要重算，不用重新查额度
    ipcMain.handle("models:offmachine", (_event, value: unknown) => { const marks = updateMark(value); backgroundRefresh(false); return marks; });
    ipcMain.handle("models:study", (_event, value: unknown) => loadModelStudy(parseModelStudyQuery(value)));
    ipcMain.handle("models:candidates", (_event, kind: unknown) => {
      if (kind !== "claude" && kind !== "chatgpt" && kind !== "grok") return [];
      return modelCandidates(kind, STUDY_FAMILY[kind]);
    });
    ipcMain.handle("requests:query", (_event, query: unknown) => loadRequests(parseRequestQuery(query)));
    // 新手引导的演示数据：单独的进程、单独的临时目录（demo.ts），查询参数照样在这里校验
    ipcMain.handle("demo:snapshot", () => demoCall("snapshot"));
    ipcMain.handle("demo:study", (_event, value: unknown) => demoCall("study", parseModelStudyQuery(value)));
    ipcMain.handle("demo:requests", (_event, query: unknown) => demoCall("requests", parseRequestQuery(query)));
    ipcMain.handle("demo:end", () => endDemo());

    ipcMain.handle("health:run", () => runHealthCheck(exitMonitor));
    ipcMain.handle("sessions:list", () => loadSessions());
    ipcMain.handle("sessions:search", (_event, query: unknown, kind: unknown) => searchSessionText(typeof query === "string" ? query.slice(0, 200) : "", typeof kind === "string" ? kind : "all"));
    ipcMain.handle("sessions:detail", (_event, kind: unknown, id: unknown) => {
      if (!isAgentKind(kind) || typeof id !== "string") throw new Error("会话参数无效");
      return loadSessionDetail(kind, id);
    });
    ipcMain.handle("sessions:copy-project", async (_event, kind: unknown, id: unknown) => {
      const { session } = await sessionOf(kind, id);
      if (!session.cwd) throw new Error("这个会话没有记录项目地址");
      clipboard.writeText(session.cwd);
      return { ok: true, cwd: session.cwd };
    });
    ipcMain.handle("sessions:copy-text", (_event, text: unknown) => {
      if (typeof text !== "string" || text.length > 200_000) throw new Error("内容无效");
      clipboard.writeText(text);
      return true;
    });
    ipcMain.handle("sessions:terminal", (_event, kind: unknown, id: unknown) => openInTerminal(kind, id));
    ipcMain.handle("sessions:prepare-resume", (_event, kind: unknown, id: unknown) => prepareResume(kind, id));
    ipcMain.handle("sessions:clis", () => installedClis());
    ipcMain.handle("sessions:new", (_event, kind: unknown, folder: unknown) => startConversation(kind, folder));
    ipcMain.handle("sessions:pick-folder", (_event, start: unknown) => pickProjectFolder(start));
    ipcMain.handle("sessions:delete", (_event, kind: unknown, id: unknown) => deleteConversation(kind, id));
    ipcMain.handle("export-csv", async (_event, content: unknown, kind: unknown) => {
      if (typeof content !== "string" || Buffer.byteLength(content) > 10 * 1024 * 1024) {
        throw new Error("导出内容无效或过大");
      }
      // 文件名用本地日期：toISOString 是 UTC，东八区早上 8 点前导出会标成前一天。
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const requests = kind === "requests";
      const options = {
        title: tr(requests ? "导出请求记录" : "导出用量明细"),
        defaultPath: requests ? `TokenPulse-${tr("请求记录") === "请求记录" ? "请求记录" : "requests"}-${today}.csv` : `TokenPulse-${today}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      };
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await fs.writeFile(result.filePath, "\uFEFF" + content, "utf8");
      return true;
    });

    scheduleQuotaChecks();
    backgroundRefresh(true);
    void deepseekBalance.refreshAll(false);
    void antigravityQuota.refresh(false);
    setInterval(() => { if (!windowAway || Date.now() - lastScanAt >= AWAY_SCAN_EVERY_MS - 1000) backgroundRefresh(false); }, SCAN_EVERY_MS);

    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });

  /*
   * 「关闭窗口时收进托盘」开着，close 事件里已经拦下改成隐藏，走不到这里。
   * 走到这里说明用户关掉了这个选项、明确要「关窗口就退出」：以前这里不退，
   * 进程带着托盘继续跑，那个开关等于没用。
   */
  app.on("window-all-closed", () => {
    if (quitting || !readPrefs().closeToTray) app.quit();
  });

  let agentQuitReady = false, agentQuitPending = false;
  app.on('before-quit', event => {
    destroyTrayPanel();
    destroyDeskPet();
    if (agentQuitReady) { quitting = true; exitMonitor.stop(); tokensUploader.stop(); deepseekBalance.stop(); antigravityQuota.stop(); releasePrism(); return; }
    event.preventDefault();
    if (agentQuitPending) return;
    agentQuitPending = true;
    const failed = (error: unknown) => {
      agentQuitPending = false; quitting = false;
      console.error('[TokenPulse] 配置恢复失败，取消退出', error);
      dialog.showErrorBox('暂不能安全退出', error instanceof Error ? error.message : '请先解决配置恢复问题，再退出 TokenPulse。');
    };
    configReason("退出时恢复工具配置");
    try { releaseAgentSwitch(); } catch (error) { configReason(""); failed(error); return; }
    configReason("");
    void waitAgentProxyClosed().then(() => { agentQuitReady = true; app.quit(); }).catch(failed);
  });
}
