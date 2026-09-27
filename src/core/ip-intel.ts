import { isIP } from "net";
import { curlJson } from "./curl";
import { dataFile, readJson, writeJson } from "./paths";

/**
 * 出口 IP 的「身份」：归属地、ASN、运营商、是家宽还是机房，以及几个公开 IP 数据库给的风险判断。
 *
 * 用哪几家（2026-09-27 实测，都不用注册、不用 API Key）：
 * - proxycheck.io：风险分 0–100、VPN / 代理判断、连接类型（Residential / Business / Hosting / Wireless）。
 *   不带 Key 每天约 100 次 —— 所以结果要缓存，只在出口 IP 变了时查，绝不跟着每 5 秒的探测一起查。
 * - ip-api.com：hosting / proxy / mobile 三个标记、ISP、ASN。免费版只有 http（查询的只是这个 IP，不带任何凭据）。
 * - ipinfo.io：ASN 和组织、反向域名、是不是 anycast。
 * - ipapi.is：所属公司、ASN。带 Key 时还会给机房 / VPN / 滥用评分，免费版只给这些，字段出现了就用。
 * Scamalytics、AbuseIPDB 的网页有 Cloudflare 人机验证，IPQualityScore 必须付费 Key，都不接。
 *
 * 这些请求会把出口 IP 发给上面几家（出口监控设置里可以关）。和出口探测不同，这里查的是「这个 IP 是什么」，
 * 走哪条线路发出去都一样。
 */

export type IpType = "isp" | "hosting" | "business" | "mobile" | "education" | "unknown";
export type SourceId = "proxycheck" | "ipapicom" | "ipinfo" | "ipapiis";
export type IntelSource = {
  id: SourceId;
  name: string;
  /** 在浏览器里查看这个 IP 的页面。 */
  url: string;
  ok: boolean;
  error?: string;
  /** 0–100，越高越可疑。只有给了评分的数据库才有。 */
  risk?: number;
  flags: { proxy?: boolean; vpn?: boolean; hosting?: boolean; mobile?: boolean; anycast?: boolean; tor?: boolean };
  type?: IpType;
  /** 数据库原话（proxycheck 的 type、ipapi.is 的公司名等），界面上小字显示。 */
  note?: string;
};
export type IpIntel = {
  ip: string;
  fetchedAt: number;
  countryCode?: string;
  region?: string;
  city?: string;
  asn?: string;
  asName?: string;
  isp?: string;
  org?: string;
  hostname?: string;
  type: IpType;
  sources: IntelSource[];
};

const UA = "User-Agent: TokenPulse";
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined);
const asnOf = (value: unknown) => {
  const text = str(typeof value === "number" ? `AS${value}` : value);
  const match = text?.match(/^AS?(\d{1,10})\b\s*(.*)$/i);
  return match ? { asn: `AS${match[1]}`, name: str(match[2]) } : undefined;
};
const code = (value: unknown) => (typeof value === "string" && /^[A-Z]{2}$/i.test(value) ? value.toUpperCase() : undefined);

/** proxycheck 的连接类型 → 我们的分类。VPN / TOR 这类标签其实说的是用途，线路本身按机房算。 */
function typeFromProxycheck(value?: string): IpType | undefined {
  const t = value?.toLowerCase() ?? "";
  if (!t) return undefined;
  if (t.includes("residential")) return "isp";
  if (t.includes("wireless") || t.includes("mobile")) return "mobile";
  if (t.includes("business")) return "business";
  if (t.includes("education")) return "education";
  if (t.includes("hosting") || t.includes("vpn") || t.includes("tor") || t.includes("server")) return "hosting";
  return undefined;
}
function typeFromCompany(value?: string): IpType | undefined {
  const t = value?.toLowerCase();
  return t === "isp" ? "isp" : t === "hosting" ? "hosting" : t === "business" ? "business" : t === "education" ? "education" : undefined;
}

type Fetch = (url: string, headers: string[]) => Promise<Record<string, unknown>>;

