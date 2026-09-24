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

export type PriceRule = { match: string; input: number; output: number; cacheRead: number; cacheWrite: number; note: string };
export type AliasRule = { match: string; replace: string; note: string };
export type Knowledge = { schema: 1; version: string; updatedAt: string; prices: PriceRule[]; aliases: AliasRule[] };
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
    prices.push({ match, input: inputPrice, output, cacheRead, cacheWrite, note: text(rule.note) });
  }
  const aliases: AliasRule[] = [];
  for (const raw of Array.isArray(input.aliases) ? input.aliases.slice(0, MAX_RULES) : []) {
    const rule = raw as Record<string, unknown>;
    const match = pattern(rule?.match);
    if (!match || !compiles(match) || typeof rule.replace !== "string") continue;
    aliases.push({ match, replace: text(rule.replace, 50), note: text(rule.note) });
  }
  if (!prices.length) return null;
  return { schema: 1, version: input.version, updatedAt: text(input.updatedAt, 40), prices, aliases };
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
  compiledPrices ??= loadKnowledge().knowledge.prices.map((price) => ({ test: new RegExp(price.match, "i"), price }));
  return compiledPrices;
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
