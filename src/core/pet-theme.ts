import fs from "node:fs";
import path from "node:path";
import { sanitizeSvg, SVG_FILE_MAX } from "./svg-sanitize";

/**
 * Clawd on Desk 格式的主题包：一个文件夹，里面有 theme.json 和它引用的动画（SVG / GIF / PNG / WebP / JPEG）。
 * TokenPulse 不带任何主题素材，只认这种格式；导入时把用得到的字段收成下面的 PetTheme，图片复制一份（SVG 先消毒）。
 *
 * 用到的字段：states（各状态的动画）、workingTiers / jugglingTiers（按会话数换姿势）、reactions（拖动、点左右、双击、被烦到）、
 * eyeTracking（眼睛跟着鼠标：眼睛 / 身体 / 影子的元素 id 和幅度）、viewBox / layout（画面坐标、身体在哪、脚底线）、
 * hitBoxes / fileHitBoxes（哪里算点在身上）、timings（一次性动画放多久、鼠标多久没动开始随机待机）、idleAnimations（随机待机）、
 * miniMode（极简模式各状态的动画、藏进屏幕的比例、探头滑出多少）。
 * 其他字段（配饰、换色、彩蛋……）不认，导入时丢掉。动画文件只写文件名，在文件夹本身、assets/、assets/svg/ 里找。
 */

export type Box = { x: number; y: number; width: number; height: number };
export type HitBox = { x: number; y: number; w: number; h: number };
export type Slot = { files: string[]; duration: number };
export type PetTheme = {
  schemaVersion: number;
  viewBox: Box;
  layout: { contentBox: Box; centerX: number; baselineY: number };
  eyeTracking: { states: string[]; maxOffset: number; bodyScale: number; shadowStretch: number; shadowShift: number; ids: { eyes: string; body: string; shadow: string; dozeEyes: string }; shadowOrigin: string } | null;
  states: Partial<Record<ThemeState, string[]>>;
  workingTiers: { minSessions: number; files: string[] }[];
  jugglingTiers: { minSessions: number; files: string[] }[];
  /** 随机待机：鼠标 timings.mouseIdleTimeout 没动后轮流放。mirrorOnRightSide：宠物在屏幕右半边时左右翻过来放。 */
  idleAnimations: { file: string; duration: number; mirrorOnRightSide?: boolean }[];
  reactions: Partial<Record<ThemeReaction, Slot>>;
  timings: { autoReturn: Record<string, number>; yawnDuration: number; wakeDuration: number; mouseIdleTimeout: number };
  hitBoxes: Partial<Record<"default" | "sleeping" | "wide", HitBox>>;
  fileHitBoxes: Record<string, HitBox>;
  fileViewBoxes: Record<string, Box>;
  wideHitboxFiles: string[];
  sleepingHitboxFiles: string[];
  /**
   * 极简模式（贴屏幕左右边，左边是右边翻过来；贴上下边不用）各状态的动画。动画自己画好了歪着探头的样子：画面宽度的 offsetRatio 藏在屏幕外，
   * 悬停时再往外滑 peek.offsetRatio（没写按画面宽的 12%）。timings.autoReturn：mini-peek 放多久换 mini-peek-hold 之类。
   */
  miniMode: { states: Record<string, string[]>; offsetRatio: number; peek: { offsetRatio: number }; timings: { autoReturn: Record<string, number> } } | null;
};

export const THEME_STATES = ["idle", "thinking", "working", "juggling", "sweeping", "error", "attention", "notification", "carrying", "yawning", "dozing", "collapsing", "sleeping", "waking", "dizzy"] as const;
export type ThemeState = (typeof THEME_STATES)[number];
export const THEME_REACTIONS = ["drag", "clickLeft", "clickRight", "annoyed", "double"] as const;
export type ThemeReaction = (typeof THEME_REACTIONS)[number];
const MINI_STATES = ["mini-idle", "mini-alert", "mini-happy", "mini-enter", "mini-peek", "mini-peek-hold", "mini-working", "mini-crabwalk", "mini-enter-sleep", "mini-sleep", "mini-sleep-peek"];

export const THEME_JSON_MAX = 256 * 1024;
export const THEME_FILES_MAX = 150;
/** 动画文件名：只能是文件名，扩展名是这几种。 */
export const THEME_FILE = /^[\w][\w .()+-]{0,95}\.(svg|png|apng|gif|webp|jpe?g)$/i;
export type ThemeFileType = "svg" | "png" | "gif" | "webp" | "jpeg";

