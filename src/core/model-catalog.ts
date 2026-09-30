import fs from "fs";
import os from "os";
import path from "path";
import { normalizeEffort } from "./model-effort";
import type { AccountKind } from "./quota";
import type { RequestRow } from "./request-log";
export type CatalogEntry = { model: string; effort: string; origins: string[]; source?: string; checkedAt?: string; semantics?: string };
export const comboKey = (model: string, effort?: string) => `${model}\u0000${effort || "unknown"}`;
import { loadKnowledge } from "./knowledge";
/** 思考等级规则：0.3.11 起放在模型知识库里（每天在线更新），不再单独打包一份。 */
const capabilities = () => loadKnowledge().knowledge.capabilities;
/** 目录可见性不等于目标账号可用权限；仅返回模型元数据，绝不返回缓存中的身份字段。 */
export function modelCatalog(kind: AccountKind, observed: RequestRow[], home = os.homedir()): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  const add = (model: string, effort: string, origin: string, extra: Partial<CatalogEntry> = {}) => {
    if (!model || model.length > 160) return;
    const key = comboKey(model, effort), previous = entries.get(key);
    if (previous) { if (!previous.origins.includes(origin)) previous.origins.push(origin); return; }
    entries.set(key, { model, effort, origins: [origin], ...extra });
  };
  if (kind === "chatgpt") {
    try {
      const file = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "models_cache.json");
      const cache = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const model of Array.isArray(cache.models) ? cache.models : []) {
        if (model.visibility === "hide" || typeof model.slug !== "string") continue;
        const efforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []).map((e: any) => normalizeEffort(typeof e === "string" ? e : e?.effort)).filter(Boolean);
        for (const effort of efforts.length ? efforts : ["unknown"]) add(model.slug, effort, "cache", { source: "Codex models_cache.json", checkedAt: typeof cache.fetched_at === "string" ? cache.fetched_at : undefined });
      }
    } catch { /* 没有可读取的目录时仅列实际记录，不猜可用型号 */ }
  }
  const doc = capabilities()?.[kind as "claude" | "chatgpt" | "grok"];
  if (doc) {
    const models = new Set<string>([...doc.models, ...observed.map(r => r.model)]);
    for (const model of models) {
      const rule = doc.rules.find((r: any) => new RegExp(r.match, "i").test(model));
      for (const effort of rule?.efforts ?? []) add(model, effort, "docs", { source: doc.source, checkedAt: capabilities()?.checkedAt, semantics: rule?.semantics });
    }
  }
  for (const row of observed) add(row.model, row.effort || "unknown", "observed");
  return [...entries.values()].sort((a, b) => a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort));
}
