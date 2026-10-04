import { execFileSync, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { deleteClaudeSession, type AgentKind } from "../core/sessions";

/**
 * 在 TokenPulse 里直接回复一段会话：用对应 CLI 的无界面模式接着这个会话跑一轮，
 * CLI 会把新的一问一答写回原来的会话文件，界面重新读一遍就能看到。
 *
 * 命令行都对着本机 CLI 的 --help 核过（参考 AllAi 的 electron/chat-run.ts）：
 * - Claude Code：`claude -p --resume <id> --output-format stream-json --verbose --include-partial-messages`，提示词从 stdin 读；
 * - Codex：`codex exec resume <id> --json … -`，`-` 表示从 stdin 读提示词；resume 子命令不收 `--sandbox`，权限用 `-c sandbox_mode=…`；
 * - Grok Build：`grok --resume <id> --output-format streaming-messages-json --include-partial-messages --prompt-file <文件>`。
 * **提示词绝不放进命令行**：Windows 整条命令行上限 32767 字符，而且拼进命令行还要操心转义。
 *
 * 权限两档：
 * - 只读（默认）：Claude / Grok 用 `dontAsk`（没预先允许的工具一律拒绝、不弹确认，所以不会卡住），Codex 只读沙箱；
 * - 可改文件：Claude / Grok 用 `acceptEdits`，Codex `workspace-write` 沙箱。其余要确认的操作照样自动拒绝。
 * 会用掉这个账号的订阅额度（和在终端里回复一样）。
 */

export type ReplyMode = "readonly" | "edit";
export type ReplyEvent =
  | { runId: string; type: "delta"; text: string }
  | { runId: string; type: "tool"; text: string }
  | { runId: string; type: "done"; ok: boolean; error?: string };

type Run = { child: ChildProcess; key: string; cleanup?: string };
const runs = new Map<string, Run>();
/** 用户点了停止的：退出码不是 0 也别当成出错。 */
const stopped = new Set<string>();
let seq = 0;

function where(name: string) {
  try {
    return execFileSync("where.exe", [name], { windowsHide: true, encoding: "utf8", timeout: 5000 })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/\.ps1$/i.test(line));
  } catch {
    return [];
  }
}

