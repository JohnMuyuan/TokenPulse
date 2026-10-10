/*
 * DeepSeek 余额监控（0.3.42）。
 *
 * DeepSeek 没有订阅套餐，只有按量计费的余额。官方有查余额的接口（GET /user/balance），但要用 API Key；
 * DeepSeek Harness 桌面版是账号授权登录的，它的凭据不是 API Key，也不该拿去干别的。
 * 所以让用户自己在 DeepSeek 开放平台建 Key 填进来：只保存在本机的数据目录里，只用来查余额（查余额不花钱）。
 *
 * - 可以填多个 Key（多个 DeepSeek 账号），每个有自己的名字、余额和提醒线；
 * - Key 不发给界面，界面只拿到「sk-…后四位」的提示；
 * - 每 10 分钟查一次，打开软件后先查一次；也可以手动刷新（每个账号至少隔 5 秒）；
 * - 余额低于设的数时提醒一次，回到上面之后再跌下来才会再提醒。
 */
import crypto from "crypto";
import fs from "fs";
import type http from "http";
import os from "os";
import path from "path";
import { appendBalanceSamples, removeBalanceHistory } from "../core/deepseek-insight";
import { dataFile, readJson, writeJson } from "../core/paths";
import { queryRelay, relayBase, type HttpGet, type RelayExtra, type RelayFlavor } from "../core/relay-balance";
import { describeNetError, proxyFor, upstreamRequest } from "../core/upstream-proxy";

export type BalanceInfo = { currency: string; total: number; granted: number; toppedUp: number };
/** extra：第三方中转站多给的信息（套餐、限速窗口、这个 Key 的用量），见 relay-balance.ts。 */
export type BalanceResult = { at: number; ok: boolean; available?: boolean; infos: BalanceInfo[]; error?: string; extra?: RelayExtra };
/** deepseek：DeepSeek 开放平台的 Key；relay：第三方中转站（sub2api、new-api 这类）的 Key，要带站点地址。 */
export type BalanceKind = "deepseek" | "relay";
/** harness：本机 DeepSeek Harness 的用量算在这个账号上。Harness 是账号授权登录的，和 API Key 对不上号，只能由用户指定；最多一个账号有。 */
/** icon / avatar：第三方 Key 的图标。icon 是预设图标的 id（或 letter = 用首字母，空 = 按名字和地址自动匹配），avatar 是上传的图片（data URL，界面已经缩成 128px）。 */
type Account = { id: string; kind: BalanceKind; label: string; apiKey: string; baseUrl?: string; flavor?: RelayFlavor; icon?: string; avatar?: string; alertBelow?: number; last?: BalanceResult; alerted?: boolean; harness?: boolean };
type Stored = { accounts: Account[] };
type Fetcher = (key: string) => Promise<{ status: number; body: string }>;

const EVERY_MS = 10 * 60_000;
const MANUAL_GAP_MS = 5000;
const MAX_ACCOUNTS = 20;
const KEY = /^sk-[A-Za-z0-9_-]{16,200}$/;
/** 中转站的 Key 格式各家不一样，只要求是一串看得见的字符。 */
const RELAY_KEY = /^[\x21-\x7e]{8,300}$/;
const INVALID_KEY = "API Key 无效或已被删除，请换一个";

/** 带着 Key 发一个 GET。不跟随跳转：Key 只发给这个地址。 */
const httpGet: HttpGet = async (target, key) => {
  const url = new URL(target);
  const proxy = await proxyFor(url);
  return new Promise((resolve, reject) => {
    const request: http.ClientRequest = upstreamRequest(url, proxy, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" }, timeout: 15_000 }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 65_536) chunks.push(chunk); });
      response.on("end", () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => reject(new Error(describeNetError(error, Boolean(proxy)))));
    request.end();
  });
};
const defaultFetcher: Fetcher = (key) => httpGet((process.env.TOKENPULSE_DEEPSEEK_BASE || "https://api.deepseek.com").replace(/\/+$/, "") + "/user/balance", key);
const AVATAR = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const iconOf = (value: unknown) => (typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value) ? value : "");
const avatarOf = (value: unknown) => (typeof value === "string" && value.length <= 400_000 && AVATAR.test(value) ? value : "");
const hostOf = (base?: string) => { try { return base ? new URL(base).host : ""; } catch { return ""; } };