async function proxycheck(ip: string, get: Fetch): Promise<IntelSource & { geo?: Partial<IpIntel> }> {
  const base = { id: "proxycheck" as const, name: "proxycheck.io", url: `https://proxycheck.io/threats/${ip}`, flags: {} };
  const json = await get(`https://proxycheck.io/v2/${ip}?vpn=3&asn=1&risk=2`, [UA]);
  const row = json[ip] as Record<string, unknown> | undefined;
  // 超出每日额度时 status 是 denied，没有这个 IP 的数据
  if (!row || (json.status !== "ok" && json.status !== "warning")) return { ...base, ok: false, error: str(json.message) ?? "no data" };
  const risk = typeof row.risk === "number" && Number.isFinite(row.risk) ? Math.max(0, Math.min(100, row.risk)) : undefined;
  const as = asnOf(row.asn);
  return {
    ...base,
    ok: true,
    risk,
    flags: { proxy: row.proxy === "yes", vpn: row.vpn === "yes" },
    type: typeFromProxycheck(str(row.type)),
    note: str(row.type),
    geo: { countryCode: code(row.isocode), region: str(row.region), city: str(row.city), asn: as?.asn, isp: str(row.provider), org: str(row.organisation) },
  };
}

async function ipapicom(ip: string, get: Fetch): Promise<IntelSource & { geo?: Partial<IpIntel> }> {
  const base = { id: "ipapicom" as const, name: "ip-api.com", url: `https://ip-api.com/#${ip}`, flags: {} };
  const json = await get(`http://ip-api.com/json/${ip}?fields=status,message,countryCode,regionName,city,isp,org,as,asname,mobile,proxy,hosting`, [UA]);
  if (json.status !== "success") return { ...base, ok: false, error: str(json.message) ?? "no data" };
  const as = asnOf(json.as);
  const hosting = json.hosting === true, mobile = json.mobile === true;
  return {
    ...base,
    ok: true,
    flags: { hosting, proxy: json.proxy === true, mobile },
    // 只给「是不是机房 / 移动」两个标记：都不是的，多半是家宽或企业线路，按家宽算
    type: hosting ? "hosting" : mobile ? "mobile" : "isp",
    geo: { countryCode: code(json.countryCode), region: str(json.regionName), city: str(json.city), asn: as?.asn, asName: str(json.asname), isp: str(json.isp), org: str(json.org) },
  };
}

async function ipinfo(ip: string, get: Fetch): Promise<IntelSource & { geo?: Partial<IpIntel> }> {
  const base = { id: "ipinfo" as const, name: "ipinfo.io", url: `https://ipinfo.io/${ip}`, flags: {} };
  const json = await get(`https://ipinfo.io/${ip}/json`, [UA, "Accept: application/json"]);
  if (json.bogon || json.error) return { ...base, ok: false, error: "no data" };
  const as = asnOf(json.org);
  return {
    ...base,
    ok: true,
    flags: { anycast: json.anycast === true },
    note: as?.name,
    geo: { countryCode: code(json.country), region: str(json.region), city: str(json.city), asn: as?.asn, org: as?.name, hostname: str(json.hostname) },
  };
}

