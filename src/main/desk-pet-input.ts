/*
 * 桌宠键鼠互动与密码框自动捂眼监听（Windows 独立后台轻量进程）。
 *
 * 设计要点：
 * 1. 绝不在 Electron 主进程 UI 线程安装全局钩子（避免主进程繁忙时拖卡整台电脑鼠标）。
 * 2. 独立子进程用 GetAsyncKeyState 轻量轮询（18ms）读取按键脉冲与鼠标左右键，不安装 WH_KEYBOARD_LL/WH_MOUSE_LL 钩子，
 *    任何情况下都不会阻滞系统输入；同时另起后台线程通过 Windows UI Automation 监听焦点 IsPassword 属性。
 * 3. 隐私优先：检测到焦点在密码框（IsPassword=true）时，子进程内立即停止输出任何按键（但仍排空 GetAsyncKeyState 的锁存位，
 *    确保切出密码框后绝不会补发密码期间的按键）；按键仅在内存中瞬间触发动画，绝不记录、不落盘、不上传。
 * 4. 零残留：子进程监听 stdin 关闭与父进程 PID 存活，主进程停止/退出或关闭「键鼠互动桌面」时立刻退出。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 定位系统自带的 Windows PowerShell 绝对路径（不依赖用户 PATH 配置，找不到再回退 powershell.exe）。 */
