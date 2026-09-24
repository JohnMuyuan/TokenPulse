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
  for (const row of priceRules()) if (row.test.test(id)) return row.price;
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