async function ipapiis(ip: string, get: Fetch): Promise<IntelSource & { geo?: Partial<IpIntel> }> {
  const base = { id: "ipapiis" as const, name: "ipapi.is", url: `https://ipapi.is/?q=${ip}`, flags: {} };
  const json = await get(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}`, [UA]);
  if (json.is_bogon === true || json.error) return { ...base, ok: false, error: str(json.error) ?? "no data" };
  const company = json.company && typeof json.company === "object" ? (json.company as Record<string, unknown>) : undefined;
  const companyName = str(company?.name) ?? str(json.company);
  const as = json.asn && typeof json.asn === "object" ? asnOf((json.asn as Record<string, unknown>).asn) : asnOf(json.asn);
  // 带 Key 时才有的字段：出现了就用。abuser_score 形如 "0.0012 (Very Low)"
  const abuser = typeof company?.abuser_score === "string" ? Number.parseFloat(company.abuser_score) : undefined;
  const flag = (key: string) => (typeof json[key] === "boolean" ? (json[key] as boolean) : undefined);
  return {
    ...base,
    ok: true,
    risk: abuser != null && Number.isFinite(abuser) ? Math.round(Math.min(1, abuser) * 100) : undefined,
    flags: { hosting: flag("is_datacenter"), vpn: flag("is_vpn"), proxy: flag("is_proxy"), tor: flag("is_tor"), mobile: flag("is_mobile") },
    type: typeFromCompany(str(company?.type)) ?? (flag("is_datacenter") ? "hosting" : undefined),
    note: companyName,
    geo: { asn: as?.asn, org: companyName },
  };
}

const SOURCES = [proxycheck, ipapicom, ipinfo, ipapiis];

/** 几家分别查，互不影响；谁挂了就标出来。汇总字段按可信程度挑第一个有值的。 */
export async function lookupIp(ip: string, get: Fetch = curlJson, now = Date.now()): Promise<IpIntel> {
  if (!isIP(ip)) throw new Error("invalid ip");
  const results = await Promise.all(
    SOURCES.map((source) =>
      source(ip, get).catch((error: Error): IntelSource => {
        const id = source === proxycheck ? "proxycheck" : source === ipapicom ? "ipapicom" : source === ipinfo ? "ipinfo" : "ipapiis";
        const names: Record<SourceId, string> = { proxycheck: "proxycheck.io", ipapicom: "ip-api.com", ipinfo: "ipinfo.io", ipapiis: "ipapi.is" };
        return { id, name: names[id], url: "", ok: false, error: error.message === "not json" ? "unexpected response" : "network", flags: {} };
      }),
    ),
  );
  const geo = results.map((result) => ("geo" in result ? result.geo : undefined)).filter((item): item is Partial<IpIntel> => Boolean(item));
  const pick = <K extends keyof IpIntel>(key: K) => geo.find((item) => item[key] != null)?.[key];
  // 类型：proxycheck 分得最细（家宽 / 企业 / 机房 / 移动），其次 ipapi.is 的公司类型，再次 ip-api 的机房标记
  const strong = (["proxycheck", "ipapiis"] as SourceId[]).map((id) => results.find((r) => r.id === id && r.ok)?.type).find(Boolean);
  const weak = results.find((r) => r.id === "ipapicom" && r.ok)?.type;
  // ip-api 只说「不是机房」就当家宽，是很弱的判断：别家已经标了 VPN / 代理 / 机房的，宁可写「类型未知」，
  // 不能一边写着「家宽 ISP」一边风险 66、VPN（实测一个 NetLab 的出口就是这样）
  const suspicious = results.some((r) => r.ok && (r.flags.vpn || r.flags.proxy || r.flags.hosting || r.flags.tor));
  const type = strong ?? (weak === "isp" && suspicious ? "unknown" : weak) ?? "unknown";
  const sources = results.map(({ geo: _geo, ...source }: IntelSource & { geo?: unknown }) => source);
  return {
    ip,
    fetchedAt: now,
    countryCode: pick("countryCode") as string | undefined,
    region: pick("region") as string | undefined,
    city: pick("city") as string | undefined,
    asn: pick("asn") as string | undefined,
    asName: (pick("asName") ?? pick("org")) as string | undefined,
    isp: pick("isp") as string | undefined,
    org: pick("org") as string | undefined,
    hostname: pick("hostname") as string | undefined,
    type,
    sources,
  };
}

/* ---------------- 缓存 ---------------- */

/** 查到的结果留 12 小时：IP 的归属几乎不变，proxycheck 不带 Key 每天只有约 100 次。 */
export const INTEL_TTL_MS = 12 * 3_600_000;
/** 大半数据库没查到（网络问题、额度用完）的，15 分钟后可以再试。 */
export const INTEL_RETRY_MS = 15 * 60_000;
const MAX_ENTRIES = 40;

type Cache = { version: 1; entries: Record<string, IpIntel> };
function cacheFile() {
  return dataFile("ip-intel.json");
}
export function readIntelCache(): Cache {
  const parsed = readJson<Cache | null>(cacheFile(), null);
  return parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object" ? parsed : { version: 1, entries: {} };
}
export function isFresh(entry: IpIntel | undefined, now = Date.now()) {
  if (!entry) return false;
  const good = entry.sources.filter((source) => source.ok).length >= 2;
  return now - entry.fetchedAt < (good ? INTEL_TTL_MS : INTEL_RETRY_MS);
}
export function storeIntel(entry: IpIntel) {
  const cache = readIntelCache();
  cache.entries[entry.ip] = entry;
  const keep = Object.values(cache.entries).sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, MAX_ENTRIES);
  cache.entries = Object.fromEntries(keep.map((item) => [item.ip, item]));
  writeJson(cacheFile(), cache);
}
