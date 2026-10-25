import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataFile, writeJson } from "./paths";
import { normalizeTheme, readThemeFolder, THEME_FILE, themeFiles, themeFileType, type PetTheme } from "./pet-theme";
import { sanitizeSvg, SVG_FILE_MAX } from "./svg-sanitize";

/**
 * 自定义桌宠（0.3.61）：用户选一个文件夹，里面有 pet.json 和各个状态的图片。
 *
 * ```json
 * { "name": "我的猫", "author": "可选", "states": { "idle": "idle.gif", "work": "work.gif", "sleep": "sleep.png" } }
 * ```
 *
 * - 只有 idle 是必须的，缺的状态用 idle 代替；
 * - 只收图片：PNG / GIF / WebP / JPEG，按文件头认，不看扩展名；SVG、HTML、脚本一律不收；
 * - 文件名只能是同一个文件夹里的文件（不能带路径、不能是链接）；单张 5 MB、整套 20 MB 以内；
 * - 导入时复制到 ~/.tokenpulse/pets/<id>/，之后只用这份副本，原文件夹删了改了都不影响。
 *
 * 也收 Clawd on Desk 格式的主题包（文件夹里是 theme.json，见 pet-theme.ts）：存成 pet.json 里 kind = "theme"、
 * theme 是收过的主题，动画文件平铺在同一个文件夹里（SVG 存消毒后的）。
 */

export const PET_STATES = ["idle", "work", "think", "sleep", "celebrate", "tight", "empty", "drag", "startle", "poke", "doze", "look", "wave", "peek", "dizzy"] as const;
export type PetState = (typeof PET_STATES)[number];
export type PetPack = { id: string; name: string; author: string; states: Partial<Record<PetState, string>>; kind?: "theme" };
type ImageType = "png" | "gif" | "webp" | "jpeg";

export const PET_FILE_MAX = 5 * 1024 * 1024;
export const PET_PACK_MAX = 20 * 1024 * 1024;
export const PET_PACKS_MAX = 20;
const MIME: Record<ImageType, string> = { png: "image/png", gif: "image/gif", webp: "image/webp", jpeg: "image/jpeg" };
const ID = /^pet-[a-f0-9]{8}$/;

export function petsDir() { return dataFile("pets"); }

/** 按文件头认图片格式；不是这四种返回 null。 */
export function imageType(head: Buffer): ImageType | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  return null;
}

function readHead(file: string) {
  const fd = fs.openSync(file, "r");
  try { const buffer = Buffer.alloc(16); const n = fs.readSync(fd, buffer, 0, 16, 0); return buffer.subarray(0, n); } finally { fs.closeSync(fd); }
}

/** 读并校验一个宠物文件夹。出错时抛出给用户看的中文说明。 */
export function readPetFolder(dir: string): { name: string; author: string; files: Partial<Record<PetState, { file: string; type: ImageType }>> } {
  const manifest = path.join(dir, "pet.json");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(manifest); } catch { throw new Error("这个文件夹里没有 pet.json"); }
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("pet.json 不是普通文件，或者太大了");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { throw new Error("pet.json 不是有效的 JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pet.json 不是有效的 JSON");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 40) throw new Error("pet.json 里要写名字（name），最多 40 个字");
  const author = typeof raw.author === "string" ? raw.author.trim().slice(0, 40) : "";
  const states = raw.states && typeof raw.states === "object" && !Array.isArray(raw.states) ? raw.states as Record<string, unknown> : null;
  if (!states || typeof states.idle !== "string") throw new Error("pet.json 的 states 里至少要有 idle（空闲时的图片）");
  const files: Partial<Record<PetState, { file: string; type: ImageType }>> = {};
  let total = 0;
  for (const state of PET_STATES) {
    const value = states[state];
    if (value == null) continue;
    if (typeof value !== "string" || !value || value.length > 100 || /[\\/]/.test(value) || value === "." || value === "..") throw new Error(`「${state}」的图片要写成同一个文件夹里的文件名`);
    const file = path.join(dir, value);
    let info: fs.Stats;
    try { info = fs.lstatSync(file); } catch { throw new Error(`找不到「${state}」的图片：${value}`); }
    if (!info.isFile()) throw new Error(`「${state}」的图片不是普通文件：${value}`);
    if (info.size > PET_FILE_MAX) throw new Error(`「${state}」的图片超过 5 MB：${value}`);
    const type = imageType(readHead(file));
    if (!type) throw new Error(`「${state}」不是 PNG、GIF、WebP 或 JPEG 图片：${value}`);
    total += info.size;
    files[state] = { file, type };
  }
  if (total > PET_PACK_MAX) throw new Error("整套图片超过 20 MB");
  return { name, author, files };
}

