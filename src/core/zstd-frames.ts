import zlib from "zlib";
import fs from "node:fs";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SKIPPABLE_MAGIC_BASE = 0x184d2a50;

function isSkippableFrame(raw: Buffer, at: number): boolean {
  return at + 4 <= raw.length && ((raw.readUInt32LE(at) & 0xfffffff0) >>> 0) === SKIPPABLE_MAGIC_BASE;
}

/**
 * 把一段字节里完整的 zstd 帧依次解开。最后一帧没写完（或者这次没读全）就停在它前面，consumed 是已经解开的字节数。
 * DeepSeek Harness 的会话文件按帧追加，扫描和会话列表共用这一份。
 */
export function zstdFrames(raw: Buffer): { text: string; consumed: number } {
  const unzip = (zlib as unknown as { zstdDecompressSync?: (data: Buffer) => Buffer }).zstdDecompressSync;
  if (!unzip) return { text: "", consumed: 0 };
  const parts: Buffer[] = [];
  let at = 0;
  while (at < raw.length) {
    const end = zstdFrameEnd(raw, at);
    if (end < 0) break;
    if (!isSkippableFrame(raw, at)) {
      try { parts.push(unzip(raw.subarray(at, end))); } catch { break; }
    }
    at = end;
  }
  return { text: Buffer.concat(parts).toString("utf8"), consumed: at };
}

/**
 * 从 at 开始的这一帧到哪里结束；没写完或者不是 zstd 帧返回 -1。
 * 不能靠「解得开」来判断：帧被截断时解压函数不报错，只是少给内容，那样会把没写完的帧当成读过了。
 * 所以按帧的结构走一遍（RFC 8878）：帧头 → 一个个块（3 字节块头里写着大小和「是不是最后一块」）→ 可选的 4 字节校验。
 */
export function zstdFrameEnd(raw: Buffer, at: number): number {
  return findFrameEnd(raw, at, raw.length);
}

function findFrameEnd(raw: Buffer, at: number, length: number, readBlock?: (pos: number) => number): number {
  if (isSkippableFrame(raw, at)) {
    if (at + 8 > raw.length) return -1;
    const end = at + 8 + raw.readUInt32LE(at + 4);
    return end > length ? -1 : end;
  }
  if (at + 6 > raw.length || raw.compare(ZSTD_MAGIC, 0, 4, at, at + 4) !== 0) return -1;
  const descriptor = raw[at + 4];
  // RFC 8878 §3.1.1.1.1：Reserved_Bit 必须为 0
  if ((descriptor >> 3) & 1) return -1;
  const single = (descriptor >> 5) & 1, contentSizeFlag = descriptor >> 6;
  let pos = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (contentSizeFlag === 0 ? single : [0, 2, 4, 8][contentSizeFlag]);
  if (pos > length) return -1;
  for (;;) {
    if (pos + 3 > length) return -1;
    const header = pos + 3 <= raw.length ? raw.readUIntLE(pos, 3) : (readBlock?.(pos) ?? -1);
    if (header < 0) return -1;
    const type = (header >> 1) & 3;
    if (type === 3) return -1;
    // RLE 块（type 1）不管声明多大，只占 1 个字节
    pos += 3 + (type === 1 ? 1 : header >> 3);
    if (pos > length) return -1;
    if (header & 1) break;
  }
  if ((descriptor >> 2) & 1) pos += 4;
  return pos > length ? -1 : pos;
}

/** 读完超过常规扫描批次的第一帧。先只读块头定位帧尾，确认完整后才读剩余内容。 */
export function readLargeZstdFrame(fd: number, prefix: Buffer, offset: number, length: number): Buffer | null {
  const block = Buffer.allocUnsafe(3);
  const end = findFrameEnd(prefix, 0, length, (pos) =>
    fs.readSync(fd, block, 0, block.length, offset + pos) === block.length ? block.readUIntLE(0, 3) : -1,
  );
  if (end <= prefix.length) return null;
  const frame = Buffer.allocUnsafe(end);
  prefix.copy(frame);
  let pos = prefix.length;
  while (pos < end) {
    const read = fs.readSync(fd, frame, pos, end - pos, offset + pos);
    if (!read) return null;
    pos += read;
  }
  return frame;
}
