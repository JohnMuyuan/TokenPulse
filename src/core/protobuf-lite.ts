/**
 * 没有 .proto 的 protobuf 读取：只按字段号取值，够读 Antigravity 本地库里的几个字段（见 antigravity.ts）。
 * 不认识的字段直接跳过；数据不完整、格式不对时返回 null / 0，不抛错。
 */

export type PbField = { no: number; wire: number; num?: number; bytes?: Buffer };

function varint(buf: Buffer, at: number): [number, number] | null {
  let value = 0, scale = 1;
  for (let i = at; i < buf.length && i < at + 10; i += 1) {
    const byte = buf[i];
    value += (byte & 0x7f) * scale;
    if (!(byte & 0x80)) return [value, i + 1];
    scale *= 128;
  }
  return null;
}

/** 一层的全部字段。格式不对返回 null（比如把一段文本当成消息来解）。 */
export function pbFields(buf: Buffer): PbField[] | null {
  const out: PbField[] = [];
  let at = 0;
  while (at < buf.length) {
    const key = varint(buf, at);
    if (!key) return null;
    at = key[1];
    const no = Math.floor(key[0] / 8), wire = key[0] % 8;
    if (no <= 0) return null;
    if (wire === 0) {
      const value = varint(buf, at);
      if (!value) return null;
      out.push({ no, wire, num: value[0] });
      at = value[1];
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > buf.length) return null;
      out.push({ no, wire, bytes: buf.subarray(at, at + size) });
      at += size;
    } else if (wire === 2) {
      const length = varint(buf, at);
      if (!length || length[1] + length[0] > buf.length) return null;
      out.push({ no, wire, bytes: buf.subarray(length[1], length[1] + length[0]) });
      at = length[1] + length[0];
    } else return null;
  }
  return out;
}

/** 按字段号一路往下找（每层取第一个）。找不到返回 null。 */
export function pbMessage(buf: Buffer | null | undefined, ...path: number[]): Buffer | null {
  let current: Buffer | null = buf ?? null;
  for (const no of path) {
    if (!current) return null;
    const field = pbFields(current)?.find((item) => item.no === no && item.wire === 2);
    current = field?.bytes ?? null;
  }
  return current;
}

/** 一层里某个数字字段（varint）。没有就是 0。 */
export function pbNumber(buf: Buffer | null | undefined, no: number): number {
  if (!buf) return 0;
  return pbFields(buf)?.find((item) => item.no === no && item.wire === 0)?.num ?? 0;
}

/** 一层里某个字符串字段。没有就是空字符串。 */
export function pbString(buf: Buffer | null | undefined, no: number): string {
  if (!buf) return "";
  const bytes = pbFields(buf)?.find((item) => item.no === no && item.wire === 2)?.bytes;
  return bytes ? bytes.toString("utf8") : "";
}

/** google.protobuf.Timestamp（1 秒、2 纳秒）→ 毫秒。没有就是 0。 */
export function pbTime(buf: Buffer | null | undefined): number {
  if (!buf) return 0;
  const seconds = pbNumber(buf, 1);
  return seconds ? seconds * 1000 + Math.floor(pbNumber(buf, 2) / 1e6) : 0;
}

/** google.protobuf.Duration（1 秒、2 纳秒）→ 毫秒（含不足 1 秒的纳秒部分）。没有就是 0。 */
export function pbDurationMs(buf: Buffer | null | undefined): number {
  if (!buf) return 0;
  const seconds = pbNumber(buf, 1);
  const nanos = pbNumber(buf, 2);
  if (!seconds && !nanos) return 0;
  return Math.max(0, seconds * 1000 + Math.round(nanos / 1e6));
}