/** 存下来的主题（kind = "theme" 的 pet.json）。data：连动画内容一起读（SVG 再消毒一遍）；不要的话只核对 idle 在不在。 */
function readStoredTheme(dir: string, raw: Record<string, unknown>, data: boolean) {
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
  if (!name) throw new Error("pet.json 里要写名字（name）");
  const theme = normalizeTheme(raw.theme);
  const files: Record<string, { svg: string } | { src: string }> = {};
  let total = 0;
  for (const file of data ? themeFiles(theme) : [theme.states.idle![0]]) {
    if (!THEME_FILE.test(file)) throw new Error("文件名不对");
    const full = path.join(dir, file), info = fs.lstatSync(full);
    if (!info.isFile()) throw new Error(`不是普通文件：${file}`);
    const type = themeFileType(readHead(full), file);
    if (!type || info.size > (type === "svg" ? SVG_FILE_MAX : PET_FILE_MAX)) throw new Error(`文件不对：${file}`);
    total += info.size;
    if (total > PET_PACK_MAX) throw new Error("整套动画超过 20 MB");
    if (data) files[file] = type === "svg" ? { svg: sanitizeSvg(fs.readFileSync(full, "utf8")) } : { src: `data:${MIME[type]};base64,${fs.readFileSync(full).toString("base64")}` };
  }
  return { name, author: typeof raw.author === "string" ? raw.author.trim().slice(0, 40) : "", theme, files };
}

/** 读文件夹里的 pet.json：主题包返回 kind = "theme" 的那份，图片宠物返回 null（按老办法读）。 */
function storedKind(dir: string): Record<string, unknown> | null {
  const manifest = path.join(dir, "pet.json");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(manifest); } catch { return null; }
  if (!stat.isFile() || stat.size > 512 * 1024) return null;
  try { const raw = JSON.parse(fs.readFileSync(manifest, "utf8")); return raw && typeof raw === "object" && raw.kind === "theme" ? raw : null; } catch { return null; }
}

const dataUrl = (item: { svg: string } | { src: string }) => ("svg" in item ? `data:image/svg+xml;base64,${Buffer.from(item.svg, "utf8").toString("base64")}` : item.src);

/** 导入 Clawd on Desk 格式的主题包。warning：有引用的文件没找到、格式版本比认识的新。 */
function importTheme(dir: string, target: string): PetPack & { warning?: string } {
  const folder = readThemeFolder(dir, { file: PET_FILE_MAX, total: PET_PACK_MAX });
  for (const [name, item] of folder.files) {
    if (item.svg) fs.writeFileSync(path.join(target, name), item.svg, "utf8");
    else fs.copyFileSync(item.file, path.join(target, name));
  }
  writeJson(path.join(target, "pet.json"), { name: folder.name, author: folder.author, kind: "theme", theme: folder.theme });
  const notes = [folder.missing.length ? `有 ${folder.missing.length} 个动画文件没找到，用到它们的地方会换成别的动画` : "", folder.theme.schemaVersion > 1 ? "这个主题的格式比 TokenPulse 认识的新，有些动作可能显示不出来" : ""].filter(Boolean);
  return { id: path.basename(target), name: folder.name, author: folder.author, states: { idle: folder.theme.states.idle![0] }, kind: "theme", ...(notes.length ? { warning: notes.join("；") } : {}) };
}