function resolvePowerShellExe(): string {
  const sysRoot = process.env.SystemRoot || process.env.WINDIR;
  if (sysRoot) {
    const candidate = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return "powershell.exe";
}

export type KeyLayout = {
  /** 飘字展示的短符号（1~3 字符）。 */
  key: string;
  /** 极简像素键盘上的行（0=数字/上排, 1=中排, 2=下排, 3=空格/底排）。 */
  row: number;
  /** 极简像素键盘上的列（0..8，从左到右）。 */
  col: number;
  /** 左手区还是右手区（决定拍左爪还是右爪）。 */
  hand: "left" | "right";
};

export type DeskPetInputEvent =
  | { type: "key"; key: string; row: number; col: number; hand: "left" | "right" }
  | { type: "mouse"; left: boolean; right: boolean }
  | { type: "password"; active: boolean };

/** Windows 虚拟键码（VK）→ 极简像素键盘键位与展示字形。 */
const VK_LAYOUT: Record<number, KeyLayout> = {
  // 顶排数字 & 功能键（row 0）
  0x1b: { key: "Esc", row: 0, col: 0, hand: "left" },
  0xc0: { key: "`", row: 0, col: 0, hand: "left" },
  0x31: { key: "1", row: 0, col: 0, hand: "left" },
  0x32: { key: "2", row: 0, col: 1, hand: "left" },
  0x33: { key: "3", row: 0, col: 2, hand: "left" },
  0x34: { key: "4", row: 0, col: 3, hand: "left" },
  0x35: { key: "5", row: 0, col: 4, hand: "left" },
  0x36: { key: "6", row: 0, col: 5, hand: "right" },
  0x37: { key: "7", row: 0, col: 6, hand: "right" },
  0x38: { key: "8", row: 0, col: 7, hand: "right" },
  0x39: { key: "9", row: 0, col: 7, hand: "right" },
  0x30: { key: "0", row: 0, col: 8, hand: "right" },
  0xbd: { key: "-", row: 0, col: 8, hand: "right" },
  0xbb: { key: "=", row: 0, col: 8, hand: "right" },
  0x08: { key: "⌫", row: 0, col: 8, hand: "right" },
  // 小键盘数字也归入对应数字
  0x60: { key: "0", row: 0, col: 8, hand: "right" },
  0x61: { key: "1", row: 0, col: 0, hand: "right" },
  0x62: { key: "2", row: 0, col: 1, hand: "right" },
  0x63: { key: "3", row: 0, col: 2, hand: "right" },
  0x64: { key: "4", row: 0, col: 3, hand: "right" },
  0x65: { key: "5", row: 0, col: 4, hand: "right" },
  0x66: { key: "6", row: 0, col: 5, hand: "right" },
  0x67: { key: "7", row: 0, col: 6, hand: "right" },
  0x68: { key: "8", row: 0, col: 7, hand: "right" },
  0x69: { key: "9", row: 0, col: 7, hand: "right" },

  // QWERTY 上排（row 0）
  0x09: { key: "⇥", row: 0, col: 0, hand: "left" },
  0x51: { key: "Q", row: 0, col: 0, hand: "left" },
  0x57: { key: "W", row: 0, col: 1, hand: "left" },
  0x45: { key: "E", row: 0, col: 2, hand: "left" },
  0x52: { key: "R", row: 0, col: 3, hand: "left" },
  0x54: { key: "T", row: 0, col: 4, hand: "left" },
  0x59: { key: "Y", row: 0, col: 5, hand: "right" },
  0x55: { key: "U", row: 0, col: 6, hand: "right" },
  0x49: { key: "I", row: 0, col: 7, hand: "right" },
  0x4f: { key: "O", row: 0, col: 8, hand: "right" },
  0x50: { key: "P", row: 0, col: 8, hand: "right" },
  0xdb: { key: "[", row: 0, col: 8, hand: "right" },
  0xdd: { key: "]", row: 0, col: 8, hand: "right" },
  0xdc: { key: "\\", row: 0, col: 8, hand: "right" },

  // ASDF 中排（row 1）
  0x41: { key: "A", row: 1, col: 0, hand: "left" },
  0x53: { key: "S", row: 1, col: 1, hand: "left" },
  0x44: { key: "D", row: 1, col: 2, hand: "left" },
  0x46: { key: "F", row: 1, col: 3, hand: "left" },
  0x47: { key: "G", row: 1, col: 4, hand: "left" },
  0x48: { key: "H", row: 1, col: 5, hand: "right" },
  0x4a: { key: "J", row: 1, col: 6, hand: "right" },
  0x4b: { key: "K", row: 1, col: 7, hand: "right" },
  0x4c: { key: "L", row: 1, col: 8, hand: "right" },
  0xba: { key: ";", row: 1, col: 8, hand: "right" },
  0xde: { key: "'", row: 1, col: 8, hand: "right" },
  0x0d: { key: "↵", row: 1, col: 8, hand: "right" },

  // ZXCV 下排（row 2）
  0x5a: { key: "Z", row: 2, col: 0, hand: "left" },
  0x58: { key: "X", row: 2, col: 1, hand: "left" },
  0x43: { key: "C", row: 2, col: 2, hand: "left" },
  0x56: { key: "V", row: 2, col: 3, hand: "left" },
  0x42: { key: "B", row: 2, col: 4, hand: "left" },
  0x4e: { key: "N", row: 2, col: 5, hand: "right" },
  0x4d: { key: "M", row: 2, col: 6, hand: "right" },
  0xbc: { key: ",", row: 2, col: 7, hand: "right" },
  0xbe: { key: ".", row: 2, col: 7, hand: "right" },
  0xbf: { key: "/", row: 2, col: 8, hand: "right" },
  0x2e: { key: "Del", row: 2, col: 8, hand: "right" },

  // 底排：空格与方向键（row 3）
  0x20: { key: "␣", row: 3, col: 4, hand: "left" },
  0x25: { key: "←", row: 3, col: 7, hand: "right" },
  0x26: { key: "↑", row: 3, col: 8, hand: "right" },
  0x28: { key: "↓", row: 3, col: 8, hand: "right" },
  0x27: { key: "→", row: 3, col: 8, hand: "right" },
};

const TRACKED_VKS = Object.keys(VK_LAYOUT).map((n) => Number(n));

export function keyLayoutOf(vk: number): KeyLayout | null {
  return VK_LAYOUT[vk] ?? null;
}

/** 解析后台辅助进程吐出的单行 NDJSON 事件；非法行返回 null。 */
export function parseHelperLine(line: string): DeskPetInputEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.t === "k") {
    const vk = Number(obj.vk);
    const layout = keyLayoutOf(vk);
    if (!layout) return null;
    return { type: "key", ...layout };
  }
  if (obj.t === "m") {
    return { type: "mouse", left: obj.l === 1 || obj.l === true, right: obj.r === 1 || obj.r === true };
  }
  if (obj.t === "pw") {
    return { type: "password", active: obj.v === true || obj.v === 1 };
  }
  return null;
}

