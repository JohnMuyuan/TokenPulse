/*
 * 桌宠（0.3.61）：桌面上一只像素小动物，表现剩余额度和本机 Agent 在不在干活；点一下冒出一个像素对话气泡，写着正在用的账号的额度。
 *
 * - 默认关闭，在「桌宠」页打开。关着的时候不建窗口、不扫会话文件。
 * - 宠物窗口透明、不占任务栏、不抢焦点；只有点在宠物身上才接鼠标，透明的地方点下去落到后面的窗口（setIgnoreMouseEvents + forward）。
 * - 任务状态只读会话文件推断（core/agent-activity.ts）：盯着会话目录，有文件变了马上看一次；另外空闲 4 秒、有任务在跑 1 秒兜底看一次。
 *   电脑 5 分钟没人动、也没有任务在跑，宠物去睡觉。
 * - 气泡是单独的透明窗口（desk-pet-bubble.html）：点宠物出来的是额度，右键「查看任务」出来的是任务列表。
 *   失焦、再点宠物、按 Esc 收起，鼠标不在上面 8 秒自己收起（在页面里计时）；收起两分钟后销毁。
 * 位置存的是宠物脚下的中点，换大小、换屏幕后都从这一点放回去，并保证整只在屏幕的可用区域里。
 * - 问题卡片（desk-pet-ask.html）：Agent 在问你（选择题、计划等你批准）时弹在屏幕右下角，写着问题和选项；回答了、点「知道了」就收起。
 *   不抢焦点（你多半正在终端里打字），挡住宠物时挪到宠物头顶。回答还是在终端里：TokenPulse 只读会话文件，不往 CLI 里写东西。
 */
import { BrowserWindow, Menu, powerMonitor, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Snapshot } from "../core/report";
import { ActivityScanner, type ActivityState, type AgentAsk, type AgentTask } from "../core/agent-activity";
import { listPetSounds } from "../core/pet-sound-file";
import { accountIdOf } from "../core/accounts";
import { authFile, claudeProfileFile, readCliAccounts } from "../core/credentials";
import { anchorOf, askBounds, bubbleBounds, flingPath, GRID, jumpPoint, MINI_POSE, miniBounds, miniSpriteCenter, PACK_ID, petBounds, petMode, petPhase, petQuota, petWindowSize, pickPetAccount, reachesRightEdge, releaseVelocity, type BubblePlace, type DeskPetPrefs, type DragSample, type PetMood, type PetUsing } from "../core/desk-pet-model";
import { petPackImages } from "../core/pet-pack";
import { tr } from "./i18n";

type Account = Snapshot["accounts"][number];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

type TaskBrief = Pick<AgentTask, "key" | "kind" | "agent" | "title" | "project" | "status" | "tool" | "since" | "doneAt"> & { asking: boolean };
export type AskCard = Pick<AgentTask, "key" | "kind" | "agent" | "title" | "project"> & { ask: AgentAsk };
export type DeskPetAskData = { now: number; theme: "light" | "dark"; cards: AskCard[]; more: number };
type BubbleWindow = { used: number; resetAt: number; high: boolean };
export type BubbleView = "quota" | "tasks";
export type DeskPetBubbleData = {
  now: number; theme: "light" | "dark"; view: BubbleView;
  /** 每打开一次加一：页面看到它变了就重新播一次冒出来的动画、重新开始 8 秒计时。 */
  opened: number;
  place: Pick<BubblePlace, "side" | "at">;
  /** quiet：后台账号（「后台账号少查一点」，半小时才查一次），过期的判断放宽。 */
  account: { kind: string; name: string; plan: string; checkedAt: number; quiet?: boolean; five: BubbleWindow | null; week: BubbleWindow | null } | null;
  quota: number | null; mood: PetMood;
  tasks: { running: TaskBrief[]; recent: TaskBrief[] }; scanned: boolean;
};
type Options = {
  preload: string;
  prefs: () => DeskPetPrefs & { theme: "light" | "dark" };
  savePos: (pos: { x: number; y: number } | null) => void;
  /** 进出极简模式（贴屏幕右边）。 */
  saveMini: (on: boolean) => void;
  hide: () => void;
  snapshot: () => Snapshot | null;
  title: (account: Account) => string;
  openMain: (target?: { page: string }) => void;
  openSettings: () => void;
  refresh: () => void;
};

