/** 思考等级是配置元数据，不是 reasoning token 数量。未知值不猜、不套用现时配置。 */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto", "adaptive", "enabled", "disabled", "not_supported", "unknown"] as const;
export function normalizeEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(text) && text !== "unknown" ? text : undefined;
}
export function recordedEffort(value: unknown): { effort: string; source: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  for (const key of ["perTurnEffort", "effort", "reasoning_effort", "reasoningEffort", "effortLevel", "level"]) {
    const direct = normalizeEffort(row[key]); if (direct) return { effort: direct, source: key };
  }
  if (row.reasoning && typeof row.reasoning === "object") {
    const effort = normalizeEffort((row.reasoning as Record<string, unknown>).effort);
    if (effort) return { effort, source: "reasoning.effort" };
  }
  if (typeof row.disabled === "boolean") return { effort: row.disabled ? "disabled" : "enabled", source: "disabled" };
  return;
}
