import { randomBytes } from "crypto";
import { execFile, execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { antigravityHub, fetchAntigravityLocalSession } from "./antigravity";
import {
  listAgyAccountStatus,
  normalizeAgyEmail,
  readAgyAccountStore,
  recordAgyLocalLogin,
  refreshAgyCredential,
  rememberAgyAccount,
  renewAgyCredentials,
  writeAgyAccountStore,
  type AgyCredential,
  type AgyOAuthStatus,
  type StoredAgyAccount,
} from "./antigravity-accounts";
import { errorText, log } from "./app-log";
import { writeAtomic } from "./cli-switch";
import { isExpired } from "./credentials";
import { dataDir } from "./paths";
import { getRawFs } from "./raw-fs";

/**
 * 一键切换本机 Antigravity（桌面端 2.x 与 agy CLI 共用同一凭据槽 `gemini:antigravity`）的登录账号。
 *
 * 机制（对着 Antigravity 2.35.0 实机核过）：
 * 1. 凭据存储在系统凭据管理器（Windows Credential Manager / macOS Keychain / Linux Secret Service），
 *    服务名 `gemini`、账号名 `antigravity`（Windows TargetName = `gemini:antigravity`，UserName = `antigravity`，
 *    UTF-8 JSON，含 `token`、`auth_method`、`id_token_email`、`writer_id`）；
 * 2. 桌面端界面状态在 `%APPDATA%/Antigravity/app_storage.json` 记有 `agy.onboarding.lastLoginUsername`；
 * 3. 切换流程：确认目标账号有可用 OAuth 凭据（过期或临近过期先自动续期）→ 抢救/保存被换下账号的现有凭据 →
 *    如桌面端正在运行则优雅关闭并等待退出与锁释放 → 备份原凭据与 `app_storage.json`（保留最近 10 份，0o600）→
 *    通过系统凭据 API 写入新凭据并读回核验 → 更新 `app_storage.json` → 更新 `antigravity-logins.json` 时间线 →
 *    原运行中则自动重启 Antigravity。任何一步失败均完整回滚原凭据与配置文件。
 *
 * 安全约束：所有凭据只通过子进程 stdin 管道传输，绝不经命令行参数暴露，也绝不写入日志或返回给渲染进程。
 */

export const AGY_KEYRING_SERVICE = "gemini";
export const AGY_KEYRING_ACCOUNT = "antigravity";
export const AGY_WIN_TARGET = `${AGY_KEYRING_SERVICE}:${AGY_KEYRING_ACCOUNT}`;

export type AgyKeyringPayload = {
  token: {
    access_token: string;
    token_type: string;
    refresh_token: string;
    expiry: string;
    expires_in: number;
  };
  auth_method: string;
  id_token_email: string;
  writer_id: string;
};

export type AgyRunningProcess = {
  pid: number;
  name: string;
  executablePath: string;
  isDesktop: boolean;
};

export type AgySwitchResult = {
  ok: true;
  message: string;
  accountId: string;
  email: string;
  restarted: boolean;
  alreadyActive?: boolean;
  status: AgyOAuthStatus;
};

export type AgySwitchDeps = {
  now?: () => number;
  platform?: NodeJS.Platform;
  home?: string;
  appDataDir?: string;
  localAppDataDir?: string;
  readKeyring?: () => string | null | Promise<string | null>;
  writeKeyring?: (rawUtf8: string) => void | Promise<void>;
  deleteKeyring?: () => void | Promise<void>;
  listProcesses?: () => AgyRunningProcess[] | Promise<AgyRunningProcess[]>;
  stopProcesses?: (procs: AgyRunningProcess[]) => Promise<void>;
  findDesktopExe?: (procs: AgyRunningProcess[]) => string | null;
  launchDesktop?: (exePath: string) => void;
  fetchLocalEmail?: () => Promise<string>;
  renewAll?: (now: number) => Promise<number>;
  refreshOne?: (cred: AgyCredential, now: number) => ReturnType<typeof refreshAgyCredential>;
  listStatus?: (now: number, localEmail?: string) => Promise<AgyOAuthStatus>;
  sleep?: (ms: number) => Promise<void>;
};

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isMockKeyringMode(): string {
  return (process.env.TOKENPULSE_AGY_KEYRING_FILE || "").trim();
}

function readMockKeyring(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

function writeMockKeyring(file: string, rawUtf8: string): void {
  writeAtomic(file, rawUtf8);
}

function deleteMockKeyring(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch { /* ignore */ }
}

/* ---------------- 系统凭据管理器读写 ---------------- */

const WIN_CRED_CSHARP = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TpWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credPtr);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
  public static string ReadUtf8(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) {
      int err = Marshal.GetLastWin32Error();
      if (err == 1168) return null;
      throw new Exception("CredRead failed (Win32 " + err + ")");
    }
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      byte[] blob = new byte[c.CredentialBlobSize];
      if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, blob, 0, (int)c.CredentialBlobSize);
      return Encoding.UTF8.GetString(blob);
    } finally {
      CredFree(ptr);
    }
  }
  public static void WriteUtf8(string target, string userName, string payload) {
    byte[] blob = Encoding.UTF8.GetBytes(payload);
    if (blob.Length > 2560) throw new Exception("Credential blob exceeds Windows 2560-byte limit (" + blob.Length + ")");
    IntPtr blobPtr = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, blobPtr, blob.Length);
      var c = new CREDENTIAL {
        Flags = 0,
        Type = 1,
        TargetName = target,
        Comment = null,
        CredentialBlobSize = (uint)blob.Length,
        CredentialBlob = blobPtr,
        Persist = 2,
        AttributeCount = 0,
        Attributes = IntPtr.Zero,
        TargetAlias = null,
        UserName = userName
      };
      if (!CredWrite(ref c, 0)) throw new Exception("CredWrite failed (Win32 " + Marshal.GetLastWin32Error() + ")");
    } finally {
      Marshal.FreeHGlobal(blobPtr);
    }
  }
  public static void DeleteTarget(string target) {
    if (!CredDelete(target, 1, 0)) {
      int err = Marshal.GetLastWin32Error();
      if (err != 1168) throw new Exception("CredDelete failed (Win32 " + err + ")");
    }
  }
}
"@
`;

function runWinPowerShellAsync(script: string, stdin?: string): Promise<string> {
  const full = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    script,
  ].join("\n");
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message));
        else resolve(String(stdout ?? ""));
      },
    );
    // 子进程先退出（15 秒超时被杀、启动失败）时写 stdin 会抛 EPIPE：不接住就是未捕获异常，原因走上面的回调
    child.stdin?.on("error", () => undefined);
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

function execFileAsync(file: string, args: string[], stdin?: string, timeout = 10_000, failOnStderrPattern?: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else if (failOnStderrPattern && failOnStderrPattern.test(String(stderr ?? ""))) reject(new Error(String(stderr).trim()));
      else resolve(String(stdout ?? ""));
    });
    child.stdin?.on("error", () => undefined);
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

/** macOS `security find-generic-password -w` 遇到换行或非 ASCII 字节会自动输出十六进制字符串：识别并还原为 UTF-8 JSON。 */
export function decodeDarwinKeyringOutput(raw: string): string | null {
  const trimmed = raw.replace(/\r?\n$/, "");
  if (!trimmed) return null;
  if (!trimmed.trimStart().startsWith("{") && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    if (decoded.trimStart().startsWith("{")) return decoded;
  }
  return trimmed;
}

let cachedKeyringEmail: { at: number; email: string } | null = null;
let keyringEmailCacheEpoch = 0;
export function clearAgyKeyringEmailCache(): void {
  keyringEmailCacheEpoch += 1;
  cachedKeyringEmail = null;
}

export async function readAgyKeyringRawAsync(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const mock = isMockKeyringMode();
  if (mock) return readMockKeyring(mock);
  if (platform === "win32") {
    const out = await runWinPowerShellAsync(`
