import { execFile } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { listAgyAccountStatus } from "../core/antigravity-accounts";
import { agentDrift, agentView, localRouteLeftovers } from "../core/agent-switch";
import { AGENT_LABEL, type AgentApp } from "../core/agent-types";
import { curlBin } from "../core/curl";
import { buildHealthReport, type HealthInputs, type HealthReport } from "../core/health-check";
import { dataDir } from "../core/paths";
import { curlProxyArgs, envHasProxy, envProxyFor, proxyFor } from "../core/upstream-proxy";
import type { ExitMonitor } from "./egress-monitor";
import { listOfficialOAuthStatus } from "./oauth";
import { readPrefs } from "./prefs";

/**
 * 体检（0.3.55）：读各处的状态交给 core/health-check.ts 判断。只读，不改任何配置；
 * 唯一的网络动作是不带账号地连一下三家官方地址（出口设了白名单、现在又不在白名单里的那家不连）。
 */

const KIND_LABEL = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok", antigravity: "Antigravity" } as const;
const SITES = [
  { kind: "claude", name: "Claude", host: "api.anthropic.com" },
  { kind: "chatgpt", name: "ChatGPT", host: "chatgpt.com" },
  { kind: "grok", name: "Grok", host: "api.x.ai" },
] as const;

function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** 不带账号连一下：拿到任何 HTTP 状态码都算连得上。 */
async function reach(host: string) {
  const url = `https://${host}/`;
  const args = ["-sS", "-I", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-m", "8", "--http1.1", ...(await curlProxyArgs(url)), "-w", "%{http_code}", url];
  const started = Date.now();
  return new Promise<{ ok: boolean; status?: number; error?: string; ms: number }>((resolve) => {
    execFile(curlBin(), args, { windowsHide: true, timeout: 12_000 }, (error, stdout, stderr) => {
      const status = Number(String(stdout).trim());
      const ms = Date.now() - started;
      if (status > 0) resolve({ ok: true, status, ms });
      else resolve({ ok: false, error: String(stderr || error?.message || "").trim().split(/\r?\n/)[0].replace(/^curl: \(\d+\)\s*/, "").slice(0, 160) || "没有响应", ms });
    });
  });
}

async function proxyInfo(): Promise<HealthInputs["proxy"]> {
  const target = new URL("https://api.anthropic.com/");
  const env = envProxyFor(target);
  if (env) return { mode: "env", address: `${env.host}:${env.port}` };
  if (envHasProxy(target)) return { mode: "direct" };
  try {
    const system = await proxyFor(target);
    if (system) return { mode: "system", address: `${system.host}:${system.port}` };
  } catch { /* 读不到系统代理当直连 */ }
  return { mode: "direct" };
}

function dataState(): HealthInputs["data"] {
  const dir = dataDir();
  let writable = true, error: string | undefined, freeBytes: number | undefined;
  try {
    const probe = path.join(dir, `.health-${process.pid}.tmp`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (e) {
    writable = false;
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    const stat = fs.statfsSync(dir);
    freeBytes = stat.bavail * stat.bsize;
  } catch { /* 拿不到就不报 */ }
  let tmpFiles = 0, tmpBytes = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.tmp$/i.test(entry.name) || entry.name.startsWith(".health-")) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(path.join(dir, entry.name)); } catch { continue; }
      if (Date.now() - stat.mtimeMs < 3600_000) continue; // 正在写的不算
      tmpFiles += 1;
      tmpBytes += stat.size;
    }
  } catch { /* 读不了目录：上面写入那条会报 */ }
  return { dir, writable, error, freeBytes, tmpFiles, tmpBytes };
}

let running: Promise<HealthReport> | null = null;
export function runHealthCheck(exitMonitor: ExitMonitor): Promise<HealthReport> {
  if (!running) running = check(exitMonitor).finally(() => { running = null; });
  return running;
}

