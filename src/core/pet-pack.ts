import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataFile, writeJson } from "./paths";

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
 */

export const PET_STATES = ["idle", "work", "sleep", "celebrate", "tight", "empty", "drag", "startle"] as const;
export type PetState = (typeof PET_STATES)[number];
export type PetPack = { id: string; name: string; author: string; states: Partial<Record<PetState, string>> };
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

/** 导入：校验后复制到数据目录，返回新宠物。 */
export function importPetPack(dir: string): PetPack {
  if (typeof dir !== "string" || !dir) throw new Error("没有选文件夹");
  const folder = readPetFolder(path.resolve(dir));
  if (listPetPacks().length >= PET_PACKS_MAX) throw new Error(`最多导入 ${PET_PACKS_MAX} 个自定义宠物，先删掉几个不用的`);
  const id = `pet-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const target = path.join(petsDir(), id);
  fs.mkdirSync(target, { recursive: true });
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

/** 桌宠窗口要的图片：data URL（窗口的内容安全策略不允许读数据目录里的文件）。 */
export function petPackImages(id: unknown): { name: string; images: Partial<Record<PetState, string>> } | null {
  if (typeof id !== "string" || !ID.test(id)) return null;
  try {
    const folder = readPetFolder(path.join(petsDir(), id));
    const images: Partial<Record<PetState, string>> = {};
    for (const [state, item] of Object.entries(folder.files) as [PetState, { file: string; type: ImageType }][]) images[state] = `data:${MIME[item.type]};base64,${fs.readFileSync(item.file).toString("base64")}`;
    return { name: folder.name, images };
  } catch { return null; }
}