/** npm 装的 codex 是个 .cmd 包装：拆出里面真正的 .js，用 Electron 自带的 Node 跑，不依赖 PATH 里有 node，也不用过 cmd 的转义。 */
function unwrapNpm(command: string) {
  if (/\.js$/i.test(command)) return command;
  try {
    const hit = fs.readFileSync(command, "utf8").match(/%dp0%\\node_modules\\([^"'\s]+\.js)/i);
    const js = hit ? path.join(path.dirname(command), "node_modules", hit[1]) : "";
    return js && fs.existsSync(js) ? js : null;
  } catch {
    return null;
  }
}

/**
 * 不在 PATH 上的 codex.exe（0.3.21）：只装了 Codex 桌面端、没有用 npm 装 CLI 的电脑上，`where codex` 找不到任何东西，
 * 但桌面端自己带着一份（%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe，目录名随更新变，取最新的）；
 * npm 包里也有一份原生的（.cmd 包装被删掉或 PATH 没配好时还能用）。
 */
function bundledCodex(): string[] {
  const children = (dir: string) => { try { return fs.readdirSync(dir).map((name) => path.join(dir, name)); } catch { return []; } };
  const newestFirst = (files: string[]) => files
    .flatMap((file) => { try { return [{ file, at: fs.statSync(file).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.at - a.at)
    .map((item) => item.file);
  const local = process.env.LOCALAPPDATA, roaming = process.env.APPDATA;
  const desktop = local ? children(path.join(local, "OpenAI", "Codex", "bin")).map((dir) => path.join(dir, "codex.exe")) : [];
  const vendor = roaming ? children(path.join(roaming, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai")).flatMap((pkg) => children(path.join(pkg, "vendor")).map((triple) => path.join(triple, "bin", "codex.exe"))) : [];
  return [...newestFirst(desktop), ...newestFirst(vendor)];
}

/** 找到这家 CLI 的可执行文件，返回 spawn 用的 [程序, 前置参数, 额外环境变量]。 */
export function resolveCli(kind: AgentKind): { file: string; prefix: string[]; env?: Record<string, string> } | null {
  const home = os.homedir();
  if (kind === "codex") {
    const npm = path.join(process.env.APPDATA || "", "npm");
    const candidates = [
      path.join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"),
      ...where("codex.exe"),
      ...where("codex.cmd"),
      ...bundledCodex(),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      if (/\.exe$/i.test(candidate)) return { file: candidate, prefix: [] };
      const js = unwrapNpm(candidate);
      if (js) return { file: process.execPath, prefix: [js], env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    return null;
  }
  const name = kind === "claude" ? "claude" : "grok";
  const known = kind === "claude" ? path.join(home, ".local", "bin", "claude.exe") : path.join(home, ".grok", "bin", "grok.exe");
  const file = [known, ...where(`${name}.exe`)].find((candidate) => fs.existsSync(candidate));
  return file ? { file, prefix: [] } : null;
}

/**
 * 交给 CLI 的环境变量去掉「别的 Agent 会话」留下的标记。
 * TokenPulse 要是从某个 Agent 的终端里启动的（比如 Claude Code 里跑的命令），会继承一串它的会话变量：
 * - `CLAUDE_CODE_CHILD_SESSION` 等：Claude 以为自己是别的会话派出的子会话，**不保存对话记录**
 *   （提示「Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker」）；在 TokenPulse 里回复的那一轮也就写不回会话文件；
 * - `NO_COLOR`：终端里的 CLI 全变成黑白。
 * 只删本机实测从 Claude Code 里启动时带上的那几个会话变量，按名字列出来：
 * 用户自己配的 CLAUDE_CODE_GIT_BASH_PATH、CLAUDE_CODE_USE_BEDROCK 这类要保留。
 */
const SESSION_MARKERS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "NO_COLOR",
]);
export function cleanAgentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) if (SESSION_MARKERS.has(key.toUpperCase())) delete env[key];
  return env;
}

/**
 * PowerShell 单引号字符串。PowerShell 把弯引号（‘ ’ ‚ ‛）也当成单引号：路径里有它们时不翻倍，字符串就在那里断开、整段脚本报错
 * （0.3.16 修：项目文件夹叫「JMY‘s Mods All in one」时「在终端里继续」打不开 CLI）。几种引号都翻倍。
 */
export const quotePs = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

/**
 * 「在终端里继续」要跑的 PowerShell 脚本：进项目目录，用 CLI 的交互模式接着这个会话。
 * 优先用 PATH 上的命令（和用户自己在终端里敲的一样）；PATH 上没有就用找到的 exe（Grok 默认装在 ~/.grok/bin，不一定在 PATH 里）。
 */
/**
 * 启动 CLI 前的出口规则（0.3.16），来自出口监控里这一家的设置：
 * - 设了 IP 白名单：只看 IP（地区白名单不管）；
 * - 没设 IP 白名单、设了地区白名单：看地区；
 * - 两个都没设：不检测（调用方不传 guard）。
 */
export type ExitGuard = { host: string; allowedIps: string[]; allowedRegions: string[] };
export const guardMode = (guard?: ExitGuard | null): "ip" | "region" | null => guard?.allowedIps.length ? "ip" : guard?.allowedRegions.length ? "region" : null;
const CLI_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok" };

/**
 * 启动 CLI 之前，在**同一个 PowerShell 窗口里**测一次出口：符合白名单才往下走，否则打印原因、不启动。
 *
 * 为什么不在 TokenPulse 里测完再开窗口：终端里的 CLI 走的是这个 PowerShell 进程的网络环境（代理环境变量等），
 * 和 TokenPulse 自己发请求的路不一定一样。只有在这个窗口里测到的出口，才是 CLI 接下来真正用的出口。
 *
 * 做法和出口监控一样：用 curl.exe 请求 `https://<域名>/cdn-cgi/trace`，取里面的 `ip=` 和 `loc=`（两位地区代码）。
 * IP 两边都用 .NET 的 IPAddress 规范化后比较（IPv6 的写法不同也能对上）；地区按大写比较，XX / ZZ / EU 这类说不清的当作测不出来。
 * 测不出来（没有 curl、超时、返回的不是 trace）一律不启动——确认不了从哪儿出去，就别启动。
 * 脚本里的域名、IP、地区都来自已经校验过的出口监控配置，仍然按 PowerShell 字符串规则加引号。
 */
export function exitGuardScript(kind: AgentKind, guard: ExitGuard) {
  const label = CLI_LABEL[kind], byIp = guardMode(guard) === "ip";
  const refuse = (message: string) => [`  Write-Host ${message} -ForegroundColor Red`];
  return [
    byIp ? `$tpAllowed = @(${guard.allowedIps.map(quotePs).join(", ")})` : `$tpAllowed = @(${guard.allowedRegions.map((code) => quotePs(code.toUpperCase())).join(", ")})`,
    `$tpHost = ${quotePs(guard.host)}`,
    `Write-Host ('[TokenPulse] 正在这个终端里检测出口${byIp ? " IP" : "地区"}（' + $tpHost + '）…') -ForegroundColor DarkGray`,
    `$tpNorm = { param($v) try { [System.Net.IPAddress]::Parse(([string]$v).Trim()).ToString().ToLowerInvariant() } catch { ([string]$v).Trim().ToLowerInvariant() } }`,
    `$tpIp = ''; $tpLoc = ''`,
    `if (Get-Command curl.exe -ErrorAction SilentlyContinue) {`,
    `  try {`,
    `    $tpOut = & curl.exe -sS --max-time 6 --http1.1 --max-filesize 16384 -H 'Cache-Control: no-cache' ('https://' + $tpHost + '/cdn-cgi/trace?tokenpulse=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) 2>$null`,
    `    if ($LASTEXITCODE -eq 0) {`,
    `      $tpText = $tpOut -join [char]10`,
    `      $tpMatch = [regex]::Match($tpText, '(?m)^ip=([0-9A-Fa-f:.]+)[ ]*$'); if ($tpMatch.Success) { $tpIp = $tpMatch.Groups[1].Value }`,
    `      $tpMatch = [regex]::Match($tpText, '(?m)^loc=([A-Za-z][A-Za-z])[ ]*$'); if ($tpMatch.Success) { $tpLoc = $tpMatch.Groups[1].Value.ToUpperInvariant() }`,
    `      if (@('XX', 'ZZ', 'EU') -contains $tpLoc) { $tpLoc = '' }`,
    `    }`,
    `  } catch { $tpIp = ''; $tpLoc = '' }`,
    `}`,
    ...(byIp ? [
      `if (-not $tpIp) {`,
      ...refuse(`'[TokenPulse] 没能确认这个终端的出口 IP，已拒绝启动 ${label}。请检查网络或代理后重试。'`),
      `  return`,
      `}`,
      `if (@($tpAllowed | ForEach-Object { & $tpNorm $_ }) -notcontains (& $tpNorm $tpIp)) {`,
      ...refuse(`('[TokenPulse] 这个终端的出口 IP 是 ' + $tpIp + '，不在白名单里，已拒绝启动 ${label}。')`),
      `  Write-Host ('[TokenPulse] IP 白名单：' + ($tpAllowed -join '、') + '。可以在 TokenPulse 的「出口监控」里修改。') -ForegroundColor DarkGray`,
      `  return`,
      `}`,
      `Write-Host ('[TokenPulse] 出口 IP ' + $tpIp + ' 在白名单里，启动 ${label}。') -ForegroundColor Green`,
    ] : [
      `if (-not $tpLoc) {`,
      ...refuse(`'[TokenPulse] 没能确认这个终端的出口地区，已拒绝启动 ${label}。请检查网络或代理后重试。'`),
      `  return`,
      `}`,
      `if ($tpAllowed -notcontains $tpLoc) {`,
      ...refuse(`('[TokenPulse] 这个终端的出口地区是 ' + $tpLoc + '（IP ' + $tpIp + '），不在地区白名单里，已拒绝启动 ${label}。')`),
      `  Write-Host ('[TokenPulse] 地区白名单：' + ($tpAllowed -join '、') + '。可以在 TokenPulse 的「出口监控」里修改。') -ForegroundColor DarkGray`,
      `  return`,
      `}`,
      `Write-Host ('[TokenPulse] 出口地区 ' + $tpLoc + '（IP ' + $tpIp + '）在地区白名单里，启动 ${label}。') -ForegroundColor Green`,
    ]),
  ].join("\n");
}

export function terminalScript(kind: AgentKind, id: string | null, cwd?: string, fallbackExe?: string, guard?: ExitGuard | null) {
  const name = kind === "claude" ? "claude" : kind === "codex" ? "codex" : "grok";
  // id 为 null：开一个新对话（0.3.16），不带任何参数，和用户自己在这个目录里敲命令一样
  const args = id === null ? "" : (kind === "codex" ? ["resume", id] : ["--resume", id]).map(quotePs).join(" ");
  return [
    cwd ? `Set-Location -LiteralPath ${quotePs(cwd)}` : "",
    // 设了出口白名单（IP 优先，没有 IP 就看地区）：先测，不符合就到此为止（脚本里的 return），下面两行不会执行
    guard && guardMode(guard) ? exitGuardScript(kind, guard) : "",
    `$cli = if (Get-Command ${name} -ErrorAction SilentlyContinue) { ${quotePs(name)} } else { ${quotePs(fallbackExe || name)} }`,
    `& $cli ${args}`.trimEnd(),
  ].filter(Boolean).join("\n");
}

/**
 * 打开一个新的 PowerShell 窗口跑 terminalScript。
 * 直接 spawn powershell（detached）在 Electron 这种 GUI 程序里拿不到控制台：进程立刻退出、什么窗口都不出（0.3.3 的 bug）。
 * 交给 `cmd /c start` 开新控制台（Win11 默认是 Windows Terminal）；脚本用 -EncodedCommand 传，路径里的空格、引号、中文都不用操心转义。
 */
export function openTerminal(kind: AgentKind, id: string | null, cwd?: string, guard?: ExitGuard | null) {
  const cli = resolveCli(kind);
  const fallbackExe = cli && cli.prefix.length === 0 ? cli.file : undefined;
  const encoded = Buffer.from(terminalScript(kind, id, cwd, fallbackExe, guard), "utf16le").toString("base64");
  const child = spawn("cmd.exe", ["/d", "/c", "start", '""', "powershell.exe", "-NoExit", "-NoProfile", "-EncodedCommand", encoded], {
    env: cleanAgentEnv(),
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

/** 命令行参数（不含提示词本身）。单独导出给测试。 */
export function replyArgs(kind: AgentKind, id: string, mode: ReplyMode, promptFile?: string) {
  if (kind === "claude") {
    return ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--resume", id, "--permission-mode", mode === "edit" ? "acceptEdits" : "dontAsk"];
  }
  if (kind === "codex") {
    return [
      "exec", "resume", id, "--json", "--skip-git-repo-check",
      "-c", `sandbox_mode="${mode === "edit" ? "workspace-write" : "read-only"}"`,
      "-c", 'approval_policy="never"',
      "-",
    ];
  }
  return [
    "--output-format", "streaming-messages-json", "--include-partial-messages",
    "--resume", id, "--permission-mode", mode === "edit" ? "acceptEdits" : "dontAsk",
    "--prompt-file", promptFile ?? "",
  ];
}
/**
 * 删除命令对着本机 CLI 的 --help 核过。Claude Code 没有普通对话删除子命令。
 * Codex 要带 --force（0.3.21）：不带的话它要在终端里问一句确认，TokenPulse 起的进程没有终端，
 * 直接报「cannot confirm session deletion without an interactive terminal」。确认已经由 TokenPulse 自己的对话框问过了。
 */
export function deleteArgs(kind: AgentKind, id: string): string[] | null {
  if (kind === "codex") return ["delete", "--force", id];
  if (kind === "grok") return ["sessions", "delete", id];
  return null;
}

/** 永久删除一段会话；正在回复的会话不允许删除。 */
export async function deleteSession(kind: AgentKind, id: string) {
  const key = `${kind}:${id}`;
  if ([...runs.values()].some((run) => run.key === key)) throw new Error("这段会话正在回复，请先停止再删除");
  const args = deleteArgs(kind, id);
  if (!args) {
    if (!deleteClaudeSession(id)) throw new Error("找不到 Claude Code 的会话记录文件");
    return;
  }
  const cli = resolveCli(kind);
  if (!cli) throw new Error(kind === "codex" ? "没找到 Codex 的命令行程序（装了 Codex 桌面端，或者用 npm 装了 codex 都可以），无法删除会话" : "没找到 Grok Build，无法删除会话");
  const env: NodeJS.ProcessEnv = { ...cleanAgentEnv(), ...cli.env };
  if (!cli.env?.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let timedOut = false;
    const child = spawn(cli.file, [...cli.prefix, ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: Buffer | string) => { output = (output + chunk.toString()).slice(-2000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => reject(new Error(`启动 CLI 失败：${error.message}`)));
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(timedOut ? "删除会话超时" : output.trim().split(/\r?\n/).slice(-3).join(" " ).slice(0, 400) || `CLI 退出码 ${code}`));
    });
  });
}

/**
 * 从一行 JSON 里挑出能给人看的：回复文字（增量或整段）和工具调用。三家格式不同，按字段找。
 * streamed：这一轮已经收到过增量文字 —— 之后整段的 assistant 消息就不再重复加。
 */
export function readEvent(kind: AgentKind, line: string, streamed: boolean): { delta?: string; tool?: string; error?: string; final?: string } {
  let row: Record<string, any>;
  try {
    row = JSON.parse(line);
  } catch {
    return {};
  }
  if (!row || typeof row !== "object") return {};
  if (kind === "codex") {
    const item = row.item ?? {};
    // Codex 一轮里可能先说一段、跑命令、再说一段：每段是一条完整的 agent_message，中间空一行
    if (row.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") return { delta: streamed ? `\n\n${item.text}` : item.text };
    if (row.type === "item.started" && (item.type === "command_execution" || item.type === "mcp_tool_call")) {
      return { tool: String(Array.isArray(item.command) ? item.command.join(" ") : item.command ?? item.tool ?? item.type).slice(0, 160) };
    }
    const message = (value: any): string => (typeof value === "string" ? value : typeof value?.message === "string" ? value.message : "");
    let error = "";
    if (row.type === "turn.failed" || row.type === "error") error = message(row.error) || message(row.message) || "Codex 返回了错误";
    else if (row.type === "item.completed" && item.type === "error") error = message(item.message) || message(item.error);
    // 「事件流滞后、丢了几条」只是诊断信息，不算失败（AllAi 的 chat-parse.ts 里踩过）
    if (error && !/^in-process app-server event stream lagged/i.test(error.trim())) return { error };
    return {};
  }
  // Grok 的 streaming-messages-json 也可能是 ACP 的 sessionUpdate 格式（和会话文件 updates.jsonl 一样）
  const update = row.update ?? row.params?.update;
  if (update && typeof update.sessionUpdate === "string") {
    const content = update.content;
    const text = typeof content === "string" ? content : typeof content?.text === "string" ? content.text : "";
    if (update.sessionUpdate === "agent_message_chunk" && text) return { delta: text };
    if (update.sessionUpdate === "tool_call") return { tool: String(update._meta?.["x.ai/tool"]?.name || update.title || "工具").slice(0, 160) };
    return {};
  }
  // Claude / Grok：流式增量在 stream_event 里；整段消息在 assistant 里；最后一条 result
  const event = row.event ?? row;
  const delta = event?.delta;
  if ((row.type === "stream_event" || event?.type === "content_block_delta") && delta && typeof delta.text === "string" && (delta.type === undefined || delta.type === "text_delta")) {
    return { delta: delta.text };
  }
  if (row.type === "assistant" && Array.isArray(row.message?.content)) {
    const tool = row.message.content.find((block: any) => block?.type === "tool_use");
    if (tool) return { tool: String(tool.name ?? "工具") };
    if (!streamed) {
      const text = row.message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("");
      if (text) return { delta: text };
    }
  }
  if (row.type === "result") {
    if (row.is_error) return { error: String(row.result ?? row.error ?? "回复失败") };
    if (!streamed && typeof row.result === "string") return { final: row.result };
  }
  if (row.type === "error") return { error: String(row.message ?? row.error ?? "回复失败") };
  return {};
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      // 已经退出了
    }
  } else child.kill("SIGTERM");
}

export function startReply(
  options: { kind: AgentKind; id: string; cwd: string; prompt: string; mode: ReplyMode },
  emit: (event: ReplyEvent) => void,
): string {
  const key = `${options.kind}:${options.id}`;
  if ([...runs.values()].some((run) => run.key === key)) throw new Error("这段会话正在回复，等它结束或先停止");
  const cli = resolveCli(options.kind);
  if (!cli) throw new Error(`没找到 ${options.kind === "claude" ? "Claude Code" : options.kind === "codex" ? "Codex CLI" : "Grok Build"}，请先安装官方 CLI`);
  const runId = `r${Date.now()}-${seq++}`;
  let promptFile: string | undefined;
  if (options.kind === "grok") {
    promptFile = path.join(os.tmpdir(), `tokenpulse-reply-${runId}.txt`);
    fs.writeFileSync(promptFile, options.prompt, "utf8");
  }
  const env: NodeJS.ProcessEnv = { ...cleanAgentEnv(), ...cli.env };
  if (!cli.env?.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(cli.file, [...cli.prefix, ...replyArgs(options.kind, options.id, options.mode, promptFile)], {
    cwd: options.cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  runs.set(runId, { child, key, cleanup: promptFile });
  if (options.kind !== "grok") child.stdin?.end(options.prompt, "utf8");
  else child.stdin?.end();

  let buffer = "";
  let streamed = false;
  let error = "";
  let stderr = "";
  const handle = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = readEvent(options.kind, trimmed, streamed);
    if (event.delta) {
      streamed = true;
      emit({ runId, type: "delta", text: event.delta });
    }
    if (event.final) emit({ runId, type: "delta", text: event.final });
    if (event.tool) emit({ runId, type: "tool", text: event.tool });
    if (event.error) error = event.error;
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const finish = (ok: boolean, message?: string) => {
    if (!runs.has(runId)) return;
    const run = runs.get(runId)!;
    runs.delete(runId);
    if (run.cleanup) fs.rm(run.cleanup, { force: true }, () => undefined);
    emit({ runId, type: "done", ok, ...(message ? { error: message } : {}) });
  };
  child.on("error", (err) => finish(false, `启动 CLI 失败：${err.message}`));
  child.on("close", (code) => {
    if (buffer) handle(buffer);
    if (stopped.delete(runId)) return finish(false, "已停止");
    if (code === 0 && !error) finish(true);
    else finish(false, error || stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400) || `CLI 退出码 ${code}`);
  });
  return runId;
}

export function stopReply(runId: string) {
  const run = runs.get(runId);
  if (!run) return false;
  stopped.add(runId);
  killTree(run.child);
  return true;
}

export function stopAllReplies() {
  for (const run of runs.values()) killTree(run.child);
}