const OFFSCREEN = () => !!process.env.TOKENPULSE_DESK_PET_OFFSCREEN;
/** 会话文件多久看一次：空闲时 4 秒，有任务在跑 1 秒。会话目录有文件变了（fs.watch）另外马上看一次，这两个只是兜底。 */
const SCAN_EVERY_MS = 4000, SCAN_BUSY_MS = 1000;
/** 会话文件变了以后等多久再看（一下子写好几行只看一次）、两次之间至少隔多久。 */
const SCAN_SOON_MS = 300, SCAN_GAP_MS = 500;
const BUBBLE_DESTROY_MS = 2 * 60_000;
/** 会话里的工具 → 它用哪家的额度。 */
const TASK_ACCOUNT = { claude: "claude", codex: "chatgpt" } as const;

let options: Options | null = null;
let pet: BrowserWindow | null = null;
let bubble: BrowserWindow | null = null;
let askWin: BrowserWindow | null = null;
/** 问题卡片的大小（页面量好告诉主进程）；点了「知道了」的提问（任务 key|调用 id），回答了就从这里清掉。 */
let askBox = { width: 340, height: 180 }, lastAsk = "";
const dismissed = new Set<string>();
/** 卡片里最多同时摆几个提问，多的写「还有 N 个」。 */
const ASK_CARDS = 3;
let scanner: ActivityScanner | null = null;
let activity: ActivityState | null = null;
let scanTimer: NodeJS.Timeout | null = null, cursorTimer: NodeJS.Timeout | null = null, dragTimer: NodeJS.Timeout | null = null, bubbleTimer: NodeJS.Timeout | null = null, flyTimer: NodeJS.Timeout | null = null;
let scanning = false, listening = false, interactive = false, bubbleShown = false;
/** 盯着会话目录的 watcher；soonTimer 是文件变了以后那次扫描；scanGen 每次 stopTimers 加一，旧的扫描循环看到就不再排下一次。 */
let watchers: fs.FSWatcher[] = [], soonTimer: NodeJS.Timeout | null = null, scanGen = 0;
let lastView = "", lastCursor = "", lastQuota: { id: string; quota: number; mood: PetMood } | null = null, lastKind = "";
/** 最近一次有任务的是哪家（任务做完十分钟后不在 activity 里了，靠它记住「最近用的」）。 */
let lastUsedKind: Account["kind"] | null = null;
let bubbleBox = { width: 236, height: 120 }, bubbleView: BubbleView = "quota", bubbleOpened = 0, bubbleHiddenAt = 0;
let bubblePlace: BubblePlace | null = null;
let drag: { dx: number; dy: number; size: { width: number; height: number }; at: { x: number; y: number; width: number; height: number }; trail: DragSample[] } | null = null;
/** 上次发给宠物窗口的「电脑多久没人动」（秒）。 */
let lastIdle = -1;

export function setupDeskPet(next: Options) {
  options = next;
  if (!listening) {
    listening = true;
    // 拔掉副屏、改分辨率：把宠物放回还在的屏幕里
    const replace = () => { if (pet && !pet.isDestroyed() && !drag) placePet(); };
    screen.on("display-removed", replace);
    screen.on("display-metrics-changed", replace);
  }
  syncDeskPet();
}

function workAreaFor(anchor: { x: number; y: number } | null) {
  return (anchor ? screen.getDisplayNearestPoint(anchor) : screen.getPrimaryDisplay()).workArea;
}
function spriteSize() { const scale = options?.prefs().deskPetScale ?? 2; return { width: GRID.width * scale, height: GRID.height * scale }; }

function placePet() {
  if (!options || !pet || pet.isDestroyed()) return;
  if (flyTimer) return;
  const prefs = options.prefs();
  const size = petWindowSize(prefs.deskPetScale);
  const work = workAreaFor(prefs.deskPetPos);
  const bounds = prefs.deskPetMini ? miniBounds(prefs.deskPetPos, size, work) : petBounds(prefs.deskPetPos, size, work);
  pet.setBounds(OFFSCREEN() ? { ...bounds, x: -20000, y: -20000 } : bounds);
  if (bubbleVisible()) placeBubble();
  placeAsk();
}

