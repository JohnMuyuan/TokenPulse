/**
 * 供应商切换。
 *
 * 每家工具同时只有一个当前供应商。切换只改配置里的地址、密钥和模型，
 * 插件、Hook、MCP 和注释留在原处。本地路由打开时，配置里写成 127.0.0.1 和占位密钥，
 * 真实密钥由路由在转发时注入。退出 TokenPulse 时把配置写回直连，下次启动再接回路由。
 */
import crypto from "crypto";
import { configureConfigFiles, configRead, configWrite, configTransaction, recoverConfig, configAllowRestore, configPreviewing } from "./agent-config";
import { listOriginals, readHistory } from "./agent-history";
import { parseToml, stringifyToml, headerName, tableName, upsertKey, readKey, readValue, replaceTable, setTableKey, quote, unquote, restoreToml } from "./agent-toml";
import fs from "fs";
import os from "os";
import path from "path";
import { ccSwitchDbPath } from "./cc-switch";
import { fetchUpstreamModels, probeUrl, startAgentProxy, type ProxyLog } from "./agent-proxy";
import { canonicalLevels, claudeRoleEnv, desktopModelMap, desktopProfile, desktopRouteModels, DESKTOP_PROFILE_ID, DESKTOP_PROFILE_NAME, emptySlot, loadCodexTemplate, parseSlots, codexCatalogEntry, type DesktopMode, type ModelSlot, type ThinkingFlags } from "./agent-models";
import { AGENT_APPS, AGENT_LABEL, NATIVE_UPSTREAM, POOL_KEY, POOL_OFFICIAL, PROXY_MANAGED, isAgentApp, isUpstream, type AgentApp, type PoolConfig, type PoolMember, type ProxyTarget, type Upstream } from "./agent-types";
import { readOfficialAccountStore, resolveAccountCredential } from "./accounts";
import { dataDir, dataFile, readJson, writeJson } from "./paths";

type Endpoint = { baseUrl: string; apiKey: string; model: string; upstream: Upstream };

type Provider = {
  id: string;
  app: AgentApp;
  name: string;
  official: boolean;
  locked: boolean;
  notes: string;
  sort: number;
  failover: boolean;
  createdAt: number;
  endpoint: Endpoint | null;
  apiKeyField: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  extra: Record<string, string | number | boolean>;
  slots: ModelSlot[];
  desktopMode: DesktopMode;
  contextWindow: number | null;
  thinking: ThinkingFlags;
  websiteUrl: string;
  category: string;
  icon: string;
  iconColor: string;
  endpointAutoSelect: boolean;
  commonConfigEnabled: boolean;
  isFullUrl: boolean;
  promptCacheKey: string;
  promptCacheRouting: "auto" | "enabled" | "disabled";
  codexFastMode: boolean;
  dailyLimitUsd: number | null;
  monthlyLimitUsd: number | null;
  envOverrides: Record<string, string>;
  requestHeaders: Record<string, string>;
  requestBody: Record<string, unknown>;
  /** 自定义头像（data:image/… 小图）。预设头像记在 icon 里。 */
  avatar: string;
  /** 号池（null = 普通供应商）。 */
  pool: PoolConfig | null;
};

type FileSnapshot = Record<string, string | null>;
type Store = {
  version: 1;
  providers: Provider[];
  direct: Partial<Record<AgentApp, string>>;
  owned: Partial<Record<AgentApp, FileSnapshot>>;
  restore: Partial<Record<AgentApp, FileSnapshot>>;
  proxyWritten: Partial<Record<AgentApp, FileSnapshot>>;
  route: Partial<Record<AgentApp, string>>;
  exclusive: Partial<Record<AgentApp, Record<string, string | number | boolean>>>;
  proxy: { port: number; apps: Record<AgentApp, boolean> };
};

export type ProviderView = {
  id: string;
  app: AgentApp;
  name: string;
  official: boolean;
  locked: boolean;
  notes: string;
  sort: number;
  failover: boolean;
  active: boolean;
  direct: boolean;
  cross: boolean;
  baseUrl: string;
  model: string;
  upstream: Upstream | "";
  hasKey: boolean;
  keyHint: string;
  /** Claude Code 写密钥用的变量（编辑时要原样带回去，否则一保存就被改成默认的 AUTH_TOKEN）。 */
  apiKeyField: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  slots: ModelSlot[];
  desktopMode: DesktopMode;
  contextWindow: number | null;
  thinking: ThinkingFlags;
  websiteUrl: string; category: string; icon: string; iconColor: string;
  endpointAutoSelect: boolean; commonConfigEnabled: boolean; isFullUrl: boolean;
  promptCacheKey: string; promptCacheRouting: "auto" | "enabled" | "disabled"; codexFastMode: boolean;
  dailyLimitUsd: number | null; monthlyLimitUsd: number | null;
  envOverrides: Record<string, string>; requestHeaders: Record<string, string>; requestBody: Record<string, unknown>;
  avatar: string;
  pool: (PoolConfig & { members: (PoolMember & { name: string; usable: boolean; requests: number; ok: number; lastAt: number; lastStatus: number; health: "ok" | "degraded" | "open" })[] }) | null;
};

export type AgentView = {
  providers: ProviderView[];
  notice?: string;
  proxy: { running: boolean; port: number; host: string; apps: Record<AgentApp, boolean>; requests: number; ok: number; active: number; startedAt: number };
  health: Record<string, "ok" | "degraded" | "open">;
  logs: ProxyLog[];
};

const CLAUDE_TOP = ["apiKeyHelper", "apiBaseUrl", "primaryModel", "smallFastModel", "apiKey", "model", "fallbackModel", "modelOverrides", "advisorModel", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"];
const CLAUDE_PROTOCOL = new Set(["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD"]);
const CLAUDE_KEYS = new Set(["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS"]);
const CLAUDE_EXCLUSIVE = new Set(["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_DISABLE_ARTIFACT", "ENABLE_TOOL_SEARCH", "CLAUDE_CODE_DISABLE_THINKING", "DISABLE_INTERLEAVED_THINKING", "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_DISABLE_1M_CONTEXT", "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"]);
const CODEX_TOP = ["model_provider", "openai_base_url", "model", "review_model", "model_reasoning_effort", "plan_mode_reasoning_effort", "disable_response_storage", "model_catalog_json", "experimental_bearer_token", "base_url", "wire_api"];
const CODEX_EXCLUSIVE = ["web_search", "model_context_window", "model_auto_compact_token_limit", "model_supports_reasoning_summaries", "model_verbosity"];
const GROK_TABLE = "tokenpulse_route";
const SECRET = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i;
const ADVANCED_DEFAULTS = { websiteUrl: "", category: "custom", icon: "", iconColor: "", endpointAutoSelect: false, commonConfigEnabled: false, isFullUrl: false, promptCacheKey: "", promptCacheRouting: "auto" as const, codexFastMode: false, dailyLimitUsd: null as number | null, monthlyLimitUsd: null as number | null, envOverrides: {} as Record<string,string>, requestHeaders: {} as Record<string,string>, requestBody: {} as Record<string,unknown>, avatar: "", pool: null as PoolConfig | null };
/** 头像：只收小图的 data URL（img 标签里的 SVG 不会执行脚本）。 */
const AVATAR = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_MAX = 400_000;
function avatarOf(value: unknown) { const text = typeof value === "string" ? value.trim() : ""; return text.length <= AVATAR_MAX && AVATAR.test(text) ? text : ""; }
function poolOf(app: AgentApp, value: unknown): PoolConfig | null {
  if (!value || typeof value !== "object" || !POOL_OFFICIAL[app]) return null;
  const raw = value as { strategy?: unknown; members?: unknown };
  const seen = new Set<string>();
  const members = (Array.isArray(raw.members) ? raw.members : []).flatMap((item): PoolMember[] => {
    const member = item as { type?: unknown; id?: unknown };
    if ((member?.type !== "account" && member?.type !== "provider") || typeof member.id !== "string" || !member.id || member.id.length > 200) return [];
    const key = member.type + ":" + member.id;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ type: member.type, id: member.id }];
  }).slice(0, 40);
  return { strategy: raw.strategy === "fill-first" ? "fill-first" : "round-robin", members };
}
/** 号池轮到第几个：每个号池一个游标，每来一个请求往后挪一格。 */
const poolCursor = new Map<string, number>();
/** 号池成员的转发统计（只在内存里，重启清零）。键是成员的目标 id。 */
const memberStats = new Map<string, { requests: number; ok: number; lastAt: number; lastStatus: number }>();


let runtime: ReturnType<typeof startAgentProxy> | null = null;
let runtimePort = 0;
const circuits = new Map<string, { fails: number; until: number }>();
let logs: ProxyLog[] = [];

export function agentHome() {
  return process.env.AGENT_SWITCH_HOME || os.homedir();
}

function claudeFloor(key: string) {
  return key.startsWith("ANTHROPIC_") || key.startsWith("AWS_") || key.startsWith("VERTEX_REGION_") || CLAUDE_PROTOCOL.has(key) || CLAUDE_KEYS.has(key) || (key.startsWith("CLAUDE_CODE_SKIP_") && key.endsWith("_AUTH"));
}
function secretKey(key: string) {
  return SECRET.test(key);
}

