import { threadId } from "worker_threads";
import fs from "fs";
import os from "os";
import path from "path";

/** 所有数据都落在这里。环境变量可以改，方便测试时用临时目录。 */
export function dataDir() {
  return process.env.TOKENPULSE_DATA_DIR || path.join(os.homedir(), ".tokenpulse");
}

export function dataFile(name: string) {
  return path.join(dataDir(), name);
}

/** pi 官方目录覆盖；测试也沿用供应商模块的隔离主目录。 */
export function piDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(process.env.AGENT_SWITCH_HOME || os.homedir(), ".pi", "agent");
}

/** pi 会话目录：支持 PI_CODING_AGENT_SESSION_DIR 独立覆盖，否则位于 piDir()/sessions。 */
export function piSessionsDir() {
  return process.env.PI_CODING_AGENT_SESSION_DIR || path.join(piDir(), "sessions");
}

export function dshRoot() {
  return process.env.TOKENPULSE_DSH_HOME || path.join(os.homedir(), ".dsh");
}

/**
 * 原子写：先写同目录的临时文件再 rename。
 * 账本文件是「整份读、整份写」的，写到一半被杀进程就全没了。
 */
export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 几个 worker 线程共用一个 pid（比如扫描顺手预热会话索引时，用户正好打开会话页），临时文件名要带上线程号
  const tmp = `${file}.${process.pid}.${threadId}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 4) {
          if (code !== "EBUSY") {
            try { fs.chmodSync(file, 0o600); } catch { /* 忽略 */ }
          }
          // Windows 杀软/索引器或并发读句柄的瞬时占用：短暂退避重试
          const waitUntil = Date.now() + 15 * (attempt + 1);
          while (Date.now() < waitUntil) { /* short backoff */ }
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理尽力而为 */ }
    throw error;
  }
}

/** 我们自己原子写留下的临时文件名：`<文件>.<pid>.<线程号>.tmp`（writeJson、请求流水、会话索引）、`<文件>.<pid>.tmp`（路由日志）、`.health-<pid>.tmp`。 */
const OWN_TEMP = /(\.\d+(\.\d+)?\.tmp|^\.health-\d+\.tmp)$/i;
/** 原子写会落临时文件的目录（数据目录本身 + 这几个子目录）。 */
const TEMP_DIRS = ["", "requests", "session-text"];

/**
 * 清理数据目录里遗留的临时文件（0.4.7）。正常写完会 rename 掉、失败会删掉，但写到一半进程被杀、断电，或老版本留下的
 * 不会有人收拾：用户反馈 ~/.tokenpulse 里攒了几十个 usage-rollups.json.<pid>.<线程>.tmp（共 20 MB+）。
 * 只删文件名符合上面格式、一天以前的普通文件（正在写的临时文件只存在几毫秒，不会被误删）；删不掉的跳过，下次启动再试。
 */
export function cleanStaleTempFiles(root = dataDir(), maxAgeMs = 86_400_000, now = Date.now()): { removed: number; bytes: number } {
  let removed = 0, bytes = 0;
  for (const sub of TEMP_DIRS) {
    const dir = sub ? path.join(root, sub) : root;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !OWN_TEMP.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs < maxAgeMs) continue;
        fs.rmSync(file, { force: true });
        removed += 1;
        bytes += stat.size;
      } catch { /* 被占用或权限不够：下次启动再试 */ }
    }
  }
  return { removed, bytes };
}

/*
 * 用户选的文件复制进数据目录：Windows 上 copyFile 会把「只读」属性一起带过来（比如从压缩包、网盘、
 * 别人共享的文件夹里选的文件），之后删除或覆盖这份副本就报 EPERM。复制后把副本改回可写；
 * 目标已经是只读的旧副本时先改可写再覆盖。
 */
export function copyIntoData(source: string, target: string) {
  try { fs.chmodSync(target, 0o600); } catch { /* 目标还不存在 */ }
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
}

/** 删数据目录里自己的文件 / 文件夹。碰到只读（旧版本复制进来的）先改可写再删，其他错误照常抛出。 */
export function removeFromData(target: string) {
  try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
  }
  const writable = (item: string) => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(item); } catch { return; }
    if (stat.isSymbolicLink()) return;
    try { fs.chmodSync(item, stat.isDirectory() ? 0o777 : 0o666); } catch { /* 改不了就让下面的 rmSync 报原来的错 */ }
    if (stat.isDirectory()) for (const name of fs.readdirSync(item)) writable(path.join(item, name));
  };
  writable(target);
  fs.rmSync(target, { recursive: true, force: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    // 别的工具（PowerShell 的 Set-Content -Encoding UTF8、记事本）存成带 BOM 的 UTF-8 时照样读：
    // 读不出来会被当成「没有这份数据」，之后一次写入就把整份文件（账号库、供应商、设置）覆盖掉
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return fallback;
  }
}