function createPet() {
  if (!options) return;
  const prefs = options.prefs();
  const size = petWindowSize(prefs.deskPetScale);
  const next = new BrowserWindow({
    ...size, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: prefs.deskPetOnTop, title: "TokenPulse",
    webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  pet = next;
  interactive = false;
  next.setIgnoreMouseEvents(true, { forward: true });
  next.setMenuBarVisibility(false);
  next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  next.loadFile(path.join(__dirname, "..", "..", "renderer", "desk-pet.html"), { query: { theme: prefs.theme } });
  next.once("ready-to-show", () => { if (next.isDestroyed()) return; placePet(); applyLook(); next.showInactive(); });
  next.on("closed", () => { if (pet === next) { pet = null; stopTimers(); } });
  placePet();
  startTimers();
}

function applyLook() {
  if (!options || !pet || pet.isDestroyed()) return;
  const prefs = options.prefs();
  pet.setOpacity(prefs.deskPetOpacity / 100);
  if (prefs.deskPetOnTop) pet.setAlwaysOnTop(true, "pop-up-menu"); else pet.setAlwaysOnTop(false);
}

/** 设置变了：开关、大小、透明度、换宠物都在这里落实。 */
export function syncDeskPet() {
  if (!options) return;
  const prefs = options.prefs();
  if (!prefs.deskPet) { destroyDeskPet(); return; }
  if (!pet || pet.isDestroyed()) { createPet(); return; }
  const size = petWindowSize(prefs.deskPetScale), now = pet.getBounds();
  if (now.width !== size.width || now.height !== size.height) placePet();
  applyLook();
  pushDeskPet(true);
  if (bubbleVisible()) pushBubble();
  syncAsk(true);
}

function startTimers() {
  stopTimers();
  scanner ??= new ActivityScanner();
  const gen = scanGen;
  let lastScan = 0, again = false;
  const scan = async () => {
    if (!scanner || gen !== scanGen) return;
    // 正在看：看完再来一次（这次的变化可能没赶上）
    if (scanning) { again = true; return; }
    scanning = true; lastScan = Date.now();
    try {
      const before = activity;
      activity = await scanner.scan();
      lastUsedKind = usingKinds()[0] ?? lastUsedKind;
      // 和上一次比：做完了庆祝；出错停下、刚变成「可能在等你」的提醒一下（宠物窗口按设置响提示音）
      if (before && activity.finished.length) sendEvent({ type: "celebrate" });
      if (before && activity.failed.length) sendEvent({ type: "alert", kind: "error" });
      if (before && activity.asked.length) sendEvent({ type: "alert", kind: "ask" });
      if (before && activity.needsYou.length) sendEvent({ type: "alert", kind: "waiting" });
      pushDeskPet();
      if (bubbleVisible()) pushBubble(true);
      syncAsk();
    } catch (error) { console.error("[TokenPulse] 桌宠读取会话状态失败", error); }
    finally { scanning = false; if (again) { again = false; soon(); } }
  };
  const soon = () => {
    if (soonTimer || gen !== scanGen) return;
    soonTimer = setTimeout(() => { soonTimer = null; void scan(); }, Math.max(SCAN_SOON_MS, SCAN_GAP_MS - (Date.now() - lastScan)));
  };
  // 兜底的定时扫描：有任务在跑看得勤一点
  const loop = () => {
    if (gen !== scanGen) return;
    scanTimer = setTimeout(() => { void scan().finally(loop); }, activity?.running.length ? SCAN_BUSY_MS : SCAN_EVERY_MS);
  };
  void scan().finally(loop);
  // 会话目录有 .jsonl 变了：马上看一次（新文件先把目录重扫一遍）。建不起来（目录不存在之类）就只靠定时扫描
  for (const dir of scanner.watchRoots()) {
    try {
      const watcher = fs.watch(dir, { recursive: true, persistent: false }, (event, name) => {
        if (!name || !String(name).endsWith(".jsonl")) return;
        if (event === "rename") scanner?.poke();
        soon();
      });
      watcher.on("error", () => { watcher.close(); watchers = watchers.filter((item) => item !== watcher); });
      watchers.push(watcher);
    } catch { /* 目录不在：等定时扫描 */ }
  }
  // 眼睛跟着鼠标：只发宠物身体中心到鼠标的相对位置，变了才发。眼睛要立刻跟上，绕着宠物转圈会晕（宠物窗口里判断），都要采得密：
  // 鼠标在动（1.5 秒内动过）时每 16 毫秒看一次，停着时隔一次看一次（Windows 计时器一格约 15.6 毫秒，实际约 32 毫秒，一动最多晚这么久就跟上）
  let tick = 0, movedAt = 0, idleAt = 0;
  cursorTimer = setInterval(() => {
    if (!pet || pet.isDestroyed() || !pet.isVisible() || drag) return;
    const now = Date.now();
    if (now - movedAt > 1500 && ++tick % 2) return;
    // 睡眠序列要知道电脑多久没人动（键盘鼠标都算）；一秒看一次，变了才发。测试时（屏幕外）由测试自己发
    if (!OFFSCREEN() && now - idleAt >= 1000) { idleAt = now; const idle = idleSeconds(); if (idle !== lastIdle) { lastIdle = idle; pet.webContents.send("desk-pet-idle", idle); } }
    const point = screen.getCursorScreenPoint(), bounds = pet.getBounds(), sprite = spriteSize();
    const rel = { x: Math.round(point.x - (bounds.x + bounds.width / 2)), y: Math.round(point.y - (bounds.y + bounds.height - sprite.height * 0.55)) };
    const key = `${Math.round(rel.x / 4)},${Math.round(rel.y / 4)}`;
    if (key === lastCursor) return;
    lastCursor = key; movedAt = now;
    pet.webContents.send("desk-pet-cursor", rel);
  }, 16);
}

function stopTimers() {
  scanGen++;
  for (const timer of [scanTimer, cursorTimer, dragTimer, flyTimer, soonTimer]) if (timer) clearInterval(timer);
  scanTimer = cursorTimer = dragTimer = flyTimer = soonTimer = null;
  for (const watcher of watchers) watcher.close();
  watchers = [];
  drag = null; lastIdle = -1;
}

function idleSeconds() { try { return powerMonitor.getSystemIdleTime(); } catch { return 0; } }

/* ---------------- 正在用的账号 ---------------- */

/** 现在在用哪家：有任务在跑的（最近有动静的在前），然后是刚做完的，再然后是之前记住的。 */
function usingKinds(): Account["kind"][] {
  const out: Account["kind"][] = [];
  const add = (kind: Account["kind"] | null | undefined) => { if (kind && !out.includes(kind)) out.push(kind); };
  for (const task of [...(activity?.running ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)) add(TASK_ACCOUNT[task.kind]);
  for (const task of [...(activity?.recent ?? [])].sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))) add(TASK_ACCOUNT[task.kind]);
  add(lastUsedKind);
  return out;
}

/** 各家 CLI 当前登录的账号 id。登录文件没变就不重读（~/.claude.json 可能有好几 MB）。 */
const loginCache = new Map<string, { stamp: string; id: string }>();
function currentLogin(kind: "claude" | "chatgpt") {
  const files = kind === "claude" ? [authFile("claude"), claudeProfileFile()] : [authFile("chatgpt")];
  const stamp = files.map((file) => { try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return "-"; } }).join("|");
  const hit = loginCache.get(kind);
  if (hit && hit.stamp === stamp) return hit.id;
  let id = "";
  try { const ref = readCliAccounts(kind)[0]?.ref; if (ref) id = accountIdOf(kind, ref); } catch { /* 读不出来：当作不知道 */ }
  loginCache.set(kind, { stamp, id });
  return id;
}
function petUsing(): PetUsing {
  const current: PetUsing["current"] = {};
  for (const kind of ["claude", "chatgpt"] as const) { const id = currentLogin(kind); if (id) current[kind] = id; }
  return { kinds: usingKinds(), current };
}

