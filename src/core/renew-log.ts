import { createHash } from "crypto";
import fs from "fs";
import { dataFile } from "./paths";

/**
 * 续期日志（0.3.54）：`~/.tokenpulse/renew-log.jsonl`，一行一次续期尝试。
 *
 * 以前续期失败只在账号上记一句「HTTP 400」，重新登录后连这句也清掉，事后查不出为什么过期。
 * 这里只记时间、哪家、账号 id 的哈希、谁的凭据（TokenPulse 存的 / CLI 文件里的）、结果、状态码和错误类型，
 * **不记 token、邮箱和官方返回的说明文字**。超过 MAX_LINES 行时只留最近的一半。
 */
export type RenewLogEntry = {
  at: number;
  kind: string;
  /** 账号 id 的 sha256 前 12 位。 */
  account: string;
  /** stored：TokenPulse 保存的凭据；cli：CLI 凭据文件里的（Claude Code 没在运行时代它续）。 */
  source: "stored" | "cli";
  ok: boolean;
  status?: number;
  code?: string;
  error?: string;
  permanent?: boolean;
  /** 补充说明：判死的原因、为什么没写回等。 */
  note?: string;
};

const MAX_LINES = 1000;

export function renewLogFile() {
  return dataFile("renew-log.jsonl");
}

export function accountHash(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

export function logRenew(entry: Omit<RenewLogEntry, "account"> & { accountId: string }) {
  const { accountId, ...rest } = entry;
  const row: RenewLogEntry = { ...rest, account: accountHash(accountId) };
  if (row.error) row.error = row.error.slice(0, 160);
  try {
    const file = renewLogFile();
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) fs.writeFileSync(file, lines.slice(-MAX_LINES / 2).join("\n") + "\n");
  } catch {
    // 日志写不了不影响续期本身
  }
}

export function readRenewLog(limit = 200): RenewLogEntry[] {
  try {
    return fs
      .readFileSync(renewLogFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try { return [JSON.parse(line) as RenewLogEntry]; } catch { return []; }
      });
  } catch {
    return [];
  }
}
