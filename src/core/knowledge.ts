import path from "path";
import { dataFile, readJson, writeJson } from "./paths";

/**
 * 模型知识库：型号单价 + 型号等价规则，放在 `knowledge/models.json`，不写死在代码里。
 *
 * 为什么单独拿出来：新型号隔几周就出一个（本机两个月里就有 gpt-5.6-sol / terra / luna、gpt-6-astra、claude-opus-5-5），
 * 认不出的型号费用显示「未定价」、核验时名字对不上。只改一份 JSON、推到 GitHub，
 * 已安装的 TokenPulse 在「设置 → 关于」里点一下（或每天自动）就能拿到，不用等发新版本。
 *
 * 两份来源，谁的 version 新用谁：
 * - 随安装包带的 `knowledge/models.json`；
 * - 从 GitHub 下载到 `~/.tokenpulse/knowledge.json` 的。
 *
 * 下载来的内容要当成不可信输入：只收认识的字段，正则限长、编不过的丢掉，数字必须是有限的非负数。
 */

type Price4 = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type PriceRule = Price4 & { match: string; note: string;
  /** 自动同步的规则对应的型号 id（0.3.12 起用来列「添加模型」的候选）。 */ auto?: string;
  /** 0.3.13：两个价格来源对不上（按 LiteLLM 用），OpenRouter 的价格。 */ dispute?: { openrouter: { input: number; output: number } };
  /** 0.3.13：单价哪天变的、变之前是多少（从家族兜底换成逐个型号的价格也算）。 */ changedAt?: string; previous?: Price4;
  /** 0.3.13：手动规则的到期日（YYYY-MM-DD，本地日期），过了就不再生效；promo 表示优惠价。 */ until?: string; promo?: boolean };
/** 0.3.13：手动给型号打的标签（优惠价等），until 过了就不显示。 */
export type ModelLabel = { model: string; promo?: boolean; until?: string; note?: string };
export type AliasRule = { match: string; replace: string; note: string };
/** 思考等级规则（0.3.11 起随知识库在线下发）：每家列出型号，以及「哪些型号支持哪些等级」。 */
export type CapabilityRule = { match: string; efforts: string[]; semantics?: string };
export type CapabilityDoc = { source?: string; modelsSource?: string; models: string[]; rules: CapabilityRule[] };
export type Capabilities = { checkedAt: string } & Partial<Record<"claude" | "chatgpt" | "grok", CapabilityDoc>>;
/** 思考等级的 token 消耗（0.3.12，Epoch AI 基准数据）：同一型号各等级每个任务的输出 token，和各家族相对 medium 的平均倍数。 */
export type EffortUsage = { source: string; sourceUrl: string; license: string; anchor: string; updatedAt: string; models: Record<string, { basis: string; perTask: Record<string, number> }>; families: Partial<Record<"claude" | "chatgpt" | "grok", Record<string, number>>> };
export type Knowledge = { schema: 1; version: string; updatedAt: string; prices: PriceRule[]; aliases: AliasRule[]; capabilities?: Capabilities; effortUsage?: EffortUsage; labels?: ModelLabel[] };
export type KnowledgeSource = "bundled" | "downloaded";

export const KNOWLEDGE_URL = "https://raw.githubusercontent.com/JohnMuyuan/TokenPulse/main/knowledge/models.json";
const MAX_RULES = 1000;
const MAX_PATTERN = 200;

export function bundledKnowledgeFile() {
  // build/core/knowledge.js → 项目根 / app.asar 根下的 knowledge/
  return path.join(__dirname, "..", "..", "knowledge", "models.json");
}

export function downloadedKnowledgeFile() {
  return dataFile("knowledge.json");
}

const isDay = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
/** 本地日期 YYYY-MM-DD（到期日按用户这边的日期算）。 */
export const localDay = (at = Date.now()) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");
/** 正则超长直接不要（截断会变成另一个意思）。 */
const pattern = (value: unknown) => (typeof value === "string" && value.length <= MAX_PATTERN ? value : "");