${WIN_CRED_CSHARP}
$val = [TpWinCred]::ReadUtf8('${AGY_WIN_TARGET}')
if ($null -eq $val) { [Console]::Write('__TP_CRED_MISSING__') } else { [Console]::Write($val) }
`);
    return out === "__TP_CRED_MISSING__" ? null : out;
  }
  if (platform === "darwin") {
    try {
      const out = await execFileAsync("security", ["find-generic-password", "-s", AGY_KEYRING_SERVICE, "-a", AGY_KEYRING_ACCOUNT, "-w"]);
      return decodeDarwinKeyringOutput(out);
    } catch {
      return null;
    }
  }
  try {
    const out = await execFileAsync("secret-tool", ["lookup", "service", AGY_KEYRING_SERVICE, "username", AGY_KEYRING_ACCOUNT]);
    return out.replace(/\r?\n$/, "") || null;
  } catch {
    return null;
  }
}

export async function writeAgyKeyringRawAsync(rawUtf8: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  clearAgyKeyringEmailCache();
  const mock = isMockKeyringMode();
  if (mock) {
    writeMockKeyring(mock, rawUtf8);
    return;
  }
  if (platform === "win32") {
    await runWinPowerShellAsync(
      `
${WIN_CRED_CSHARP}
$payload = [Console]::In.ReadToEnd()
[TpWinCred]::WriteUtf8('${AGY_WIN_TARGET}', '${AGY_KEYRING_ACCOUNT}', $payload)
`,
      rawUtf8,
    );
    return;
  }
  if (platform === "darwin") {
    const hex = Buffer.from(rawUtf8, "utf8").toString("hex");
    await execFileAsync("security", ["-i"], `add-generic-password -U -s ${AGY_KEYRING_SERVICE} -a ${AGY_KEYRING_ACCOUNT} -X ${hex}\n`, 10_000, /security:/i);
    return;
  }
  await execFileAsync(
    "secret-tool",
    ["store", `--label=${AGY_WIN_TARGET}`, "service", AGY_KEYRING_SERVICE, "username", AGY_KEYRING_ACCOUNT],
    rawUtf8,
  );
}

export async function deleteAgyKeyringRawAsync(platform: NodeJS.Platform = process.platform): Promise<void> {
  clearAgyKeyringEmailCache();
  const mock = isMockKeyringMode();
  if (mock) {
    deleteMockKeyring(mock);
    return;
  }
  if (platform === "win32") {
    await runWinPowerShellAsync(`