const isObj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown, fallback: number, low = -1e4, high = 1e4) => { const n = Number(value); return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback; };
const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const fileName = (value: unknown) => (typeof value === "string" && THEME_FILE.test(value) && value !== "." && value !== ".." ? value : null);
const files = (value: unknown, max = 8) => (Array.isArray(value) ? value : [value]).map(fileName).filter((item): item is string => !!item).slice(0, max);
function box(value: unknown): Box | null {
  if (!isObj(value)) return null;
  const width = num(value.width, 0, 0), height = num(value.height, 0, 0);
  return width > 0 && height > 0 ? { x: num(value.x, 0), y: num(value.y, 0), width, height } : null;
}
function hitBox(value: unknown): HitBox | null {
  if (!isObj(value)) return null;
  const w = num(value.w, 0, 0), h = num(value.h, 0, 0);
  return w > 0 && h > 0 ? { x: num(value.x, 0), y: num(value.y, 0), w, h } : null;
}
const ID = (value: unknown, fallback: string) => (typeof value === "string" && /^[A-Za-z_][\w-]{0,63}$/.test(value) ? value : fallback);
const ms = (value: unknown) => num(value, 0, 0, 600_000);

/** 把 theme.json（Clawd on Desk 的原样，或者这里收过一次的）收成 PetTheme。没有 idle 抛错。对自己的输出再收一次结果不变。 */
export function normalizeTheme(raw: unknown): PetTheme {
  if (!isObj(raw)) throw new Error("theme.json 不是有效的 JSON");
  const rawStates = isObj(raw.states) ? raw.states : {};
  const states: PetTheme["states"] = {};
  for (const state of THEME_STATES) { const list = files(rawStates[state]); if (list.length) states[state] = list; }
  if (!states.idle) throw new Error("theme.json 的 states 里至少要有 idle（空闲时的动画）");
  const viewBox = box(raw.viewBox) ?? { x: 0, y: 0, width: 100, height: 100 };
  const layoutRaw = isObj(raw.layout) ? raw.layout : {};
  const contentBox = box(layoutRaw.contentBox) ?? viewBox;
  const eye = isObj(raw.eyeTracking) && raw.eyeTracking.enabled !== false ? raw.eyeTracking : null;
  const ids = eye && isObj(eye.ids) ? eye.ids : {};
  const tiers = (value: unknown) => (Array.isArray(value) ? value : []).filter(isObj).slice(0, 8)
    .map((tier) => ({ minSessions: Math.round(num(tier.minSessions, 1, 1, 99)), files: files(tier.files ?? tier.file) }))
    .filter((tier) => tier.files.length).sort((a, b) => b.minSessions - a.minSessions);
  const rawReactions = isObj(raw.reactions) ? raw.reactions : {};
  const reactions: PetTheme["reactions"] = {};
  for (const name of THEME_REACTIONS) {
    const item = rawReactions[name];
    if (!isObj(item)) continue;
    const list = files(item.files ?? item.file);
    if (list.length) reactions[name] = { files: list, duration: ms(item.duration) };
  }
  const timingsRaw = isObj(raw.timings) ? raw.timings : {};
  const durations = (value: unknown) => {
    const out: Record<string, number> = {};
    if (isObj(value)) for (const [key, item] of Object.entries(value).slice(0, 40)) if (/^[\w-]{1,30}$/.test(key)) out[key] = ms(item);
    return out;
  };
  const autoReturn = durations(timingsRaw.autoReturn);
  const hitRaw = isObj(raw.hitBoxes) ? raw.hitBoxes : {};
  const hitBoxes: PetTheme["hitBoxes"] = {};
  for (const key of ["default", "sleeping", "wide"] as const) { const item = hitBox(hitRaw[key]); if (item) hitBoxes[key] = item; }
  const perFile = <T>(value: unknown, read: (item: unknown) => T | null) => {
    const out: Record<string, T> = {};
    if (isObj(value)) for (const [key, item] of Object.entries(value).slice(0, THEME_FILES_MAX)) { const parsed = fileName(key) ? read(item) : null; if (parsed) out[key] = parsed; }
    return out;
  };
  const miniRaw = isObj(raw.miniMode) && raw.miniMode.supported !== false && isObj(raw.miniMode.states) ? raw.miniMode : null;
  const miniStates: Record<string, string[]> = {};
  if (miniRaw) for (const key of MINI_STATES) { const list = files((miniRaw.states as Record<string, unknown>)[key]); if (list.length) miniStates[key] = list; }
  const miniPeek = miniRaw && isObj(miniRaw.peek) ? miniRaw.peek : {};
  const miniMode: PetTheme["miniMode"] = miniRaw && miniStates["mini-idle"] ? {
    states: miniStates,
    offsetRatio: num(miniRaw.offsetRatio, 0.5, 0, 0.9),
    peek: { offsetRatio: num(miniPeek.offsetRatio, 0.12, 0, 0.9) },
    timings: { autoReturn: durations(isObj(miniRaw.timings) ? miniRaw.timings.autoReturn : null) },
  } : null;
  return {
    schemaVersion: Math.round(num(raw.schemaVersion, 1, 0, 1000)),
    viewBox,
    layout: { contentBox, centerX: num(layoutRaw.centerX, contentBox.x + contentBox.width / 2), baselineY: num(layoutRaw.baselineY, contentBox.y + contentBox.height) },
    eyeTracking: eye ? {
      states: (Array.isArray(eye.states) ? eye.states : ["idle"]).filter((item): item is string => typeof item === "string" && /^[\w-]{1,30}$/.test(item)).slice(0, 10),
      maxOffset: num(eye.maxOffset, 3, 0, 50), bodyScale: num(eye.bodyScale, 0.33, 0, 2), shadowStretch: num(eye.shadowStretch, 0.15, 0, 2), shadowShift: num(eye.shadowShift, 0.3, 0, 2),
      ids: { eyes: ID(ids.eyes, "eyes-js"), body: ID(ids.body, "body-js"), shadow: ID(ids.shadow, "shadow-js"), dozeEyes: ID(ids.dozeEyes, "eyes-doze") },
      shadowOrigin: typeof eye.shadowOrigin === "string" && /^[\d.\s%a-z-]{1,40}$/i.test(eye.shadowOrigin) ? eye.shadowOrigin : "",
    } : null,
    states,
    workingTiers: tiers(raw.workingTiers),
    jugglingTiers: tiers(raw.jugglingTiers),
    idleAnimations: (Array.isArray(raw.idleAnimations) ? raw.idleAnimations : []).filter(isObj).slice(0, 12)
      .map((item) => ({ file: fileName(item.file) ?? "", duration: ms(item.duration) || 6000, ...(item.mirrorOnRightSide === true ? { mirrorOnRightSide: true } : {}) })).filter((item) => item.file),
    reactions,
    timings: { autoReturn, yawnDuration: ms(timingsRaw.yawnDuration), wakeDuration: ms(timingsRaw.wakeDuration), mouseIdleTimeout: num(timingsRaw.mouseIdleTimeout, 20_000, 3000, 600_000) },
    hitBoxes,
    fileHitBoxes: perFile(raw.fileHitBoxes, hitBox),
    fileViewBoxes: perFile(raw.fileViewBoxes, box),
    wideHitboxFiles: files(raw.wideHitboxFiles, 40),
    sleepingHitboxFiles: files(raw.sleepingHitboxFiles, 40),
    miniMode,
  };
}

