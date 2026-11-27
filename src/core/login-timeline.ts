import { routeAccount } from "./route-ledger";
import { accountIdOf, readOfficialAccountStore } from "./accounts";
import { readAgyAccountStore, readAgyLoginTimeline, type AgyLoginSpan } from "./antigravity-accounts";
import { OFFICIAL_KINDS, readCliAccounts, type OfficialAccountKind } from "./credentials";
import { readPiLoginStore } from "./pi-accounts";
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

export type LoginSpan = { from: number; id: string; email: string; label: string; orgId?: string };
export type LoginTimeline = { version: 1; kinds: Partial<Record<OfficialAccountKind, LoginSpan[]>> };

/** 依据：会话里直接写了 / 按登录时间线 / 时间线开始前的推断。 */
/** route：经 TokenPulse 的号池发出去的，路由记下了交给哪个账号（见 route-ledger.ts）。 */
export type AccountBasis = "session" | "timeline" | "inferred" | "route" | "route-window";
export type RequestAccount = { id: string; label: string; basis: AccountBasis };
export type AccountEvidence = { ref?: string; email?: string; at?: number; org?: string; orgAt?: number };

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
    let current: { id: string; email: string; label: string; orgId?: string };
    try {
      const account = read(kind)[0];
      current = account
        ? { id: accountIdOf(kind, account.ref), email: account.email, label: account.label, ...(account.orgId ? { orgId: account.orgId } : {}) }
        : { id: "", email: "", label: "" };
    } catch {
      continue; // 读不了就这轮不记，别当成登出
    }
    const spans = (timeline.kinds[kind] ??= []);
    const last = spans.at(-1);
    if (!last && !current.id) continue;
    if (last && last.id === current.id) {
      // 同一个账号，邮箱或组织 ID 后来才拿到的话补上
      if (current.email && last.email !== current.email) {
        last.email = current.email;
        last.label = current.label;
        changed = true;
      }
      if (current.orgId && last.orgId !== current.orgId) {
        last.orgId = current.orgId;
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

export type SourceAccountKind = OfficialAccountKind | "antigravity";

export const KIND_OF_SOURCE: Record<string, OfficialAccountKind> = {
  "Claude Code": "claude",
  "Codex CLI": "chatgpt",
  "Grok Build": "grok",
};

export const ACCOUNT_KIND_OF_SOURCE: Record<string, SourceAccountKind> = {
  ...KIND_OF_SOURCE,
  Antigravity: "antigravity",
};

/**
 * 账号 id → 显示名；
 * - emails：id → 邮箱，按邮箱对账号时用（显示名可能是用户起的别名，不能拿来比邮箱）；
 * - orgs：`${kind}:${orgId}` → 唯一归属的账号 id；多个账号共享同一组织（如 Team 工作区）时记为 null，不猜。
 */
export type AccountLabels = Map<string, string> & { emails?: Map<string, string>; orgs?: Map<string, string | null> };

/**
 * 给界面用的名字：优先用「设置 → 官方账号」里起的别名，其次登记的邮箱 / 名字，再次时间线里记的邮箱。
 */
export function accountLabels(): AccountLabels {
  const labels: AccountLabels = new Map<string, string>();
  const emails = new Map<string, string>();
  const orgs = new Map<string, string | null>();
  const rememberOrg = (kind: OfficialAccountKind, id: string, rawOrg: unknown) => {
    const org = typeof rawOrg === "string" ? rawOrg.trim().toLowerCase() : "";
    if (!org || !id.startsWith(kind + ":")) return;
    const key = `${kind}:${org}`;
    if (!orgs.has(key)) orgs.set(key, id);
    else if (orgs.get(key) !== id) orgs.set(key, null);
  };
  for (const [kind, spans] of Object.entries(readLoginTimeline().kinds) as [OfficialAccountKind, LoginSpan[] | undefined][]) {
    for (const span of spans ?? []) {
      if (!span?.id) continue;
      labels.set(span.id, span.email || span.label || span.id);
      if (span.email) emails.set(span.id, span.email);
      rememberOrg(kind, span.id, span.orgId);
    }
  }
  const aliasByEmail = new Map<string, string>();
  for (const account of readOfficialAccountStore().accounts) {
    labels.set(account.id, account.alias || account.email || account.label || account.id);
    if (account.email) {
      emails.set(account.id, account.email);
      if (account.alias) aliasByEmail.set(account.email.toLowerCase(), account.alias);
    }
    rememberOrg(account.kind, account.id, account.orgId);
    const snapAccount = account.cliAuth?.account as Record<string, unknown> | undefined;
    rememberOrg(account.kind, account.id, snapAccount?.organizationUuid);
  }
  for (const account of readAgyAccountStore().accounts) {
    labels.set(account.id, account.alias || account.email || account.label || account.id);
    if (account.email) {
      emails.set(account.id, account.email);
      if (account.alias) aliasByEmail.set(account.email.toLowerCase(), account.alias);
    }
  }
  const piStore = readPiLoginStore();
  for (const spans of Object.values(piStore.providers)) {
    for (const span of spans ?? []) {
      if (!span?.id) continue;
      const email = span.email || "";
      const ownAlias = piStore.aliases?.[span.id];
      const alias = ownAlias || (email ? aliasByEmail.get(email.toLowerCase()) : undefined);
      labels.set(span.id, alias || email || span.label || span.id);
      if (email) emails.set(span.id, email);
    }
  }
  labels.emails = emails;
  labels.orgs = orgs;
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
  kind: SourceAccountKind | undefined,
  at: number,
  evidence: AccountEvidence,
  timeline: LoginTimeline,
  labels: AccountLabels,
  agyTimeline?: AgyLoginSpan[],
): RequestAccount | null {
  if (!kind) return null;
  if (kind === "antigravity") {
    const spans = agyTimeline ?? readAgyLoginTimeline();
    if (!spans.length) return null;
    let hit: AgyLoginSpan | undefined;
    for (const item of spans) {
      if (item.from <= at) hit = item;
      else break;
    }
    if (hit) {
      return hit.id ? { id: hit.id, label: labels.get(hit.id) ?? "本机 Antigravity", basis: "timeline" } : null;
    }
    const first = spans.find((item) => item.id);
    return first ? { id: first.id, label: labels.get(first.id) ?? "本机 Antigravity", basis: "inferred" } : null;
  }
  const orgKey = typeof evidence.org === "string" && evidence.org.trim() ? `${kind}:${evidence.org.trim().toLowerCase()}` : "";
  const orgAccountId = orgKey && labels.orgs ? labels.orgs.get(orgKey) ?? undefined : undefined;
  const spans = timeline.kinds[kind] ?? [];
  let span: LoginSpan | undefined;
  let index = -1;
  spans.forEach((item, i) => { if (item.from <= at) { span = item; index = i; } });
  const hasFreshEmail = Boolean(span && evidence.email && evidence.at && evidence.at >= span.from);
  const hasFreshOrg = Boolean(span && orgAccountId && evidence.orgAt && evidence.orgAt >= span.from);
  // 第一段只是首次观察，不能拿它改写更早的会话身份；后续段才是已知的登录变更。
  // bridge owner 和恢复会话沿用的 userEmail 都可能是旧身份。新写入的邮箱或 credential_org 仍可识别尚未重启的旧 CLI 进程。
  if (span && index > 0 && !hasFreshEmail && !hasFreshOrg) {
    return span.id ? { id: span.id, label: labels.get(span.id) ?? span.label, basis: "timeline" } : null;
  }
  if (span && index > 0 && hasFreshOrg && !hasFreshEmail && orgAccountId) {
    return { id: orgAccountId, label: labels.get(orgAccountId) ?? orgAccountId, basis: "session" };
  }
  if (evidence.ref) {
    const id = accountIdOf(kind, evidence.ref);
    /*
     * 0.3.48：ref 来自 bridge-session 的 ownerAccountUuid，是远程控制桥接的发起账号，会话里中途换了登录也一直不变；
     * session_context 的 userEmail（或 credential_org）才是当前登录。两者对不上时按当前登录算。
     */
    const refEmail = labels.emails?.get(id);
    const emailConflict = Boolean(evidence.email && refEmail && refEmail.toLowerCase() !== evidence.email.toLowerCase());
    const orgConflict = Boolean(!evidence.email && orgAccountId && orgAccountId !== id);
    if (!emailConflict && !orgConflict) {
      return { id, label: labels.get(id) ?? evidence.email ?? id, basis: "session" };
    }
  }
  if (evidence.email) {
    const email = evidence.email.toLowerCase();
    // 没有 emails（老调用、测试直接传 Map）时显示名就是邮箱
    const known = [...(labels.emails ?? labels)].find(([id, value]) => id.startsWith(kind + ":") && value.toLowerCase() === email);
    return { id: known?.[0] ?? `${kind}:email:${email}`, label: (known && labels.get(known[0])) || evidence.email, basis: "session" };
  }
  if (orgAccountId) {
    return { id: orgAccountId, label: labels.get(orgAccountId) ?? orgAccountId, basis: "session" };
  }
  if (!spans.length) return null;
  if (span) return span.id ? { id: span.id, label: labels.get(span.id) ?? span.label, basis: "timeline" } : null;
  // 时间线开始之前：按最早那个账号推断
  const first = spans.find((item) => item.id);
  return first ? { id: first.id, label: labels.get(first.id) ?? first.label, basis: "inferred" } : null;
}