${WIN_CRED_CSHARP}
[TpWinCred]::DeleteTarget('${AGY_WIN_TARGET}')
`);
    return;
  }
  if (platform === "darwin") {
    try { await execFileAsync("security", ["delete-generic-password", "-s", AGY_KEYRING_SERVICE, "-a", AGY_KEYRING_ACCOUNT]); } catch { /* ignore */ }
    return;
  }
  try { await execFileAsync("secret-tool", ["clear", "service", AGY_KEYRING_SERVICE, "username", AGY_KEYRING_ACCOUNT]); } catch { /* ignore */ }
}

function runWinPowerShell(script: string, stdin?: string): string {
  const full = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    script,
  ].join("\n");
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      ...(stdin !== undefined ? { input: stdin } : {}),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
}

export function readAgyKeyringRaw(platform: NodeJS.Platform = process.platform): string | null {
  const mock = isMockKeyringMode();
  if (mock) return readMockKeyring(mock);
  if (platform === "win32") {
    const out = runWinPowerShell(`
${WIN_CRED_CSHARP}
$val = [TpWinCred]::ReadUtf8('${AGY_WIN_TARGET}')
if ($null -eq $val) { [Console]::Write('__TP_CRED_MISSING__') } else { [Console]::Write($val) }
`);
    return out === "__TP_CRED_MISSING__" ? null : out;
  }
  if (platform === "darwin") {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", AGY_KEYRING_SERVICE, "-a", AGY_KEYRING_ACCOUNT, "-w"],
        { encoding: "utf8", timeout: 10_000 },
      );
      return decodeDarwinKeyringOutput(out);
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync(
      "secret-tool",
      ["lookup", "service", AGY_KEYRING_SERVICE, "username", AGY_KEYRING_ACCOUNT],
      { encoding: "utf8", timeout: 10_000 },
    );
    return out.replace(/\r?\n$/, "") || null;
  } catch {
    return null;
  }
}

export function writeAgyKeyringRaw(rawUtf8: string, platform: NodeJS.Platform = process.platform): void {
  clearAgyKeyringEmailCache();
  const mock = isMockKeyringMode();
  if (mock) {
    writeMockKeyring(mock, rawUtf8);
    return;
  }
  if (platform === "win32") {
    runWinPowerShell(
      `
${WIN_CRED_CSHARP}
$payload = [Console]::In.ReadToEnd()
[TpWinCred]::WriteUtf8('${AGY_WIN_TARGET}', '${AGY_KEYRING_ACCOUNT}', $payload)
`,
      rawUtf8,
    );
    return;
  }
  if (platform === "darwin") {
    const hex = Buffer.from(rawUtf8, "utf8").toString("hex");
    // 通过 interactive stdin 传 hex，避免凭据出现在命令行参数中
    execFileSync("security", ["-i"], {
      input: `add-generic-password -U -s ${AGY_KEYRING_SERVICE} -a ${AGY_KEYRING_ACCOUNT} -X ${hex}\n`,
      encoding: "utf8",
      timeout: 10_000,
    });
    return;
  }
  execFileSync(
    "secret-tool",
    ["store", `--label=${AGY_WIN_TARGET}`, "service", AGY_KEYRING_SERVICE, "username", AGY_KEYRING_ACCOUNT],
    { input: rawUtf8, encoding: "utf8", timeout: 10_000 },
  );
}

export function deleteAgyKeyringRaw(platform: NodeJS.Platform = process.platform): void {
  clearAgyKeyringEmailCache();
  const mock = isMockKeyringMode();
  if (mock) {
    deleteMockKeyring(mock);
    return;
  }
  if (platform === "win32") {
    runWinPowerShell(`
