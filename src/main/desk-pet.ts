/*
 * 桌宠（0.3.61）：桌面上一只像素小动物，表现剩余额度和本机 Agent 在不在干活；点一下冒出一个像素对话气泡，写着正在用的账号的额度。
 *
 * - 默认关闭，在「桌宠」页打开。关着的时候不建窗口、不扫会话文件。
 * - 宠物窗口透明、不占任务栏、不抢焦点；只有点在宠物身上才接鼠标，透明的地方点下去落到后面的窗口（setIgnoreMouseEvents + forward）。
 * - 任务状态只读会话文件推断（core/agent-activity.ts），4 秒看一次；电脑 5 分钟没人动、也没有任务在跑，宠物去睡觉。
 * - 气泡是单独的透明窗口（desk-pet-bubble.html）：点宠物出来的是额度，右键「查看任务」出来的是任务列表。
 *   失焦、再点宠物、按 Esc 收起，鼠标不在上面 8 秒自己收起（在页面里计时）；收起两分钟后销毁。
 * 位置存的是宠物脚下的中点，换大小、换屏幕后都从这一点放回去，并保证整只在屏幕的可用区域里。
 */
import { BrowserWindow, Menu, powerMonitor, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Snapshot } from "../core/report";
import { ActivityScanner, type ActivityState, type AgentTask } from "../core/agent-activity";
import { accountIdOf } from "../core/accounts";
import { authFile, claudeProfileFile, readCliAccounts } from "../core/credentials";
import { anchorOf, bubbleBounds, flingPath, GRID, jumpPoint, MINI_PEEK, MINI_SHOW, miniBounds, miniSpriteCenter, PACK_ID, petBounds, petMode, petQuota, petWindowSize, pickPetAccount, reachesRightEdge, releaseVelocity, type BubblePlace, type DeskPetPrefs, type DragSample, type PetMood, type PetUsing } from "../core/desk-pet-model";
import { petPackImages } from "../core/pet-pack";
import { tr } from "./i18n";

type Account = Snapshot["accounts"][number];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

type TaskBrief = Pick<AgentTask, "key" | "kind" | "agent" | "title" | "project" | "status" | "tool" | "since" | "doneAt">;
type BubbleWindow = { used: number; resetAt: number; high: boolean };
export type BubbleView = "quota" | "tasks";
export type DeskPetBubbleData = {
  now: number; theme: "light" | "dark"; view: BubbleView;
  /** 每打开一次加一：页面看到它变了就重新播一次冒出来的动画、重新开始 8 秒计时。 */
  opened: number;
  place: Pick<BubblePlace, "side" | "at">;
  account: { kind: string; name: string; plan: string; checkedAt: number; five: BubbleWindow | null; week: BubbleWindow | null } | null;
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
const SCAN_EVERY_MS = 4000;
const BUBBLE_DESTROY_MS = 2 * 60_000;
/** 会话里的工具 → 它用哪家的额度。 */
const TASK_ACCOUNT = { claude: "claude", codex: "chatgpt" } as const;

let options: Options | null = null;
let pet: BrowserWindow | null = null;
let bubble: BrowserWindow | null = null;
let scanner: ActivityScanner | null = null;
let activity: ActivityState | null = null;
let scanTimer: NodeJS.Timeout | null = null, cursorTimer: NodeJS.Timeout | null = null, dragTimer: NodeJS.Timeout | null = null, bubbleTimer: NodeJS.Timeout | null = null, flyTimer: NodeJS.Timeout | null = null;
let scanning = false, listening = false, interactive = false, bubbleShown = false;
let lastView = "", lastCursor = "", lastQuota: { id: string; quota: number } | null = null, lastKind = "";
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
}

