/** 供应商切换和本地路由共用的类型。 */

/** 用户不用 Gemini（2026-09-28）：Gemini CLI 和 Gemini 上游都不支持，旧数据里的 Gemini 供应商读入时丢掉。 */
export type AgentApp = "claude" | "desktop" | "codex" | "grok";

/** 上游接口。和客户端自己说的协议可以不同，不同时由本地路由转换。 */
export type Upstream = "anthropic" | "openai-chat" | "openai-responses";

export const AGENT_APPS: AgentApp[] = ["claude", "desktop", "codex", "grok"];

export const AGENT_LABEL: Record<AgentApp, string> = {
  claude: "Claude Code",
  desktop: "Claude 桌面端",
  codex: "Codex",
  grok: "Grok CLI",
};

/** 各工具自己发出的协议。桌面端和 Claude Code 一样发 Anthropic Messages。 */
export const NATIVE_UPSTREAM: Record<AgentApp, Upstream> = {
  claude: "anthropic",
  desktop: "anthropic",
  codex: "openai-responses",
  grok: "openai-responses",
};

export const UPSTREAM_LABEL: Record<Upstream, string> = {
  anthropic: "Anthropic",
  "openai-chat": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
};

export type ProxyTarget = {
  concurrencyProviderId?: string;
  concurrencyProviderName?: string;
  concurrencyPoolId?: string;
  concurrencyPoolName?: string;
  id: string;
  name: string;
  upstream: Upstream;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 桌面端映射：客户端看到的角色 ID → 实际上游模型。 */
  modelMap?: Record<string, string>;
  requestHeaders?: Record<string, string>;
  requestBody?: Record<string, unknown>;
  /**
   * Grok 专用（0.3.29）：请求里没带思考等级时，转发前补上这一档。Grok CLI 只认官方目录里的型号支持思考等级，
   * 经 TokenPulse 的供应商 / 号池（配置里是自定义模型 tokenpulse_route）时 /effort 会说不支持，请求里也不带等级。
   */
  reasoningEffort?: string;
  /**
   * 号池里的官方账号：用这个账号自己的登录凭据，直接转给官方接口（见 agent-proxy.ts 的 applyOfficialAuth）。
   * 请求本来就是真的 CLI 发出来的，只换掉认证：Claude 换成 Bearer + OAuth beta；Codex 走 ChatGPT 的 Codex 接口，
   * 带上工作区 id；Grok 走 CLI 登录用的 cli-chat-proxy。
   */
  auth?: "claude-oauth" | "codex-oauth" | "grok-oauth";
  /** 号池里的官方账号在 TokenPulse 里的 id（如 grok:xxxx）。转发成功后记进路由账本，统计用量时归到这个账号名下。 */
  officialAccount?: string;
  /** ChatGPT 工作区 id（Chatgpt-Account-Id）。 */
  accountId?: string;
  /** 号池成员：401 / 403 也换下一个（别的账号可能还能用）。 */
  pool?: boolean;
};

/** 号池：同一工具的多个官方账号 / API Key 供应商轮流用。 */
export type PoolStrategy = "round-robin" | "fill-first";
export type PoolMember = { type: "account" | "provider"; id: string };
/** reasoningEffort：只有 Grok 的号池用，见 ProxyTarget.reasoningEffort。 */
export type PoolConfig = { strategy: PoolStrategy; members: PoolMember[]; reasoningEffort?: string };

/** 号池里官方账号走的接口。桌面端不支持号池（它用自己的网关配置）。 */
export const POOL_OFFICIAL: Partial<Record<AgentApp, { kind: "claude" | "chatgpt" | "grok"; baseUrl: string; auth: NonNullable<ProxyTarget["auth"]> }>> = {
  claude: { kind: "claude", baseUrl: "https://api.anthropic.com", auth: "claude-oauth" },
  codex: { kind: "chatgpt", baseUrl: "https://chatgpt.com/backend-api/codex", auth: "codex-oauth" },
  grok: { kind: "grok", baseUrl: "https://cli-chat-proxy.grok.com/v1", auth: "grok-oauth" },
};

/** 号池在配置里占位的密钥：号池只能走本地路由，这个值不会写进任何工具配置。 */
export const POOL_KEY = "TOKENPULSE_POOL";

export function isAgentApp(value: unknown): value is AgentApp {
  return value === "claude" || value === "desktop" || value === "codex" || value === "grok";
}

export function isUpstream(value: unknown): value is Upstream {
  return value === "anthropic" || value === "openai-chat" || value === "openai-responses";
}

/** 写进客户端配置、用来占位的密钥。真实密钥只留在 TokenPulse 的数据文件里。 */
export const PROXY_MANAGED = "PROXY_MANAGED";
