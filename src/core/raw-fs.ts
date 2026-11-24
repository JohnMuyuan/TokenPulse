import fs from "fs";
import path from "path";

/**
 * 在 Electron 运行时获取未打 ASAR 虚拟文件系统补丁的原始 `fs`（`original-fs`）。
 *
 * 背景：Electron 的默认 `fs` 会把任何 `.asar` 路径交给内部 `asar-fs-wrapper`，
 * 首次调用 `existsSync` / `statSync` 等就会打开原生 `asar::Archive` 文件句柄并永久缓存在
 * 进程全局 `cachedArchives` 中，直到进程退出才释放。访问其他软件（如 Antigravity、
 * DeepSeek Harness）安装目录里的 `resources/app.asar` 时，这会导致它们在 Windows 上
 * 覆盖升级报 `ERROR_SHARING_VIOLATION` / `EBUSY`。
 *
 * 通过 `original-fs` 直接操作操作系统文件，既不影响 TokenPulse 自身 `app.asar` 的正常加载
 * （避免修改全局 `process.noAsar`），又能确保每次只读打开后在 `finally` 立即关闭句柄。
 */
let cachedRawFs: typeof fs | null = null;

export function getRawFs(): typeof fs {
  if (cachedRawFs) return cachedRawFs;
  const versions = process.versions as Record<string, string | undefined>;
  if (versions?.electron) {
    try {
      cachedRawFs = require("original-fs") as typeof fs;
      return cachedRawFs;
    } catch {
      /* 非完整 Electron 环境时回退到标准 fs */
    }
  }
  cachedRawFs = fs;
  return cachedRawFs;
}

const MAX_ASAR_HEADER_BYTES = 32 * 1024 * 1024;

function readExact(rawFs: typeof fs, fd: number, length: number, startPos: number): Buffer | null {
  const buf = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const n = rawFs.readSync(fd, buf, offset, length - offset, startPos + offset);
    if (n <= 0) return null;
    offset += n;
  }
  return buf;
}

/**
 * 使用 `original-fs` 只读解析 `.asar` 文件头 JSON，检查归档内是否存在指定文件。
 * 绝不触发 Electron 的 ASAR 缓存；如果路径本身是未打包目录则直接按普通文件检查。
 * 句柄严格限定在本次调用内，任何成功/失败路径都会在 `finally` 立即关闭。
 */
export function asarContainsFile(asarPath: string, innerPath: string): boolean {
  const segments = innerPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const rawFs = getRawFs();
  let fd: number | null = null;
  try {
    const stat = rawFs.statSync(asarPath);
    if (stat.isDirectory()) {
      try {
        return rawFs.statSync(path.join(asarPath, ...segments)).isFile();
      } catch {
        return false;
      }
    }
    if (!stat.isFile() || stat.size < 16) return false;

    fd = rawFs.openSync(asarPath, "r");
    const fstat = rawFs.fstatSync(fd);
    if (!fstat.isFile() || fstat.size < 16) return false;

    const prefix = readExact(rawFs, fd, 16, 0);
    if (!prefix) return false;
    const sizePicklePayload = prefix.readUInt32LE(0);
    const headerPickleSize = prefix.readUInt32LE(4);
    const headerPicklePayload = prefix.readUInt32LE(8);
    const jsonLen = prefix.readUInt32LE(12);
    if (
      sizePicklePayload !== 4 ||
      headerPickleSize < 8 ||
      headerPicklePayload < 4 ||
      jsonLen <= 0 ||
      jsonLen > headerPicklePayload ||
      jsonLen > MAX_ASAR_HEADER_BYTES ||
      16 + jsonLen > fstat.size
    ) {
      return false;
    }

    const jsonBuf = readExact(rawFs, fd, jsonLen, 16);
    if (!jsonBuf) return false;
    const header = JSON.parse(jsonBuf.toString("utf8")) as { files?: Record<string, unknown> } | null;
    if (!header || typeof header !== "object") return false;

    let node: Record<string, unknown> = header as Record<string, unknown>;
    for (const seg of segments) {
      const files = node.files;
      if (!files || typeof files !== "object") return false;
      const next = (files as Record<string, unknown>)[seg];
      if (!next || typeof next !== "object") return false;
      node = next as Record<string, unknown>;
    }
    return !("files" in node);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        rawFs.closeSync(fd);
      } catch { /* ignore */ }
    }
  }
}
