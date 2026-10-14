import { routeAccount } from "./route-ledger";
import { accountIdOf, readOfficialAccountStore } from "./accounts";
import { OFFICIAL_KINDS, readCliAccounts, type OfficialAccountKind } from "./credentials";
import { dataFile, readJson, writeJson } from "./paths";

/**
 * 「这次请求是哪个账号发的」。
 *
 * 请求是 CLI 用它**自己的登录**发出去的 —— TokenPulse 里选的「当前使用」账号只用来查额度，不影响 CLI。
 * 可会话文件里基本不记账号（本机实测）：
 * - Claude Code：只有部分会话有 `bridge-session.ownerAccountUuid`（远程控制时）和 `session_context.userEmail`；
 * - Codex：只有 `rate_limits.plan_type`（档位），没有账号；
 * - Grok：没有。
 *
 * 所以按时间对：每轮扫描读一下各 CLI 当前登录的是谁（只记账号 id 和邮箱，**不记任何凭据**），
 * 登录变了就开一段新的。请求落在哪段里就是哪个账号。
 * 记录开始之前的老请求没法知道，按最早那段的账号算，界面上标「推断」。
 */

export type LoginSpan = { from: number; id: string; email: string; label: string };
export type LoginTimeline = { version: 1; kinds: Partial<Record<OfficialAccountKind, LoginSpan[]>> };

/** 依据：会话里直接写了 / 按登录时间线 / 时间线开始前的推断。 */
/** route：经 TokenPulse 的号池发出去的，路由记下了交给哪个账号（见 route-ledger.ts）。 */
export type AccountBasis = "session" | "timeline" | "inferred" | "route" | "route-window";
export type RequestAccount = { id: string; label: string; basis: AccountBasis };

function file() {
  return dataFile("cli-logins.json");
}

export function readLoginTimeline(): LoginTimeline {
  const parsed = readJson<LoginTimeline | null>(file(), null);
  return parsed?.version === 1 && parsed.kinds && typeof parsed.kinds === "object" ? parsed : { version: 1, kinds: {} };
}

/** 记下各 CLI 当前登录的账号。没登录记一段空 id（登出之后的请求不该算到上一个账号头上）。 */
export function recordCliLogins(now = Date.now(), read: typeof readCliAccounts = readCliAccounts, kinds: readonly OfficialAccountKind[] = OFFICIAL_KINDS): LoginTimeline {
  const timeline = readLoginTimeline();
  let changed = false;
  for (const kind of kinds) {
    let current: { id: string; email: string; label: string };
    try {
      const account = read(kind)[0];
      current = account ? { id: accountIdOf(kind, account.ref), email: account.email, label: account.label } : { id: "", email: "", label: "" };
    } catch {
      continue; // 读不了就这轮不记，别当成登出
    }
    const spans = (timeline.kinds[kind] ??= []);
    const last = spans.at(-1);
    if (!last && !current.id) continue;
    if (last && last.id === current.id) {
      // 同一个账号，邮箱后来才拿到的话补上
      if (current.email && last.email !== current.email) {
        last.email = current.email;
        last.label = current.label;
        changed = true;
      }
      continue;
    }
    spans.push({ from: now, ...current });
    changed = true;
  }
  if (changed) writeJson(file(), timeline);
  return timeline;
}

export const KIND_OF_SOURCE: Record<string, OfficialAccountKind> = {
  "Claude Code": "claude",
  "Codex CLI": "chatgpt",
  "Grok Build": "grok",
};

/** 账号 id → 显示名；emails 是 id → 邮箱，按邮箱对账号时用（显示名可能是用户起的别名，不能拿来比邮箱）。 */
export type AccountLabels = Map<string, string> & { emails?: Map<string, string> };

/**
 * 给界面用的名字：优先用「设置 → 官方账号」里起的别名，其次登记的邮箱 / 名字，再次时间线里记的邮箱。
 */
export function accountLabels(): AccountLabels {
  const labels: AccountLabels = new Map<string, string>();
  const emails = new Map<string, string>();
  for (const span of Object.values(readLoginTimeline().kinds).flat()) {
    if (!span?.id) continue;
    labels.set(span.id, span.email || span.label || span.id);
    if (span.email) emails.set(span.id, span.email);
  }
  for (const account of readOfficialAccountStore().accounts) {
    labels.set(account.id, account.alias || account.email || account.label || account.id);
    if (account.email) emails.set(account.id, account.email);
  }
  labels.emails = emails;
  return labels;
}

/**
 * 把一次请求对到账号上。
 * evidence：会话里记下的身份与记录时间；旧上下文不能覆盖之后观察到的登录变更。
 */
/**
 * 号池把这次请求交给了哪个官方账号。有的话它比会话里记的、时间线上的都准：
 * 会话里记的是 CLI 自己登录的那个账号，请求实际上被路由换成了号池成员的登录。
 */
export function routedAccount(kind: OfficialAccountKind | undefined, at: number, labels: AccountLabels, responseId?: string): RequestAccount | null {
  const id = routeAccount(kind, at, responseId);
  return id ? { id, label: labels.get(id) ?? id, basis: "route" } : null;
}

export function resolveAccount(
  kind: OfficialAccountKind | undefined,
  at: number,
  evidence: { ref?: string; email?: string; at?: number },
  timeline: LoginTimeline,
  labels: AccountLabels,
): RequestAccount | null {
  if (!kind) return null;
  const spans = timeline.kinds[kind] ?? [];
  let span: LoginSpan | undefined;
  let index = -1;
  spans.forEach((item, i) => { if (item.from <= at) { span = item; index = i; } });
  // 第一段只是首次观察，不能拿它改写更早的会话身份；后续段才是已知的登录变更。
  // bridge owner 和恢复会话沿用的 userEmail 都可能是旧身份。新写入的邮箱仍可识别尚未重启的旧 CLI 进程。
  if (span && index > 0 && (!evidence.email || !evidence.at || evidence.at < span.from)) {
    return span.id ? { id: span.id, label: labels.get(span.id) ?? span.label, basis: "timeline" } : null;
  }
  if (evidence.ref) {
    const id = accountIdOf(kind, evidence.ref);
    /*
     * 0.3.48：ref 来自 bridge-session 的 ownerAccountUuid，是远程控制桥接的发起账号，会话里中途换了登录也一直不变；
     * session_context 的 userEmail 才是当前登录。两者对不上（ref 账号的邮箱已知且和当前邮箱不同）时按邮箱算。
     */
    const refEmail = labels.emails?.get(id);
    if (!evidence.email || !refEmail || refEmail.toLowerCase() === evidence.email.toLowerCase()) {
      return { id, label: labels.get(id) ?? evidence.email ?? id, basis: "session" };
    }
  }
  if (evidence.email) {
    const email = evidence.email.toLowerCase();
    // 没有 emails（老调用、测试直接传 Map）时显示名就是邮箱
    const known = [...(labels.emails ?? labels)].find(([id, value]) => id.startsWith(kind + ":") && value.toLowerCase() === email);
    return { id: known?.[0] ?? `${kind}:email:${email}`, label: (known && labels.get(known[0])) || evidence.email, basis: "session" };
  }
  if (!spans.length) return null;
  if (span) return span.id ? { id: span.id, label: labels.get(span.id) ?? span.label, basis: "timeline" } : null;
  // 时间线开始之前：按最早那个账号推断
  const first = spans.find((item) => item.id);
  return first ? { id: first.id, label: labels.get(first.id) ?? first.label, basis: "inferred" } : null;
}
