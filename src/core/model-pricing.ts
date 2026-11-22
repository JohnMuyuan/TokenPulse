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
 * 匹配从上往下，第一条命中生效，所以具体的要排在笼统的前面（`claude.*haiku` 必须在 `claude` 前面）。
 * 表本身在 `knowledge/models.json`，能在线更新（knowledge.ts）。
 */

import { priceRules } from "./knowledge";

export type ModelPrice = {
  /** 每百万 token 多少美元。 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  note: string;
};

/** 单价表在 knowledge/models.json 里（见 knowledge.ts），这里只负责匹配。 */
export function priceOf(modelId: string): ModelPrice | null {
  const id = (modelId || "").trim();
  if (!id) return null;
  const rules = priceRules();
  for (const row of rules) if (row.test.test(id)) return row.price;
  if (/orchestrator/i.test(id)) {
    for (const row of rules) if (row.test.test("gemini-pro")) return row.price;
  }
  return null;
}

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** 相比全部按输入价计费，缓存读写净省下的美元；未知型号不估价。 */
export function cacheSavings(modelId: string, tokens: TokenCounts): number | null {
  const price = priceOf(modelId);
  if (!price) return null;
  const writePrice = price.cacheWrite > 0 ? price.cacheWrite : price.input;
  return (
    tokens.cacheRead * (price.input - price.cacheRead) -
    tokens.cacheWrite * (writePrice - price.input)
  ) / 1_000_000;
}

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
  /*
   * 表里 cacheWrite 为 0 的意思是「这家没有单独的缓存写入价」（OpenAI / xAI / DeepSeek 都这样），
   * 写缓存的 token 照常按输入价收，**不是免费**。以前按 0 算，平时没事 —— Codex 一直报 0 条缓存写入；
   * 2026-09-24 起新版 Codex（gpt-5.6-sol-excel）开始报 `cache_write_input_tokens`，
   * 实测一条 78,824 输入、56,692 缓存写入的请求只算了 $0.0115（应为约 $0.29），当天 Codex 费用少算一大截。
   */
  const writePrice = price.cacheWrite > 0 ? price.cacheWrite : price.input;
  return (
    (fresh * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * writePrice) /
    1_000_000
  );
}

/**
 * 常见模型的最大输入上下文窗口（Token 数），用于计算单次请求的上下文水位百分比与自动压缩预警。
 * - 若客户端请求型号明确带有 `[1m]` / `[2m]` 标记（如 Claude Code 1M 模式），直接采用该窗口；
 * - 若实际观测输入已超过基础档位（如未带 `[1m]` 后缀但已运行在 1M 上下文的会话），自动上调到对应长窗口档位，避免出现 >100% 假溢出；
 * - 完全未知的第三方自定义型号返回 null，界面不强行编造百分比。
 */
export function contextWindowOf(modelId: string, requestedId?: string, observedInput = 0): number | null {
  const combined = `${requestedId || ""} ${modelId || ""}`.toLowerCase();
  const id = (modelId || requestedId || "").trim().toLowerCase();
  if (!id || id === "未知模型" || id === "unknown") return null;

  let base: number | null = null;
  if (/\[2m\]|(?:^|[-_:/])2m(?:$|[-_[\]])/.test(combined)) base = 2_000_000;
  else if (/\[1m\]|(?:^|[-_:/])1m(?:$|[-_[\]])/.test(combined)) base = 1_000_000;
  else if (/gemini-[234]|orchestrator/.test(id)) base = 1_000_000;
  else if (/claude-/.test(id)) base = 200_000;
  else if (/gpt-4\.1/.test(id)) base = 1_000_000;
  else if (/gpt-[56]|codex/.test(id)) base = 400_000;
  else if (/(?:^|\/)o[134](?:[-_]|$)/.test(id)) base = 200_000;
  else if (/gpt-4o|gpt-oss/.test(id)) base = 128_000;
  else if (/grok-4[\w.-]*fast/.test(id)) base = 2_000_000;
  else if (/grok-4/.test(id)) base = 256_000;
  else if (/grok-[23]/.test(id)) base = 131_072;
  else if (/deepseek/.test(id)) base = 128_000;
  else if (/kimi-k2/.test(id)) base = 256_000;
  else if (/minimax/.test(id)) base = 1_000_000;
  else if (/qwen3|glm-4|glm-5/.test(id)) base = 128_000;

  if (base == null) return null;
  if (observedInput > base) {
    // Claude 长上下文只有 1M 档（没有 256K / 400K 中间档），超过 200K 直接升到 1M
    if (/claude-/.test(id) && observedInput <= 1_000_000) return 1_000_000;
    for (const tier of [200_000, 256_000, 400_000, 1_000_000, 2_000_000]) {
      if (tier >= observedInput) return tier;
    }
    return Math.ceil(observedInput / 100_000) * 100_000;
  }
  return base;
}
