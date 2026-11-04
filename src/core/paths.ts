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

/**
 * 原子写：先写同目录的临时文件再 rename。
 * 账本文件是「整份读、整份写」的，写到一半被杀进程就全没了。
 */
export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 几个 worker 线程共用一个 pid（比如扫描顺手预热会话索引时，用户正好打开会话页），临时文件名要带上线程号
  const tmp = `${file}.${process.pid}.${threadId}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/*
 * 用户选的文件复制进数据目录：Windows 上 copyFile 会把「只读」属性一起带过来（比如从压缩包、网盘、
 * 别人共享的文件夹里选的文件），之后删除或覆盖这份副本就报 EPERM。复制后把副本改回可写；
 * 目标已经是只读的旧副本时先改可写再覆盖。
 */
export function copyIntoData(source: string, target: string) {
  try { fs.chmodSync(target, 0o666); } catch { /* 目标还不存在 */ }
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o666);
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
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
