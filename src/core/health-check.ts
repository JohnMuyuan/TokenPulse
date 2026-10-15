/**
 * 体检（0.3.55）：把散在各页的状态集中检查一遍，告诉用户哪里不对、怎么修。
 *
 * 这里只做判断和文案（纯函数，好测）；读状态、连网络在 main/health.ts。体检本身不改任何配置：
 * 发现问题给出「去哪一页处理」的按钮，修复动作仍走原来那一页（有确认、有备份）。
 *
 * 四组：工具配置、官方账号、网络、数据。每一项 level：
 * - ok：正常；info：提示一下，不用处理；warn：建议看看；bad：现在就有东西用不了。
 */

export type HealthLevel = "ok" | "info" | "warn" | "bad";
export type HealthGroup = "tools" | "accounts" | "network" | "data";
export type HealthAction = { label: string; page?: string; settings?: string };
export type HealthItem = { id: string; group: HealthGroup; level: HealthLevel; title: string; detail?: string; lines?: string[]; action?: HealthAction };
export type HealthReport = { at: number; ms: number; items: HealthItem[]; summary: Record<HealthLevel, number> };

export type HealthInputs = {
  now: number;
  /** 被改走的工具配置（agent-switch.ts 的 agentDrift）。 */
  drift: { appName: string; expectedName: string; liveName: string }[];
  /** 还指着本地地址、但路由 / 转发没在跑的工具（localRouteLeftovers）。 */
  leftovers: { appName: string; kind: "route" | "pass"; url: string }[];
  /** 本地路由：有没有工具要走它、在不在跑、端口能不能连上（没在跑时 listening 是 null）。 */
  route: { port: number; running: boolean; listening: boolean | null; users: string[] };
  readOnly: boolean;
  accounts: { kindLabel: string; name: string; inCli: boolean; usable: boolean; needsLogin: boolean; waitCli: boolean; renewError?: string; hidden: boolean }[];
  /** 开着自动切换、这会儿却不起作用的原因。 */
  autoSwitchIdle: { cli: string; reason: string }[];
  /** 最近 24 小时的续期记录。name 是账号显示名（认不出是空）。 */
  renewLog: { at: number; kindLabel: string; name: string; source: "stored" | "cli"; ok: boolean; status?: number; code?: string; error?: string; permanent?: boolean }[];
  egress: { enabled: boolean; providers: { name: string; ip?: string; region?: string; error?: string; blocked?: "ip_mismatch" | "probe_failed" }[] };
  /** 访问官方用的代理：环境变量 / 系统代理 / 直连。 */
  proxy: { mode: "env" | "system" | "direct"; address?: string };
  /** 三家官方地址连不连得上（不带账号，只看网络）。skipped：出口不在允许列表，没去测。 */
  reach: { name: string; host: string; ok: boolean; status?: number; error?: string; ms?: number; skipped?: boolean }[];
  data: { dir: string; writable: boolean; error?: string; freeBytes?: number; tmpFiles: number; tmpBytes: number };
};

const LOW_DISK = 1024 ** 3;

