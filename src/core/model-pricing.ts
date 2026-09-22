/**
 * 型号单价（美元 / 每百万 token），用来给没有自报花费的记录估一个价。
 *
 * 谁报价谁说了算：
 * - Grok Build 在会话文件里自己报了 `costUsdTicks`，直接用它，不查这张表；
 * - CC Switch 导进来的历史带着它自己算好的 `total_cost_usd`，也直接用；
 * - Claude Code / Codex 的会话文件**只有 token、没有钱**，才落到这张表上。
 *
 * 所以这张表算出来的一律是**估算**，界面上要标出来。定价随时会变，而且第三方中转站
 * 的价格和官方也不一样 —— 它只是让「这个月大概花了多少」有个量级，别当账单。
 *
 * 匹配从上往下，第一条命中生效，所以具体的要排在笼统的前面
 * （`claude.*haiku` 必须在 `claude` 前面），和 lib/context-window.ts 的表一个规矩。
 */

export type ModelPrice = {
  /** 每百万 token 多少美元。 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  note: string;
};

const TABLE: { test: RegExp; price: ModelPrice }[] = [
  // Anthropic
  { test: /claude.*haiku/i, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, note: "Claude Haiku" } },
  { test: /claude.*opus.*4[.-]?[01]?$/i, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, note: "Claude Opus 4 / 4.1" } },
  { test: /claude.*opus/i, price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, note: "Claude Opus 4.5 及之后" } },
  { test: /claude.*(sonnet|fable)/i, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, note: "Claude Sonnet" } },
  { test: /claude/i, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, note: "Claude（按 Sonnet 估）" } },

  // OpenAI / Codex
  { test: /gpt-5\.4-nano/i, price: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0, note: "GPT-5.4 nano" } },
  { test: /gpt-5\.4-mini/i, price: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0, note: "GPT-5.4 mini" } },
  { test: /gpt-5\.4/i, price: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0, note: "GPT-5.4" } },
  { test: /gpt-5\.2/i, price: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0, note: "GPT-5.2" } },
  { test: /gpt-(5\.[56]|6)/i, price: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, note: "GPT-5.5 及之后" } },
  { test: /gpt-4o|gpt-4-turbo/i, price: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0, note: "GPT-4o" } },
  { test: /^o[34]/i, price: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0, note: "o 系列" } },

  // xAI（Grok 自己会报花费，这里只是兜底）
  { test: /grok.*(code|build)/i, price: { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0, note: "grok-code / build" } },
  { test: /grok/i, price: { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0, note: "Grok" } },

  // 其它常见的
  { test: /gemini.*(flash|lite)/i, price: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0, note: "Gemini Flash" } },
  { test: /gemini/i, price: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0, note: "Gemini Pro" } },
  { test: /deepseek/i, price: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0, note: "DeepSeek" } },
  { test: /qwen|glm|kimi|moonshot/i, price: { input: 0.6, output: 2, cacheRead: 0.06, cacheWrite: 0, note: "国产长文模型" } },
];

export function priceOf(modelId: string): ModelPrice | null {
  const id = (modelId || "").trim();
  if (!id) return null;
  for (const row of TABLE) if (row.test.test(id)) return row.price;
  return null;
}

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * 估一笔花费。认不出型号就返回 0（界面上显示「—」，别编一个数出来）。
 *
 * 注意口径：`input` 一律含缓存读和缓存写（Codex / Grok 本来就含，Claude 在扫描时补齐），
 * 所以要先把这两部分扣掉再按全价算，否则那几十万缓存 token 会被当成全价输入。
 */
export function estimateCost(modelId: string, tokens: TokenCounts): number {
  const price = priceOf(modelId);
  if (!price) return 0;
  // `input` 含缓存读和缓存写（见 electron/usage-scan.ts 的口径说明），两个都要扣掉再按全价算。
  const fresh = Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite);
  return (
    (fresh * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}
