import zlib from "zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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
    try { parts.push(unzip(raw.subarray(at, end))); } catch { break; }
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
  if (at + 6 > raw.length || raw.compare(ZSTD_MAGIC, 0, 4, at, at + 4) !== 0) return -1;
  const descriptor = raw[at + 4];
  const single = (descriptor >> 5) & 1, contentSizeFlag = descriptor >> 6;
  let pos = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (contentSizeFlag === 0 ? single : [0, 2, 4, 8][contentSizeFlag]);
  for (;;) {
    if (pos + 3 > raw.length) return -1;
    const header = raw[pos] | (raw[pos + 1] << 8) | (raw[pos + 2] << 16);
    const type = (header >> 1) & 3;
    if (type === 3) return -1;
    // RLE 块（type 1）不管声明多大，只占 1 个字节
    pos += 3 + (type === 1 ? 1 : header >> 3);
    if (pos > raw.length) return -1;
    if (header & 1) break;
  }
  if ((descriptor >> 2) & 1) pos += 4;
  return pos > raw.length ? -1 : pos;
}