/** 生成运行在独立 PowerShell 进程内的精简 C# 轮询 + UIA 密码框监听脚本。 */
function buildWindowsHelperScript(parentPid: number): string {
  const vkList = TRACKED_VKS.join(",");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase",
    "$src = @\"",
    "using System;",
    "using System.Diagnostics;",
    "using System.Runtime.InteropServices;",
    "using System.Threading;",
    "using System.Windows.Automation;",
    "public static class TpPetInput {",
    "  [DllImport(\"user32.dll\")] private static extern short GetAsyncKeyState(int vKey);",
    "  [DllImport(\"user32.dll\")] private static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);",
    "  [DllImport(\"user32.dll\")] private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder sb, int maxCount);",
    "  [DllImport(\"user32.dll\", EntryPoint = \"GetWindowLongW\")] private static extern int GetWindowLongW(IntPtr hWnd, int nIndex);",
    "  [StructLayout(LayoutKind.Sequential)] private struct RECT { public int L, T, R, B; }",
    "  [StructLayout(LayoutKind.Sequential)] private struct GUITHREADINFO { public int cbSize, flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }",
    "  private static volatile bool _stop = false;",
    "  private static volatile bool _isPw = false;",
    "  private static int _pwClearStreak = 0;",
    "  private static readonly object _lk = new object();",
    "  private static void Emit(string s) { lock (_lk) { try { Console.WriteLine(s); Console.Out.Flush(); } catch { _stop = true; } } }",
    "  private static void SetPw(bool v) {",
    "    if (v) { _pwClearStreak = 0; if (_isPw) return; _isPw = true; Emit(\"{\\\"t\\\":\\\"pw\\\",\\\"v\\\":true}\"); return; }",
    "    if (!_isPw) return;",
    "    if (++_pwClearStreak < 2) return;",
    "    _pwClearStreak = 0; _isPw = false; Emit(\"{\\\"t\\\":\\\"pw\\\",\\\"v\\\":false}\");",
    "  }",
    "  private static bool IsClassicEditClass(string cls) {",
    "    if (string.IsNullOrEmpty(cls)) return false;",
    "    string lo = cls.ToLowerInvariant();",
    "    return lo == \"edit\" || lo.StartsWith(\"richedit\") || lo == \"tedit\" || lo == \"tmaskedit\" || lo == \"wedit\" || (lo.StartsWith(\"thunder\") && lo.Contains(\"textbox\"));",
    "  }",
    "  private static bool ClassicWin32IsPassword() {",
    "    try {",
    "      IntPtr fg = GetForegroundWindow(); if (fg == IntPtr.Zero) return false;",
    "      uint dummy; uint tid = GetWindowThreadProcessId(fg, out dummy); if (tid == 0) return false;",
    "      var info = new GUITHREADINFO(); info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));",
    "      if (!GetGUIThreadInfo(tid, ref info) || info.hwndFocus == IntPtr.Zero) return false;",
    "      var sb = new System.Text.StringBuilder(128);",
    "      int n = GetClassNameW(info.hwndFocus, sb, sb.Capacity); if (n <= 0) return false;",
    "      if (!IsClassicEditClass(sb.ToString(0, n))) return false;",
    "      int style = GetWindowLongW(info.hwndFocus, -16);",
    "      return (style & 0x0020) != 0 && (style & 0x0004) == 0;",
    "    } catch { return false; }",
    "  }",
    "  private static bool ElementIsRealPassword(AutomationElement el) {",
    "    if (el == null) return false;",
    "    try {",
    "      if (!el.Current.IsPassword) return false;",
    "      if (el.Current.ControlType != ControlType.Edit) return false;",
    "      var rc = el.Current.BoundingRectangle;",
    "      if (rc.IsEmpty || double.IsNaN(rc.Height)) return false;",
    "      return rc.Height >= 8.0 && rc.Height <= 140.0;",
    "    } catch { return false; }",
    "  }",
    "  private static IntPtr _lastFg = IntPtr.Zero;",
    "  private static IntPtr _lastFocus = IntPtr.Zero;",
    "  private static void PollFocus(bool forceUia) {",
    "    try {",
    "      IntPtr fg = GetForegroundWindow();",
    "      IntPtr focusHwnd = IntPtr.Zero;",
    "      if (fg != IntPtr.Zero) {",
    "        uint dummy; uint tid = GetWindowThreadProcessId(fg, out dummy);",
    "        if (tid != 0) {",
    "          var info = new GUITHREADINFO(); info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));",
    "          if (GetGUIThreadInfo(tid, ref info)) focusHwnd = info.hwndFocus;",
    "        }",
    "      }",
    "      if (focusHwnd != IntPtr.Zero) {",
    "        var sb = new System.Text.StringBuilder(128);",
    "        int n = GetClassNameW(focusHwnd, sb, sb.Capacity);",
    "        if (n > 0 && IsClassicEditClass(sb.ToString(0, n))) {",
    "          int style = GetWindowLongW(focusHwnd, -16);",
    "          if ((style & 0x0020) != 0 && (style & 0x0004) == 0) { _lastFg = fg; _lastFocus = focusHwnd; SetPw(true); return; }",
    "        }",
    "      }",
    "      bool changed = fg != _lastFg || focusHwnd != _lastFocus;",
    "      _lastFg = fg; _lastFocus = focusHwnd;",
    "      if (!changed && !forceUia && !_isPw) return;",
    "      SetPw(ElementIsRealPassword(AutomationElement.FocusedElement));",
    "    } catch { SetPw(false); }",
    "  }",
    "  public static void Run(int ppid, int[] vks) {",
    "    var tIn = new Thread(() => { try { while (!_stop) { if (Console.In.Read() < 0) break; } } catch {} _stop = true; });",
    "    tIn.IsBackground = true; tIn.Start();",
    "    var tUia = new Thread(() => {",
    "      AutomationFocusChangedEventHandler h = null;",
    "      try { h = (s, e) => { if (_stop) return; try { if (ClassicWin32IsPassword()) { SetPw(true); return; } SetPw(ElementIsRealPassword(s as AutomationElement)); } catch { PollFocus(true); } }; Automation.AddAutomationFocusChangedEventHandler(h); } catch {}",
    "      PollFocus(true);",
    "      int uiaTick = 0;",
    "      while (!_stop) { Thread.Sleep(450); if (_stop) break; PollFocus(++uiaTick % 5 == 0); }",
    "      try { if (h != null) Automation.RemoveAutomationFocusChangedEventHandler(h); } catch {}",
    "    });",
    "    tUia.IsBackground = true; tUia.SetApartmentState(ApartmentState.MTA); tUia.Start();",
    "    bool[] prev = new bool[vks.Length];",
    "    for (int i = 0; i < vks.Length; i++) prev[i] = (GetAsyncKeyState(vks[i]) & 0x8000) != 0;",
    "    bool pL = (GetAsyncKeyState(0x01) & 0x8000) != 0, pR = (GetAsyncKeyState(0x02) & 0x8000) != 0;",
    "    Emit(\"{\\\"t\\\":\\\"ready\\\"}\");",
    "    int ticks = 0;",
    "    while (!_stop) {",
    "      Thread.Sleep(25);",
    "      if (_stop) break;",
    "      bool cL = (GetAsyncKeyState(0x01) & 0x8000) != 0, cR = (GetAsyncKeyState(0x02) & 0x8000) != 0;",
    "      if (cL != pL || cR != pR) { pL = cL; pR = cR; Emit(\"{\\\"t\\\":\\\"m\\\",\\\"l\\\":\" + (cL ? \"1\" : \"0\") + \",\\\"r\\\":\" + (cR ? \"1\" : \"0\") + \"}\"); }",
    "      bool pw = _isPw;",
    "      for (int i = 0; i < vks.Length; i++) {",
    "        short st = GetAsyncKeyState(vks[i]);",
    "        bool down = (st & 0x8000) != 0;",
    "        bool edge = !prev[i] && (down || (st & 0x0001) != 0);",
    "        prev[i] = down;",
    "        if (edge && !pw) Emit(\"{\\\"t\\\":\\\"k\\\",\\\"vk\\\":\" + vks[i] + \"}\");",
    "      }",
    "      if (++ticks >= 30) { ticks = 0; if (ppid > 0) { try { var p = Process.GetProcessById(ppid); if (p == null || p.HasExited) _stop = true; } catch { _stop = true; } } }",
    "    }",
    "  }",
    "}",
    "\"@",
    "Add-Type -TypeDefinition $src -ReferencedAssemblies @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')",
    `[TpPetInput]::Run(${parentPid}, [int[]]@(${vkList}))`,
  ].join("\n");
}

