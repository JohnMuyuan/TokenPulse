import { accountIdOf, readOfficialAccountStore, rememberOfficialAccount, writeOfficialAccountStore, type StoredOfficialAccount } from "./accounts";
import { grokUserOf, isLegacyGrokRef, readCliAccounts, tokenRef, type CliAccount } from "./credentials";
import { readLoginTimeline, type LoginTimeline } from "./login-timeline";
import { dataFile, readJson, writeJson } from "./paths";
import type { QuotaHistory } from "./quota-history";

/**
 * 0.3.3 之前 Grok 账号的身份是 auth.json 的键「https://auth.x.ai::<client id>」，谁登录都一样，
 * 所以所有 Grok 账号共用一个 id：在 TokenPulse 里登第二个账号，会把第一个的记录整个顶掉。
 * 现在身份是用户 ID（credentials.ts 的 grokAccounts）。这里把旧数据一次性搬过去：
 *
 * - 账号库：旧记录里存的凭据属于**最后一次在 TokenPulse 里登录的那个人**（本机实测：它的 sub 和 CLI 当前登录的
 *   不是同一个用户）→ 按凭据 JWT 的 sub 变回独立的账号；邮箱只有在它就是 CLI 当前账号时才可信，否则留空，
 *   重新登录一次就补上。没存凭据的旧记录直接丢：CLI 当前账号下次列表时会按新身份重新登记。
 * - 活动账号：原来指向旧 id 的，指向凭据的主人（最后一次登录的那个，也就是用户刚选中的）。
 * - CLI 登录时间线 / 额度采样历史：旧 id 一律记作 CLI 当前登录的账号 —— 采样绝大部分来自它；
 *   加第二个账号之后那一小段混在一起的采样分不开，几轮刷新之后就被新采样盖过。
 *
 * 幂等：没有旧 id 时什么都不写。返回搬了几个账号。
 */
export function migrateLegacyGrokAccounts(read: (kind: "grok") => CliAccount[] = readCliAccounts): number {
  const store = readOfficialAccountStore();
  const legacy = store.accounts.filter((item) => item.kind === "grok" && isLegacyGrokRef(item.ref));
  const legacyIds = new Set(legacy.map((item) => item.id));
  const timeline = readLoginTimeline();
  const history = readJson<QuotaHistory | null>(dataFile("quota-history.json"), null);
  const staleSpans = (timeline.kinds.grok ?? []).some((span) => span.id && isLegacyGrokRef(span.id));
  const staleSamples = (history?.accounts?.grok ?? []).some((sample) => sample.account && isLegacyGrokRef(sample.account));
  if (!legacy.length && !staleSpans && !staleSamples) return 0;

  let live: CliAccount | undefined;
  try {
    live = read("grok")[0];
  } catch {
    live = undefined;
  }
  const liveId = live ? accountIdOf("grok", live.ref) : "";

  // 账号库
  let moved = 0;
  let activeTarget = "";
  store.accounts = store.accounts.filter((item) => !legacyIds.has(item.id));
  for (const old of legacy) {
    if (!old.credential) continue;
    const ref = grokUserOf(old.credential.token) || tokenRef(old.credential.refreshToken || old.credential.token);
    const id = accountIdOf("grok", ref);
    const trusted = live && live.ref === ref;
    const existing = store.accounts.find((item) => item.id === id);
    if (existing) {
      if (!existing.credential) existing.credential = old.credential;
    } else {
      const next: StoredOfficialAccount = {
        id,
        kind: "grok",
        ref,
        email: trusted ? live!.email : "",
        label: trusted ? live!.label : "Grok 账号",
        credential: old.credential,
        ...(old.renewFailed ? { renewFailed: old.renewFailed } : {}),
        createdAt: old.createdAt,
        lastSeenAt: old.lastSeenAt,
      };
      store.accounts.push(next);
    }
    moved += 1;
    if (store.active.grok === old.id) activeTarget = id;
  }
  if (store.active.grok && legacyIds.has(store.active.grok)) {
    if (activeTarget) store.active.grok = activeTarget;
    else delete store.active.grok;
  }
  if (legacy.length) {
    writeOfficialAccountStore(store);
    // CLI 当前账号马上按新身份登记（只记名字，不存凭据），不用等打开设置页才出现
    if (live) rememberOfficialAccount(live, false);
  }

  // 时间线和采样：旧 id → CLI 当前账号（读不到 CLI 登录时留着，下次再搬）
  if (liveId) {
    const spans: LoginTimeline["kinds"]["grok"] = timeline.kinds.grok ?? [];
    let spansChanged = false;
    for (const span of spans) {
      if (span.id && isLegacyGrokRef(span.id)) {
        span.id = liveId;
        spansChanged = true;
      }
    }
    if (spansChanged) writeJson(dataFile("cli-logins.json"), timeline);
    if (history && staleSamples) {
      for (const sample of history.accounts.grok ?? []) if (sample.account && isLegacyGrokRef(sample.account)) sample.account = liveId;
      writeJson(dataFile("quota-history.json"), history);
    }
  }
  return moved;
}
