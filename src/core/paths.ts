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

/**
 * 原子写：先写同目录的临时文件再 rename。
 * 账本文件是「整份读、整份写」的，写到一半被杀进程就全没了。
 */
export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