function emptyStore(): Store {
  return {
    version: 1,
    providers: [],
    direct: {}, owned: {}, restore: {}, proxyWritten: {},
    route: {},
    exclusive: {},
    proxy: { port: 17621, apps: { claude: false, desktop: false, codex: false, grok: false } },
  };
}

function seedOfficials(store: Store) {
  const rows: [AgentApp, string][] = [["claude", "Claude 官方"], ["desktop", "Claude 桌面端官方"], ["codex", "OpenAI 官方"], ["grok", "Grok 官方"]];
  rows.forEach(([app, name], sort) => {
    if (store.providers.some((item) => item.id === `official-${app}`)) return;
    store.providers.push(officialSeed(app, name, sort));
  });
}

function officialSeed(app: AgentApp, name: string, sort: number): Provider {
  return { id: `official-${app}`, app, name, official: true, locked: false, notes: "使用这个工具自己的官方登录。", sort, failover: false, createdAt: 0, endpoint: null, apiKeyField: "ANTHROPIC_AUTH_TOKEN", extra: {}, slots: [], desktopMode: "direct", contextWindow: null, thinking: { supportsThinking: false, supportsEffort: false }, ...ADVANCED_DEFAULTS };
}

function normalize(raw: Store): Store {
  const store = emptyStore();
  store.providers = Array.isArray(raw.providers) ? raw.providers.map(normalizeProvider).filter((item): item is Provider => !!item) : [];
  // 旧数据里可能有 gemini 的键（0.3.9 草稿支持过 Gemini CLI），只留现在支持的三家
  const known = <T>(value: Partial<Record<string, T>> | undefined) => Object.fromEntries(Object.entries(value || {}).filter(([app]) => isAgentApp(app))) as Partial<Record<AgentApp, T>>;
  store.direct = known(raw.direct);
  store.owned = known(raw.owned); store.restore = known(raw.restore); store.proxyWritten = known(raw.proxyWritten);
  store.route = known(raw.route);
  store.exclusive = known(raw.exclusive);
  store.proxy.port = Number(raw.proxy?.port) || 17621;
  for (const app of AGENT_APPS) store.proxy.apps[app] = raw.proxy?.apps?.[app] === true;
  seedOfficials(store);
  return store;
}

function normalizeProvider(value: Partial<Provider>): Provider | null {
  if (!value || !isAgentApp(value.app) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  const endpoint = value.endpoint;
  // 上游是已经不支持的协议（旧的 Gemini）：整条丢掉，不留一个没有地址的空壳
  if (!value.official && endpoint && !isUpstream(endpoint.upstream)) return null;
  const validEndpoint = endpoint && typeof endpoint.baseUrl === "string" && isUpstream(endpoint.upstream)
    ? { baseUrl: endpoint.baseUrl, apiKey: String(endpoint.apiKey || ""), model: String(endpoint.model || ""), upstream: endpoint.upstream }
    : null;
  return {
    id: value.id,
    app: value.app,
    name: value.name.slice(0, 80),
    official: value.official === true,
    locked: value.locked === true,
    notes: String(value.notes || "").slice(0, 400),
    sort: Number(value.sort) || 0,
    failover: value.failover === true,
    createdAt: Number(value.createdAt) || 0,
    endpoint: value.official ? null : validEndpoint,
    apiKeyField: value.apiKeyField === "ANTHROPIC_API_KEY" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN",
    extra: normalizeExtra(value.app, value.extra),
    slots: parseSlots(value.slots),
    desktopMode: value.desktopMode === "map" ? "map" : "direct",
    contextWindow: Number.isInteger(Number(value.contextWindow)) && Number(value.contextWindow) > 0 ? Number(value.contextWindow) : null,
    thinking: { supportsThinking: value.thinking?.supportsThinking === true, supportsEffort: value.thinking?.supportsEffort === true },
    websiteUrl: String(value.websiteUrl || "").slice(0, 300), category: String(value.category || "custom").slice(0, 60), icon: String(value.icon || "").slice(0, 40), iconColor: String(value.iconColor || "").slice(0, 20),
    endpointAutoSelect: value.endpointAutoSelect === true, commonConfigEnabled: value.commonConfigEnabled === true, isFullUrl: value.isFullUrl === true,
    promptCacheKey: String(value.promptCacheKey || "").slice(0, 200), promptCacheRouting: value.promptCacheRouting === "enabled" || value.promptCacheRouting === "disabled" ? value.promptCacheRouting : "auto", codexFastMode: value.codexFastMode === true,
    dailyLimitUsd: positiveNumber(value.dailyLimitUsd), monthlyLimitUsd: positiveNumber(value.monthlyLimitUsd),
    envOverrides: stringMap(value.envOverrides, 80), requestHeaders: stringMap(value.requestHeaders, 40), requestBody: objectMap(value.requestBody),
    avatar: avatarOf(value.avatar), pool: value.official ? null : poolOf(value.app, value.pool),
  };
}

function storeFile() {
  return dataFile("agent-switch.json");
}

function load(): Store {
  recoverConfig();
  const file = storeFile();
  const text = configRead(file);
  if (text === null) {
    const store = emptyStore();
    seedOfficials(store);
    save(store);
    return store;
  }
  const parsed = JSON.parse(text) as Store;
  if (!parsed || parsed.version !== 1) throw new Error("供应商数据损坏，已停止写入，请先恢复备份");
  return normalize(parsed);
}

function save(store: Store) {
  const file = storeFile();
  configWrite(file, JSON.stringify(store));
}

function byId(store: Store, id?: string) {
  return store.providers.find((item) => item.id === id);
}

export function agentView(): AgentView {
  const store = load();
  const stats = runtime?.stats() ?? { requests: 0, ok: 0, active: 0, startedAt: 0 };
  return {
    notice: configNotice || undefined,
    providers: store.providers
      .slice()
      .sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt)
      .map((provider) => {
        const activeId = currentId(store, provider.app);
        const endpoint = provider.endpoint;
        return {
          id: provider.id,
          app: provider.app,
          name: provider.name,
          official: provider.official,
          locked: provider.locked,
          notes: provider.notes,
          sort: provider.sort,
          failover: provider.failover,
          active: provider.id === activeId,
          direct: provider.id === store.direct[provider.app],
          cross: !!endpoint && endpoint.upstream !== NATIVE_UPSTREAM[provider.app],
          baseUrl: endpoint?.baseUrl || "",
          model: endpoint?.model || "",
          upstream: endpoint?.upstream || "",
          hasKey: !!endpoint?.apiKey,
          keyHint: endpoint?.apiKey ? endpoint.apiKey.slice(-4) : "",
          apiKeyField: provider.apiKeyField,
          slots: provider.slots,
          desktopMode: provider.desktopMode,
          contextWindow: provider.contextWindow,
          // Codex 整体上下文（config.toml 顶层的 model_context_window / model_auto_compact_token_limit）
          codexContextWindow: typeof provider.extra.model_context_window === "number" ? provider.extra.model_context_window : null,
          codexAutoCompact: typeof provider.extra.model_auto_compact_token_limit === "number" ? provider.extra.model_auto_compact_token_limit : null,
          thinking: provider.thinking, websiteUrl: provider.websiteUrl, category: provider.category, icon: provider.icon, iconColor: provider.iconColor, endpointAutoSelect: provider.endpointAutoSelect, commonConfigEnabled: provider.commonConfigEnabled, isFullUrl: provider.isFullUrl, promptCacheKey: provider.promptCacheKey, promptCacheRouting: provider.promptCacheRouting, codexFastMode: provider.codexFastMode, dailyLimitUsd: provider.dailyLimitUsd, monthlyLimitUsd: provider.monthlyLimitUsd, envOverrides: provider.envOverrides, requestHeaders: provider.requestHeaders, requestBody: provider.requestBody,
          avatar: provider.avatar,
          pool: provider.pool ? { ...provider.pool, members: provider.pool.members.map((member) => poolMemberView(store, provider, member)) } : null,
        };
      }),
    proxy: {
      running: !!runtime,
      port: runtimePort || store.proxy.port,
      host: "127.0.0.1",
      apps: { ...store.proxy.apps },
      requests: stats.requests,
      ok: stats.ok,
      active: stats.active,
      startedAt: stats.startedAt,
    },
    health: Object.fromEntries(store.providers.map((provider) => [provider.id, healthOf(provider.id)])),
    logs: logs.slice(0, 30),
  };
}

