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
      if (!response.ok) {
        const error = friendly(null, response.status);
        writeKnowledgeCheck({ checkedAt, error });
        return { ...knowledgeInfo(), checkedAt, error };
      }
      // 限个大小：正常的知识库几 KB
      const body = await response.text();
      if (body.length > 1024 * 1024) throw new Error("知识库文件太大");
      const result = acceptKnowledge(JSON.parse(body));
      writeKnowledgeCheck({ checkedAt, error: result.error });
      if (result.updated) onUpdated?.();
      return { ...result.info, checkedAt, error: result.error, updated: result.updated };
    } catch (error) {
      const message = error instanceof SyntaxError ? "知识库格式不对，已忽略" : friendly(error);
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
