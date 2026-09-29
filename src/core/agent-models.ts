/**
 * 四家工具的模型候选，口径跟 CC Switch 的表单对齐。
 *
 * Claude Code：Sonnet / Opus / Fable / Haiku / 子代理，各填显示名和实际模型，可声明 1M。
 * Claude Desktop：直连时列出多个 claude-* 角色模型；映射时把角色路由到真实模型。
 * Codex：模型目录，每一行可以同时勾选多个思考等级，并指定默认等级。
 * Grok：一个上游模型加上下文窗口；Chat 格式还可以声明是否支持思考和思考等级。
 */
import fs from "fs";
import path from "path";

export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export const CLAUDE_ROLES = [
  { role: "sonnet", label: "Sonnet", env: "ANTHROPIC_DEFAULT_SONNET_MODEL", nameEnv: "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", oneM: true },
  { role: "opus", label: "Opus", env: "ANTHROPIC_DEFAULT_OPUS_MODEL", nameEnv: "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", oneM: true },
  { role: "fable", label: "Fable", env: "ANTHROPIC_DEFAULT_FABLE_MODEL", nameEnv: "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", oneM: true },
  { role: "haiku", label: "Haiku", env: "ANTHROPIC_DEFAULT_HAIKU_MODEL", nameEnv: "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", oneM: false },
  { role: "subagent", label: "子代理", env: "CLAUDE_CODE_SUBAGENT_MODEL", nameEnv: "", oneM: true },
] as const;

export const DESKTOP_ROLES = [
  { role: "sonnet", label: "Sonnet", route: "claude-sonnet-5" },
  { role: "opus", label: "Opus", route: "claude-opus-5" },
  { role: "fable", label: "Fable", route: "claude-fable-5" },
  { role: "haiku", label: "Haiku", route: "claude-haiku-4-5" },
] as const;

const LEVEL_TEXT: Record<string, string> = {
  none: "Disable Thinking",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Ultra reasoning depth",
};

export type ModelSlot = {
  role: string;
  model: string;
  displayName: string;
  oneM: boolean;
  contextWindow: number | null;
  reasoningLevels: string[];
  defaultReasoningLevel: string;
};

export type DesktopMode = "direct" | "map";

export type ThinkingFlags = { supportsThinking: boolean; supportsEffort: boolean };

export function emptySlot(role = ""): ModelSlot {
  return { role, model: "", displayName: "", oneM: false, contextWindow: null, reasoningLevels: [], defaultReasoningLevel: "" };
}

export function parseSlots(value: unknown): ModelSlot[] {
  if (!Array.isArray(value)) return [];
  const slots: ModelSlot[] = [];
  for (const item of value.slice(0, 24)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const rawLevels = Array.isArray(row.reasoningLevels) ? row.reasoningLevels.map((item) => String(item)) : [];
    const levels = REASONING_LEVELS.filter((level) => rawLevels.includes(level));
    const context = Number(row.contextWindow);
    const fallback = typeof row.defaultReasoningLevel === "string" ? row.defaultReasoningLevel : "";
    slots.push({
      role: String(row.role || "").slice(0, 24),
      model: String(row.model || "").trim().slice(0, 120),
      displayName: String(row.displayName || "").trim().slice(0, 80),
      oneM: row.oneM === true,
      contextWindow: Number.isInteger(context) && context > 0 ? context : null,
      reasoningLevels: levels,
      defaultReasoningLevel: (levels as readonly string[]).includes(fallback) ? fallback : "",
    });
  }
  return slots.filter((slot) => slot.model || slot.displayName || slot.reasoningLevels.length);
}

export function withMarker(model: string, oneM: boolean) {
  const base = model.replace(/\s*\[1m\]\s*$/i, "").trim();
  if (!base) return "";
  return oneM ? `${base}[1M]` : base;
}

/** Claude Code 要写进 settings.json env 的角色模型。主模型用 Sonnet，没有就用传入的默认模型。 */
export function claudeRoleEnv(slots: ModelSlot[], fallback: string) {
  const env: Record<string, string> = {};
  const byRole = new Map(slots.filter((slot) => slot.model).map((slot) => [slot.role, slot]));
  const primary = byRole.get("sonnet")?.model || fallback;
  if (primary) env.ANTHROPIC_MODEL = withMarker(primary, byRole.get("sonnet")?.oneM === true);
  for (const role of CLAUDE_ROLES) {
    const slot = byRole.get(role.role);
    const model = slot?.model || (role.role === "haiku" ? "" : primary);
    if (!model) continue;
    env[role.env] = withMarker(model, role.oneM && slot?.oneM === true);
    if (role.nameEnv) env[role.nameEnv] = slot?.displayName || model.replace(/\s*\[1m\]\s*$/i, "");
  }
  return env;
}

