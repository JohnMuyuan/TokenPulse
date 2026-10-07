/*
 * 透明转发的长连接（WebSocket）旁路解析。
 *
 * Codex 用官方登录时，对话走的是一条 WebSocket 长连接。透明转发把这条连接的字节原样在两头之间搬运（见 agent-proxy.ts 的 tunnelPass），
 * 这里只是**旁路**看一眼搬过去的帧：把一条条消息拼出来，留下开头和结尾各一小段，供上面找型号和用量数字。
 * 不改、不拦、不保存任何帧；解析出错就停止解析，搬运不受影响。
 *
 * 支持：分片、掩码（工具发出的帧都带掩码）、控制帧夹在分片中间、permessage-deflate 压缩（协商了才解）。
 */
import zlib from "zlib";
import { StringDecoder } from "string_decoder";

export type WsMessage = {
  /** 这条消息第一帧到的时间、最后一帧到的时间。 */
  startAt: number;
  endAt: number;
  /** 帧里载荷的字节数（压缩的话是压缩后的）。 */
  bytes: number;
  /** 文本消息才有内容；只留开头和结尾各 EDGE 个字符。 */
  text: boolean;
  head: string;
  tail: string;
  /** 打开了 grab 才有：这条消息里第一次出现的响应 ID 和型号、最后一次出现的整段用量（见 Grab）。 */
  responseId?: string;
  model?: string;
  usage?: GrabUsage;
};
export type GrabUsage = { input: number; output: number; cacheRead?: number };

/*
 * 从回复里找「响应 ID」和「上游实际用的型号」（给型号核验用）：取第一次出现的。
 * 回复是一段一段到的，而且可能很长（Codex 的 response.created 里带着整段系统提示词，型号排在它后面），
 * 所以不能只看开头一截：每来一段就接着上一段的结尾找，找到就不再找。
 * 请求和回复里的正文是 JSON 字符串，里面的引号都带反斜杠，不会被当成这两个键。
 */
const GRAB_ID = /"id"\s*:\s*"((?:resp|msg|chatcmpl)[_-][A-Za-z0-9_-]{8,120})"/;
const GRAB_MODEL = /"model"\s*:\s*"([^"\\]{1,120})"/;
/*
 * OpenAI Responses 的用量：{"input_tokens":N,"input_tokens_details":{…"cached_tokens":M},"output_tokens":K,…}。
 * 不能靠「消息的开头和结尾各留一截」来找：response.completed 里前面有一段 tool_usage.image_gen（同样的键，全是 0），
 * 真正的用量在整个 response 对象的后部，它后面还可以跟别的字段——留的那一截里没有它时，读到的就是前面那段 0
 * （0.3.35 测试版在 Codex 桌面端的长对话上就是这样，Token 全是 0，速度算不出来）。
 * 所以边收边找这一整段，取最后一次出现的。
 */
const GRAB_USAGE = /"input_tokens"\s*:\s*(\d+)\s*,\s*"input_tokens_details"\s*:\s*\{([^{}]*)\}\s*,\s*"output_tokens"\s*:\s*(\d+)/g;
const CARRY = 600;
export class Grab {
  responseId = "";
  model = "";
  usage: GrabUsage | null = null;
  private carry = "";
  feed(text: string) {
    if (!text) return;
    const joined = this.carry + text;
    if (!this.responseId) this.responseId = GRAB_ID.exec(joined)?.[1] || "";
    if (!this.model) this.model = GRAB_MODEL.exec(joined)?.[1] || "";
    if (joined.includes('"input_tokens_details"')) {
      for (const match of joined.matchAll(GRAB_USAGE)) {
        const cached = /"cached_tokens"\s*:\s*(\d+)/.exec(match[2])?.[1];
        this.usage = { input: Number(match[1]), output: Number(match[3]), ...(cached != null ? { cacheRead: Number(cached) } : {}) };
      }
    }
    this.carry = joined.slice(-CARRY);
  }
}

const EDGE = 20000;
const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

export class WsReader {
  private pending: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private inFrame = false;
  private mask: Buffer | null = null;
  private maskAt = 0;
  private control = false;
  private fin = false;
  private current: { startAt: number; bytes: number; text: boolean; compressed: boolean; head: string; tail: string; decoder: StringDecoder; grab: Grab | null } | null = null;
  private inflater: zlib.InflateRaw | null = null;
  /** 正在解压的消息排队：解压是异步的，按顺序交出去。 */
  private inflating: NonNullable<WsReader["current"]>[] = [];
  private dead = false;

  constructor(private readonly deflate: boolean, private readonly onMessage: (message: WsMessage) => void, private readonly grab = false) {}

