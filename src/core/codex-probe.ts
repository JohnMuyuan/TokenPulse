import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * 让本机的 Codex 试读一遍 TokenPulse 生成的模型目录（0.3.15）。
 *
 * 起因：Codex 0.159 给 model_catalog_json 加了几个必填字段，TokenPulse 写的目录缺这几项，切到第三方后
 * Codex 整份配置读取失败（桌面端显示「无法加载登录要求」，进不了界面）。字段补上了，但 Codex 以后还会再加。
 * 所以写目录之前先问本机的 Codex：在一个临时目录里放一份只引用这份目录的最小配置，跑 `codex features list`
 * （只加载配置、不联网、不需要登录）。读不过就不写目录——没有目录 Codex 照样能用，只是模型列表和思考等级用它自带的。
 *
 * - 只读：不碰真实的 ~/.codex；临时目录用完就删。
 * - 拿不准就放行（unknown）：找不到 Codex、超时、别的原因失败，都按以前的方式写目录。只有 Codex 明确说目录解析不了才算 rejected。
 * - 试读是异步的（不卡界面），结果按「目录内容 + 用的哪个 Codex」记住；同步写配置的地方只查记下来的结果。
 */
export type CatalogVerdict = "ok" | "rejected" | "unknown";
type Probe = (exe: string, catalogJson: string) => Promise<CatalogVerdict>;

const TIMEOUT_MS = 10_000;
const verdicts = new Map<string, CatalogVerdict>();
let override: Probe | null = null;
let exeOverride: string | null = null;

/** 自动化测试用：换掉试读的实现 / 指定「本机的 Codex」。传 null 恢复。 */
export function setCodexProbeForTests(probe: Probe | null, exe: string | null = null) { override = probe; exeOverride = exe; verdicts.clear(); }

const newest = (files: string[]) => files.filter((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } })
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || "";
const children = (dir: string) => { try { return fs.readdirSync(dir).map((name) => path.join(dir, name)); } catch { return []; } };

/**
 * 本机的 Codex 可执行文件：TOKENPULSE_CODEX_EXE 指定的；桌面端自带的（%LOCALAPPDATA%\OpenAI\Codex\bin\<版本>\codex.exe，取最新）；
 * npm 全局装的 CLI。自动化测试（设了 AGENT_SWITCH_HOME 的假用户目录）里不去找真实机器上的 Codex，除非明确指定。
 */
export function findCodexExe(): string {
  if (exeOverride !== null) return exeOverride;
  const named = process.env.TOKENPULSE_CODEX_EXE;
  if (named) return fs.existsSync(named) ? named : "";
  if (process.env.AGENT_SWITCH_HOME || process.platform !== "win32") return "";
  const local = process.env.LOCALAPPDATA, roaming = process.env.APPDATA;
  const desktop = local ? newest(children(path.join(local, "OpenAI", "Codex", "bin")).map((dir) => path.join(dir, "codex.exe"))) : "";
  if (desktop) return desktop;
  const vendor = roaming ? path.join(roaming, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai") : "";
  return vendor ? newest(children(vendor).flatMap((pkg) => children(path.join(pkg, "vendor")).map((triple) => path.join(triple, "bin", "codex.exe")))) : "";
}

function keyOf(exe: string, catalogJson: string) {
  let stamp = "";
  try { const stat = fs.statSync(exe); stamp = `${stat.size}:${stat.mtimeMs}`; } catch { /* 文件没了：下面会当成找不到 */ }
  return crypto.createHash("sha1").update(exe + "\u0000" + stamp + "\u0000" + catalogJson).digest("hex");
}

const run: Probe = (exe, catalogJson) => new Promise((resolve) => {
  let dir = "";
  const done = (verdict: CatalogVerdict) => { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结果 */ } resolve(verdict); };
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-codex-probe-"));
    const catalog = path.join(dir, "catalog.json");
    fs.writeFileSync(catalog, catalogJson);
    // 和 TokenPulse 实际写的结构一样，只是地址和密钥是占位的；TOML 字面量字符串里的路径不用转义
    fs.writeFileSync(path.join(dir, "config.toml"), [
      'model_provider = "tokenpulse_probe"', 'model = "probe"', `model_catalog_json = '${catalog}'`,
      "[model_providers.tokenpulse_probe]", 'name = "TokenPulse"', 'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"', 'experimental_bearer_token = "probe"', "requires_openai_auth = false", "",
    ].join("\n"));
    execFile(exe, ["features", "list"], { env: { ...process.env, CODEX_HOME: dir }, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return done("ok");
      // 只有 Codex 明确说目录解析不了才算数；别的失败（老版本没有这个子命令、超时、被安全软件拦了）不下结论
      done(/model_catalog_json/i.test(String(stderr || "")) ? "rejected" : "unknown");
    });
  } catch { done("unknown"); }
});

/** 试读（异步）。同样的目录 + 同一个 Codex 只试一次。 */
export async function probeCodexCatalog(catalogJson: string): Promise<CatalogVerdict> {
  const exe = findCodexExe();
  if (!exe || !catalogJson) return "unknown";
  const key = keyOf(exe, catalogJson);
  const known = verdicts.get(key);
  if (known) return known;
  let verdict: CatalogVerdict;
  try { verdict = await (override ?? run)(exe, catalogJson); } catch { verdict = "unknown"; }
  // 拿不准的不记：下次再试
  if (verdict !== "unknown") { if (verdicts.size > 64) verdicts.clear(); verdicts.set(key, verdict); }
  return verdict;
}

/** 之前试读的结果（同步，给写配置的地方用）。没试过就是 unknown。 */
export function catalogVerdict(catalogJson: string): CatalogVerdict {
  const exe = findCodexExe();
  return exe && catalogJson ? verdicts.get(keyOf(exe, catalogJson)) ?? "unknown" : "unknown";
}