/** 宠物要画的状态。和上次一样就不发（force：设置变了，照样发一次）。 */
export function deskPetView() {
  if (!options) return null;
  const prefs = options.prefs();
  const quota = petQuota(options.snapshot(), prefs.deskPetAccount, options.title, prefs.deskPetAccount ? undefined : petUsing());
  const running = activity?.running ?? [];
  return {
    pet: prefs.deskPetKind, scale: prefs.deskPetScale, theme: prefs.theme, fidget: prefs.deskPetFidget, badge: prefs.deskPetBadge,
    sound: prefs.deskPetSound, volume: prefs.deskPetVolume, mute: prefs.deskPetMute,
    // 换成自己音频的提示音：种类 → 导入时间（变了宠物窗口重新要一次数据）
    sounds: Object.fromEntries(Object.entries(listPetSounds()).map(([kind, item]) => [kind, item!.at])),
    mini: prefs.deskPetMini ? MINI_POSE : null,
    quota: quota.quota, mood: quota.mood, account: quota.account,
    mode: petMode(activity, idleSeconds()), phase: petPhase(activity), tasks: running.length, waiting: running.filter((task) => task.status === "waiting").length, asking: running.filter((task) => task.ask).length,
    // 在跑的子代理一共几个（主题包宠物按它换「同时忙好几件」的姿势）
    subagents: running.reduce((sum, task) => sum + (task.subagents ?? 0), 0),
  };
}

export function pushDeskPet(force = false) {
  if (!pet || pet.isDestroyed() || !options) return;
  const view = deskPetView();
  if (!view) return;
  // 额度一下子多了 30 个点以上：窗口重置了，补满一下
  if (view.quota != null) {
    const id = options.prefs().deskPetAccount + "|" + view.account;
    if (lastQuota && lastQuota.id === id && view.quota - lastQuota.quota >= 30) sendEvent({ type: "restock", from: lastQuota.quota });
    // 同一个账号的额度刚用完：提醒一下
    if (lastQuota && lastQuota.id === id && view.mood === "empty" && lastQuota.mood !== "empty") sendEvent({ type: "alert", kind: "empty" });
    lastQuota = { id, quota: view.quota, mood: view.mood };
  }
  if (view.pet !== lastKind) { lastKind = view.pet; pet.webContents.send("desk-pet-pack", PACK_ID.test(view.pet) ? petPackImages(view.pet) : null); }
  const json = JSON.stringify(view);
  if (!force && json === lastView) return;
  lastView = json;
  pet.webContents.send("desk-pet-state", view);
}