/** 把接口的回复整理成余额；格式不对返回 null。金额是字符串（"110.00"），转成数字。 */
export function parseBalance(body: string): { available: boolean; infos: BalanceInfo[] } | null {
  let json: Record<string, unknown>;
  try { json = JSON.parse(body); } catch { return null; }
  if (!json || !Array.isArray(json.balance_infos)) return null;
  const infos: BalanceInfo[] = [];
  for (const raw of json.balance_infos.slice(0, 8)) {
    const item = raw as Record<string, unknown>;
    const currency = typeof item?.currency === "string" && /^[A-Z]{3}$/.test(item.currency) ? item.currency : "";
    const total = Number(item?.total_balance), granted = Number(item?.granted_balance), toppedUp = Number(item?.topped_up_balance);
    if (!currency || !Number.isFinite(total)) continue;
    infos.push({ currency, total, granted: Number.isFinite(granted) ? granted : 0, toppedUp: Number.isFinite(toppedUp) ? toppedUp : 0 });
  }
  return { available: json.is_available === true, infos };
}

function alertAmount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error("提醒金额请填 0 到 1000000 之间的数");
  return amount === 0 ? undefined : Math.round(amount * 100) / 100;
}
function labelText(value: unknown) {
  return typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").trim().slice(0, 30) : "";
}

export class DeepSeekBalance {
  private stored: Stored;
  private loading = new Set<string>();
  private lastStarted = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly file = dataFile("deepseek-balance.json");
  private readonly fetcher: Fetcher;
  private readonly relayGet: HttpGet;
  private readonly now: () => number;

  constructor(private options: { publish?: (state: unknown) => void; notify?: (info: BalanceInfo, below: number, label: string, kind: BalanceKind) => void; fetcher?: Fetcher; relayGet?: HttpGet; now?: () => number } = {}) {
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.relayGet = options.relayGet ?? httpGet;
    this.now = options.now ?? Date.now;
    const raw = readJson<Record<string, unknown>>(this.file, {});
    // 这一版的第一个测试版只能存一个 Key（{ apiKey, alertBelow, last }）：读进来当成第一个账号
    const list = Array.isArray(raw?.accounts) ? raw.accounts : typeof raw?.apiKey === "string" ? [raw] : [];
    const accounts: Account[] = [];
    for (const item of list.slice(0, MAX_ACCOUNTS) as Record<string, unknown>[]) {
      const kind: BalanceKind = item?.kind === "relay" ? "relay" : "deepseek";
      let baseUrl = "";
      if (kind === "relay") { try { baseUrl = relayBase(item.baseUrl); } catch { continue; } }
      if (typeof item?.apiKey !== "string" || !(kind === "relay" ? RELAY_KEY : KEY).test(item.apiKey) || accounts.some((account) => account.apiKey === item.apiKey && (account.baseUrl ?? "") === baseUrl)) continue;
      const last = item.last as BalanceResult | undefined;
      const below = Number(item.alertBelow);
      accounts.push({
        id: typeof item.id === "string" && /^[a-f0-9]{8,32}$/.test(item.id) && !accounts.some((account) => account.id === item.id) ? item.id : crypto.randomBytes(6).toString("hex"),
        kind, label: labelText(item.label), apiKey: item.apiKey,
        ...(kind === "relay" ? { baseUrl, ...(item.flavor === "sub2api" || item.flavor === "newapi" ? { flavor: item.flavor } : {}), ...(iconOf(item.icon) ? { icon: iconOf(item.icon) } : {}), ...(avatarOf(item.avatar) ? { avatar: avatarOf(item.avatar) } : {}) } : {}),
        ...(Number.isFinite(below) && below > 0 ? { alertBelow: below } : {}),
        ...(last && typeof last.at === "number" && Array.isArray(last.infos) ? { last } : {}),
        ...(item.alerted === true ? { alerted: true } : {}),
        ...(kind === "deepseek" && item.harness === true && !accounts.some((account) => account.harness) ? { harness: true } : {}),
      });
    }
    // 老数据没有这个标记：第一个账号当作本机 Harness 用的那个。用户明确取消过（harness: false）就不再自动补
    const firstDeepseek = accounts.find((account) => account.kind === "deepseek");
    if (firstDeepseek && !accounts.some((account) => account.harness) && !(list as Record<string, unknown>[]).some((item) => item?.harness === false)) firstDeepseek.harness = true;
    this.stored = { accounts };
  }