function startTimers() {
  stopTimers();
  scanner ??= new ActivityScanner();
  const scan = async () => {
    if (scanning || !scanner) return;
    scanning = true;
    try {
      const before = activity;
      activity = await scanner.scan();
      lastUsedKind = usingKinds()[0] ?? lastUsedKind;
      if (before && activity.finished.length) sendEvent({ type: "celebrate" });
      pushDeskPet();
      if (bubbleVisible()) pushBubble();
    } catch (error) { console.error("[TokenPulse] 桌宠读取会话状态失败", error); }
    finally { scanning = false; }
  };
  void scan();
  scanTimer = setInterval(() => void scan(), SCAN_EVERY_MS);
  // 眼睛跟着鼠标：只发宠物身体中心到鼠标的相对位置，变了才发
  cursorTimer = setInterval(() => {
    if (!pet || pet.isDestroyed() || !pet.isVisible() || drag) return;
    // 睡眠序列要知道电脑多久没人动（键盘鼠标都算）；变了才发，最多一秒一次。测试时（屏幕外）由测试自己发
    if (!OFFSCREEN()) { const idle = idleSeconds(); if (idle !== lastIdle) { lastIdle = idle; pet.webContents.send("desk-pet-idle", idle); } }
    const point = screen.getCursorScreenPoint(), bounds = pet.getBounds(), sprite = spriteSize();
    const rel = { x: Math.round(point.x - (bounds.x + bounds.width / 2)), y: Math.round(point.y - (bounds.y + bounds.height - sprite.height * 0.55)) };
    const key = `${Math.round(rel.x / 4)},${Math.round(rel.y / 4)}`;
    if (key === lastCursor) return;
    lastCursor = key;
    pet.webContents.send("desk-pet-cursor", rel);
  }, 150);
}

function stopTimers() {
  for (const timer of [scanTimer, cursorTimer, dragTimer, flyTimer]) if (timer) clearInterval(timer);
  scanTimer = cursorTimer = dragTimer = flyTimer = null;
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
    mini: prefs.deskPetMini ? { show: MINI_SHOW, peek: MINI_PEEK } : null,
    quota: quota.quota, mood: quota.mood, account: quota.account,
    mode: petMode(activity, idleSeconds()), tasks: running.length, waiting: running.filter((task) => task.status === "waiting").length,
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
    lastQuota = { id, quota: view.quota };
  }
  if (view.pet !== lastKind) { lastKind = view.pet; pet.webContents.send("desk-pet-pack", PACK_ID.test(view.pet) ? petPackImages(view.pet) : null); }
  const json = JSON.stringify(view);
  if (!force && json === lastView) return;
  lastView = json;
  pet.webContents.send("desk-pet-state", view);
}

function sendEvent(event: { type: "celebrate" } | { type: "restock"; from: number } | { type: "bubble"; open: boolean } | { type: "fly" } | { type: "landed" }) {
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
  return { key: task.key, kind: task.kind, agent: task.agent, title: task.title, project: task.project, status: task.status, tool: task.tool, since: task.since, doneAt: task.doneAt };
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
    account: account ? { kind: account.kind, name: options.title(account), plan: account.plan ?? "", checkedAt: account.lastCheckedAt ?? account.lastSampleAt ?? 0, five: bubbleWindow(account.five), week: bubbleWindow(account.week) } : null,
    quota: quota.quota, mood: quota.mood,
    tasks: { running: (activity?.running ?? []).map(brief), recent: (activity?.recent ?? []).map(brief) }, scanned: !!activity,
  };
}
function pushBubble() { if (bubble && !bubble.isDestroyed()) bubble.webContents.send("desk-pet-bubble", deskPetBubbleData()); }

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

export function destroyDeskPet() {
  stopTimers();
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  if (bubble && !bubble.isDestroyed()) bubble.destroy();
  if (pet && !pet.isDestroyed()) pet.destroy();
  bubble = pet = null; bubbleShown = false;
  activity = null; scanner = null; lastView = ""; lastCursor = ""; lastQuota = null; lastKind = ""; interactive = false; bubblePlace = null;
}

export function deskPetWindows() { return { pet, bubble }; }
