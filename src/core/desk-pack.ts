import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyIntoData, dataFile, removeFromData, writeJson } from "./paths";
import { imageType } from "./pet-pack";

/**
 * 自定义桌宠键鼠样式包（0.3.117）：
 * 用户准备一个文件夹，里面放一个 desk.json（以及可选的 keyboard.png / mouse.png 自定义贴图）。
 *
 * ```json
 * {
 *   "name": "霓虹樱花",
 *   "author": "可选",
 *   "base": "cyber",
 *   "colors": {
 *     "kbBodyTop": "#24142c",
 *     "kbBodyBot": "#140b1a",
 *     "keyTop": "#3b1f48",
 *     "keyActive": "#ff6ec7",
 *     "glow": "#ff6ec7"
 *   },
 *   "effects": {
 *     "hoverFloat": true,
 *     "holoGrid": true
 *   }
 * }
 * ```
 *
 * - 支持基于任意内置款式（white / obsidian / esports / apple / cyber）微调配色与特效，也可附带 PNG/GIF/WebP/JPEG 贴图；
 * - 所有颜色字段只收标准 hex / rgb / rgba 字符串，图片按文件头校验，仅允许同级单文件名，单张 <= 2 MB、整包 <= 5 MB；
 * - 导入时复制到 ~/.tokenpulse/desks/<id>/，原文件夹删改不影响已导入样式。
 */

export const DESK_BASES = ["white", "obsidian", "esports", "apple", "cyber"] as const;
export type DeskBase = (typeof DESK_BASES)[number];

export const DESK_COLOR_KEYS = [
  "shadow",
  "kbRim",
  "kbBodyTop",
  "kbBodyBot",
  "kbStroke",
  "kbWell",
  "keyTop",
  "keySide",
  "keyStroke",
  "keyActive",
  "keyActiveSide",
  "mouseRim",
  "mouseTop",
  "mouseBot",
  "mouseBtnIdle",
  "mouseStroke",
  "mouseSeam",
  "mouseLeft",
  "mouseRight",
  "wheelWell",
  "wheel",
  "mouseLabel",
  "floatSide",
  "floatTop",
  "floatStroke",
  "floatText",
  "glow",
] as const;
export type DeskColorKey = (typeof DESK_COLOR_KEYS)[number];
export type DeskColors = Partial<Record<DeskColorKey, string>>;

export type DeskEffects = {
  rgbBorder?: boolean;
  hoverFloat?: boolean;
  holoGrid?: boolean;
  magicMouse?: boolean;
  slimKeys?: boolean;
  glow?: number;
};

export type DeskImageSlot = "keyboard" | "mouse";
export const DESK_IMAGE_SLOTS = ["keyboard", "mouse"] as const;

export type DeskPack = {
  id: string;
  name: string;
  author: string;
  base: DeskBase;
  colors: DeskColors;
  effects: DeskEffects;
  images: Partial<Record<DeskImageSlot, string>>;
};

export type DeskPackData = {
  id: string;
  name: string;
  author: string;
  base: DeskBase;
  colors: DeskColors;
  effects: DeskEffects;
  images: Partial<Record<DeskImageSlot, string>>;
};

type ImageType = "png" | "gif" | "webp" | "jpeg";
const MIME: Record<ImageType, string> = { png: "image/png", gif: "image/gif", webp: "image/webp", jpeg: "image/jpeg" };

export const DESK_PACK_ID = /^desk-[a-f0-9]{8}$/;
export const DESK_FILE_MAX = 2 * 1024 * 1024;
export const DESK_PACK_MAX = 5 * 1024 * 1024;
export const DESK_PACKS_MAX = 20;

const SAFE_COLOR = /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i;

export function desksDir() {
  return dataFile("desks");
}

function readHead(file: string) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(16);
    const n = fs.readSync(fd, buffer, 0, 16, 0);
    return buffer.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function isSafeCssColor(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48 && SAFE_COLOR.test(value.trim());
}

