import fs from "node:fs";
import path from "node:path";
import { dataFile, writeJson } from "./paths";

/**
 * 桌宠提示音换成自己的音频：每种提示音可以单独换一个文件。
 *
 * - 只收音频：WAV / MP3 / OGG / FLAC / M4A（AAC），按文件头认，不看扩展名；单个 2 MB 以内；
 * - 选好后复制到 ~/.tokenpulse/pet-sounds/<种类>.<扩展名>，之后只用这份副本，原文件删了改了都不影响；
 * - 播放时最多放 5 秒（renderer/pet-sound.js），太长的提示音截掉、淡出。
 * 列表记在同一个目录的 sounds.json：{ 种类: { name 原文件名, type, size, at 导入时间 } }。
 */

export const SOUND_KINDS = ["done", "ask", "waiting", "error", "empty"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];
export type AudioType = "wav" | "mp3" | "ogg" | "flac" | "m4a";
export type PetSound = { name: string; type: AudioType; size: number; at: number };
export const SOUND_FILE_MAX = 2 * 1024 * 1024;
const MIME: Record<AudioType, string> = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4" };

export function soundsDir() { return dataFile("pet-sounds"); }
const listFile = () => path.join(soundsDir(), "sounds.json");
const isKind = (kind: unknown): kind is SoundKind => typeof kind === "string" && (SOUND_KINDS as readonly string[]).includes(kind);

/** 按文件头认音频格式；不认识的返回 null。 */
export function audioType(head: Buffer): AudioType | null {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (head.length >= 4 && ascii(0, 4) === "OggS") return "ogg";
  if (head.length >= 4 && ascii(0, 4) === "fLaC") return "flac";
  if (head.length >= 12 && ascii(4, 8) === "ftyp" && /^(M4A |M4B |mp42|mp41|isom|iso2|dash)$/.test(ascii(8, 12))) return "m4a";
  if (head.length >= 3 && ascii(0, 3) === "ID3") return "mp3";
  // 没有 ID3 标签的 MP3：开头就是帧同步（11 个 1），层是 Layer III
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) === 0x02) return "mp3";
  return null;
}

function readList(): Partial<Record<SoundKind, PetSound>> {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(listFile(), "utf8")); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<SoundKind, PetSound>> = {};
  for (const [kind, item] of Object.entries(raw as Record<string, Partial<PetSound>>)) {
    if (!isKind(kind) || !item || typeof item !== "object" || !item.type || !(item.type in MIME)) continue;
    // 文件被手动删了：当作没换
    if (!fs.existsSync(path.join(soundsDir(), `${kind}.${item.type}`))) continue;
    out[kind] = { name: String(item.name ?? "").slice(0, 120), type: item.type, size: Number(item.size) || 0, at: Number(item.at) || 0 };
  }
  return out;
}

/** 已经换成自己音频的提示音。 */
export function listPetSounds() { return readList(); }

/** 把一种提示音换成用户选的文件：校验后复制到数据目录。出错时抛出给用户看的中文说明。 */
export function importPetSound(kind: unknown, file: unknown): PetSound {
  if (!isKind(kind)) throw new Error("不认识的提示音");
  if (typeof file !== "string" || !file) throw new Error("没有选文件");
  let info: fs.Stats;
  try { info = fs.statSync(file); } catch { throw new Error("找不到这个文件"); }
  if (!info.isFile()) throw new Error("选的不是普通文件");
  if (info.size > SOUND_FILE_MAX) throw new Error("音频文件超过 2 MB，换一个短一点的");
  const fd = fs.openSync(file, "r");
  let head: Buffer;
  try { const buffer = Buffer.alloc(16); head = buffer.subarray(0, fs.readSync(fd, buffer, 0, 16, 0)); } finally { fs.closeSync(fd); }
  const type = audioType(head);
  if (!type) throw new Error("不是 WAV、MP3、OGG、FLAC 或 M4A 音频");
  fs.mkdirSync(soundsDir(), { recursive: true });
  const list = readList();
  const old = list[kind];
  fs.copyFileSync(file, path.join(soundsDir(), `${kind}.${type}`));
  if (old && old.type !== type) fs.rmSync(path.join(soundsDir(), `${kind}.${old.type}`), { force: true });
  const sound: PetSound = { name: path.basename(file).slice(0, 120), type, size: info.size, at: Date.now() };
  writeJson(listFile(), { ...list, [kind]: sound });
  return sound;
}

/** 恢复成默认的提示音。 */
export function removePetSound(kind: unknown): boolean {
  if (!isKind(kind)) return false;
  const list = readList(), old = list[kind];
  if (!old) return false;
  fs.rmSync(path.join(soundsDir(), `${kind}.${old.type}`), { force: true });
  delete list[kind];
  writeJson(listFile(), list);
  return true;
}

/** 播放要的音频数据（窗口的内容安全策略不让直接读数据目录，交给 Web Audio 自己解码）。没换过的返回 null。 */
export function petSoundData(kind: unknown): { type: string; data: Uint8Array; at: number } | null {
  if (!isKind(kind)) return null;
  const item = readList()[kind];
  if (!item) return null;
  try {
    const buffer = fs.readFileSync(path.join(soundsDir(), `${kind}.${item.type}`));
    if (buffer.length > SOUND_FILE_MAX) return null;
    return { type: MIME[item.type], data: new Uint8Array(buffer), at: item.at };
  } catch { return null; }
}
