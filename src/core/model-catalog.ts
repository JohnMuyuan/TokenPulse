import fs from "fs";
import os from "os";
import path from "path";
import { normalizeEffort } from "./model-effort";
import type { AccountKind } from "./quota";
import type { RequestRow } from "./request-log";
export type CatalogEntry = { model: string; effort: string; origins: string[]; source?: string; checkedAt?: string; semantics?: string };
export const comboKey = (model: string, effort?: string) => `${model}\u0000${effort || "unknown"}`;
import { loadKnowledge } from "./knowledge";
import { priceOf } from "./model-pricing";
import { dataFile, readJson } from "./paths";

/*
 * 用户自己加进「换一种模型，整窗能用多少」的型号（0.3.12）：存在 prefs.json 的 studyModels（按家分开），
 * 没用过也能按单价和思考等级消耗估算。目录来源记为 user。
 */
export type StudyModel = { model: string; efforts: string[] };
const STUDY_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "not_supported"]);
export function readStudyModels(kind: AccountKind): StudyModel[] {
  const prefs = readJson<{ studyModels?: Record<string, unknown> }>(dataFile("prefs.json"), {});
  return parseStudyModels(prefs.studyModels?.[kind]);
}
export function parseStudyModels(value: unknown): StudyModel[] {
  const out: StudyModel[] = [];
  for (const raw of Array.isArray(value) ? value.slice(0, 40) : []) {
    const item = raw as { model?: unknown; efforts?: unknown };
    const model = typeof item?.model === "string" ? item.model.trim() : "";
    if (!model || model.length > 120 || !/^[A-Za-z0-9][\w.:/@\[\]-]*$/.test(model) || out.some((m) => m.model === model)) continue;
    const efforts = [...new Set((Array.isArray(item.efforts) ? item.efforts : []).filter((e): e is string => typeof e === "string" && STUDY_EFFORTS.has(e)))];
    out.push({ model, efforts: efforts.length ? efforts : ["not_supported"] });
  }
  return out;
}

/** 「添加模型」的候选：知识库里有单价的这一家型号 + 思考等级目录 + 等级消耗表里的型号，带上单价和已知的等级。 */
export type ModelCandidate = { model: string; input: number | null; output: number | null; efforts: string[]; usage: boolean };
export function modelCandidates(kind: AccountKind, family: RegExp): ModelCandidate[] {
  const knowledge = loadKnowledge().knowledge;
  const ids = new Set<string>();
  for (const rule of knowledge.prices) if (rule.auto && family.test(rule.auto)) ids.add(rule.auto);
  const doc = capabilities()?.[kind as "claude" | "chatgpt" | "grok"];
  for (const model of doc?.models ?? []) if (family.test(model)) ids.add(model.toLowerCase());
  for (const model of Object.keys(knowledge.effortUsage?.models ?? {})) if (family.test(model)) ids.add(model);
  for (const entry of modelCatalog(kind, [])) if (family.test(entry.model)) ids.add(entry.model);
  return [...ids].map((model) => {
    const price = priceOf(model);
    const rule = doc?.rules.find((r) => new RegExp(r.match, "i").test(model));
    const usage = knowledge.effortUsage?.models[model]?.perTask;
    const efforts = [...new Set([...(rule?.efforts ?? []), ...Object.keys(usage ?? {})])];
    return { model, input: price?.input ?? null, output: price?.output ?? null, efforts, usage: Boolean(usage) };
  }).sort((a, b) => a.model.localeCompare(b.model, undefined, { numeric: true }));
}
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