/** 号池成员在界面上的样子：名字、现在能不能用、转发统计。不带任何凭据。 */
function poolMemberView(store: Store, pool: Provider, member: PoolMember) {
  const targetId = memberTargetId(pool, member);
  const stats = memberStats.get(targetId) ?? { requests: 0, ok: 0, lastAt: 0, lastStatus: 0 };
  if (member.type === "provider") {
    const provider = byId(store, member.id);
    return { ...member, name: provider?.name || "已删除的供应商", usable: !!provider?.endpoint && !provider.official && !provider.pool, ...stats, health: healthOf(targetId) };
  }
  const account = readOfficialAccountStore().accounts.find((item) => item.id === member.id);
  const usable = !!account && !account.hidden && !resolveAccountCredential(account).expired;
  return { ...member, name: account ? account.alias || account.email || account.label : "已删除的账号", usable, ...stats, health: healthOf(targetId) };
}
function memberTargetId(pool: Provider, member: PoolMember) {
  return member.type === "provider" ? member.id : `${pool.id}@${member.id}`;
}

function healthOf(id: string): "ok" | "degraded" | "open" {
  const row = circuits.get(id);
  if (!row || row.fails === 0) return "ok";
  if (row.until > Date.now()) return "open";
  return "degraded";
}

function currentId(store: Store, app: AgentApp) {
  if (store.proxy.apps[app] && store.route[app] && proxyIsOurs(app)) return store.route[app] || "";
  if (app === 'desktop') return stillOwned(store, app) ? store.direct[app] || '' : '';
  return matchLive(store, app) || (!liveMarker(app) && stillOwned(store, app) ? store.direct[app] || '' : '');
}

export function saveProvider(input: unknown) { return syncMutation(() => saveProviderImpl(input)); }
function saveProviderImpl(input: unknown) {
  const parsed = parseSave(input);
  const store = load();
  const existing = parsed.id ? byId(store, parsed.id) : undefined;
  if (parsed.id && !existing) throw new Error("找不到这个供应商");
  if (existing?.official || existing?.locked) throw new Error("官方供应商不能改成第三方配置");
  if (existing && existing.app !== parsed.app) throw new Error("不能改变供应商所属工具，请在目标工具下新增");
  if (existing && !!existing.pool !== !!parsed.pool) throw new Error("号池和普通供应商不能互相转换，请新建");
  const needsProxy = !!parsed.pool || parsed.upstream !== NATIVE_UPSTREAM[parsed.app] || (parsed.app === "desktop" && parsed.desktopMode === "map");
  if (existing && !store.proxy.apps[parsed.app] && currentId(store, parsed.app) === existing.id && needsProxy) {
    throw new Error("当前供应商正在直连。请先开启本地路由，再修改接口格式或模型映射。");
  }
  const apiKey = parsed.pool ? POOL_KEY : parsed.apiKey || (parsed.keepKey ? existing?.endpoint?.apiKey || "" : "");
  if (!apiKey) throw new Error("请填写 API Key");
  if (parsed.pool) {
    // 成员只能是同一工具的普通供应商或同一家的官方账号
    const accounts = readOfficialAccountStore().accounts;
    for (const member of parsed.pool.members) {
      if (member.type === "provider") {
        const target = byId(store, member.id);
        if (!target || target.app !== parsed.app || !target.endpoint || target.official || target.locked || target.pool) throw new Error("号池只能加入同一工具下带地址和密钥的供应商");
      } else if (!accounts.some((item) => item.id === member.id && item.kind === POOL_OFFICIAL[parsed.app]?.kind)) throw new Error("号池里有找不到的官方账号，请刷新后重选");
    }
    if (!parsed.pool.members.length) throw new Error("号池至少要有一个成员");
  }
  const owned = stillOwned(store, parsed.app);
  const endpoint: Endpoint = { baseUrl: parsed.baseUrl, apiKey, model: parsed.model, upstream: parsed.upstream };
  rejectLoopback(endpoint.baseUrl);
  const provider: Provider = existing ?? {
    id: `p${crypto.randomBytes(8).toString("hex")}`,
    app: parsed.app,
    name: parsed.name,
    official: false,
    locked: false,
    notes: "",
    sort: nextSort(store, parsed.app),
    failover: false,
    createdAt: Date.now(),
    endpoint,
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    extra: {},
    slots: [],
    desktopMode: "direct",
    contextWindow: null,
    thinking: { supportsThinking: false, supportsEffort: false }, websiteUrl: "", category: "official", icon: "", iconColor: "", endpointAutoSelect: false, commonConfigEnabled: false, isFullUrl: false, promptCacheKey: "", promptCacheRouting: "auto", codexFastMode: false, dailyLimitUsd: null, monthlyLimitUsd: null, envOverrides: {}, requestHeaders: {}, requestBody: {}, avatar: "", pool: null,
  };
  provider.app = parsed.app;
  provider.name = parsed.name;
  provider.notes = parsed.notes;
  provider.endpoint = endpoint;
  provider.apiKeyField = parsed.apiKeyField;
  provider.slots = parsed.slots.length ? parsed.slots : [{ ...emptySlot(parsed.app === "codex" ? "catalog" : "sonnet"), model: parsed.model }];
  provider.desktopMode = parsed.desktopMode;
  provider.contextWindow = parsed.contextWindow;
  if (parsed.codexContext) {
    const extra = { ...provider.extra };
    if (parsed.codexContext.window) extra.model_context_window = parsed.codexContext.window; else delete extra.model_context_window;
    if (parsed.codexContext.compact) extra.model_auto_compact_token_limit = parsed.codexContext.compact; else delete extra.model_auto_compact_token_limit;
    provider.extra = extra;
  }
  provider.thinking = parsed.thinking; provider.websiteUrl = parsed.websiteUrl; provider.category = parsed.category; provider.icon = parsed.icon; provider.iconColor = parsed.iconColor; provider.endpointAutoSelect = parsed.endpointAutoSelect; provider.commonConfigEnabled = parsed.commonConfigEnabled; provider.isFullUrl = parsed.isFullUrl; provider.promptCacheKey = parsed.promptCacheKey; provider.promptCacheRouting = parsed.promptCacheRouting; provider.codexFastMode = parsed.codexFastMode; provider.dailyLimitUsd = parsed.dailyLimitUsd; provider.monthlyLimitUsd = parsed.monthlyLimitUsd; provider.envOverrides = parsed.envOverrides; provider.requestHeaders = parsed.requestHeaders; provider.requestBody = parsed.requestBody;
  provider.avatar = parsed.avatar; provider.pool = parsed.pool;
  if (!existing) store.providers.push(provider);
  save(store);
  const current = store.proxy.apps[provider.app] ? store.route[provider.app] : store.direct[provider.app];
  if (current === provider.id && owned) {
    if (store.proxy.apps[provider.app]) applyProxy(provider.app); else applyDirect(provider);
  } else if (current === provider.id) configNotice = '资料已保存；工具配置已在外部修改，未覆盖。需要切换时请明确点击启用。';
  return provider.id;
}

function parseSave(input: unknown) {
  const body = asObj(input);
  const app = body.app;
  const upstream = body.upstream;
  const poolInput = body.pool && typeof body.pool === "object";
  if (poolInput && isAgentApp(app) && !POOL_OFFICIAL[app]) throw new Error("Claude 桌面端不支持号池");
  const pool = isAgentApp(app) && poolInput ? poolOf(app, body.pool) : null;
  if (!isAgentApp(app) || (!pool && !isUpstream(upstream))) throw new Error("工具或接口格式不正确");
  const name = str(body.name).trim();
  // 号池不用填地址：官方账号走各家官方接口，API Key 成员走它们自己的地址。这里记官方接口，只是占位
  const baseUrl = pool ? POOL_OFFICIAL[app]!.baseUrl : str(body.baseUrl).trim().replace(/\/+$/, "");
  if (!name || name.length > 60) throw new Error("请填写 60 字以内的名称");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("请求地址需要是 http 或 https 网址"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("请求地址需要是 http 或 https 网址");
  if (Array.isArray(body.slots) && body.slots.length > 24) throw new Error("最多支持 24 个模型，请精简后再保存；未保存任何更改");
  const slots = parseSlots(body.slots);
  const model = str(body.model).trim() || slots.find((slot) => slot.model)?.model || "";
  // 号池可以不指定模型：官方账号按 CLI 自己选的模型发。Grok 的配置表必须写一个模型名
  if ((!model && (!pool || app === "grok")) || model.length > 120) throw new Error("请填写模型名");
  const context = Number(body.contextWindow);
  const thinking = asObj(body.thinking);
  const codexContext = app === "codex" && ("codexContextWindow" in body || "codexAutoCompact" in body) ? parseCodexContext(body.codexContextWindow, body.codexAutoCompact) : null;
  return {
    id: str(body.id),
    app,
    name,
    baseUrl,
    apiKey: str(body.apiKey).trim(),
    model,
    upstream: pool ? NATIVE_UPSTREAM[app] : upstream as Upstream,
    pool,
    avatar: avatarOf(body.avatar),
    notes: str(body.notes).trim().slice(0, 400),
    keepKey: body.keepKey === true,
    apiKeyField: body.apiKeyField === "ANTHROPIC_API_KEY" ? "ANTHROPIC_API_KEY" as const : "ANTHROPIC_AUTH_TOKEN" as const,
    slots,
    desktopMode: body.desktopMode === "map" ? "map" as const : "direct" as const,
    contextWindow: Number.isInteger(context) && context > 0 ? context : null,
    codexContext,
    thinking: { supportsThinking: thinking.supportsThinking === true, supportsEffort: thinking.supportsEffort === true },
    websiteUrl: str(body.websiteUrl).trim().slice(0, 300), category: str(body.category).trim().slice(0, 60) || "custom", icon: str(body.icon).trim().slice(0, 40), iconColor: str(body.iconColor).trim().slice(0, 20), endpointAutoSelect: body.endpointAutoSelect === true, commonConfigEnabled: body.commonConfigEnabled === true, isFullUrl: body.isFullUrl === true, promptCacheKey: str(body.promptCacheKey).trim().slice(0, 200), promptCacheRouting: (body.promptCacheRouting === "enabled" || body.promptCacheRouting === "disabled" ? body.promptCacheRouting : "auto") as "auto" | "enabled" | "disabled", codexFastMode: body.codexFastMode === true, dailyLimitUsd: positiveNumber(body.dailyLimitUsd), monthlyLimitUsd: positiveNumber(body.monthlyLimitUsd), envOverrides: stringMap(body.envOverrides, 80), requestHeaders: stringMap(body.requestHeaders, 40), requestBody: objectMap(body.requestBody),
  };
}

/**
 * Codex 整体上下文（0.3.9）：和 CC Switch 一样写 config.toml 顶层的 model_context_window 和 model_auto_compact_token_limit。
 * 空 = 不写（跟随 Codex 自己的默认）。上限 1000 万；自动压缩阈值要小于上下文窗口。
 */
function parseCodexContext(windowValue: unknown, compactValue: unknown) {
  const read = (value: unknown, label: string) => {
    if (value == null || (typeof value === "string" && !value.trim())) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1000 || n > 10_000_000) throw new Error(label + "要是 1000 到 10000000 之间的整数");
    return n;
  };
  const window = read(windowValue, "上下文窗口");
  const compact = read(compactValue, "自动压缩阈值");
  if (window && compact && compact >= window) throw new Error("自动压缩阈值要小于上下文窗口");
  return { window, compact };
}