function compiles(pattern: string) {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

/** 校验并清洗。不合格返回 null。 */
export function parseKnowledge(value: unknown): Knowledge | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.schema !== 1 || typeof input.version !== "string" || !/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(input.version)) return null;
  const prices: PriceRule[] = [];
  for (const raw of Array.isArray(input.prices) ? input.prices.slice(0, MAX_RULES) : []) {
    const rule = raw as Record<string, unknown>;
    const match = pattern(rule?.match);
    const numbers = [rule?.input, rule?.output, rule?.cacheRead, rule?.cacheWrite].map(finite);
    if (!match || !compiles(match) || numbers.some((n) => n === null)) continue;
    const [inputPrice, output, cacheRead, cacheWrite] = numbers as number[];
    const auto = typeof rule.auto === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(rule.auto) ? rule.auto.toLowerCase() : undefined;
    const extra: Partial<PriceRule> = {};
    const two = (v: unknown) => { const o = v as Record<string, unknown> | null; const a = finite(o?.input), b = finite(o?.output); return a !== null && b !== null ? { input: a, output: b } : null; };
    const four = (v: unknown) => { const o = v as Record<string, unknown> | null; const n = [o?.input, o?.output, o?.cacheRead, o?.cacheWrite].map(finite); return n.every((x) => x !== null) ? { input: n[0]!, output: n[1]!, cacheRead: n[2]!, cacheWrite: n[3]! } : null; };
    const dispute = two((rule.dispute as Record<string, unknown> | undefined)?.openrouter);
    if (dispute) extra.dispute = { openrouter: dispute };
    const previous = four(rule.previous);
    if (previous && isDay(rule.changedAt)) { extra.previous = previous; extra.changedAt = rule.changedAt as string; }
    if (isDay(rule.until)) extra.until = rule.until as string;
    if (rule.promo === true) extra.promo = true;
    prices.push({ match, input: inputPrice, output, cacheRead, cacheWrite, note: text(rule.note), ...(auto ? { auto } : {}), ...extra });
  }
  const aliases: AliasRule[] = [];
  for (const raw of Array.isArray(input.aliases) ? input.aliases.slice(0, MAX_RULES) : []) {
    const rule = raw as Record<string, unknown>;
    const match = pattern(rule?.match);
    if (!match || !compiles(match) || typeof rule.replace !== "string") continue;
    aliases.push({ match, replace: text(rule.replace, 50), note: text(rule.note) });
  }
  if (!prices.length) return null;
  const capabilities = parseCapabilities(input.capabilities);
  const effortUsage = parseEffortUsage(input.effortUsage);
  const labels: ModelLabel[] = [];
  for (const raw of Array.isArray(input.labels) ? input.labels.slice(0, 200) : []) {
    const l = raw as Record<string, unknown>;
    if (typeof l?.model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(l.model)) continue;
    labels.push({ model: l.model.toLowerCase(), ...(l.promo === true ? { promo: true } : {}), ...(isDay(l.until) ? { until: l.until as string } : {}), ...(typeof l.note === "string" ? { note: text(l.note, 300) } : {}) });
  }
  return { schema: 1, version: input.version, updatedAt: text(input.updatedAt, 40), prices, aliases, ...(capabilities ? { capabilities } : {}), ...(effortUsage ? { effortUsage } : {}), ...(labels.length ? { labels } : {}) };
}

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive", "auto", "not_supported"]);
const USAGE_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
/** 等级消耗表：只收认识的等级名、正的有限数字，型号 id 限长、数量有上限。 */
function parseEffortUsage(value: unknown): EffortUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const levels = (raw: unknown): Record<string, number> => Object.fromEntries(Object.entries(raw && typeof raw === "object" ? raw as Record<string, unknown> : {})
    .filter((entry): entry is [string, number] => USAGE_EFFORTS.has(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0 && entry[1] < 1e9));
  const models: EffortUsage["models"] = {};
  for (const [id, raw] of Object.entries(input.models && typeof input.models === "object" ? input.models as Record<string, unknown> : {}).slice(0, 500)) {
    const m = raw as Record<string, unknown>;
    const perTask = levels(m?.perTask);
    if (id.length <= 80 && /^[a-z0-9][a-z0-9._-]*$/i.test(id) && Object.keys(perTask).length >= 2) models[id.toLowerCase()] = { basis: text(m.basis, 40), perTask };
  }
  const families: EffortUsage["families"] = {};
  const fams = input.families && typeof input.families === "object" ? input.families as Record<string, unknown> : {};
  for (const kind of ["claude", "chatgpt", "grok"] as const) { const r = levels(fams[kind]); if (Object.keys(r).length >= 2) families[kind] = r; }
  if (!Object.keys(models).length && !Object.keys(families).length) return undefined;
  return { source: text(input.source, 300), sourceUrl: text(input.sourceUrl, 300), license: text(input.license, 40), anchor: text(input.anchor, 20) || "medium", updatedAt: text(input.updatedAt, 40), models, families };
}