export function desktopRouteModels(slots: ModelSlot[], mode: DesktopMode): { name: string; label: string; oneM: boolean; upstream?: string }[] {
  if (mode === "direct") {
    return slots
      .filter((slot) => /^claude-(sonnet|opus|haiku|fable)-.+/i.test(slot.model))
      .map((slot) => ({ name: slot.model, label: slot.displayName, oneM: slot.oneM }));
  }
  const filled = slots.filter((slot) => slot.model);
  const fallback = filled[0];
  return DESKTOP_ROLES.flatMap((role) => {
    const slot = filled.find((item) => item.role === role.role) || fallback;
    if (!slot?.model) return [];
    return [{ name: role.route, label: slot.displayName || slot.model, oneM: slot.oneM, upstream: slot.model }];
  });
}

export function desktopModelMap(slots: ModelSlot[], mode: DesktopMode) {
  if (mode !== "map") return undefined;
  const map: Record<string, string> = {};
  for (const row of desktopRouteModels(slots, "map")) {
    if (row.upstream) map[row.name] = row.upstream;
  }
  return Object.keys(map).length ? map : undefined;
}

const REASONING_ORDER = REASONING_LEVELS as readonly string[];

export function canonicalLevels(levels: string[]) {
  return REASONING_ORDER.filter((level) => levels.includes(level));
}

/** Codex 自定义目录的一条。模板来自本机 models_cache，没有就用一份能过解析器的骨架。 */
export function codexCatalogEntry(slot: ModelSlot, template: Record<string, unknown> | null, index: number) {
  const entry: Record<string, unknown> = template ? { ...template } : {
    visibility: "list",
    supported_in_api: true,
    shell_type: "shell_command",
    supports_reasoning_summaries: false,
    supports_parallel_tool_calls: true,
    input_modalities: ["text", "image"],
    base_instructions: "You are a coding agent. Follow the user's instructions and use the tools you are given.",
    model_messages: { instructions_template: "You are a coding agent.", instructions_variables: { personality_default: "" } },
    additional_speed_tiers: [],
    availability_nux: null,
  };
  const name = slot.displayName || slot.model;
  entry.slug = slot.model;
  entry.display_name = name;
  entry.description = name;
  entry.priority = 1000 + index;
  entry.additional_speed_tiers = [];
  entry.availability_nux = null;
  if (slot.contextWindow) {
    entry.context_window = slot.contextWindow;
    entry.max_context_window = slot.contextWindow;
  }
  const levels = canonicalLevels(slot.reasoningLevels);
  if (levels.length) {
    entry.supported_reasoning_levels = levels.map((effort) => ({ effort, description: LEVEL_TEXT[effort] }));
    entry.default_reasoning_level = levels.includes(slot.defaultReasoningLevel) ? slot.defaultReasoningLevel : levels[levels.length - 1];
  }
  return entry;
}

export function loadCodexTemplate(codexDir: string): Record<string, unknown> | null {
  const file = path.join(codexDir, "models_cache.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { models?: unknown[] };
    const hit = parsed.models?.find((item) => item && typeof item === "object" && "base_instructions" in item && "model_messages" in item);
    return hit && typeof hit === "object" ? { ...(hit as Record<string, unknown>) } : null;
  } catch {
    return null;
  }
}

export const DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-000000176210";
export const DESKTOP_PROFILE_NAME = "TokenPulse";

export function desktopProfile(baseUrl: string, apiKey: string, models: { name: string; label?: string; oneM?: boolean }[]) {
  const profile: Record<string, unknown> = {
    coworkEgressAllowedHosts: ["*"],
    disableDeploymentModeChooser: true,
    inferenceGatewayApiKey: apiKey,
    inferenceGatewayAuthScheme: "bearer",
    inferenceGatewayBaseUrl: baseUrl,
    inferenceProvider: "gateway",
  };
  if (models.length) {
    profile.inferenceModels = models.map((model) => {
      if (!model.label && !model.oneM) return model.name;
      const item: Record<string, unknown> = { name: model.name };
      if (model.label) item.labelOverride = model.label;
      if (model.oneM) item.supports1m = true;
      return item;
    });
  }
  return profile;
}