export type PetAlert = "error" | "ask" | "waiting" | "empty";
function sendEvent(event: { type: "celebrate" } | { type: "restock"; from: number } | { type: "bubble"; open: boolean } | { type: "fly" } | { type: "landed" } | { type: "alert"; kind: PetAlert }) {
  if (pet && !pet.isDestroyed()) pet.webContents.send("desk-pet-event", event);
}

/** 宠物窗口加载好了来要第一份数据。 */
export function deskPetReady() {
  lastView = "";
  const view = deskPetView();
  lastKind = view?.pet ?? "";
  if (view) lastView = JSON.stringify(view);
  return { view, pack: view && PACK_ID.test(view.pet) ? petPackImages(view.pet) : null };
}

/** 鼠标在不在宠物身上：在的时候接鼠标，不在的时候点击穿透到后面。 */
export function deskPetHit(on: boolean) {
  if (!pet || pet.isDestroyed() || drag || on === interactive) return;
  interactive = on;
  pet.setIgnoreMouseEvents(!on, { forward: true });
}

export function deskPetDrag(phase: "start" | "end") {
  if (!pet || pet.isDestroyed() || !options) return;
  if (phase === "start") {
    if (drag) return;
    hideBubble();
    stopFlying();
    const point = screen.getCursorScreenPoint(), bounds = pet.getBounds();
    // 大小用算出来的，不用 getBounds()：屏幕缩放 150% 这类非整数倍时，把读回来的大小再设回去，窗口每次会大一像素，
    // 宠物画在底边中间，光标停着不动也会一直漂。光标没动就不碰窗口
    const size = petWindowSize(options.prefs().deskPetScale);
    let dx = point.x - bounds.x;
    // 从屏幕边上拽出来：退出极简模式，宠物回到窗口中间，抓着的就是它的身子中间
    if (options.prefs().deskPetMini) { options.saveMini(false); pushDeskPet(true); dx = Math.round(size.width / 2); }
    drag = { dx, dy: point.y - bounds.y, size, at: { x: bounds.x, y: bounds.y, ...size }, trail: [{ x: bounds.x, y: bounds.y, t: Date.now() }] };
    pet.setIgnoreMouseEvents(false); interactive = true;
    dragTimer = setInterval(() => {
      if (!pet || pet.isDestroyed() || !drag) return;
      const point = screen.getCursorScreenPoint();
      const x = point.x - drag.dx, y = point.y - drag.dy;
      if (x === drag.at.x && y === drag.at.y) return;
      drag.at = { x, y, ...drag.size };
      drag.trail.push({ x, y, t: Date.now() });
      if (drag.trail.length > 12) drag.trail.shift();
      pet.setBounds(drag.at);
    }, 16);
    return;
  }
  if (!drag) return;
  if (dragTimer) clearInterval(dragTimer);
  const dropped = drag.at, trail = drag.trail;
  dragTimer = null; drag = null;
  const velocity = OFFSCREEN() ? { x: 0, y: 0 } : releaseVelocity(trail, Date.now());
  if (!velocity.x && !velocity.y) { settle(dropped, false); return; }
  // 甩出去：按速度滑一段，碰边弹回来；用力甩到右边就贴边藏起来
  const work = screen.getDisplayNearestPoint(anchorOf(dropped)).workArea;
  const { points, hitRight } = flingPath(dropped, velocity, { minX: work.x, maxX: work.x + work.width - dropped.width, minY: work.y, maxY: work.y + work.height - dropped.height });
  let i = 0;
  flyTimer = setInterval(() => {
    if (!pet || pet.isDestroyed()) { stopFlying(); return; }
    const point = points[i++];
    if (point) pet.setBounds({ x: point.x, y: point.y, width: dropped.width, height: dropped.height });
    if (i >= points.length) { stopFlying(); settle({ ...dropped, ...(points[points.length - 1] ?? dropped) }, hitRight); }
  }, 16);
}

function stopFlying() {
  if (flyTimer) clearInterval(flyTimer);
  flyTimer = null;
}

/** 停下来了：记住位置；宠物到了（或伸出了）屏幕右边就贴边藏起来。宠物窗口收到 landed 播落地。 */
function settle(at: { x: number; y: number; width: number; height: number }, toEdge: boolean) {
  if (!options) return;
  const work = screen.getDisplayNearestPoint(anchorOf(at)).workArea;
  options.savePos(anchorOf(at));
  if (toEdge || (!OFFSCREEN() && reachesRightEdge(at, spriteSize(), work))) options.saveMini(true);
  sendEvent({ type: "landed" });
  placePet();
  pushDeskPet(true);
}