  /** 给界面的：没有 Key 本身，只有提示。 */
  state() {
    // 本机装没装过 DeepSeek Harness：装过才在界面里主动露出 DeepSeek
    const detected = fs.existsSync(path.join(os.homedir(), ".dsh"));
    return {
      detected, everyMinutes: EVERY_MS / 60_000, max: MAX_ACCOUNTS,
      accounts: this.stored.accounts.map((account) => ({ id: account.id, kind: account.kind, label: account.label, host: hostOf(account.baseUrl), baseUrl: account.baseUrl ?? "", flavor: account.flavor ?? null, icon: account.icon ?? "", avatar: account.avatar ?? "", keyHint: `${account.apiKey.startsWith("sk-") ? "sk-" : ""}…${account.apiKey.slice(-4)}`, harness: account.harness === true, alertBelow: account.alertBelow ?? null, last: account.last ?? null, loading: this.loading.has(account.id) })),
    };
  }
  private find(id: unknown) {
    const account = this.stored.accounts.find((item) => item.id === id);
    if (!account) throw new Error("找不到这个 DeepSeek 账号，可能已经删除了");
    return account;
  }
  /** 这个账号存在吗、本机 Harness 的用量算不算它的（给账号页的分析用）。 */
  owner(id: unknown) {
    const account = this.stored.accounts.find((item) => item.id === id);
    return account ? { id: account.id, local: account.harness === true } : null;
  }
  private save() { try { writeJson(this.file, this.stored.accounts.length ? { accounts: this.stored.accounts.map((account) => ({ ...account, harness: account.harness === true })) } : this.stored); } catch { /* 存不下来：这次的结果还在内存里 */ } }
  private publish() { if (!this.stopped) this.options.publish?.(this.state()); }