function mb(bytes: number) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}
function hm(at: number) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function buildHealthReport(input: HealthInputs, ms = 0): HealthReport {
  const items: HealthItem[] = [];
  const add = (item: HealthItem) => items.push(item);
  const providers: HealthAction = { label: "去供应商页", page: "providers" };
  const accountsPage: HealthAction = { label: "去设置 → 官方账号", settings: "accounts" };

  /* ---- 工具配置 ---- */
  for (const [i, d] of input.drift.entries()) {
    add({ id: `drift-${i}`, group: "tools", level: "warn", title: `${d.appName} 没在用 TokenPulse 设好的供应商`, detail: `现在连的是「${d.liveName}」，TokenPulse 里设的是「${d.expectedName}」。可能是工具自己改了配置，或者你在别处切换过。`, action: providers });
  }
  if (!input.drift.length) add({ id: "drift", group: "tools", level: "ok", title: "工具配置和 TokenPulse 设的一致" });

  for (const [i, left] of input.leftovers.entries()) {
    add({ id: `leftover-${i}`, group: "tools", level: "bad", title: `${left.appName} 的配置还指向 TokenPulse 的${left.kind === "pass" ? "透明转发" : "本地路由"}，但它没在运行`, detail: `配置里的地址是 ${left.url}，现在这个工具连不上。常见原因是 TokenPulse 上次被强制结束，没来得及把配置改回去。到供应商页重新打开${left.kind === "pass" ? "透明转发" : "本地路由"}，或者切回官方登录。`, action: providers });
  }

  const route = input.route;
  if (route.users.length) {
    if (!route.running) add({ id: "route", group: "tools", level: "bad", title: "本地路由没在运行", detail: `${route.users.join("、")} 设成了走本地路由，现在连不上。`, action: providers });
    else if (route.listening === false) add({ id: "route", group: "tools", level: "bad", title: `本地路由的端口 ${route.port} 连不上`, detail: `${route.users.join("、")} 走的是 127.0.0.1:${route.port}。可能被别的程序占用，或者被安全软件拦了。`, action: providers });
    else add({ id: "route", group: "tools", level: "ok", title: `本地路由正常（127.0.0.1:${route.port}）`, detail: `走它的：${route.users.join("、")}` });
  } else add({ id: "route", group: "tools", level: "info", title: "没有工具走本地路由", detail: "需要号池、第三方供应商协议转换或透明转发时，在供应商页打开。" });

  if (input.readOnly) add({ id: "readonly", group: "tools", level: "info", title: "供应商「只读保护」开着", detail: "TokenPulse 不会改动工具的配置文件（切换供应商、自动切换 CLI 登录都不会生效）。", action: providers });

  /* ---- 官方账号 ---- */
  const visible = input.accounts.filter((account) => !account.hidden);
  let healthy = 0;
  for (const [i, account] of visible.entries()) {
    const who = `${account.kindLabel} 的 ${account.name}`;
    if (account.needsLogin) add({ id: `account-${i}`, group: "accounts", level: "bad", title: `${who} 需要重新登录`, detail: `官方拒绝了续期${account.renewError ? `（${account.renewError}）` : ""}。${account.inCli ? "请在 CLI 里重新登录。" : "在设置里点「重新授权」。"}`, action: accountsPage });
    else if (account.waitCli) add({ id: `account-${i}`, group: "accounts", level: "info", title: `${who} 的凭据过期了，等 CLI 续`, detail: "它登录在 CLI 里。CLI 没在运行时 TokenPulse 会替它续；正在运行时等它下次发请求自己续上，不用重新登录。" });
    else if (!account.usable) add({ id: `account-${i}`, group: "accounts", level: "warn", title: `${who} 的凭据过期了`, detail: account.renewError ? `上次续期没成功（${account.renewError}），会继续重试。` : "下一轮查额度时会自动续期；一直这样的话，看看网络或者重新授权。", action: accountsPage });
    else if (account.renewError) add({ id: `account-${i}`, group: "accounts", level: "warn", title: `${who} 上次续期没成功`, detail: `现在的凭据还能用，会继续重试（${account.renewError}）。`, action: accountsPage });
    else healthy += 1;
  }
  if (!visible.length) add({ id: "accounts", group: "accounts", level: "info", title: "还没有登记官方账号", detail: "在设置 → 官方账号里添加后，就能查额度、自动续期。", action: accountsPage });
  else if (healthy === visible.length) add({ id: "accounts", group: "accounts", level: "ok", title: `${visible.length} 个官方账号的凭据都正常` });
  else if (healthy) add({ id: "accounts", group: "accounts", level: "ok", title: `另外 ${healthy} 个官方账号的凭据正常` });

  const failed = input.renewLog.filter((row) => !row.ok);
  if (failed.length) {
    add({
      id: "renew-log", group: "accounts", level: failed.some((row) => row.permanent) ? "bad" : "warn", title: `最近 24 小时有 ${failed.length} 次续期没成功`,
      detail: `共续期 ${input.renewLog.length} 次。下面是没成功的几次（只有状态码和错误类型，不含凭据），完整记录在数据目录的 renew-log.jsonl。`,
      lines: failed.slice(-8).reverse().map((row) => `${hm(row.at)} ${row.kindLabel}${row.name ? ` · ${row.name}` : ""}${row.source === "cli" ? "（CLI 的凭据）" : ""}：${[row.status ? `HTTP ${row.status}` : "", row.code || "", row.status ? "" : row.error || ""].filter(Boolean).join(" ") || "失败"}${row.permanent ? "，需要重新登录" : ""}`),
      action: accountsPage,
    });
  } else if (input.renewLog.length) add({ id: "renew-log", group: "accounts", level: "ok", title: `最近 24 小时续期 ${input.renewLog.length} 次，全部成功` });

  for (const [i, idle] of input.autoSwitchIdle.entries()) add({ id: `auto-switch-${i}`, group: "accounts", level: "info", title: `${idle.cli} 的自动切换暂时不起作用`, detail: idle.reason, action: accountsPage });

  /* ---- 网络 ---- */
  const proxy = input.proxy;
  add({ id: "proxy", group: "network", level: "info", title: proxy.mode === "env" ? `访问官方走环境变量里的代理（${proxy.address}）` : proxy.mode === "system" ? `访问官方走系统代理（${proxy.address}）` : "访问官方没有走代理（直连）", detail: proxy.mode === "direct" ? "需要代理的话，请打开系统代理或设置 HTTPS_PROXY 环境变量后重启 TokenPulse。" : undefined });
  for (const site of input.reach) {
    if (site.skipped) add({ id: `reach-${site.host}`, group: "network", level: "info", title: `没测 ${site.name}`, detail: "这一家设了出口 IP 白名单，现在的出口不在里面，不去连官方。", action: { label: "去出口监控", page: "egress" } });
    else if (site.ok) add({ id: `reach-${site.host}`, group: "network", level: "ok", title: `连得上 ${site.name}（${site.host}）`, detail: site.ms != null ? `用了 ${site.ms} 毫秒` : undefined });
    else add({ id: `reach-${site.host}`, group: "network", level: "bad", title: `连不上 ${site.name}（${site.host}）`, detail: `${site.error || "没有响应"}。额度查询、续期和走这一家的请求都会失败，检查一下代理。` });
  }
  const egress = input.egress;
  const blocked = egress.providers.filter((item) => item.blocked);
  for (const [i, item] of blocked.entries()) {
    add({ id: `egress-${i}`, group: "network", level: "warn", title: `${item.name} 的额度查询被出口规则拦下了`, detail: item.blocked === "probe_failed" ? "确认不了出口 IP，按规则没去问官方。" : `现在的出口 ${item.ip || ""}${item.region ? `（${item.region}）` : ""} 不在允许列表里。`, action: { label: "去出口监控", page: "egress" } });
  }
  if (!egress.enabled) add({ id: "egress", group: "network", level: "info", title: "出口监控没开", detail: "想确认请求从哪个 IP、哪个地区出去，可以在出口监控里打开。", action: { label: "去出口监控", page: "egress" } });
  else if (!blocked.length) {
    const seen = egress.providers.filter((item) => item.ip).map((item) => `${item.name} ${item.ip}${item.region ? `（${item.region}）` : ""}`);
    add({ id: "egress", group: "network", level: "ok", title: "出口符合你设的规则", detail: seen.length ? seen.join("；") : undefined });
  }

  /* ---- 数据 ---- */
  const data = input.data;
  if (!data.writable) add({ id: "data-write", group: "data", level: "bad", title: "数据目录写不进去", detail: `${data.dir}：${data.error || "没有写入权限"}。用量、额度历史和设置都存不下来。` });
  else add({ id: "data-write", group: "data", level: "ok", title: "数据目录可以正常写入", detail: data.dir });
  if (data.freeBytes != null && data.freeBytes < LOW_DISK) add({ id: "disk", group: "data", level: "warn", title: `数据目录所在的磁盘只剩 ${mb(data.freeBytes)}`, detail: "空间不够时用量记录可能写坏，建议清理一下。" });
  if (data.tmpFiles) add({ id: "tmp", group: "data", level: "info", title: `数据目录里有 ${data.tmpFiles} 个没清掉的临时文件（共 ${mb(data.tmpBytes)}）`, detail: "是以前写文件时中断留下的，不影响使用，可以手动删掉（文件名以 .tmp 结尾）。" });

  const summary: Record<HealthLevel, number> = { ok: 0, info: 0, warn: 0, bad: 0 };
  for (const item of items) summary[item.level] += 1;
  return { at: input.now, ms, items, summary };
}