/**
 * 同一型号从 from 档换到 to 档，每个任务的输出 token 大约乘几倍（按 Epoch 的基准数据）。
 * 先找这个型号自己的数据（去掉 [1m]、日期后缀），没有就用家族平均；都没有返回 null。
 */
export function benchmarkEffortRatio(kind: "claude" | "chatgpt" | "grok", model: string, from: string, to: string): { ratio: number; basis: "model" | "family"; source: string } | null {
  const usage = loadKnowledge().knowledge.effortUsage;
  if (!usage || from === to) return null;
  const id = model.toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const own = usage.models[id]?.perTask;
  if (own?.[from] && own?.[to]) return { ratio: own[to] / own[from], basis: "model", source: usage.models[id].basis };
  const fam = usage.families[kind];
  if (fam?.[from] && fam?.[to]) return { ratio: fam[to] / fam[from], basis: "family", source: "family" };
  return null;
}

/** 思考等级规则同样是下载来的：只收认识的家和等级名，正则要编得过。 */
function parseCapabilities(value: unknown): Capabilities | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const out: Capabilities = { checkedAt: text(input.checkedAt, 40) };
  for (const kind of ["claude", "chatgpt", "grok"] as const) {
    const doc = input[kind] as Record<string, unknown> | undefined;
    if (!doc || typeof doc !== "object") continue;
    const models = (Array.isArray(doc.models) ? doc.models : []).filter((m): m is string => typeof m === "string" && m.length > 0 && m.length <= 120).slice(0, 200);
    const rules: CapabilityRule[] = [];
    for (const raw of Array.isArray(doc.rules) ? doc.rules.slice(0, 100) : []) {
      const rule = raw as Record<string, unknown>;
      const match = pattern(rule?.match);
      const efforts = (Array.isArray(rule?.efforts) ? rule.efforts : []).filter((e): e is string => typeof e === "string" && EFFORTS.has(e));
      if (!match || !compiles(match) || !efforts.length) continue;
      rules.push({ match, efforts, ...(typeof rule.semantics === "string" ? { semantics: text(rule.semantics) } : {}) });
    }
    out[kind] = { source: text(doc.source, 300), modelsSource: text(doc.modelsSource, 300), models, rules };
  }
  return out;
}

/** 版本号比较：2026.09.24 < 2026.09.24.1 < 2026.10.01。 */
export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

let cached: { knowledge: Knowledge; source: KnowledgeSource } | null = null;

/** 当前生效的知识库（内置和下载的谁新用谁）。 */
export function loadKnowledge(): { knowledge: Knowledge; source: KnowledgeSource } {
  if (cached) return cached;
  const bundled = parseKnowledge(readJson(bundledKnowledgeFile(), null));
  const downloaded = parseKnowledge(readJson(downloadedKnowledgeFile(), null));
  if (downloaded && (!bundled || compareVersions(downloaded.version, bundled.version) > 0)) cached = { knowledge: downloaded, source: "downloaded" };
  else if (bundled) cached = { knowledge: bundled, source: "bundled" };
  else cached = { knowledge: { schema: 1, version: "0000.00.00", updatedAt: "", prices: [], aliases: [] }, source: "bundled" };
  return cached;
}