async function check(exitMonitor: ExitMonitor): Promise<HealthReport> {
  const started = Date.now();
  const now = started;
  const appName = (app: AgentApp) => AGENT_LABEL[app] || app;

  let drift: HealthInputs["drift"] = [];
  let leftovers: HealthInputs["leftovers"] = [];
  let route: HealthInputs["route"] = { port: 0, running: false, listening: null, users: [] };
  try {
    drift = agentDrift().map((d) => ({ appName: appName(d.app), expectedName: d.expectedName, liveName: d.liveName }));
    leftovers = localRouteLeftovers().map((item) => ({ appName: appName(item.app), kind: item.kind, url: item.url }));
    const view = agentView();
    const users = [
      ...Object.entries(view.proxy.apps).filter(([, on]) => on).map(([app]) => appName(app as AgentApp)),
      ...Object.entries(view.pass).filter(([, pass]) => pass.on).map(([app]) => `${appName(app as AgentApp)}（透明转发）`),
    ];
    route = { port: view.proxy.port, running: view.proxy.running, listening: view.proxy.running ? await canConnect(view.proxy.port) : null, users };
  } catch { /* 供应商数据读不了：这一组只剩能读到的 */ }

  const prefs = readPrefs();
  // 先按出口白名单门控各家，再决定哪些 provider 允许发起续期和连通性探测，避免绕过出口白名单
  const siteGates = await Promise.all(SITES.map(async (site) => ({ site, allowed: await exitMonitor.gateQuota(site.kind).catch(() => false) })));
  const allowedKinds = siteGates.filter((entry) => entry.allowed).map((entry) => entry.site.kind);
  const [statuses, agyStatus] = await Promise.all([
    listOfficialOAuthStatus(now, { allowedKinds }).catch(() => []),
    listAgyAccountStatus().catch(() => null),
  ]);
  const accounts: HealthInputs["accounts"] = [
    ...statuses.flatMap((status) => status.accounts.map((account) => ({
      kindLabel: status.label, name: account.alias || account.email || account.label, inCli: account.inCli, usable: account.usable,
      autoRenew: account.autoRenew, expiresAt: account.expiresAt,
      needsLogin: account.needsLogin, waitCli: account.waitCli, renewError: account.renewError, hidden: account.hidden,
    }))),
    ...(agyStatus?.accounts ?? []).map((account) => ({
      kindLabel: agyStatus!.label, name: account.alias || account.email || account.label, inCli: account.inCli, usable: account.usable,
      autoRenew: account.autoRenew, expiresAt: account.expiresAt,
      needsLogin: account.needsLogin, waitCli: false, waitLocal: account.waitLocal, renewError: account.renewError, hidden: account.hidden,
    })),
  ];
  const autoSwitchIdle = statuses.filter((status) => status.autoSwitch.on && status.autoSwitch.idle).map((status) => ({ cli: { claude: "Claude Code", chatgpt: "Codex", grok: "Grok CLI" }[status.kind], reason: status.autoSwitch.idle! }));

  // 出口快照在 gateQuota 探测之后读取，确保同一份体检报告里「出口规则」与「连通性」一致
  const egressSnap = exitMonitor.snapshot();
  const egress: HealthInputs["egress"] = {
    enabled: egressSnap.config.enabled,
    providers: egressSnap.providers.map((item) => ({
      name: KIND_LABEL[item.provider as keyof typeof KIND_LABEL] || item.provider,
      ip: item.row?.ip, region: item.row?.region, error: item.row?.error,
      blocked: (egressSnap.quotaBlocks as Record<string, { reason: "ip_mismatch" | "probe_failed" }>)[item.provider]?.reason,
    })),
  };

  // 出口设了白名单的那家，先按规则放行再连（和查额度同一个规矩）；安装了 Antigravity 或登记了账号时也测 Cloud Code
  const reachRows = await Promise.all([
    ...siteGates.map(async ({ site, allowed }) => {
      if (!allowed) return { name: site.name, host: site.host, ok: false, skipped: true };
      return { name: site.name, host: site.host, ...(await reach(site.host)) };
    }),
    ...(agyStatus && (agyStatus.installed || agyStatus.accounts.some((account) => !account.hidden))
      ? [{ name: "Antigravity", host: "cloudcode-pa.googleapis.com", ...(await reach("cloudcode-pa.googleapis.com")) }]
      : []),
  ]);

  const inputs: HealthInputs = { now, drift, leftovers, route, readOnly: prefs.agentReadOnly === true, accounts, autoSwitchIdle, egress, proxy: await proxyInfo(), reach: reachRows, data: dataState() };
  return buildHealthReport(inputs, Date.now() - started);
}