${WIN_CRED_CSHARP}
[TpWinCred]::DeleteTarget('${AGY_WIN_TARGET}')
`);
    return;
  }
  if (platform === "darwin") {
    try {
      execFileSync("security", ["delete-generic-password", "-s", AGY_KEYRING_SERVICE, "-a", AGY_KEYRING_ACCOUNT], {
        encoding: "utf8",
        timeout: 10_000,
      });
    } catch { /* ignore */ }
    return;
  }
  try {
    execFileSync("secret-tool", ["clear", "service", AGY_KEYRING_SERVICE, "username", AGY_KEYRING_ACCOUNT], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch { /* ignore */ }
}

export function parseAgyKeyringPayload(raw: string | null): AgyKeyringPayload | null {
  if (!raw || !raw.trim().startsWith("{")) return null;
  try {
    const obj = JSON.parse(raw) as Partial<AgyKeyringPayload>;
    if (!obj || typeof obj !== "object" || !obj.token || typeof obj.token !== "object") return null;
    if (typeof obj.token.access_token !== "string" && typeof obj.token.refresh_token !== "string") return null;
    return {
      token: {
        access_token: typeof obj.token.access_token === "string" ? obj.token.access_token : "",
        token_type: typeof obj.token.token_type === "string" && obj.token.token_type ? obj.token.token_type : "Bearer",
        refresh_token: typeof obj.token.refresh_token === "string" ? obj.token.refresh_token : "",
        expiry: typeof obj.token.expiry === "string" ? obj.token.expiry : "",
        expires_in: typeof obj.token.expires_in === "number" && Number.isFinite(obj.token.expires_in) ? obj.token.expires_in : 3599,
      },
      auth_method: typeof obj.auth_method === "string" && obj.auth_method ? obj.auth_method : "consumer",
      id_token_email: typeof obj.id_token_email === "string" ? obj.id_token_email : "",
      writer_id: typeof obj.writer_id === "string" ? obj.writer_id : "",
    };
  } catch {
    return null;
  }
}

/** 从系统凭据槽读取当前 Antigravity 登录邮箱（只返回邮箱，不返回 token）。出错返回空串。 */
export function readAgyKeyringEmail(readKeyring: () => string | null = readAgyKeyringRaw): string {
  try {
    const parsed = parseAgyKeyringPayload(readKeyring());
    return parsed?.id_token_email ? parsed.id_token_email.trim() : "";
  } catch {
    return "";
  }
}

/** 异步非阻塞读取系统凭据槽中当前 Antigravity 登录邮箱（供 Electron 主进程使用，绝不阻塞事件循环）。 */
export async function readAgyKeyringEmailAsync(platform: NodeJS.Platform = process.platform): Promise<string> {
  if (!isMockKeyringMode() && readAgyAccountStore().accounts.length === 0) return "";
  const now = Date.now();
  if (!isMockKeyringMode() && cachedKeyringEmail && now - cachedKeyringEmail.at < 15_000) {
    return cachedKeyringEmail.email;
  }
  const epoch = keyringEmailCacheEpoch;
  try {
    const parsed = parseAgyKeyringPayload(await readAgyKeyringRawAsync(platform));
    const email = parsed?.id_token_email ? parsed.id_token_email.trim() : "";
    if (!isMockKeyringMode() && epoch === keyringEmailCacheEpoch) cachedKeyringEmail = { at: Date.now(), email };
    return email;
  } catch {
    return "";
  }
}

export function buildAgyKeyringPayload(
  account: Pick<StoredAgyAccount, "email">,
  credential: AgyCredential,
  now = Date.now(),
): AgyKeyringPayload {
  const expiresAt = typeof credential.expiresAt === "number" && credential.expiresAt > now + 60_000
    ? credential.expiresAt
    : now + 3599 * 1000;
  const expiresIn = Math.max(60, Math.round((expiresAt - now) / 1000));
  return {
    token: {
      access_token: credential.token,
      token_type: "Bearer",
      refresh_token: credential.refreshToken || "",
      expiry: new Date(expiresAt).toISOString(),
      expires_in: expiresIn,
    },
    auth_method: "consumer",
    id_token_email: account.email,
    writer_id: randomBytes(32).toString("base64url"),
  };
}

/* ---------------- Antigravity 安装目录与进程管理 ---------------- */

function defaultAppDataDir(platform: NodeJS.Platform, home: string): string {
  if (platform === "win32") return process.env.APPDATA || path.join(home, "AppData", "Roaming");
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

function defaultLocalAppDataDir(home: string): string {
  return process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
}

export function agyAppStorageFile(platform: NodeJS.Platform = process.platform, home = os.homedir(), appDataDir?: string): string {
  const base = appDataDir || defaultAppDataDir(platform, home);
  return path.join(base, "Antigravity", "app_storage.json");
}

export function findAntigravityDesktopExe(
  procs: AgyRunningProcess[] = [],
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  appDataDir?: string,
  localAppDataDir?: string,
): string | null {
  const rawFs = getRawFs();
  for (const proc of procs) {
    if (proc.isDesktop && proc.executablePath && rawFs.existsSync(proc.executablePath)) {
      return proc.executablePath;
    }
  }
  const envExe = (process.env.TOKENPULSE_AGY_DESKTOP_EXE || "").trim();
  if (envExe && rawFs.existsSync(envExe)) return envExe;

  if (platform === "win32") {
    const roaming = appDataDir || defaultAppDataDir(platform, home);
    const local = localAppDataDir || defaultLocalAppDataDir(home);
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const cmdWrapper = path.join(roaming, "Antigravity", "bin", "agy.cmd");
    try {
      if (rawFs.existsSync(cmdWrapper)) {
        const text = rawFs.readFileSync(cmdWrapper, "utf8");
        const m = text.match(/"([^"]+Antigravity\.exe)"/i);
        if (m?.[1] && rawFs.existsSync(m[1])) return m[1];
      }
    } catch { /* ignore */ }
    const candidates = [
      path.join(local, "Programs", "antigravity", "Antigravity.exe"),
      path.join(pf, "Antigravity", "Antigravity.exe"),
    ];
    for (const c of candidates) if (rawFs.existsSync(c)) return c;
    return null;
  }

  if (platform === "darwin") {
    for (const c of ["/Applications/Antigravity.app", path.join(home, "Applications", "Antigravity.app")]) {
      if (rawFs.existsSync(c)) return c;
    }
    return null;
  }

  for (const c of ["/usr/share/antigravity/antigravity", "/opt/Antigravity/antigravity", "/usr/bin/antigravity"]) {
    if (rawFs.existsSync(c)) return c;
  }
  return null;
}

export function listRunningAntigravityProcesses(platform: NodeJS.Platform = process.platform): AgyRunningProcess[] {
  if (platform === "win32") {
    try {
      const out = runWinPowerShell(`