/** 下载了新的之后清缓存（主进程里用；worker 每次都是新进程，自然会重读）。 */
export function resetKnowledgeCache() {
  cached = null;
  compiledPrices = null;
  compiledAliases = null;
}

let compiledPrices: { test: RegExp; price: PriceRule }[] | null = null;
let compiledAliases: { test: RegExp; replace: string }[] | null = null;

export function priceRules() {
  // 手动规则到期（until 早于今天）就跳过：优惠价结束后自动回到自动同步的价格
  const today = localDay();
  if (compiledPrices && compiledDay !== today) compiledPrices = null;
  compiledDay = today;
  compiledPrices ??= loadKnowledge().knowledge.prices.filter((price) => !price.until || price.until >= today).map((price) => ({ test: new RegExp(price.match, "i"), price }));
  return compiledPrices;
}
let compiledDay = "";

/**
 * 型号单价的说明（0.3.13，界面在型号旁边标注用）：优惠价 / 标价不同 / 单价刚更新。
 * 标签按型号 id 匹配（去掉 [1m]、日期后缀）；「刚更新」由界面按 changedAt 决定显示多久。
 */
export type PriceNotes = { price?: Price4; promo?: { until?: string; note?: string }; dispute?: { openrouter: { input: number; output: number } }; changed?: { at: string; previous: Price4 } };
export function priceNotes(modelId: string, rule: PriceRule | null): PriceNotes | null {
  const id = modelId.toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const today = localDay();
  const label = (loadKnowledge().knowledge.labels ?? []).find((l) => (l.model === id || l.model === rule?.auto) && (!l.until || l.until >= today));
  const notes: PriceNotes = {};
  if (label?.promo || rule?.promo) notes.promo = { ...(label?.until || rule?.until ? { until: label?.until || rule?.until } : {}), ...(label?.note ? { note: label.note } : {}) };
  if (rule?.dispute) notes.dispute = rule.dispute;
  if (rule?.changedAt && rule.previous) notes.changed = { at: rule.changedAt, previous: rule.previous };
  if (!Object.keys(notes).length) return null;
  if (rule) notes.price = { input: rule.input, output: rule.output, cacheRead: rule.cacheRead, cacheWrite: rule.cacheWrite };
  return notes;
}

export function aliasRules() {
  compiledAliases ??= loadKnowledge().knowledge.aliases.map((alias) => ({ test: new RegExp(alias.match, "i"), replace: alias.replace }));
  return compiledAliases;
}

export type KnowledgeInfo = { version: string; updatedAt: string; source: KnowledgeSource; prices: number; aliases: number };

export function knowledgeInfo(): KnowledgeInfo {
  const { knowledge, source } = loadKnowledge();
  return { version: knowledge.version, updatedAt: knowledge.updatedAt, source, prices: knowledge.prices.length, aliases: knowledge.aliases.length };
}

/**
 * 拿到远端的内容后调这个：比当前的新就存下来。返回结果给界面说明。
 * 网络请求在主进程里做（Electron 的 net.fetch 走系统代理），这里只管校验和落盘。
 */
export function acceptKnowledge(value: unknown): { updated: boolean; info: KnowledgeInfo; error?: string } {
  const next = parseKnowledge(value);
  if (!next) return { updated: false, info: knowledgeInfo(), error: "知识库格式不对，已忽略" };
  if (compareVersions(next.version, loadKnowledge().knowledge.version) <= 0) return { updated: false, info: knowledgeInfo() };
  writeJson(downloadedKnowledgeFile(), next);
  resetKnowledgeCache();
  return { updated: true, info: knowledgeInfo() };
}

/** 上次检查的时间，存一个小文件。 */
export function readKnowledgeCheck(): { checkedAt?: number; error?: string } {
  return readJson(dataFile("knowledge-check.json"), {});
}

export function writeKnowledgeCheck(value: { checkedAt: number; error?: string }) {
  try {
    writeJson(dataFile("knowledge-check.json"), value);
  } catch {
    // 记不下也不影响使用
  }
}