export class DeskPetInputMonitor {
  private child: ChildProcess | null = null;
  private buffer = "";
  private running = false;
  private readyFlag = false;
  private lastPassword = false;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(private readonly onEvent: (event: DeskPetInputEvent) => void) {}

  get active(): boolean {
    return this.running;
  }

  get ready(): boolean {
    return this.readyFlag;
  }

  get passwordActive(): boolean {
    return this.lastPassword;
  }

  start(): void {
    if (this.running) return;
    if (process.platform !== "win32") return;
    this.running = true;
    this.readyFlag = false;
    this.buffer = "";
    this.lastPassword = false;

    // 必须用 -EncodedCommand 而非 -Command -：PowerShell 非交互 -Command - 会阻塞等 stdin EOF 才执行脚本；
    // 用 -EncodedCommand 可立即编译启动轮询循环，同时把打开的 stdin 留作父进程存活管道（关闭 stdin 几十毫秒内自动退出）。
    const encoded = Buffer.from(buildWindowsHelperScript(process.pid), "utf16le").toString("base64");
    const proc = spawn(
      resolvePowerShellExe(),
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    this.child = proc;

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      if (!this.running || this.child !== proc) return;
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim() === '{"t":"ready"}') {
          this.readyFlag = true;
        } else {
          const ev = parseHelperLine(line);
          if (ev) {
            if (ev.type === "password") this.lastPassword = ev.active;
            this.onEvent(ev);
          }
        }
        nl = this.buffer.indexOf("\n");
      }
      if (this.buffer.length > 8192) this.buffer = "";
    });

    const cleanup = () => {
      if (this.child === proc) {
        this.child = null;
        this.running = false;
        this.readyFlag = false;
        if (this.lastPassword) {
          this.lastPassword = false;
          this.onEvent({ type: "password", active: false });
        }
      }
    };
    proc.on("error", cleanup);
    proc.on("exit", cleanup);
  }

  stop(): void {
    this.running = false;
    this.readyFlag = false;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    const proc = this.child;
    this.child = null;
    this.buffer = "";
    if (this.lastPassword) {
      this.lastPassword = false;
      this.onEvent({ type: "password", active: false });
    }
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch { /* ignore */ }
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      try { if (!proc.killed && proc.exitCode === null) proc.kill(); } catch { /* ignore */ }
    }, 250);
    this.killTimer.unref?.();
  }
}