  push(chunk: Buffer, at = Date.now()) {
    if (this.dead) return;
    try { this.consume(chunk, at); } catch { this.stop(); }
  }
  stop() { this.dead = true; this.pending = Buffer.alloc(0); this.inflater?.destroy(); this.inflater = null; }

  private consume(chunk: Buffer, at: number) {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    for (;;) {
      if (!this.inFrame) {
        // 帧头：2 字节 + 扩展长度（0 / 2 / 8）+ 掩码（0 / 4）
        if (data.length < 2) break;
        const masked = (data[1] & 0x80) !== 0;
        let length = data[1] & 0x7f, offset = 2;
        if (length === 126) { if (data.length < 4) break; length = data.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (data.length < 10) break; const big = data.readBigUInt64BE(2); if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large"); length = Number(big); offset = 10; }
        if (data.length < offset + (masked ? 4 : 0)) break;
        const opcode = data[0] & 0x0f;
        this.fin = (data[0] & 0x80) !== 0;
        this.control = opcode >= 8;
        this.mask = masked ? Buffer.from(data.subarray(offset, offset + 4)) : null;
        this.maskAt = 0;
        this.remaining = length;
        this.inFrame = true;
        if (!this.control && opcode !== 0) {
          // 新消息的第一帧（上一条没收完就来了新的：丢掉上一条）
          this.current = { startAt: at, bytes: 0, text: opcode === 1, compressed: this.deflate && (data[0] & 0x40) !== 0, head: "", tail: "", decoder: new StringDecoder("utf8"), grab: this.grab ? new Grab() : null };
        }
        data = data.subarray(offset + (masked ? 4 : 0));
      }
      const take = Math.min(this.remaining, data.length);
      if (take) {
        if (!this.control && this.current) this.payload(data.subarray(0, take));
        else if (this.mask) this.maskAt += take;
        this.remaining -= take;
        data = data.subarray(take);
      }
      if (this.remaining > 0) break;
      this.inFrame = false;
      if (!this.control && this.fin && this.current) { this.finish(this.current, at); this.current = null; }
    }
    if (data.length) this.pending = Buffer.from(data);
  }

  private payload(part: Buffer) {
    const message = this.current!;
    message.bytes += part.length;
    let plain = part;
    if (this.mask) {
      plain = Buffer.allocUnsafe(part.length);
      for (let index = 0; index < part.length; index++) plain[index] = part[index] ^ this.mask[(this.maskAt + index) & 3];
      this.maskAt += part.length;
    }
    if (!message.text) return;
    if (message.compressed) this.inflate(message, plain);
    else keep(message, message.decoder.write(plain));
  }

  private inflate(message: NonNullable<WsReader["current"]>, part: Buffer) {
    if (!this.inflater) {
      this.inflater = zlib.createInflateRaw();
      // 不用 data 事件：它是异步发的，消息结束时可能还有一截没到。改成自己取（见 drain）。
      this.inflater.on("readable", () => this.drain());
      this.inflater.on("error", () => this.stop());
    }
    if (this.inflating[this.inflating.length - 1] !== message) this.inflating.push(message);
    this.inflater.write(part);
  }

  /** 把解压器里已经解出来的都取走，记到排在最前面那条消息上。 */
  private drain() {
    let out: Buffer | null;
    while (this.inflater && (out = this.inflater.read() as Buffer | null) !== null) { const first = this.inflating[0]; if (first) keep(first, first.decoder.write(out)); }
  }

  private finish(message: NonNullable<WsReader["current"]>, at: number) {
    const emit = () => this.onMessage({ startAt: message.startAt, endAt: at, bytes: message.bytes, text: message.text, head: message.head, tail: message.tail,
      ...(message.grab?.responseId ? { responseId: message.grab.responseId } : {}), ...(message.grab?.model ? { model: message.grab.model } : {}), ...(message.grab?.usage ? { usage: message.grab.usage } : {}) });
    if (!message.text || !message.compressed || !this.inflater) { emit(); return; }
    if (this.inflating[this.inflating.length - 1] !== message) this.inflating.push(message);
    // 每条压缩消息的结尾要补上 00 00 ff ff 才是完整的一段；补完等解压器把这一段吐干净再交出去
    this.inflater.write(TRAILER);
    this.inflater.flush(zlib.constants.Z_SYNC_FLUSH, () => {
      if (this.dead) return;
      this.drain();
      const index = this.inflating.indexOf(message);
      if (index >= 0) this.inflating.splice(index, 1);
      emit();
    });
  }
}

function keep(seen: { head: string; tail: string; grab?: Grab | null }, text: string) {
  if (!text) return;
  seen.grab?.feed(text);
  if (seen.head.length < EDGE) seen.head += text.slice(0, EDGE - seen.head.length);
  seen.tail = (seen.tail + text).slice(-EDGE);
}
