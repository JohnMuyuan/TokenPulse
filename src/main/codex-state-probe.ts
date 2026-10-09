/*
 * Codex 降智检测的主进程部分（0.3.41），判据和局限见 core/codex-state-probe.ts。
 * 只在界面上点了才跑；同一个账号同时只跑一次；结果（不含门票、凭据）存一份，下次打开还能看到上次的结论。
 */
import fs from "fs";
import path from "path";
import { readOfficialAccountStore, resolveAccountCredential } from "../core/accounts";
import { cliDir, readCliAccounts } from "../core/credentials";
import { probeCodexState, type ProbeResult } from "../core/codex-state-probe";
import { dataFile, readJson, writeJson } from "../core/paths";
import { readRouteLog } from "../core/route-ledger";

const file = () => dataFile("codex-state-probe.json");
const busy = new Set<string>();
type Stored = Record<string, ProbeResult>;

/** 用哪个型号测：Codex 配置里现在用的；没写就用最近一次成功转发的；都没有才用内置的。 */
export function probeModel(): string {
  try {
    const hit = /^\s*model\s*=\s*"([^"\n]{1,120})"/m.exec(fs.readFileSync(path.join(cliDir("chatgpt"), "config.toml"), "utf8"));
    if (hit?.[1] && !hit[1].startsWith("tokenpulse")) return hit[1];
  } catch { /* 没有配置文件 */ }
  try {
    const row = readRouteLog({ limit: 300 }).rows.find((item) => item.app === "codex" && Number(item.status) === 200 && typeof item.requestModel === "string" && item.requestModel && item.requestModel !== "codex-auto-review");
    if (row) return String(row.requestModel);
  } catch { /* 没有转发记录 */ }
  return "gpt-6.1-sol";
}

export function lastProbes(): Stored {
  const stored = readJson<Stored>(file(), {});
  return stored && typeof stored === "object" ? stored : {};
}

export async function runProbe(accountId: unknown): Promise<ProbeResult> {
  const id = typeof accountId === "string" ? accountId.slice(0, 200) : "";
  // 没给账号 id：用 Codex CLI 现在登录的那个账号
  const account = id ? readOfficialAccountStore().accounts.find((item) => item.kind === "chatgpt" && item.id === id) : undefined;
  const cli = id ? undefined : readCliAccounts("chatgpt")[0];
  if (!account && !cli) throw new Error("找不到这个 ChatGPT 账号");
  const key = id || "cli";
  if (busy.has(key)) throw new Error("这个账号正在检测，请等它结束");
  busy.add(key);
  try {
    const credential = account ? resolveAccountCredential(account).credential : cli?.credential;
    const result = await probeCodexState({ token: credential?.token || "", accountId: credential?.accountId }, probeModel());
    try { const stored = lastProbes(); stored[key] = result; writeJson(file(), stored); } catch { /* 存不下来不影响这次的结果 */ }
    return result;
  } finally {
    busy.delete(key);
  }
}
