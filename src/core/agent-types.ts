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
  id: string;
  name: string;
  upstream: Upstream;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 桌面端映射：客户端看到的角色 ID → 实际上游模型。 */
  modelMap?: Record<string, string>;
};

export function isAgentApp(value: unknown): value is AgentApp {
  return value === "claude" || value === "desktop" || value === "codex" || value === "grok";
}

export function isUpstream(value: unknown): value is Upstream {
  return value === "anthropic" || value === "openai-chat" || value === "openai-responses";
}

/** 写进客户端配置、用来占位的密钥。真实密钥只留在 TokenPulse 的数据文件里。 */
export const PROXY_MANAGED = "PROXY_MANAGED";