/** 导入：校验后复制到数据目录，返回新宠物。文件夹里有 pet.json 按图片宠物导入，没有但有 theme.json 按主题包导入。 */
export function importPetPack(dir: string): PetPack & { warning?: string } {
  if (typeof dir !== "string" || !dir) throw new Error("没有选文件夹");
  const source = path.resolve(dir);
  const hasPet = fs.existsSync(path.join(source, "pet.json")), theme = !hasPet && fs.existsSync(path.join(source, "theme.json"));
  if (!hasPet && !theme) throw new Error("这个文件夹里没有 pet.json 或 theme.json");
  const folder = theme ? null : readPetFolder(source);
  if (listPetPacks().length >= PET_PACKS_MAX) throw new Error(`最多导入 ${PET_PACKS_MAX} 个自定义宠物，先删掉几个不用的`);
  const id = `pet-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const target = path.join(petsDir(), id);
  fs.mkdirSync(target, { recursive: true });
  if (!folder) {
    try { return importTheme(source, target); } catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
  }
  const states: Partial<Record<PetState, string>> = {};
  try {
    for (const [state, item] of Object.entries(folder.files) as [PetState, { file: string; type: ImageType }][]) {
      const name = `${state}.${item.type === "jpeg" ? "jpg" : item.type}`;
      fs.copyFileSync(item.file, path.join(target, name));
      states[state] = name;
    }
    writeJson(path.join(target, "pet.json"), { name: folder.name, author: folder.author, states });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return { id, name: folder.name, author: folder.author, states };
}

/** 已导入的自定义宠物。坏掉的（被手动改坏）跳过。 */
export function listPetPacks(): PetPack[] {
  let names: string[] = [];
  try { names = fs.readdirSync(petsDir()).filter((name) => ID.test(name)).sort(); } catch { return []; }
  const packs: PetPack[] = [];
  for (const id of names) {
    try {
      const stored = storedKind(path.join(petsDir(), id));
      if (stored) { const item = readStoredTheme(path.join(petsDir(), id), stored, false); packs.push({ id, name: item.name, author: item.author, states: { idle: item.theme.states.idle![0] }, kind: "theme" }); continue; }
      const folder = readPetFolder(path.join(petsDir(), id));
      packs.push({ id, name: folder.name, author: folder.author, states: Object.fromEntries(Object.entries(folder.files).map(([state, item]) => [state, path.basename(item!.file)])) });
    } catch { /* 跳过 */ }
  }
  return packs;
}

export function removePetPack(id: unknown): boolean {
  if (typeof id !== "string" || !ID.test(id)) return false;
  const target = path.join(petsDir(), id);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

export type ThemePackData = { name: string; kind: "theme"; images: { idle: string }; theme: PetTheme; files: Record<string, { svg: string } | { src: string }> };

/**
 * 桌宠窗口要的图片：data URL（窗口的内容安全策略不允许读数据目录里的文件）。
 * 主题包另外给 theme 和每个动画（SVG 给消毒后的文字，桌宠窗口放进 Shadow DOM 里才能动眼睛；位图给 data URL）；images.idle 给设置页预览。
 */
export function petPackImages(id: unknown): { name: string; images: Partial<Record<PetState, string>> } | ThemePackData | null {
  if (typeof id !== "string" || !ID.test(id)) return null;
  try {
    const stored = storedKind(path.join(petsDir(), id));
    if (stored) {
      const item = readStoredTheme(path.join(petsDir(), id), stored, true);
      return { name: item.name, kind: "theme", images: { idle: dataUrl(item.files[item.theme.states.idle![0]]) }, theme: item.theme, files: item.files };
    }
    const folder = readPetFolder(path.join(petsDir(), id));
    const images: Partial<Record<PetState, string>> = {};
    for (const [state, item] of Object.entries(folder.files) as [PetState, { file: string; type: ImageType }][]) images[state] = `data:${MIME[item.type]};base64,${fs.readFileSync(item.file).toString("base64")}`;
    return { name: folder.name, images };
  } catch { return null; }
}