/**
 * 右键菜单进出极简模式：抛物线跳过去。进的时候跳到右边贴好再藏；出的时候先探出来，往左跳一段落地。
 * 测试时（屏幕外）不跳，直接换。
 */
export function setDeskPetMini(on: boolean) {
  if (!pet || pet.isDestroyed() || !options || drag) return;
  const o = options, prefs = o.prefs();
  if (prefs.deskPetMini === on) return;
  hideBubble();
  stopFlying();
  const size = petWindowSize(prefs.deskPetScale), from = pet.getBounds(), work = screen.getDisplayMatching(from).workArea;
  const to = on ? miniBounds(prefs.deskPetPos, size, work) : petBounds({ x: work.x + work.width - Math.round(spriteSize().width * 1.4), y: from.y + size.height }, size, work);
  if (!on) { o.saveMini(false); pushDeskPet(true); }
  const done = () => { o.savePos(anchorOf(to)); if (on) o.saveMini(true); sendEvent({ type: "landed" }); placePet(); pushDeskPet(true); };
  if (OFFSCREEN()) { done(); return; }
  sendEvent({ type: "fly" });
  const start = Date.now(), ms = 520, arc = Math.round(size.height * 0.6);
  flyTimer = setInterval(() => {
    if (!pet || pet.isDestroyed()) { stopFlying(); return; }
    const u = Math.min(1, (Date.now() - start) / ms), point = jumpPoint(from, to, u, arc);
    pet.setBounds({ ...point, width: size.width, height: size.height });
    if (u >= 1) { stopFlying(); done(); }
  }, 16);
}

export function deskPetClick() { toggleBubble("quota"); }

export function deskPetMenu() {
  if (!pet || pet.isDestroyed() || !options) return;
  const o = options;
  Menu.buildFromTemplate([
    { label: tr("查看额度"), click: () => openDeskPetBubble("quota") },
    { label: tr("查看任务"), click: () => openDeskPetBubble("tasks") },
    { label: tr("立即刷新"), click: () => o.refresh() },
    { type: "separator" },
    { label: o.prefs().deskPetMini ? tr("退出极简模式") : tr("极简模式（贴到屏幕右边）"), click: () => setDeskPetMini(!o.prefs().deskPetMini) },
    { label: tr("桌宠设置"), click: () => o.openSettings() },
    { label: tr("打开 TokenPulse"), click: () => o.openMain() },
    { type: "separator" },
    { label: tr("隐藏桌宠"), click: () => o.hide() },
  ]).popup({ window: pet });
}

/** 把宠物放回主屏右下角（找不到宠物的时候用）。 */
export function resetDeskPetPosition() {
  if (!options) return;
  stopFlying();
  options.savePos(null);
  if (options.prefs().deskPetMini) options.saveMini(false);
  placePet();
  pushDeskPet(true);
}

/* ---------------- 对话气泡 ---------------- */

function bubbleVisible() { return !!bubble && !bubble.isDestroyed() && bubble.isVisible(); }

function placeBubble() {
  if (!bubble || bubble.isDestroyed() || !pet || pet.isDestroyed()) return;
  const real = pet.getBounds(), work = screen.getDisplayMatching(real).workArea, sprite = spriteSize();
  // 极简模式：宠物只露出右边一截，气泡对着露出来的那截
  const bounds = options?.prefs().deskPetMini ? { ...real, x: Math.round(miniSpriteCenter(work, sprite) - real.width / 2) } : real;
  const place = bubbleBounds(bounds, sprite, bubbleBox, work);
  const moved = !bubblePlace || bubblePlace.side !== place.side || bubblePlace.at !== place.at;
  bubblePlace = place;
  bubble.setBounds(OFFSCREEN() ? { x: -20000, y: -21000, width: place.width, height: place.height } : { x: place.x, y: place.y, width: place.width, height: place.height });
  if (moved) pushBubble();
}