$rows = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne ${process.pid} -and (
    $_.Name -ieq 'Antigravity.exe' -or
    (
      ($_.Name -ilike 'language_server*.exe' -or $_.Name -ieq 'agy.exe') -and
      $_.ExecutablePath -and
      ($_.ExecutablePath -ilike '*\\antigravity\\*' -or $_.ExecutablePath -ilike '*\\.gemini\\antigravity*')
    )
  )
} | Select-Object @{N='pid';E={[int]$_.ProcessId}},@{N='name';E={[string]$_.Name}},@{N='executablePath';E={[string]$_.ExecutablePath}}
if ($null -eq $rows) { '[]' } else { ConvertTo-Json -InputObject @($rows) -Compress }
`).trim();
      const parsed = JSON.parse(out || "[]") as { pid: number; name: string; executablePath: string }[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.pid !== process.pid && !/tokenpulse/i.test(p.executablePath || ""))
        .map((p) => ({
          pid: p.pid,
          name: String(p.name || ""),
          executablePath: String(p.executablePath || ""),
          isDesktop: /^antigravity\.exe$/i.test(String(p.name || "")),
        }));
    } catch {
      return [];
    }
  }
  if (platform === "darwin" || platform === "linux") {
    try {
      const out = execFileSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8", timeout: 5_000 });
      const res: AgyRunningProcess[] = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const name = m[2];
        const args = m[3];
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || /tokenpulse/i.test(args)) continue;
        const argv0 = args.split(/\s+/)[0] || "";
        const isDesktop =
          /Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/i.test(args) ||
          /(?:^|\/)antigravity$/i.test(argv0) ||
          /^antigravity$/i.test(name);
        const isLangSrv = /language_server/i.test(name) && /antigravity/i.test(args);
        if (isDesktop || isLangSrv) {
          res.push({ pid, name, executablePath: argv0, isDesktop });
        }
      }
      return res;
    } catch {
      return [];
    }
  }
  return [];
}

export async function listRunningAntigravityProcessesAsync(platform: NodeJS.Platform = process.platform): Promise<AgyRunningProcess[]> {
  if (platform === "win32") {
    try {
      const out = (await runWinPowerShellAsync(`