/** 主题里引用到的所有动画文件名（去重）。 */
export function themeFiles(theme: PetTheme): string[] {
  const all = new Set<string>();
  const add = (list: string[]) => list.forEach((item) => all.add(item));
  Object.values(theme.states).forEach((list) => add(list!));
  [...theme.workingTiers, ...theme.jugglingTiers].forEach((tier) => add(tier.files));
  theme.idleAnimations.forEach((item) => all.add(item.file));
  Object.values(theme.reactions).forEach((item) => add(item!.files));
  if (theme.miniMode) Object.values(theme.miniMode.states).forEach(add);
  return [...all];
}

/** 去掉没找到的文件；状态、反应里一个文件都不剩的整条去掉。idle 没了抛错。 */
function dropMissing(theme: PetTheme, have: Set<string>): PetTheme {
  const keep = (list: string[]) => list.filter((item) => have.has(item));
  const states: PetTheme["states"] = {};
  for (const [state, list] of Object.entries(theme.states) as [ThemeState, string[]][]) { const left = keep(list); if (left.length) states[state] = left; }
  if (!states.idle) throw new Error("找不到 idle（空闲时）的动画文件");
  const reactions: PetTheme["reactions"] = {};
  for (const [name, slot] of Object.entries(theme.reactions) as [ThemeReaction, Slot][]) { const left = keep(slot.files); if (left.length) reactions[name] = { ...slot, files: left }; }
  const miniStates: Record<string, string[]> = {};
  if (theme.miniMode) for (const [key, list] of Object.entries(theme.miniMode.states)) { const left = keep(list); if (left.length) miniStates[key] = left; }
  const tiers = (list: PetTheme["workingTiers"]) => list.map((tier) => ({ ...tier, files: keep(tier.files) })).filter((tier) => tier.files.length);
  return { ...theme, states, reactions, workingTiers: tiers(theme.workingTiers), jugglingTiers: tiers(theme.jugglingTiers), idleAnimations: theme.idleAnimations.filter((item) => have.has(item.file)), miniMode: theme.miniMode && miniStates["mini-idle"] ? { ...theme.miniMode, states: miniStates } : null };
}