/** 读并校验一个键盘样式文件夹；出错时抛出给用户看的中文说明。 */
export function readDeskFolder(dir: string): {
  name: string;
  author: string;
  base: DeskBase;
  colors: DeskColors;
  effects: DeskEffects;
  files: Partial<Record<DeskImageSlot, { file: string; type: ImageType }>>;
} {
  const manifest = path.join(dir, "desk.json");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(manifest);
  } catch {
    throw new Error("这个文件夹里没有 desk.json");
  }
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("desk.json 不是普通文件，或者太大了");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch {
    throw new Error("desk.json 不是有效的 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("desk.json 不是有效的 JSON");

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 40) throw new Error("desk.json 里要写名字（name），最多 40 个字");
  const author = typeof raw.author === "string" ? raw.author.trim().slice(0, 40) : "";

  const baseRaw = raw.base == null ? "white" : raw.base;
  if (typeof baseRaw !== "string" || !(DESK_BASES as readonly string[]).includes(baseRaw)) {
    throw new Error(`desk.json 的 base 只能是 ${DESK_BASES.join(" / ")}`);
  }
  const base = baseRaw as DeskBase;

  const colors: DeskColors = {};
  if (raw.colors != null) {
    if (typeof raw.colors !== "object" || Array.isArray(raw.colors)) throw new Error("desk.json 的 colors 必须是对象");
    const colorObj = raw.colors as Record<string, unknown>;
    for (const key of DESK_COLOR_KEYS) {
      const value = colorObj[key];
      if (value == null || value === "") continue;
      if (!isSafeCssColor(value)) throw new Error(`colors.${key} 必须是有效的颜色值（如 #1e293b 或 rgba(0,255,255,0.8)）`);
      colors[key] = value.trim();
    }
  }

  const effects: DeskEffects = {};
  if (raw.effects != null) {
    if (typeof raw.effects !== "object" || Array.isArray(raw.effects)) throw new Error("desk.json 的 effects 必须是对象");
    const eff = raw.effects as Record<string, unknown>;
    for (const flag of ["rgbBorder", "hoverFloat", "holoGrid", "magicMouse", "slimKeys"] as const) {
      if (typeof eff[flag] === "boolean") effects[flag] = eff[flag];
    }
    if (eff.glow != null) {
      const g = Number(eff.glow);
      if (Number.isFinite(g)) effects.glow = Math.max(0, Math.min(1, Math.round(g * 100) / 100));
    }
  }

  const files: Partial<Record<DeskImageSlot, { file: string; type: ImageType }>> = {};
  let total = 0;
  if (raw.images != null) {
    if (typeof raw.images !== "object" || Array.isArray(raw.images)) throw new Error("desk.json 的 images 必须是对象");
    const imgObj = raw.images as Record<string, unknown>;
    for (const slot of DESK_IMAGE_SLOTS) {
      const value = imgObj[slot];
      if (value == null || value === "") continue;
      if (typeof value !== "string" || value.length > 100 || /[\\/]/.test(value) || value === "." || value === "..") {
        throw new Error(`「${slot}」贴图要写成同一个文件夹里的文件名`);
      }
      const file = path.join(dir, value);
      let info: fs.Stats;
      try {
        info = fs.lstatSync(file);
      } catch {
        throw new Error(`找不到「${slot}」贴图：${value}`);
      }
      if (!info.isFile()) throw new Error(`「${slot}」贴图不是普通文件：${value}`);
      if (info.size > DESK_FILE_MAX) throw new Error(`「${slot}」贴图超过 2 MB：${value}`);
      const type = imageType(readHead(file));
      if (!type) throw new Error(`「${slot}」不是 PNG、GIF、WebP 或 JPEG 图片：${value}`);
      total += info.size;
      files[slot] = { file, type };
    }
  }
  if (total > DESK_PACK_MAX) throw new Error("整套贴图超过 5 MB");

  return { name, author, base, colors, effects, files };
}

/** 导入自定义键盘样式文件夹：校验并复制到 ~/.tokenpulse/desks/<id>/。 */
export function importDeskPack(dir: string): DeskPack {
  if (typeof dir !== "string" || !dir) throw new Error("没有选文件夹");
  const source = path.resolve(dir);
  const folder = readDeskFolder(source);
  if (listDeskPacks().length >= DESK_PACKS_MAX) {
    throw new Error(`最多导入 ${DESK_PACKS_MAX} 个自定义键盘样式，先删掉几个不用的`);
  }
  const id = `desk-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const target = path.join(desksDir(), id);
  fs.mkdirSync(target, { recursive: true });
  const images: Partial<Record<DeskImageSlot, string>> = {};
  try {
    for (const [slot, item] of Object.entries(folder.files) as [DeskImageSlot, { file: string; type: ImageType }][]) {
      const name = `${slot}.${item.type === "jpeg" ? "jpg" : item.type}`;
      copyIntoData(item.file, path.join(target, name));
      images[slot] = name;
    }
    writeJson(path.join(target, "desk.json"), {
      name: folder.name,
      author: folder.author,
      base: folder.base,
      colors: folder.colors,
      effects: folder.effects,
      ...(Object.keys(images).length ? { images } : {}),
    });
  } catch (error) {
    try { removeFromData(target); } catch { /* 清不掉也报原来的错 */ }
    throw error;
  }
  return { id, name: folder.name, author: folder.author, base: folder.base, colors: folder.colors, effects: folder.effects, images };
}

/** 列出已导入的自定义键盘样式（坏掉的自动跳过）。 */
export function listDeskPacks(): DeskPack[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(desksDir()).filter((name) => DESK_PACK_ID.test(name)).sort();
  } catch {
    return [];
  }
  const packs: DeskPack[] = [];
  for (const id of names) {
    try {
      const folder = readDeskFolder(path.join(desksDir(), id));
      packs.push({
        id,
        name: folder.name,
        author: folder.author,
        base: folder.base,
        colors: folder.colors,
        effects: folder.effects,
        images: Object.fromEntries(Object.entries(folder.files).map(([slot, item]) => [slot, path.basename(item!.file)])),
      });
    } catch { /* 跳过 */ }
  }
  return packs;
}

export function removeDeskPack(id: unknown): boolean {
  if (typeof id !== "string" || !DESK_PACK_ID.test(id)) return false;
  const target = path.join(desksDir(), id);
  if (!fs.existsSync(target)) return false;
  removeFromData(target);
  return true;
}

/** 读取自定义键盘样式完整数据（含贴图 data URL），供桌宠窗口与设置页预览渲染。 */
export function deskPackData(id: unknown): DeskPackData | null {
  if (typeof id !== "string" || !DESK_PACK_ID.test(id)) return null;
  try {
    const folder = readDeskFolder(path.join(desksDir(), id));
    const images: Partial<Record<DeskImageSlot, string>> = {};
    for (const [slot, item] of Object.entries(folder.files) as [DeskImageSlot, { file: string; type: ImageType }][]) {
      images[slot] = `data:${MIME[item.type]};base64,${fs.readFileSync(item.file).toString("base64")}`;
    }
    return {
      id,
      name: folder.name,
      author: folder.author,
      base: folder.base,
      colors: folder.colors,
      effects: folder.effects,
      images,
    };
  } catch {
    return null;
  }
}