$rows = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne ${process.pid} -and (
    $_.Name -ieq 'Antigravity.exe' -or
    (
      ($_.Name -ilike 'language_server*.exe' -or $_.Name -ieq 'agy.exe') -and
      $_.ExecutablePath -and
      ($_.ExecutablePath -ilike '*\\antigravity\\*' -or $_.ExecutablePath -ilike '*\\.gemini\\antigravity*')
    )
  )
} | Select-Object @{N='pid';E={[int]$_.ProcessId}},@{N='name';E={[string]$_.Name}},@{N='executablePath';E={[string]$_.ExecutablePath}}
if ($null -eq $rows) { '[]' } else { ConvertTo-Json -InputObject @($rows) -Compress }
`)).trim();
      const parsed = JSON.parse(out || "[]") as { pid: number; name: string; executablePath: string }[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.pid !== process.pid && !/tokenpulse/i.test(p.executablePath || ""))
        .map((p) => ({
          pid: p.pid,
          name: String(p.name || ""),
          executablePath: String(p.executablePath || ""),
          isDesktop: /^antigravity\.exe$/i.test(String(p.name || "")),
        }));
    } catch {
      return [];
    }
  }
  if (platform === "darwin" || platform === "linux") {
    try {
      const out = await execFileAsync("ps", ["-eo", "pid=,comm=,args="], undefined, 5_000);
      const res: AgyRunningProcess[] = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const name = m[2];
        const args = m[3];
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || /tokenpulse/i.test(args)) continue;
        const argv0 = args.split(/\s+/)[0] || "";
        const isDesktop =
          /Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/i.test(args) ||
          /(?:^|\/)antigravity$/i.test(argv0) ||
          /^antigravity$/i.test(name);
        const isLangSrv = /language_server/i.test(name) && /antigravity/i.test(args);
        if (isDesktop || isLangSrv) {
          res.push({ pid, name, executablePath: argv0, isDesktop });
        }
      }
      return res;
    } catch {
      return [];
    }
  }
  return [];
}

async function stopAntigravityProcessesDefault(
  procs: AgyRunningProcess[],
  platform: NodeJS.Platform = process.platform,
  listProcs: () => AgyRunningProcess[] | Promise<AgyRunningProcess[]> = () => listRunningAntigravityProcessesAsync(platform),
  sleep: (ms: number) => Promise<void> = sleepMs,
): Promise<void> {
  if (!procs.length) return;
  const hasDesktop = procs.some((p) => p.isDesktop);

  // 1. 先请求优雅退出，让 Antigravity 刷盘 app_storage.json 与 SQLite WAL
  if (platform === "win32") {
    if (hasDesktop) {
      try {
        await execFileAsync("taskkill.exe", ["/IM", "Antigravity.exe"], undefined, 5_000);
      } catch { /* 部分辅助进程无窗口时会返回非 0，继续轮询 */ }
    }
  } else if (platform === "darwin") {
    if (hasDesktop) {
      try {
        await execFileAsync("osascript", ["-e", 'tell application "Antigravity" to quit'], undefined, 5_000);
      } catch { /* ignore */ }
    }
  } else {
    for (const p of procs) {
      try { process.kill(p.pid, "SIGTERM"); } catch { /* ignore */ }
    }
  }

  // 等待最多 4 秒让优雅退出完成
  const gracefulDeadline = Date.now() + 4_000;
  while (Date.now() < gracefulDeadline) {
    if (!(await listProcs()).length) return;
    await sleep(250);
  }

  // 2. 仍存活的仅按校验过的 Antigravity PID 精准结束（绝不误杀其他软件）
  const remaining = await listProcs();
  if (!remaining.length) return;
  if (platform === "win32") {
    for (const p of remaining) {
      if (p.pid === process.pid || /tokenpulse/i.test(p.executablePath)) continue;
      try {
        await execFileAsync("taskkill.exe", ["/PID", String(p.pid), "/T", "/F"], undefined, 5_000);
      } catch { /* 可能已退出 */ }
    }
  } else {
    for (const p of remaining) {
      if (p.pid === process.pid) continue;
      try { process.kill(p.pid, "SIGKILL"); } catch { /* ignore */ }
    }
  }

  const forceDeadline = Date.now() + 4_000;
  while (Date.now() < forceDeadline) {
    if (!(await listProcs()).length) return;
    await sleep(250);
  }
  const still = await listProcs();
  if (still.length) {
    throw new Error("无法关闭正在运行的 Antigravity 进程，请先手动关闭 Antigravity 后再试。");
  }
}

export function launchAntigravityDesktopDefault(exePath: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "darwin" && exePath.endsWith(".app")) {
    const child = spawn("open", ["-a", exePath], { detached: true, stdio: "ignore" });
    // 启动失败（权限、文件刚被卸载）是异步的 error 事件：不接住就是主进程的未捕获异常
    child.on("error", (error) => log.warn("antigravity", "重新启动 Antigravity 失败：" + errorText(error)));
    child.unref();
    return;
  }
  const child = spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd: path.dirname(exePath),
  });
  child.on("error", (error) => log.warn("antigravity", "重新启动 Antigravity 失败：" + errorText(error)));
  child.unref();
}

/* ---------------- 备份与 app_storage.json 更新 ---------------- */

function backupAgySwitchState(rawKeyring: string | null, appStoragePath: string): { appStorageText: string | null } {
  const root = path.join(dataDir(), "backups", "antigravity-switch");
  const dir = path.join(root, String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  if (rawKeyring !== null) {
    fs.writeFileSync(path.join(dir, "keyring.json"), rawKeyring, { mode: 0o600 });
  }
  let appStorageText: string | null = null;
  try {
    if (fs.existsSync(appStoragePath)) {
      appStorageText = fs.readFileSync(appStoragePath, "utf8");
      fs.writeFileSync(path.join(dir, "app_storage.json"), appStorageText, { mode: 0o600 });
    }
  } catch {
    appStorageText = null;
  }
  try {
    const all = fs.readdirSync(root).sort();
    for (const name of all.slice(0, Math.max(0, all.length - 10))) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch { /* 清不掉旧备份不影响切换 */ }
  return { appStorageText };
}

function updateAppStorageLogin(appStoragePath: string, email: string): void {
  if (!email || !fs.existsSync(appStoragePath)) return;
  let parsed: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(appStoragePath, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    parsed = obj as Record<string, unknown>;
  } catch {
    // 损坏或正在被其他进程占用时不强写
    return;
  }
  parsed["agy.onboarding.lastLoginUsername"] = email;
  if ("agy.onboarding.lastLoginIsGcpTos" in parsed) {
    parsed["agy.onboarding.lastLoginIsGcpTos"] = "false";
  }
  writeAtomic(appStoragePath, JSON.stringify(parsed, null, 2));
}

function rescueOutgoingKeyringAccount(outgoing: AgyKeyringPayload | null, now: number): void {
  if (!outgoing?.id_token_email || !outgoing.token.refresh_token) return;
  const email = outgoing.id_token_email.trim();
  const norm = normalizeAgyEmail(email);
  if (!norm) return;
  const store = readAgyAccountStore();
  const existing = store.accounts.find((a) => normalizeAgyEmail(a.email) === norm);
  // 已有健康凭据的账号无需覆写；只为「仅登记了本机身份」或「已过期/需重登」的换下账号补齐凭据，方便随时切回
  if (existing?.credential?.refreshToken && !existing.renewFailed && !isExpired(existing.credential, now)) return;
  const expiryMs = Date.parse(outgoing.token.expiry);
  const credential: AgyCredential = {
    token: outgoing.token.access_token,
    refreshToken: outgoing.token.refresh_token,
    ...(Number.isFinite(expiryMs) ? { expiresAt: expiryMs } : {}),
  };
  try {
    rememberAgyAccount({ email, label: email, credential }, true, now);
  } catch {
    /* 不阻塞主切换 */
  }
}

/* ---------------- 主切换入口 ---------------- */

let runningSwitch: Promise<AgySwitchResult> | null = null;

export function switchAntigravityAccount(id: string, deps: AgySwitchDeps = {}): Promise<AgySwitchResult> {
  if (runningSwitch) return Promise.reject(new Error("上一次 Antigravity 切换还没完成，请稍候"));
  runningSwitch = doSwitchAntigravity(id, deps).finally(() => {
    runningSwitch = null;
  });
  return runningSwitch;
}

async function doSwitchAntigravity(id: string, deps: AgySwitchDeps): Promise<AgySwitchResult> {
  const nowFn = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const readKeyring = deps.readKeyring ?? (() => readAgyKeyringRawAsync(platform));
  const writeKeyring = deps.writeKeyring ?? ((raw) => writeAgyKeyringRawAsync(raw, platform));
  const deleteKeyring = deps.deleteKeyring ?? (() => deleteAgyKeyringRawAsync(platform));
  const listProcs = deps.listProcesses ?? (() => listRunningAntigravityProcessesAsync(platform));
  const sleep = deps.sleep ?? sleepMs;
  const stopProcs = deps.stopProcesses ?? ((procs) => stopAntigravityProcessesDefault(procs, platform, listProcs, sleep));
  const findExe = deps.findDesktopExe ?? ((procs) => findAntigravityDesktopExe(procs, platform, home, deps.appDataDir, deps.localAppDataDir));
  const launchDesktop = deps.launchDesktop ?? ((exe) => launchAntigravityDesktopDefault(exe, platform));
  const fetchLocalEmail = deps.fetchLocalEmail ?? (async () => {
    if (!antigravityHub()) return "";
    const sess = await fetchAntigravityLocalSession().catch(() => null);
    return sess?.email || "";
  });
  const renewAll = deps.renewAll ?? ((t) => renewAgyCredentials(t));
  const refreshOne = deps.refreshOne ?? ((cred, t) => refreshAgyCredential(cred, t));
  const listStatus = deps.listStatus ?? ((t, email) => listAgyAccountStatus(t, email));

  const initialStore = readAgyAccountStore();
  const initialTarget = initialStore.accounts.find((a) => a.id === id);
  if (!initialTarget) throw new Error("找不到这个 Antigravity 账号");
  if (!initialTarget.email) throw new Error("这个 Antigravity 账号缺少邮箱信息，请先点「重新授权」后再切换。");

  // 1. 核对目标账号是否有可用 OAuth 凭据，临近过期或已过期则先续期
  const now = nowFn();
  if (!initialTarget.credential?.refreshToken || initialTarget.renewFailed) {
    throw new Error("TokenPulse 里没有这个账号可用的 OAuth 登录（仅登记了本机身份或授权已失效）。请先点「重新授权」完成浏览器登录，之后即可一键切换。");
  }

  await renewAll(now).catch(() => 0);
  let store = readAgyAccountStore();
  let target = store.accounts.find((a) => a.id === id);
  if (!target?.credential?.refreshToken || target.renewFailed) {
    throw new Error("这个 Antigravity 账号的 OAuth 授权已失效，请先点「重新授权」完成登录后再切换。");
  }
  if (isExpired(target.credential, now + 5 * 60_000)) {
    const refreshed = await refreshOne(target.credential, now);
    if (!refreshed.ok) {
      throw new Error(`目标账号 OAuth 续期失败（${refreshed.error}），请先点「重新授权」后再切换。`);
    }
    store = readAgyAccountStore();
    target = store.accounts.find((a) => a.id === id)!;
    target.credential = { ...refreshed.credential, ...(target.credential?.projectId ? { projectId: target.credential.projectId } : {}) };
    delete target.renewFailed;
    delete target.renewTrouble;
    writeAgyAccountStore(store);
  }
  const freshCredential = target.credential!;
  const targetEmailNorm = normalizeAgyEmail(target.email);

  // 2. 检测当前状态（系统凭据槽 + 运行中进程）
  const beforeKeyringRaw = await readKeyring();
  const beforeKeyring = parseAgyKeyringPayload(beforeKeyringRaw);
  const procsBefore = await listProcs();
  const wasDesktopRunning = procsBefore.some((p) => p.isDesktop);
  const desktopExe = findExe(procsBefore);
  const liveEmail = normalizeAgyEmail((await fetchLocalEmail().catch(() => "")) || beforeKeyring?.id_token_email || "");

  if (liveEmail && liveEmail === targetEmailNorm && normalizeAgyEmail(beforeKeyring?.id_token_email || "") === targetEmailNorm) {
    const name = target.alias || target.email || target.label;
    return {
      ok: true,
      alreadyActive: true,
      restarted: false,
      accountId: target.id,
      email: target.email,
      message: `Antigravity 当前登录的就是 ${name}。`,
      status: await listStatus(nowFn(), target.email),
    };
  }

  // 3. 记录旧账号登录边界并尝试收存被换下账号的 OAuth 凭据（方便以后一键切回）
  const beforeStoreJson = JSON.stringify(readAgyAccountStore());
  if (liveEmail) recordAgyLocalLogin(liveEmail, nowFn());
  rescueOutgoingKeyringAccount(beforeKeyring, nowFn());

  // 4. 如 Antigravity 正在运行，先关闭并等待锁释放（必须在写 app_storage.json 与凭据前完成）
  const appStoragePath = agyAppStorageFile(platform, home, deps.appDataDir);
  if (procsBefore.length > 0) {
    log.info("antigravity", `切换账号前正在关闭运行中的 Antigravity（${procsBefore.length} 个进程）`);
    await stopProcs(procsBefore);
    // 稍等 300ms 让 Windows 回收文件锁与命名管道
    await sleep(300);
  }

  // 5. 备份原有系统凭据与 app_storage.json
  const backup = backupAgySwitchState(beforeKeyringRaw, appStoragePath);
  const nextPayload = buildAgyKeyringPayload(target, freshCredential, nowFn());
  const nextRaw = JSON.stringify(nextPayload);

  try {
    await writeKeyring(nextRaw);
    const verified = parseAgyKeyringPayload(await readKeyring());
    if (
      !verified ||
      normalizeAgyEmail(verified.id_token_email) !== targetEmailNorm ||
      verified.token.refresh_token !== nextPayload.token.refresh_token ||
      verified.token.access_token !== nextPayload.token.access_token
    ) {
      throw new Error("写入系统凭据后读回核对不一致");
    }
    updateAppStorageLogin(appStoragePath, target.email);
    recordAgyLocalLogin(target.email, nowFn());
    clearAgyKeyringEmailCache();
  } catch (error) {
    // 完整回滚：恢复系统凭据、app_storage.json、账号库，并在原本运行中时拉回 Antigravity
    try {
      if (beforeKeyringRaw === null) await deleteKeyring();
      else await writeKeyring(beforeKeyringRaw);
    } catch { /* 尽量恢复 */ }
    try {
      if (backup.appStorageText !== null) writeAtomic(appStoragePath, backup.appStorageText);
    } catch { /* 尽量恢复 */ }
    try {
      writeAgyAccountStore(JSON.parse(beforeStoreJson));
    } catch { /* 尽量恢复 */ }
    if (wasDesktopRunning && desktopExe) {
      try { launchDesktop(desktopExe); } catch { /* 尽量拉起 */ }
    }
    const reason = errorText(error);
    log.warn("antigravity", "切换 Antigravity 账号失败并已回滚：" + reason);
    throw new Error("切换失败，Antigravity 的登录已恢复原样：" + reason);
  }

  // 6. 原先在运行则自动重启 Antigravity 桌面端
  let restarted = false;
  if (wasDesktopRunning && desktopExe) {
    try {
      launchDesktop(desktopExe);
      restarted = true;
      log.info("antigravity", `已切换 Antigravity 账号并重新启动桌面端`);
    } catch (error) {
      log.warn("antigravity", "凭据已切换但自动重启 Antigravity 失败：" + errorText(error));
    }
  }

  const name = target.alias || target.email || target.label;
  const status = await listStatus(nowFn(), target.email);
  const message = restarted
    ? `已把 Antigravity（桌面端与 CLI）切换到 ${name}，正在自动重启 Antigravity。`
    : wasDesktopRunning
      ? `已把 Antigravity（桌面端与 CLI）切换到 ${name}，请手动重新打开 Antigravity 生效。`
      : `已把 Antigravity（桌面端与 CLI）切换到 ${name}，下次打开 Antigravity 或运行 agy 时自动生效。`;

  return {
    ok: true,
    message,
    accountId: target.id,
    email: target.email,
    restarted,
    status,
  };
}