/** 限额：没填（null / 空串 / 空白）就是不限，不能被 Number() 变成 0。 */
function positiveNumber(value: unknown) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function stringMap(value: unknown, limit: number) { const obj = asObj(value); return Object.fromEntries(Object.entries(obj).slice(0, limit).filter(([k,v]) => /^[A-Za-z0-9_:-]{1,100}$/.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")).map(([k,v]) => [k, String(v)])); }
function objectMap(value: unknown) { const obj = asObj(value); return Object.fromEntries(Object.entries(obj).slice(0, 80)); }
function rejectLoopback(baseUrl: string) {
  const url = new URL(baseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (local && /^\/(claude|desktop|codex|grok)(\/|$)/.test(url.pathname)) throw new Error("这个地址是本地路由自己，不能当作供应商");
}

function nextSort(store: Store, app: AgentApp) {
  return store.providers.filter((item) => item.app === app).reduce((max, item) => Math.max(max, item.sort), 0) + 1;
}

export function deleteProvider(id: string) { return syncMutation(() => deleteProviderImpl(id)); }
function deleteProviderImpl(id: string) {
  const store = load();
  const provider = must(store, id);
  if (provider.official && provider.id.startsWith("official-")) throw new Error("内置的官方供应商保留着，用来切回官方登录");
  if (store.direct[provider.app] === id || (store.proxy.apps[provider.app] && store.route[provider.app] === id) || currentId(store, provider.app) === id) {
    throw new Error("正在使用的供应商要先切换走，才能删除");
  }
  store.providers = store.providers.filter((item) => item.id !== id);
  save(store);
}

export function setFailover(id: string, on: boolean) { return syncMutation(() => setFailoverImpl(id, on)); }
function setFailoverImpl(id: string, on: boolean) {
  const store = load();
  const provider = must(store, id);
  if (provider.official || provider.locked) throw new Error("官方登录不进入备用队列");
  if (provider.pool) throw new Error("号池自己会在成员之间切换，不进入备用队列");
  provider.failover = on;
  save(store);
}

export function reorderProviders(app: AgentApp, ids: string[]) { return syncMutation(() => reorderProvidersImpl(app, ids)); }
function reorderProvidersImpl(app: AgentApp, ids: string[]) {
  const store = load();
  const mine = store.providers.filter((item) => item.app === app);
  if (mine.length !== ids.length || mine.some((item) => !ids.includes(item.id))) throw new Error("排序和当前供应商对不上");
  ids.forEach((id, index) => {
    const provider = must(store, id);
    provider.sort = index + 1;
  });
  save(store);
}

export async function activateProvider(id: string) {
  return asyncMutation(async () => {
    const store = load(), provider = must(store, id), app = provider.app;
    if (provider.locked) throw new Error('该供应商的凭证由原工具管理，请添加 API Key 供应商');
    if (provider.official && store.proxy.apps[app]) throw new Error('请先关闭本地路由，再切回官方登录');
    const cross = !!provider.endpoint && (!!provider.pool || provider.endpoint.upstream !== NATIVE_UPSTREAM[app] || (app === 'desktop' && provider.desktopMode === 'map'));
    if (cross || store.proxy.apps[app]) {
      await enableProxy(app, id);
      return { message: '已启用 ' + provider.name + (provider.pool ? '（号池，经本地路由轮流转发）' : '（本地路由）'), restart: app !== 'claude' };
    }
    configTransaction(() => {
      const current = load(); current.direct[app] = id; current.route[app] = id;
      save(current); applyDirect(must(current, id));
    });
    return { message: AGENT_LABEL[app] + ' 已切换到 ' + provider.name, restart: app !== 'claude' };
  });
}
async function enableProxy(app: AgentApp, selected?: string) {
  const initial = load();
  const id = selected || [initial.route[app], initial.direct[app]].find(id => { const p = byId(initial, id); return p?.endpoint && !p.official && !p.locked; })
    || initial.providers.find(p => p.app === app && p.endpoint && !p.official && !p.locked && !p.pool)?.id;
  const provider = id ? must(initial, id) : null;
  if (!provider?.endpoint || provider.official || provider.locked) throw new Error('先添加带地址和密钥的供应商');
  if (initial.proxy.apps[app] && initial.restore[app] && !proxyIsOurs(app)) throw new Error('工具连接已在外部修改，请先关闭此路由再明确启用');
  await ensureProxy();
  try {
    configTransaction(() => {
      const store = load();
      if (!store.proxy.apps[app] || !store.restore[app]) {
        if (proxyIsOurs(app)) throw new Error('当前是缺少接管快照的旧路由配置，请先关闭旧路由再重新启用');
        captureDirect(store, app); store.restore[app] = snapshotFiles(app);
      }
      store.route[app] = id; store.proxy.apps[app] = true; save(store); applyProxy(app);
    });
  } catch (error) { if (!AGENT_APPS.some(app => load().proxy.apps[app])) await stopProxy(); throw error; }
}
export async function setAppProxy(app: AgentApp, on: boolean) {
  return asyncMutation(async () => {
    if (on) { await enableProxy(app); return; }
    configAllowRestore(() => configTransaction(() => {
      const store = load(); restoreProxy(store, app); store.proxy.apps[app] = false; save(store);
    }));
    if (!AGENT_APPS.some(app => load().proxy.apps[app])) await stopProxy();
  });
}
export async function setProxyPort(port: number) {
  return syncMutation(() => {
    if (runtime) throw new Error('先关闭本地路由，再修改端口');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口要在 1024 到 65535 之间');
    const store = load(); store.proxy.port = port; save(store);
  });
}
export async function resumeAgentProxy() {
  return asyncMutation(async () => {
    recoverConfig();
    for (const app of AGENT_APPS) {
      const store = load(); if (!store.proxy.apps[app]) continue;
      if (store.restore[app] && proxyIsOurs(app)) { await ensureProxy(); continue; }
      if (!stillOwned(store, app)) {
        configTransaction(() => { const current = load(); current.proxy.apps[app] = false; save(current); });
        configNotice = '检测到外部配置变更，未自动接管 ' + AGENT_LABEL[app]; continue;
      }
      await enableProxy(app);
    }
  });
}
export function releaseAgentSwitch() {
  if (mutationPending) throw new Error('供应商操作尚未完成，请稍后退出');
  configAllowRestore(() => configTransaction(() => {
    const store = load();
    for (const app of AGENT_APPS) if (store.proxy.apps[app]) restoreProxy(store, app);
    save(store);
  }));
  if (runtime) {
    const closing = runtime; runtime = null; runtimePort = 0;
    closingProxy = closing.close();
  }
}
export async function waitAgentProxyClosed() { await closingProxy; }

/*
 * 还原配置备份（0.3.9）：把历史里某次修改「之前」的内容，或 TokenPulse 接管前的原件写回去。
 * 同样走事务（会再记一条历史，所以还原本身也能撤回）；只读保护下也允许，因为这是把东西放回去。
 * 本地路由开着的工具不许还原：路由退出时要按接管快照恢复，中途改掉会对不上。
 */
export function restoreConfigBackup(kind: 'history' | 'original', id: string) {
  return configAllowRestore(() => syncMutation(() => {
    const targets: Array<{ file: string; content: string | null }> = [];
    if (kind === 'history') {
      const entry = readHistory(id);
      if (!entry) throw new Error('找不到这份备份，可能已经被新的备份挤掉了');
      for (const change of entry.files) targets.push({ file: change.file, content: change.before });
    } else {
      const original = listOriginals().find((item) => item.id === id);
      if (!original) throw new Error('找不到这份原件');
      targets.push({ file: original.file, content: original.content });
    }
    const store = load();
    for (const target of targets) {
      const app = AGENT_APPS.find((item) => filesForApp(item).some((file) => path.resolve(file) === path.resolve(target.file)));
      if (!app) throw new Error('这份备份的文件不在当前的工具配置位置，不能自动还原：' + target.file);
      if (store.proxy.apps[app]) throw new Error(AGENT_LABEL[app] + ' 的本地路由正开着，请先关闭路由再还原');
    }
    for (const target of targets) configWrite(target.file, target.content);
    configNotice = '已还原。TokenPulse 会把还原后的配置当作外部修改，不会自动覆盖；需要切换时请明确点击启用。';
    return targets.length;
  }));
}

export async function importCcProviders() { return syncMutation(() => importCcProvidersImpl()); }
function importCcProvidersImpl() {
  const file = process.env.AGENT_SWITCH_CC_DB || ccSwitchDbPath();
  if (!fs.existsSync(file)) return { found: false, added: 0, skipped: 0 };
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, app_type, name, settings_config, category, notes, sort_index, meta FROM providers").all() as Record<string, unknown>[];
    const store = load();
    let added = 0;
    let skipped = 0;
    for (const row of rows) {
      const app = row.app_type === "grokbuild" ? "grok" : row.app_type;
      if (!isAgentApp(app)) { skipped += 1; continue; }
      const id = `cc:${app}:${String(row.id)}`;
      if (byId(store, id)) { skipped += 1; continue; }
      let settings: unknown = {};
      let meta: Record<string, unknown> = {};
      try { settings = JSON.parse(String(row.settings_config || "{}")); } catch { skipped += 1; continue; }
      try { meta = asObj(JSON.parse(String(row.meta || "{}"))); } catch { meta = {}; }
      // 用户不用 Gemini：接口格式是 Gemini 的供应商不导入
      if (str(meta.apiFormat) === "gemini") { skipped += 1; continue; }
      const provider = providerFromSettings(id, app, String(row.name || "未命名"), settings, meta, String(row.category || ""), String(row.notes || ""));
      provider.sort = Number(row.sort_index) || nextSort(store, app);
      store.providers.push(provider);
      added += 1;
    }
    save(store);
    return { found: true, added, skipped };
  } finally {
    db.close();
  }
}

export function importCurrent(app: AgentApp) { return syncMutation(() => importCurrentImpl(app)); }
function importCurrentImpl(app: AgentApp) {
  const store = load();
  const snapped = snapshotLive(app);
  if (!snapped) throw new Error("当前配置里没有可保存的第三方地址。指向本地路由的配置不会当成供应商。");
  const same = store.providers.find((item) => item.app === app && item.endpoint && snapped.endpoint && normalizeUrl(item.endpoint.baseUrl) === normalizeUrl(snapped.endpoint.baseUrl) && item.endpoint.apiKey === snapped.endpoint.apiKey && item.endpoint.model === snapped.endpoint.model);
  if (same) return same.id;
  snapped.sort = nextSort(store, app);
  store.providers.push(snapped);
  save(store);
  return snapped.id;
}

export async function listProviderModels(input: unknown) {
  const body = asObj(input);
  const existing = str(body.id) ? byId(load(), str(body.id)) : undefined;
  const baseUrl = str(body.baseUrl).trim() || existing?.endpoint?.baseUrl || "";
  const apiKey = str(body.apiKey).trim() || existing?.endpoint?.apiKey || "";
  if (!baseUrl) throw new Error("先填写请求地址");
  const models = await fetchUpstreamModels(baseUrl, apiKey);
  if (!models.length) throw new Error("供应商没有返回模型");
  return models;
}

export function probeProvider(id: string) {
  const provider = must(load(), id);
  if (!provider.endpoint) return Promise.resolve({ ok: false, error: "官方登录由工具自己连接，这里不探测" });
  if (provider.pool) return Promise.resolve({ ok: false, error: "号池按成员分别转发，请在号池详情里看各成员的状态" });
  return probeUrl(provider.endpoint.baseUrl);
}

export async function resetAgentSwitchForTests() {
  if (!process.env.TOKENPULSE_DATA_DIR) throw new Error("只能在测试数据目录里重置");
  await stopProxy();
  await closingProxy;
  configNotice = "";
  circuits.clear();
  poolCursor.clear();
  memberStats.clear();
  logs = [];
  const file = storeFile();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const logFile = dataFile("agent-switch-log.json");
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
}

function must(store: Store, id: string) {
  const provider = byId(store, id);
  if (!provider) throw new Error("找不到这个供应商");
  return provider;
}

function officialOf(store: Store, app: AgentApp) {
  return store.providers.find((item) => item.app === app && item.official) || {
    id: `official-${app}`, app, name: AGENT_LABEL[app], official: true, locked: false, notes: "", sort: 0, failover: false, createdAt: 0, endpoint: null, apiKeyField: "ANTHROPIC_AUTH_TOKEN" as const, extra: {}, slots: [], desktopMode: "direct" as const, contextWindow: null, thinking: { supportsThinking: false, supportsEffort: false },
  };
}

function captureDirect(store: Store, app: AgentApp) {
  const matched = matchLive(store, app);
  if (matched) { store.direct[app] = matched; return; }
  const snapped = snapshotLive(app);
  if (snapped) { store.providers.push(snapped); store.direct[app] = snapped.id; }
  else store.direct[app] = officialOf(store, app).id;
}
function matchLive(store: Store, app: AgentApp) {
  const endpoint = endpointFromLive(app);
  if (!endpoint || endpoint.apiKey === PROXY_MANAGED) return '';
  const matches = store.providers.filter(p => p.app === app && p.endpoint && normalizeUrl(p.endpoint.baseUrl) === normalizeUrl(endpoint.baseUrl)
    && p.endpoint.apiKey === endpoint.apiKey && p.endpoint.upstream === endpoint.upstream
    && (p.endpoint.model === endpoint.model || p.slots.some(slot => slot.model === endpoint.model.replace(/\s*\[1m\]$/i, ''))));
  return matches.find(p => p.id === store.direct[app])?.id || (matches.length === 1 ? matches[0].id : '');
}
function normalizeUrl(url: string) {
  try { const parsed = new URL(url); parsed.pathname = parsed.pathname.replace(/\/+$/, ''); return parsed.toString().replace(/\/+$/, ''); }
  catch { return url.trim().replace(/\/+$/, ''); }
}

async function ensureProxy() {
  if (runtime) return runtimePort;
  // 预览（只算改动给用户确认）时不真的起本地路由
  if (configPreviewing()) return load().proxy.port;
  await closingProxy;
  const store = load();
  const started = startAgentProxy({
    host: "127.0.0.1",
    port: store.proxy.port,
    targets: targetsFor,
    log: pushLog,
    fail: (id) => {
      const row = circuits.get(id) || { fails: 0, until: 0 };
      row.fails += 1;
      if (row.fails >= 3) row.until = Date.now() + 60_000;
      circuits.set(id, row);
    },
    succeed: (id) => circuits.set(id, { fails: 0, until: 0 }),
    open: (id) => (circuits.get(id)?.until || 0) > Date.now(),
  });
  try {
    runtimePort = await started.listen();
  } catch (error) {
    throw new Error(`本地路由没有监听到 ${store.proxy.port}：${error instanceof Error ? error.message : "端口被占用"}`);
  }
  runtime = started;
  return runtimePort;
}

async function stopProxy() {
  if (!runtime || configPreviewing()) return;
  const closing = runtime;
  runtime = null;
  runtimePort = 0;
  await closing.close();
}

function targetsFor(app: AgentApp): ProxyTarget[] {
  const store = load();
  const active = byId(store, store.route[app]);
  const backups = store.providers
    .filter((item) => item.app === app && item.failover && item.id !== active?.id && item.endpoint && !item.official && !item.locked && !item.pool)
    .sort((a, b) => a.sort - b.sort);
  const seen = new Set<string>();
  return [active, ...backups].flatMap((item) => {
    if (!item?.endpoint?.baseUrl || item.official) return [];
    return item.pool ? poolTargets(store, item) : [plainTarget(item)];
  }).filter((target) => !seen.has(target.id) && !!seen.add(target.id));
}
function plainTarget(item: Provider): ProxyTarget {
  return { id: item.id, name: item.name, upstream: item.endpoint!.upstream, baseUrl: item.endpoint!.baseUrl, apiKey: item.endpoint!.apiKey, model: item.endpoint!.model, modelMap: desktopModelMap(item.slots, item.desktopMode), requestHeaders: item.requestHeaders, requestBody: item.requestBody };
}
/**
 * 号池展开成一串目标：轮询时每个请求从下一个成员开始，其余成员依次排在后面当作这次请求的备选；
 * 用满再换（fill-first）总是从第一个能用的开始。凭据过期 / 找不到的官方账号直接跳过；
 * 连续失败被熔断的成员由路由自己跳过（open）。
 */
function poolTargets(store: Store, pool: Provider): ProxyTarget[] {
  const spec = POOL_OFFICIAL[pool.app];
  if (!spec || !pool.pool) return [];
  const accounts = readOfficialAccountStore().accounts;
  const members = pool.pool.members.flatMap((member): ProxyTarget[] => {
    const id = memberTargetId(pool, member);
    if (member.type === "provider") {
      const item = byId(store, member.id);
      if (!item?.endpoint || item.official || item.locked || item.pool || item.app !== pool.app) return [];
      return [{ ...plainTarget(item), id, name: `${pool.name} · ${item.name}`, pool: true }];
    }
    const account = accounts.find((row) => row.id === member.id && row.kind === spec.kind && !row.hidden);
    if (!account) return [];
    const { credential, expired } = resolveAccountCredential(account);
    if (!credential?.token || expired) return [];
    return [{
      // AGENT_SWITCH_POOL_BASE 只给自动化测试用：把官方接口换成本机假上游
      id, name: `${pool.name} · ${account.alias || account.email || account.label}`, upstream: NATIVE_UPSTREAM[pool.app], baseUrl: process.env.AGENT_SWITCH_POOL_BASE ? `${process.env.AGENT_SWITCH_POOL_BASE}/${pool.app}` : spec.baseUrl, apiKey: credential.token,
      model: "", requestHeaders: pool.requestHeaders, requestBody: pool.requestBody, auth: spec.auth, accountId: credential.accountId, pool: true,
    }];
  });
  if (!members.length || pool.pool.strategy === "fill-first") return members;
  const start = (poolCursor.get(pool.id) ?? 0) % members.length;
  poolCursor.set(pool.id, start + 1);
  return [...members.slice(start), ...members.slice(0, start)];
}

function pushLog(entry: ProxyLog) {
  const stats = memberStats.get(entry.providerId) ?? { requests: 0, ok: 0, lastAt: 0, lastStatus: 0 };
  stats.requests += 1; if (!entry.error) stats.ok += 1; stats.lastAt = entry.at; stats.lastStatus = entry.status;
  memberStats.set(entry.providerId, stats);
  logs = [entry, ...logs].slice(0, 80);
  try { writeJson(dataFile("agent-switch-log.json"), logs); } catch { /* 日志写失败不影响转发 */ }
}

function proxyBase(app: AgentApp, port: number) {
  const host = `http://127.0.0.1:${port}`;
  if (app === "claude" || app === "desktop") return `${host}/${app}`;
  if (app === "grok") return `${host}/grok/v1`;
  return `${host}/codex/v1`;
}

function applyProxy(app: AgentApp) {
  const store = load();
  const provider = byId(store, store.route[app]);
  if (!provider?.endpoint) throw new Error("本地路由还没有选定供应商");
  if (provider.pool && !POOL_OFFICIAL[app]) throw new Error("Claude 桌面端不支持号池");
  const port = runtimePort || store.proxy.port;
  if (app === "claude") writeClaude(store, provider, proxyBase(app, port), PROXY_MANAGED, true);
  else if (app === "desktop") writeDesktop(provider, proxyBase(app, port), PROXY_MANAGED, true);
  else if (app === "codex") writeCodex(store, provider, proxyBase(app, port), PROXY_MANAGED, true);
  else writeGrok(provider, proxyBase(app, port), PROXY_MANAGED, true);
  store.owned[app] = snapshotFiles(app); store.proxyWritten[app] = snapshotFiles(app);
  save(store);
}

function applyDirect(provider: Provider) {
  // 号池没有自己的地址和密钥，绝不能直连写进工具配置
  if (provider.pool) throw new Error("号池只能经本地路由使用");
  const store = load();
  if (provider.app === "claude") writeClaude(store, provider, provider.endpoint?.baseUrl || "", provider.endpoint?.apiKey || "", false);
  else if (provider.app === "desktop") writeDesktop(provider, provider.endpoint?.baseUrl || "", provider.endpoint?.apiKey || "", false);
  else if (provider.app === "codex") writeCodex(store, provider, provider.endpoint?.baseUrl || "", provider.endpoint?.apiKey || "", false);
  else writeGrok(provider, provider.endpoint?.baseUrl || "", provider.endpoint?.apiKey || "", false);
  store.owned[provider.app] = snapshotFiles(provider.app);
  save(store);
}

function writeClaude(store: Store, provider: Provider, baseUrl: string, apiKey: string, proxy: boolean) {
  const file = claudeFile();
  const doc = readObject(file);
  if (doc.env !== undefined && (!doc.env || typeof doc.env !== "object" || Array.isArray(doc.env))) throw new Error("Claude env 格式不正确，已停止写入");
  const env = asObj(doc.env);
  for (const key of Object.keys(env)) if (claudeFloor(key)) delete env[key];
  const previous = store.exclusive.claude || {};
  for (const [key, value] of Object.entries(previous)) if (env[key] === value) delete env[key];
  const exclusive: Record<string, string | number | boolean> = {};
  if (!provider.official) {
    for (const [key, value] of Object.entries(provider.extra)) if (CLAUDE_EXCLUSIVE.has(key)) exclusive[key] = value;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (apiKey) env[provider.apiKeyField] = apiKey;
    Object.assign(env, claudeRoleEnv(provider.slots, provider.endpoint?.model || ""));
    if (!proxy) {
      Object.assign(env, provider.envOverrides);
      for (const [key, value] of Object.entries(provider.extra)) if (claudeFloor(key) && !secretKey(key)) env[key] = value;
    }
  }
  Object.assign(env, exclusive);
  doc.env = env;
  for (const key of CLAUDE_TOP) delete doc[key];
  if (!provider.official && provider.endpoint?.model) doc.model = provider.endpoint.model;
  writeObject(file, doc);
  store.exclusive.claude = exclusive;
}

function writeCodex(store: Store, provider: Provider, baseUrl: string, apiKey: string, proxy: boolean) {
  const file = codexFile();
  const blocks = parseToml(readText(file));
  const root = blocks[0];
  for (const key of CODEX_TOP) upsertKey(root.lines, key, null);
  const previous = store.exclusive.codex || {};
  for (const key of CODEX_EXCLUSIVE) {
    if (previous[key] && readValue(root.lines, key) === previous[key]) upsertKey(root.lines, key, null);
  }
  for (const key of ['name', 'base_url', 'wire_api', 'experimental_bearer_token', 'requires_openai_auth']) setTableKey(blocks, 'model_providers.tokenpulse_route', key, null);
  const exclusive: Record<string, string | number | boolean> = {};
  if (!provider.official && baseUrl) {
    upsertKey(root.lines, "model_provider", '"tokenpulse_route"');
    const primary = provider.slots.find((slot) => slot.model) || null;
    const modelName = primary?.model || provider.endpoint?.model || "";
    if (modelName) upsertKey(root.lines, "model", quote(modelName));
    const effort = primary?.defaultReasoningLevel || canonicalLevels(primary?.reasoningLevels || [])[0];
    if (effort) upsertKey(root.lines, "model_reasoning_effort", quote(effort));
    const catalogPath = writeCodexCatalog(provider);
    if (catalogPath) upsertKey(root.lines, "model_catalog_json", quote(catalogPath));
    for (const key of ["model_reasoning_effort", "plan_mode_reasoning_effort", "disable_response_storage", "review_model"]) {
      if (provider.extra[key] !== undefined) upsertKey(root.lines, key, quote(provider.extra[key]));
    }
    for (const key of CODEX_EXCLUSIVE) if (provider.extra[key] !== undefined) {
      exclusive[key] = provider.extra[key];
      upsertKey(root.lines, key, quote(provider.extra[key]));
    }
    const wire = proxy || provider.endpoint?.upstream !== "openai-chat" ? "responses" : "chat";
    for (const [key, value] of Object.entries({ name: 'TokenPulse', base_url: baseUrl, wire_api: wire, experimental_bearer_token: apiKey, requires_openai_auth: false })) {
      setTableKey(blocks, 'model_providers.tokenpulse_route', key, quote(value));
    }
  }
  writeText(file, stringifyToml(blocks));
  store.exclusive.codex = exclusive;
}

function writeGrok(provider: Provider, baseUrl: string, apiKey: string, _proxy: boolean) {
  const file = grokFile();
  const blocks = parseToml(readText(file));
  for (const key of ['model', 'base_url', 'api_key', 'api_backend', 'context_window']) setTableKey(blocks, 'model.' + GROK_TABLE, key, null);
  if (provider.official || !baseUrl) {
    const models = blocks.find((block) => block.header && headerName(block.header) === "models");
    if (models && readKey(models.lines, "default") === GROK_TABLE) upsertKey(models.lines, "default", null);
  } else {
    setTableKey(blocks, "models", "default", quote(GROK_TABLE));
    for (const [key, value] of Object.entries({ model: provider.endpoint?.model || 'grok', base_url: baseUrl, api_key: apiKey, api_backend: 'responses', ...(provider.contextWindow ? { context_window: provider.contextWindow } : {}) })) {
      setTableKey(blocks, 'model.' + GROK_TABLE, key, quote(value));
    }
  }
  writeText(file, stringifyToml(blocks));
}

function writeCodexCatalog(provider: Provider) {
  const rows = provider.slots.filter((slot) => slot.model);
  if (!rows.length) return "";
  const dir = path.dirname(codexFile());
  const template = loadCodexTemplate(dir);
  const catalog = { models: rows.map((slot, index) => codexCatalogEntry(slot, template, index)) };
  const file = path.join(dir, "tokenpulse-model-catalog.json");
  writeText(file, `${JSON.stringify(catalog, null, 2)}\n`);
  return file;
}

function writeDesktop(provider: Provider, baseUrl: string, apiKey: string, proxy: boolean) {
  const dir = desktopDir();
  const library = path.join(dir, "configLibrary");
  const profileFile = path.join(library, `${DESKTOP_PROFILE_ID}.json`);
  const metaFile = path.join(library, "_meta.json");
  if (provider.official || !baseUrl) {
    configWrite(profileFile, null);
    const meta = readObject(metaFile);
    const entries = Array.isArray(meta.entries) ? meta.entries.filter((item) => asObj(item).id !== DESKTOP_PROFILE_ID) : [];
    if (meta.appliedId === DESKTOP_PROFILE_ID) delete meta.appliedId;
    meta.entries = entries;
    if (fs.existsSync(metaFile) || entries.length) writeObject(metaFile, meta);
    return;
  }
  const mode = proxy || provider.desktopMode === "map" ? "map" : provider.desktopMode;
  const models = desktopRouteModels(provider.slots, mode).map((row) => ({ name: row.name, label: row.label, oneM: row.oneM }));
  if (!configPreviewing()) fs.mkdirSync(library, { recursive: true });
  writeObject(profileFile, desktopProfile(baseUrl, apiKey, models));
  const meta = readObject(metaFile);
  const entries = Array.isArray(meta.entries) ? meta.entries.filter((item) => asObj(item).id !== DESKTOP_PROFILE_ID) : [];
  entries.push({ id: DESKTOP_PROFILE_ID, name: DESKTOP_PROFILE_NAME });
  meta.entries = entries;
  meta.appliedId = DESKTOP_PROFILE_ID;
  writeObject(metaFile, meta);
}

function desktopDir() {
  if (process.env.AGENT_SWITCH_HOME) return path.join(process.env.AGENT_SWITCH_HOME, "Claude-3p");
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Claude-3p");
}

function providerFromSettings(id: string, app: AgentApp, name: string, settings: unknown, meta: Record<string, unknown>, category: string, notes: string): Provider {
  const providerType = str(meta.providerType);
  const locked = providerType === "github_copilot" || providerType === "codex_oauth" || providerType === "xai_oauth";
  const official = category === "official";
  const endpoint = official || locked ? null : extractEndpoint(app, settings, meta);
  return {
    id,
    app,
    name: name.slice(0, 80) || "未命名",
    official,
    locked,
    notes: notes.slice(0, 400),
    sort: 0,
    failover: false,
    createdAt: Date.now(),
    endpoint,
    apiKeyField: meta.apiKeyField === "ANTHROPIC_API_KEY" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN",
    extra: extractExtra(app, settings),
    slots: slotsFromImport(app, settings),
    desktopMode: "direct",
    contextWindow: null,
    thinking: { supportsThinking: false, supportsEffort: false }, ...ADVANCED_DEFAULTS,
  };
}

function extractEndpoint(app: AgentApp, settings: unknown, meta: Record<string, unknown>): Endpoint | null {
  const root = asObj(settings);
  if (app === "claude") {
    const env = asObj(root.env);
    const baseUrl = str(env.ANTHROPIC_BASE_URL);
    const apiKey = str(env.ANTHROPIC_AUTH_TOKEN) || str(env.ANTHROPIC_API_KEY);
    const model = str(env.ANTHROPIC_MODEL) || str(root.model);
    const upstream = upstreamOf(meta, app, null);
    if (!baseUrl || apiKey === PROXY_MANAGED || !upstream) return null;
    return { baseUrl, apiKey, model, upstream };
  }
  if (app === "codex" || app === "grok") {
    const read = readRoute(str(root.config), app);
    const upstream = upstreamOf(meta, app, read.wire);
    if (!read.baseUrl || read.apiKey === PROXY_MANAGED || !upstream) return null;
    return { baseUrl: read.baseUrl, apiKey: read.apiKey || (app === "codex" ? str(asObj(root.auth).OPENAI_API_KEY) : ""), model: read.model, upstream };
  }
  return null;
}

function extractExtra(app: AgentApp, settings: unknown) {
  const extra: Record<string, string | number | boolean> = {};
  if (app === "claude") {
    const env = asObj(asObj(settings).env);
    for (const [key, value] of Object.entries(env)) if (CLAUDE_EXCLUSIVE.has(key)) extra[key] = str(value);
  }
  if (app === "codex") {
    const blocks = parseToml(str(asObj(settings).config));
    for (const key of ["model_reasoning_effort", "plan_mode_reasoning_effort", "disable_response_storage", "review_model", ...CODEX_EXCLUSIVE]) {
      const value = readValue(blocks[0].lines, key);
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") extra[key] = value;
    }
  }
  return extra;
}

function upstreamOf(meta: Record<string, unknown>, app: AgentApp, wire: string | null): Upstream | null {
  const format = str(meta.apiFormat);
  if (format === "openai_chat" || wire === "chat") return "openai-chat";
  if (format === "openai_responses" || wire === "responses") return "openai-responses";
  if (format === "gemini") return null;
  if (format === "anthropic") return "anthropic";
  return NATIVE_UPSTREAM[app];
}

function snapshotLive(app: AgentApp): Provider | null {
  const marker = liveMarker(app);
  if (!marker || marker.managed || !marker.base) return null;
  const endpoint = endpointFromLive(app);
  if (!endpoint?.baseUrl || !endpoint.apiKey || endpoint.apiKey === PROXY_MANAGED) return null;
  return {
    id: `snap${crypto.randomBytes(6).toString("hex")}`,
    app,
    name: "切换前的配置",
    official: false,
    locked: false,
    notes: "打开本地路由之前，从工具配置里收下的地址。",
    sort: 0,
    failover: false,
    createdAt: Date.now(),
    endpoint,
    apiKeyField: app === 'claude' && asObj(readObject(claudeFile()).env).ANTHROPIC_API_KEY && !asObj(readObject(claudeFile()).env).ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN',
    extra: extractExtra(app, app === 'claude' ? readObject(claudeFile()) : { config: readText(app === 'codex' ? codexFile() : grokFile()) }),
    slots: app === 'claude' ? slotsFromImport(app, readObject(claudeFile())) : [],
    desktopMode: 'direct', contextWindow: null,
    thinking: { supportsThinking: false, supportsEffort: false }, ...ADVANCED_DEFAULTS,
  };
}

function slotsFromImport(app: AgentApp, settings: unknown): ModelSlot[] {
  if (app !== "claude" && app !== "desktop") {
    const catalog = asObj(asObj(settings).modelCatalog).models;
    return parseSlots(catalog).map((slot) => ({ ...slot, role: slot.role || "catalog" }));
  }
  const env = asObj(asObj(settings).env);
  return ["sonnet", "opus", "fable", "haiku", "subagent"].flatMap((role) => {
    const key = role === "subagent" ? "CLAUDE_CODE_SUBAGENT_MODEL" : `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`;
    const model = str(env[key]);
    if (!model || model === PROXY_MANAGED) return [];
    return [{ ...emptySlot(role), model: model.replace(/\s*\[1m\]\s*$/i, ""), displayName: str(env[`${key}_NAME`]), oneM: /\[1m\]\s*$/i.test(model) }];
  });
}

function endpointFromLive(app: AgentApp): Endpoint | null {
  if (app === "desktop") return null;
  if (app === "claude") {
    const env = asObj(readObject(claudeFile()).env);
    return { baseUrl: str(env.ANTHROPIC_BASE_URL), apiKey: str(env.ANTHROPIC_AUTH_TOKEN) || str(env.ANTHROPIC_API_KEY), model: str(env.ANTHROPIC_MODEL) || str(readObject(claudeFile()).model) || str(env.ANTHROPIC_DEFAULT_SONNET_MODEL), upstream: "anthropic" };
  }
  const file = app === "codex" ? codexFile() : grokFile();
  const read = readRoute(readText(file), app);
  return { baseUrl: read.baseUrl, apiKey: read.apiKey, model: read.model, upstream: read.wire === "chat" ? "openai-chat" : NATIVE_UPSTREAM[app] };
}

function liveMarker(app: AgentApp) {
  try {
    const endpoint = endpointFromLive(app);
    if (!endpoint?.baseUrl) return null;
    return { base: endpoint.baseUrl, managed: endpoint.apiKey === PROXY_MANAGED || /127\.0\.0\.1:\d+\/(claude|desktop|codex|grok)(\/|$)/.test(endpoint.baseUrl) };
  } catch {
    return null;
  }
}

function readRoute(text: string, app: AgentApp) {
  const blocks = parseToml(text);
  if (app === "grok") {
    const models = blocks.find((block) => block.header && headerName(block.header) === "models");
    const name = models ? readKey(models.lines, "default") || GROK_TABLE : GROK_TABLE;
    const table = blocks.find((block) => block.header && headerName(block.header) === tableName("model", name));
    return { baseUrl: table ? readKey(table.lines, "base_url") || "" : "", apiKey: table ? readKey(table.lines, "api_key") || "" : "", model: table ? readKey(table.lines, "model") || "" : "", wire: table ? readKey(table.lines, "api_backend") : null };
  }
  const providerName = readKey(blocks[0].lines, "model_provider") || "custom";
  const table = blocks.find((block) => block.header && headerName(block.header) === tableName("model_providers", providerName));
  return {
    baseUrl: (table && readKey(table.lines, "base_url")) || readKey(blocks[0].lines, "openai_base_url") || "",
    apiKey: (table && readKey(table.lines, "experimental_bearer_token")) || "",
    model: readKey(blocks[0].lines, "model") || "",
    wire: table ? readKey(table.lines, "wire_api") : null,
  };
}

function claudeFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(agentHome(), ".claude");
  const modern = path.join(dir, "settings.json");
  const legacy = path.join(dir, "claude.json");
  return fs.existsSync(modern) || !fs.existsSync(legacy) ? modern : legacy;
}
function codexFile() {
  return path.join(process.env.CODEX_HOME || path.join(agentHome(), ".codex"), "config.toml");
}
function grokFile() {
  return path.join(process.env.GROK_HOME || path.join(agentHome(), ".grok"), "config.toml");
}

function quoteEnv(value: string) {
  return /[\s#"'`]/.test(value) ? quote(value) : value;
}

function readText(file: string) { return configRead(file) || ''; }
function readObject(file: string) {
  const text = configRead(file); if (text === null) return {} as Record<string, unknown>;
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置文件不是 JSON 对象');
  return value as Record<string, unknown>;
}
function writeText(file: string, text: string) { configWrite(file, text); }
function writeObject(file: string, value: unknown) {
  // 按第一层键的缩进来（嵌套层总会有 4 空格的行，不能拿来判断）；没有就用 2
  const first = /^\{\r?\n([ \t]+)"/.exec(configRead(file) || '');
  const indent = first ? first[1] : 2;
  writeText(file, JSON.stringify(value, null, indent) + '\n');
}
function envMap(text: string) {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    out[match[1]] = unquote(match[2].trim());
  }
  return out;
}
function setPath(root: Record<string, unknown>, keys: string[], value: string | undefined) {
  let cursor: Record<string, unknown> = root;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1];
  if (value == null) delete cursor[leaf];
  else cursor[leaf] = value;
}
function asObj(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

let mutationPending = false;
let closingProxy: Promise<void> = Promise.resolve();
let configNotice = '';
function syncMutation<T>(work: () => T) {
  if (mutationPending) throw new Error('供应商操作正在进行，请稍后重试');
  configNotice = ''; return configTransaction(work);
}
async function asyncMutation<T>(work: () => Promise<T>) {
  if (mutationPending) throw new Error('供应商操作正在进行，请稍后重试');
  mutationPending = true; configNotice = '';
  try { return await work(); } finally { mutationPending = false; }
}
function filesForApp(app: AgentApp) {
  if (app === 'claude') return [claudeFile()];
  if (app === 'codex') return [codexFile(), path.join(path.dirname(codexFile()), 'tokenpulse-model-catalog.json')];
  if (app === 'grok') return [grokFile()];
  return [path.join(desktopDir(), 'configLibrary', DESKTOP_PROFILE_ID + '.json'), path.join(desktopDir(), 'configLibrary', '_meta.json')];
}
configureConfigFiles(() => [storeFile(), ...AGENT_APPS.flatMap(filesForApp)]);
function snapshotFiles(app: AgentApp): FileSnapshot { return Object.fromEntries(filesForApp(app).map(file => [file, configRead(file)])); }
function stillOwned(store: Store, app: AgentApp) {
  const owned = store.owned[app];
  return !!owned && filesForApp(app).every(file => Object.hasOwn(owned, file) && configRead(file) === owned[file]);
}
function proxyIsOurs(app: AgentApp) {
  if (app === 'desktop') {
    const dir = path.join(desktopDir(), 'configLibrary');
    const profile = readObject(path.join(dir, DESKTOP_PROFILE_ID + '.json'));
    return readObject(path.join(dir, '_meta.json')).appliedId === DESKTOP_PROFILE_ID
      && profile.inferenceGatewayApiKey === PROXY_MANAGED
      && normalizeUrl(str(profile.inferenceGatewayBaseUrl)) === normalizeUrl(proxyBase(app, runtimePort || load().proxy.port));
  }
  const endpoint = endpointFromLive(app);
  if (!endpoint || endpoint.apiKey !== PROXY_MANAGED) return false;
  return normalizeUrl(endpoint.baseUrl) === normalizeUrl(proxyBase(app, runtimePort || load().proxy.port));
}
function reverseJson(current: unknown, before: unknown, after: unknown): unknown {
  if (JSON.stringify(before) === JSON.stringify(after)) return current;
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (object(current) && object(after) && (before === undefined || object(before))) {
    for (const key of new Set([...Object.keys(asObj(before)), ...Object.keys(after)])) {
      const restored = reverseJson(current[key], asObj(before)[key], after[key]);
      if (restored === undefined) delete current[key];
      else Object.defineProperty(current, key, { value: restored, writable: true, enumerable: true, configurable: true });
    }
    return before === undefined && !Object.keys(current).length ? undefined : current;
  }
  return JSON.stringify(current) === JSON.stringify(after) ? before : current;
}
function restoreProxy(store: Store, app: AgentApp) {
  const before = store.restore[app], written = store.proxyWritten[app];
  if (!before || !written) {
    if (proxyIsOurs(app)) throw new Error('旧路由缺少恢复快照，请先备份并在原工具恢复直连配置后再关闭');
    return;
  }
  if (!proxyIsOurs(app)) {
    delete store.restore[app]; delete store.proxyWritten[app]; delete store.owned[app];
    store.proxy.apps[app] = false;
    configNotice = '连接已在外部修改，保留外部配置，未自动覆盖。'; return;
  }
  for (const file of filesForApp(app)) {
    if (!Object.hasOwn(before, file) || !Object.hasOwn(written, file)) throw new Error('接管恢复快照不完整，已停止写入');
    const live = configRead(file), original = before[file], ours = written[file];
    if (live === ours) { configWrite(file, original); continue; }
    if (live === null || ours === null) continue;
    if (file.endsWith('.toml')) configWrite(file, restoreToml(live, original || '', ours));
    else if (file.endsWith('settings.json') || file.endsWith('claude.json')) {
      const restored = reverseJson(JSON.parse(live), original === null ? undefined : JSON.parse(original), JSON.parse(ours));
      configWrite(file, restored === undefined ? null : JSON.stringify(restored, null, 2) + '\n');
    } else if (app === 'desktop' && file.endsWith('_meta.json')) {
      const meta = JSON.parse(live), old = original === null ? {} : JSON.parse(original);
      if (meta.appliedId === DESKTOP_PROFILE_ID) { if (old.appliedId === undefined) delete meta.appliedId; else meta.appliedId = old.appliedId; }
      if (Array.isArray(meta.entries)) { meta.entries = meta.entries.filter((item: { id?: string }) => item.id !== DESKTOP_PROFILE_ID); const previous = old.entries?.find((item: { id?: string }) => item.id === DESKTOP_PROFILE_ID); if (previous) meta.entries.push(previous); }
      configWrite(file, JSON.stringify(meta, null, 2) + '\n');
    }
  }
  delete store.restore[app]; delete store.proxyWritten[app]; store.owned[app] = snapshotFiles(app);
}

function normalizeExtra(app: AgentApp, value: unknown): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(asObj(value)).map(([key, raw]) => {
    let item = typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw);
    if (app === 'codex' && typeof item === 'string') {
      if (['disable_response_storage', 'model_supports_reasoning_summaries'].includes(key) && /^(true|false)$/.test(item)) item = item === 'true';
      if (typeof item === 'string' && ['model_context_window', 'model_auto_compact_token_limit'].includes(key) && /^\d+$/.test(item) && Number.isSafeInteger(Number(item))) item = Number(item);
    }
    return [key, item];
  }));
}