function readHead(file: string) {
  const fd = fs.openSync(file, "r");
  try { const buffer = Buffer.alloc(16); const n = fs.readSync(fd, buffer, 0, 16, 0); return buffer.subarray(0, n); } finally { fs.closeSync(fd); }
}

/** 动画文件按文件头认格式：位图看魔数，SVG 交给消毒（不是 SVG 会抛错）。 */
export function themeFileType(head: Buffer, name: string): ThemeFileType | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  return /\.svg$/i.test(name) ? "svg" : null;
}

export type ThemeFolder = { name: string; author: string; theme: PetTheme; files: Map<string, { file: string; type: ThemeFileType; svg?: string }>; missing: string[] };

/**
 * 读 Clawd on Desk 格式的主题文件夹：校验 theme.json、找到用到的动画、SVG 消毒。
 * 位图单个 5 MB、SVG 单个 2 MB、整套 20 MB、最多 150 个文件以内；不是普通文件（链接之类）的不收。
 */
export function readThemeFolder(dir: string, limits = { file: 5 * 1024 * 1024, total: 20 * 1024 * 1024 }): ThemeFolder {
  const manifest = path.join(dir, "theme.json");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(manifest); } catch { throw new Error("这个文件夹里没有 pet.json 或 theme.json"); }
  if (!stat.isFile() || stat.size > THEME_JSON_MAX) throw new Error("theme.json 不是普通文件，或者太大了");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(fs.readFileSync(manifest, "utf8").replace(/^﻿/, "")); } catch { throw new Error("theme.json 不是有效的 JSON"); }
  const parsed = normalizeTheme(raw);
  const wanted = themeFiles(parsed);
  if (wanted.length > THEME_FILES_MAX) throw new Error(`主题引用的动画超过 ${THEME_FILES_MAX} 个`);
  const roots = [dir, path.join(dir, "assets"), path.join(dir, "assets", "svg")];
  const found = new Map<string, { file: string; type: ThemeFileType; svg?: string }>(), missing: string[] = [];
  let total = 0;
  for (const name of wanted) {
    let hit: { file: string; info: fs.Stats } | null = null;
    for (const base of roots) { const file = path.join(base, name); try { const info = fs.lstatSync(file); if (info.isFile()) { hit = { file, info }; break; } } catch { /* 下一个目录 */ } }
    if (!hit) { missing.push(name); continue; }
    const type = themeFileType(readHead(hit.file), name);
    if (!type) throw new Error(`「${name}」不是 SVG、PNG、GIF、WebP 或 JPEG`);
    if (hit.info.size > (type === "svg" ? SVG_FILE_MAX : limits.file)) throw new Error(`「${name}」太大了（SVG 最多 2 MB，图片最多 5 MB）`);
    total += hit.info.size;
    if (total > limits.total) throw new Error("整套动画超过 20 MB");
    let svg: string | undefined;
    if (type === "svg") { try { svg = sanitizeSvg(fs.readFileSync(hit.file, "utf8")); } catch (error) { throw new Error(`「${name}」${error instanceof Error ? error.message : "读不出来"}`); } }
    found.set(name, { file: hit.file, type, ...(svg ? { svg } : {}) });
  }
  const theme = dropMissing(parsed, new Set(found.keys()));
  const name = text(raw.name, 40) || path.basename(dir).slice(0, 40) || "主题";
  return { name, author: text(raw.author, 40), theme, files: found, missing };
}