  start() {
    this.timer = setInterval(() => { void this.refreshAll(false); }, EVERY_MS);
    this.timer.unref?.();
    if (this.stored.accounts.length) { this.first = setTimeout(() => { void this.refreshAll(false); }, 8000); this.first.unref?.(); }
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** 加一个账号：先查一次，DeepSeek 明确说 Key 不对就不留（留着只会每 10 分钟白查一次）。 */
  async add(value: unknown) {
    const input = (value ?? {}) as Record<string, unknown>;
    const key = typeof input.key === "string" ? input.key.trim() : "";
    const kind: BalanceKind = input.kind === "relay" ? "relay" : "deepseek";
    const baseUrl = kind === "relay" ? relayBase(input.baseUrl) : "";
    if (kind === "deepseek" && !KEY.test(key)) throw new Error("这不像 DeepSeek 的 API Key（应该是 sk- 开头的一串）");
    if (kind === "relay" && !RELAY_KEY.test(key)) throw new Error("这不像 API Key（应该是一串不带空格的字符）");
    if (this.stored.accounts.some((account) => account.apiKey === key && (account.baseUrl ?? "") === baseUrl)) throw new Error("这个 API Key 已经添加过了");
    if (this.stored.accounts.length >= MAX_ACCOUNTS) throw new Error(`最多添加 ${MAX_ACCOUNTS} 个账号`);
    const alertBelow = alertAmount(input.alertBelow);
    // 第一个账号默认就是本机 Harness 用的那个；之后加的要用户自己指定
    const firstDeepseek = kind === "deepseek" && !this.stored.accounts.some((item) => item.kind === "deepseek");
    const account: Account = { id: crypto.randomBytes(6).toString("hex"), kind, label: labelText(input.label), apiKey: key, ...(kind === "relay" ? { baseUrl, ...(iconOf(input.icon) ? { icon: iconOf(input.icon) } : {}), ...(avatarOf(input.avatar) ? { avatar: avatarOf(input.avatar) } : {}) } : {}), ...(alertBelow ? { alertBelow } : {}), ...(kind === "deepseek" && (input.harness === true || (input.harness !== false && firstDeepseek)) ? { harness: true } : {}) };
    if (account.harness) for (const other of this.stored.accounts) other.harness = false;
    this.stored.accounts.push(account);
    this.save();
    await this.refresh(account.id, true, true);
    // Key 不对，或者这个站根本查不了余额：都不留
    const refused = account.last && !account.last.ok && (account.last.error === INVALID_KEY || (kind === "relay" && !account.flavor));
    if (refused) {
      const reason = account.last!.error || INVALID_KEY;
      this.stored.accounts = this.stored.accounts.filter((item) => item !== account);
      try { removeBalanceHistory(account.id); } catch { /* 没有历史 */ }
      this.save(); this.publish();
      throw new Error(reason);
    }
    return { ...this.state(), id: account.id };
  }
  /** 改名字、提醒线，或者换 Key（换 Key 同样先查一次，不对就保持原样）。 */
  async update(id: unknown, value: unknown) {
    const account = this.find(id);
    const input = (value ?? {}) as Record<string, unknown>;
    const key = typeof input.key === "string" ? input.key.trim() : "";
    if (key && account.kind === "deepseek" && !KEY.test(key)) throw new Error("这不像 DeepSeek 的 API Key（应该是 sk- 开头的一串）");
    if (key && account.kind === "relay" && !RELAY_KEY.test(key)) throw new Error("这不像 API Key（应该是一串不带空格的字符）");
    if (key && this.stored.accounts.some((item) => item !== account && item.apiKey === key && (item.baseUrl ?? "") === (account.baseUrl ?? ""))) throw new Error("这个 API Key 已经添加过了");
    const alertBelow = "alertBelow" in input ? alertAmount(input.alertBelow) : account.alertBelow;
    if ("label" in input) account.label = labelText(input.label);
    if (account.kind === "relay" && ("icon" in input || "avatar" in input)) {
      const icon = iconOf(input.icon), avatar = avatarOf(input.avatar);
      if (icon) account.icon = icon; else delete account.icon;
      if (avatar) account.avatar = avatar; else delete account.avatar;
    }
    if (input.harness === true && account.kind === "deepseek") { for (const other of this.stored.accounts) other.harness = false; account.harness = true; }
    else if (input.harness === false) account.harness = false;
    if (alertBelow !== account.alertBelow) { if (alertBelow) account.alertBelow = alertBelow; else delete account.alertBelow; account.alerted = false; }
    if (key && key !== account.apiKey) {
      const before = { apiKey: account.apiKey, last: account.last };
      account.apiKey = key; account.last = undefined; account.alerted = false;
      this.save();
      await this.refresh(account.id, true, true);
      if ((account.last as BalanceResult | undefined)?.error === INVALID_KEY) {
        account.apiKey = before.apiKey; account.last = before.last;
        this.save(); this.publish();
        throw new Error(INVALID_KEY);
      }
    }
    this.check(account);
    this.save(); this.publish();
    return this.state();
  }
  remove(id: unknown) {
    const account = this.find(id);
    this.stored.accounts = this.stored.accounts.filter((item) => item !== account);
    this.loading.delete(account.id); this.lastStarted.delete(account.id);
    try { removeBalanceHistory(account.id); } catch { /* 历史删不掉不影响删账号 */ }
    this.save(); this.publish();
    return this.state();
  }

  /** 调整账号的顺序（额度详情里拖动标签）。ids 必须正好是现有的全部账号，否则不动。 */
  /** 账号的类型，没有这个账号返回 null。 */
  kindOf(id: unknown) { return this.stored.accounts.find((item) => item.id === id)?.kind ?? null; }
  reorder(ids: unknown) {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    const current = this.stored.accounts;
    if (list.length !== current.length || new Set(list).size !== list.length || !list.every((id) => current.some((account) => account.id === id))) throw new Error("账号有变化，顺序没保存上，请重试");
    this.stored.accounts = list.map((id) => current.find((account) => account.id === id)!);
    this.save(); this.publish();
    return this.state();
  }

  async refreshAll(manual: boolean) {
    await Promise.all(this.stored.accounts.map((account) => this.refresh(account.id, manual)));
    return this.state();
  }
  async refresh(id: unknown, manual: boolean, force = false) {
    const account = this.stored.accounts.find((item) => item.id === id);
    if (!account || this.loading.has(account.id) || this.stopped) return this.state();
    if (manual && !force && this.now() - (this.lastStarted.get(account.id) ?? -Infinity) < MANUAL_GAP_MS) return this.state();
    const key = account.apiKey;
    this.lastStarted.set(account.id, this.now());
    this.loading.add(account.id); this.publish();
    let result: BalanceResult;
    try {
      if (account.kind === "relay") {
        const reply = await queryRelay(account.baseUrl!, key, this.relayGet, account.flavor);
        if (reply.ok) {
          const { balance } = reply;
          if (this.stored.accounts.includes(account) && account.apiKey === key) account.flavor = balance.extra.flavor;
          // 余额统一放进 infos（没有充值 / 赠送之分）；不限额或订阅没有余额这个数时 infos 是空的，看 extra
          result = { at: this.now(), ok: true, available: balance.available, infos: balance.remaining == null ? [] : [{ currency: balance.currency, total: balance.remaining, granted: 0, toppedUp: balance.remaining }], extra: balance.extra };
        } else result = { at: this.now(), ok: false, infos: account.last?.infos ?? [], error: reply.error, ...(account.last?.extra ? { extra: account.last.extra } : {}) };
      } else {
      const reply = await this.fetcher(key);
      const parsed = reply.status === 200 ? parseBalance(reply.body) : null;
      if (parsed) result = { at: this.now(), ok: true, available: parsed.available, infos: parsed.infos };
      else result = { at: this.now(), ok: false, infos: account.last?.infos ?? [], error: reply.status === 401 || reply.status === 403 ? INVALID_KEY : reply.status === 429 ? "查得太频繁了，稍后会自动再查" : reply.status === 200 ? "DeepSeek 返回的内容看不懂" : `DeepSeek 返回了 HTTP ${reply.status}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const who = account.kind === "relay" ? "站点" : "DeepSeek";
      result = { at: this.now(), ok: false, infos: account.last?.infos ?? [], error: message === "timeout" ? `连接${who === "站点" ? "站点" : " DeepSeek "}超时` : `没连上${who === "站点" ? "站点" : " DeepSeek"}${message ? "：" + message.slice(0, 160) : ""}`, ...(account.last?.extra ? { extra: account.last.extra } : {}) };
    }
    // 查的过程中账号被删掉或 Key 被换掉了：这次的结果不要
    if (this.stored.accounts.includes(account) && account.apiKey === key) {
      account.last = result; this.check(account); this.save();
      // 查到了就记进余额历史：消耗趋势、预计还能用多久都从这里算
      if (result.ok) { try { appendBalanceSamples(account.id, result.at, result.infos); } catch { /* 记不下来：这次的余额照常显示 */ } }
    }
    this.loading.delete(account.id); this.publish();
    return this.state();
  }

  /** 余额低于设的数：提醒一次；回到上面之后重新计。有几种币种时每种都看。 */
  private check(account: Account) {
    const below = account.alertBelow, last = account.last;
    if (!below || !last?.ok || !last.infos.length) return;
    const low = last.infos.find((info) => info.total < below);
    if (low && !account.alerted) { account.alerted = true; this.options.notify?.(low, below, account.label || hostOf(account.baseUrl), account.kind); }
    else if (!low && account.alerted) account.alerted = false;
  }
}