function brief(task: AgentTask): TaskBrief {
  return { key: task.key, kind: task.kind, agent: task.agent, title: task.title, project: task.project, status: task.status, tool: task.tool, since: task.since, doneAt: task.doneAt, asking: !!task.ask };
}
function bubbleWindow(window: Account["five"]): BubbleWindow | null {
  return window ? { used: clamp(window.used, 0, 100), resetAt: window.resetAt ?? 0, high: window.pressure === "high" } : null;
}
export function deskPetBubbleData(): DeskPetBubbleData | null {
  if (!options) return null;
  const prefs = options.prefs(), snapshot = options.snapshot();
  const using = prefs.deskPetAccount ? undefined : petUsing();
  const account = pickPetAccount(snapshot?.accounts ?? [], prefs.deskPetAccount, using);
  const quota = petQuota(snapshot, prefs.deskPetAccount, options.title, using);
  return {
    now: Date.now(), theme: prefs.theme, view: bubbleView, opened: bubbleOpened,
    place: { side: bubblePlace?.side ?? "down", at: bubblePlace?.at ?? Math.round(bubbleBox.width / 2) },
    account: account ? { kind: account.kind, name: options.title(account), plan: account.plan ?? "", checkedAt: account.lastCheckedAt ?? account.lastSampleAt ?? 0, ...(account.quiet ? { quiet: true } : {}), five: bubbleWindow(account.five), week: bubbleWindow(account.week) } : null,
    quota: quota.quota, mood: quota.mood,
    tasks: { running: (activity?.running ?? []).map(brief), recent: (activity?.recent ?? []).map(brief) }, scanned: !!activity,
  };
}
let bubbleSent = { json: "", at: 0 };
/** 把气泡要画的东西发过去。changedOnly：扫描完顺手更新的，内容没变、离上次不到 4 秒就不发（扫描现在可能一秒一次）。 */
function pushBubble(changedOnly = false) {
  if (!bubble || bubble.isDestroyed()) return;
  const data = deskPetBubbleData(), json = JSON.stringify({ ...data, now: 0 }), now = Date.now();
  if (changedOnly && json === bubbleSent.json && now - bubbleSent.at < SCAN_EVERY_MS) return;
  bubbleSent = { json, at: now };
  bubble.webContents.send("desk-pet-bubble", data);
}

/** 右键菜单「查看额度」「查看任务」：打开气泡，开着就换到那一页。 */
export function openDeskPetBubble(view: BubbleView) { toggleBubble(view, true); }

