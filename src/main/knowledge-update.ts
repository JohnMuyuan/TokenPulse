import { errorText, log, logUrl } from "../core/app-log";
import { net } from "electron";
import { acceptKnowledge, KNOWLEDGE_URL, knowledgeInfo, readKnowledgeCheck, writeKnowledgeCheck, type KnowledgeInfo } from "../core/knowledge";

/**
 * 从 GitHub 拉最新的模型知识库（knowledge/models.json）。
 * 启动 5 分钟后查一次、之后每天一次；设置 → 关于里也能手动查。
 * 用 Electron 的 net.fetch：走系统代理，和浏览器一样能连上 GitHub。
 */

export type KnowledgeState = KnowledgeInfo & { checkedAt?: number; error?: string; updated?: boolean };

const FIRST_CHECK_MS = 5 * 60_000;
const CHECK_EVERY_MS = 24 * 60 * 60_000;
let checking: Promise<KnowledgeState> | null = null;

export function knowledgeState(): KnowledgeState {
  return { ...knowledgeInfo(), ...readKnowledgeCheck() };
}

function friendly(error: unknown, status?: number) {
  if (status === 404) return "GitHub 上还没有更新的知识库";
  if (status && status >= 500) return "GitHub 暂时不可用，稍后再试";
  const text = String((error as Error)?.message || error || "");
  if (/abort|timeout/i.test(text)) return "连接 GitHub 超时，稍后再试";
  if (/net::|ENOTFOUND|ECONN|network/i.test(text)) return "网络不通，稍后再试";
  return "检查知识库失败，稍后再试";
}

/** onUpdated：拿到了新知识库，需要重算一遍费用。 */
export function checkKnowledge(onUpdated?: () => void): Promise<KnowledgeState> {
  if (checking) return checking;
  checking = (async () => {
    const checkedAt = Date.now();
    try {
      const response = await net.fetch(`${KNOWLEDGE_URL}?t=${checkedAt}`, { signal: AbortSignal.timeout(20_000), headers: { "Cache-Control": "no-cache" } });
      log[response.ok ? "info" : "warn"]("net", `GET ${logUrl(KNOWLEDGE_URL)} → ${response.status}（知识库，${Date.now() - checkedAt} ms）`);
      if (!response.ok) {
        const error = friendly(null, response.status);
        writeKnowledgeCheck({ checkedAt, error });
        return { ...knowledgeInfo(), checkedAt, error };
      }
      // 流式限流 1 MiB：避免超大响应先整段缓冲进内存再拒
      const MAX_BYTES = 1024 * 1024;
      const cl = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(cl) && cl > MAX_BYTES) throw new Error("知识库文件太大");
      let body: string;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > MAX_BYTES) {
              await reader.cancel().catch(() => undefined);
              throw new Error("知识库文件太大");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        body = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
      } else {
        body = await response.text();
        if (Buffer.byteLength(body, "utf8") > MAX_BYTES) throw new Error("知识库文件太大");
      }
      const result = acceptKnowledge(JSON.parse(body));
      writeKnowledgeCheck({ checkedAt, error: result.error });
      if (result.updated) onUpdated?.();
      return { ...result.info, checkedAt, error: result.error, updated: result.updated };
    } catch (error) {
      const message = error instanceof SyntaxError ? "知识库格式不对，已忽略" : friendly(error);
      log.warn("net", `知识库更新失败：${message}（${errorText(error)}）`);
      writeKnowledgeCheck({ checkedAt, error: message });
      return { ...knowledgeInfo(), checkedAt, error: message };
    }
  })().finally(() => {
    checking = null;
  });
  return checking;
}

export function scheduleKnowledgeChecks(onUpdated: () => void) {
  setTimeout(() => void checkKnowledge(onUpdated), FIRST_CHECK_MS);
  setInterval(() => void checkKnowledge(onUpdated), CHECK_EVERY_MS);
}