/** 点宠物：开着就收起，收着就打开。从右键菜单来的（open）只打开；开着别的那页就换过去。 */
function toggleBubble(view: BubbleView, open = false) {
  if (!options || !pet || pet.isDestroyed()) return;
  if (bubbleVisible()) {
    if (open && bubbleView !== view) { bubbleView = view; bubbleOpened++; pushBubble(); }
    else if (!open) hideBubble();
    return;
  }
  if (!open && Date.now() - bubbleHiddenAt < 300) return;
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  bubbleView = view; bubbleOpened++;
  const fresh = !bubble || bubble.isDestroyed();
  if (fresh) {
    const next = new BrowserWindow({
      width: bubbleBox.width, height: bubbleBox.height, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, title: "TokenPulse",
      webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    next.setMenuBarVisibility(false);
    next.loadFile(path.join(__dirname, "..", "..", "renderer", "desk-pet-bubble.html"), { query: { theme: options.prefs().theme } });
    next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // 点宠物会先让气泡失焦：记下时间，紧接着的那一下点击是要关，不是再打开
    // 自己 hide() 也会触发 blur，而且在 Windows 上会晚一点到、那时 isVisible() 还是 true：按自己记的「开着」判断
    next.on("blur", () => { if (bubbleShown) { bubbleHiddenAt = Date.now(); hideBubble(); } });
    next.on("closed", () => { if (bubble === next) { bubble = null; bubblePlace = null; bubbleShown = false; } });
    bubble = next;
  }
  const target = bubble!;
  const show = () => {
    if (target.isDestroyed()) return;
    placeBubble(); pushBubble();
    target.setAlwaysOnTop(true, "pop-up-menu");
    target.show(); target.focus(); bubbleShown = true;
    sendEvent({ type: "bubble", open: true });
  };
  if (fresh) target.once("ready-to-show", show); else show();
}

export function hideBubble() {
  if (!bubble || bubble.isDestroyed() || !bubble.isVisible()) return;
  bubbleShown = false;
  bubble.hide();
  sendEvent({ type: "bubble", open: false });
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { if (bubble && !bubble.isDestroyed() && !bubble.isVisible()) bubble.destroy(); }, BUBBLE_DESTROY_MS);
}

/** 页面量好的气泡大小（不含描边和尾巴）。 */
export function resizeDeskPetBubble(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  const next = { width: clamp(Math.round(width), 120, 420), height: clamp(Math.round(height), 40, 700) };
  if (next.width === bubbleBox.width && next.height === bubbleBox.height) return;
  bubbleBox = next;
  if (bubble && !bubble.isDestroyed()) placeBubble();
}

export function deskPetBubbleAction(action: unknown, value?: unknown) {
  if (!options) return;
  if (action === "close") hideBubble();
  else if (action === "sessions" && (value == null || (typeof value === "string" && value.length < 300))) { hideBubble(); options.openMain({ page: "sessions" }); }
}

/** 快照更新时：宠物和开着的气泡都跟着更新。 */
export function deskPetSnapshotChanged() {
  pushDeskPet();
  if (bubbleVisible()) pushBubble();
}

/* ---------------- 问题卡片 ---------------- */

const askKey = (task: AgentTask) => `${task.key}|${task.ask?.id ?? ""}`;
function asking() { return (activity?.running ?? []).filter((task) => task.ask).sort((a, b) => b.ask!.at - a.ask!.at); }

export function deskPetAskData(): DeskPetAskData | null {
  if (!options) return null;
  const list = asking().filter((task) => !dismissed.has(askKey(task)));
  return {
    now: Date.now(), theme: options.prefs().theme, more: Math.max(0, list.length - ASK_CARDS),
    cards: list.slice(0, ASK_CARDS).map((task) => ({ key: task.key, kind: task.kind, agent: task.agent, title: task.title, project: task.project, ask: task.ask! })),
  };
}

/** 卡片挨着宠物所在的屏幕右下角；宠物（画出来的那块，极简模式下是露出来的那截）在那儿就让开。 */
function placeAsk() {
  if (!askWin || askWin.isDestroyed() || !pet || pet.isDestroyed()) return;
  if (OFFSCREEN()) { askWin.setBounds({ x: -20000, y: -22000, ...askBox }); return; }
  const real = pet.getBounds(), work = screen.getDisplayMatching(real).workArea, sprite = spriteSize();
  const center = options?.prefs().deskPetMini ? miniSpriteCenter(work, sprite) : real.x + real.width / 2;
  const avoid = { x: Math.round(center - sprite.width / 2), y: real.y + real.height - sprite.height, ...sprite };
  askWin.setBounds(askBounds(askBox, work, avoid));
}

/** 扫描、设置变了：有没回答的提问就开卡片、更新内容；都回答了（或都点了知道了）就关掉。 */
function syncAsk(force = false) {
  if (!options || !pet || pet.isDestroyed()) return;
  // 回答过的提问不会再回来：「知道了」只记还在等的
  const live = new Set(asking().map(askKey));
  for (const key of dismissed) if (!live.has(key)) dismissed.delete(key);
  const data = options.prefs().deskPetAsk ? deskPetAskData() : null;
  if (!data || !data.cards.length) { closeAsk(); return; }
  const json = JSON.stringify({ ...data, now: 0 });
  if (askWin && !askWin.isDestroyed()) {
    if (force || json !== lastAsk) { lastAsk = json; askWin.webContents.send("desk-pet-ask", data); }
    return;
  }
  lastAsk = json;
  const next = new BrowserWindow({
    ...askBox, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, title: "TokenPulse",
    webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  askWin = next;
  next.setMenuBarVisibility(false);
  next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  next.loadFile(path.join(__dirname, "..", "..", "renderer", "desk-pet-ask.html"), { query: { theme: options.prefs().theme } });
  next.once("ready-to-show", () => { if (next.isDestroyed()) return; placeAsk(); next.setAlwaysOnTop(true, "pop-up-menu"); next.showInactive(); });
  next.on("closed", () => { if (askWin === next) { askWin = null; lastAsk = ""; } });
  placeAsk();
}

function closeAsk() {
  if (askWin && !askWin.isDestroyed()) askWin.destroy();
  askWin = null; lastAsk = "";
}

/** 页面量好的卡片大小（含投影）。 */
export function resizeDeskPetAsk(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  const next = { width: clamp(Math.round(width), 200, 420), height: clamp(Math.round(height), 60, 720) };
  if (next.width === askBox.width && next.height === askBox.height) return;
  askBox = next;
  placeAsk();
}

/** 卡片上的按钮：dismiss 收起一个提问（value = 任务 key|调用 id），dismiss-all 全部收起，sessions 打开会话管理。 */
export function deskPetAskAction(action: unknown, value?: unknown) {
  if (!options) return;
  if (action === "dismiss" && typeof value === "string" && value.length < 600) { dismissed.add(value); syncAsk(true); }
  else if (action === "dismiss-all") { for (const task of asking()) dismissed.add(askKey(task)); syncAsk(true); }
  else if (action === "sessions") options.openMain({ page: "sessions" });
}

export function destroyDeskPet() {
  stopTimers();
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  if (bubble && !bubble.isDestroyed()) bubble.destroy();
  if (pet && !pet.isDestroyed()) pet.destroy();
  closeAsk(); dismissed.clear();
  bubble = pet = null; bubbleShown = false;
  activity = null; scanner = null; lastView = ""; lastCursor = ""; lastQuota = null; lastKind = ""; interactive = false; bubblePlace = null;
}

export function deskPetWindows() { return { pet, bubble, ask: askWin }; }
