/**
 * 会话全文搜索（0.3.55，core/session-search.ts）。跑法（先 npm run compile）：
 *
 *   node scripts/test-session-search.cjs
 *
 * 会话文件照 test-sessions.cjs 的格式在临时目录里造，不碰本机真实会话。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-session-search-"));
const claudeDir = path.join(root, "claude");
const codexDir = path.join(root, "codex");
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = codexDir;
process.env.GROK_HOME = path.join(root, "grok");
process.env.TOKENPULSE_DSH_HOME = path.join(root, "dsh");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); };
const project = path.join(root, "Demo");

const build = (file) => require(path.join(__dirname, "..", "build", ...file.split("/")));
const { searchSessions, searchTerms } = build("core/session-search.js");
const sessions = build("core/sessions.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const claudeFile = path.join(claudeDir, "projects", "D--Demo", "claude-1.jsonl");
write(claudeFile, [
  { type: "user", uuid: "u1", timestamp: "2026-09-24T10:00:00Z", sessionId: "claude-1", cwd: project, message: { content: "<system-reminder>webpack 别搜到我</system-reminder>帮我改一下 Webpack 配置" } },
  { type: "assistant", uuid: "a1", timestamp: "2026-09-24T10:00:02Z", message: { id: "msg_1", model: "claude-opus-5", content: [{ type: "text", text: "好的，先看看 webpack.config.js。" }] } },
  { type: "assistant", uuid: "a2", timestamp: "2026-09-24T10:00:03Z", message: { id: "msg_2", model: "claude-opus-5", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "D:\\Demo\\webpack.config.js" } }] } },
  { type: "user", uuid: "u2", timestamp: "2026-09-24T10:00:04Z", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "module.exports = { secretOutputOnly: true }" }] } },
  { type: "assistant", uuid: "a3", timestamp: "2026-09-24T10:00:06Z", message: { id: "msg_3", model: "claude-opus-5", content: [{ type: "text", text: "改好了，打包速度会快一些。" }] } },
]);
const codexFile = path.join(codexDir, "sessions", "2026", "09", "25", "rollout-2026-09-25T11-00-00-codex-1.jsonl");
write(codexFile, [
  { type: "session_meta", timestamp: "2026-09-25T11:00:00Z", payload: { id: "codex-1", cwd: project } },
  { type: "response_item", timestamp: "2026-09-25T11:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "数据库迁移脚本报错了" }] } },
  { type: "response_item", timestamp: "2026-09-25T11:00:04Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "是 migration 里少了一列。" + "很长的解释".repeat(60) }] } },
]);

(async () => {
  try {
    check("搜索词：按空白切开、去重、转小写", JSON.stringify(searchTerms("  WebPack  配置 webpack ")) === JSON.stringify(["webpack", "配置"]));
    check("太短的词不搜", searchSessions("a").hits.length === 0 && searchSessions("   ").hits.length === 0);

    let result = searchSessions("WEBPACK");
    const hit = result.hits[0];
    check("不分大小写，搜到 Claude 会话", result.hits.length === 1 && hit.key === "claude:claude-1" && hit.kind === "claude", JSON.stringify(result.hits.map((h) => h.key)));
    check("第一次搜索：把两段会话抽成文字", result.indexed === 2, String(result.indexed));
    check("用户、AI 和工具调用的概要都搜得到：3 处", hit.count === 3 && hit.ids.length === 3, JSON.stringify(hit));
    check("CLI 塞进去的 <system-reminder> 不算", !hit.snippets.some((s) => /别搜到我/.test(s.text)));
    check("工具的输出不进搜索", searchSessions("secretOutputOnly").hits.length === 0);
    check("片段带角色", hit.snippets.map((s) => s.role).join(",") === "user,assistant,tool", hit.snippets.map((s) => s.role).join(","));

    const detail = sessions.getSession("claude", "claude-1");
    check("命中的消息 id 和打开详情时的一致（能直接跳过去）", hit.ids.every((id) => detail.messages.some((m) => m.id === id)));

    check("几个词：都要在同一段会话里出现（不必同一条）", searchSessions("webpack 打包速度").hits.length === 1 && searchSessions("webpack 迁移").hits.length === 0);
    result = searchSessions("migration");
    check("搜到 Codex 会话，长消息的片段截短、两头加省略号", result.hits[0]?.key === "codex:codex-1" && result.hits[0].snippets[0].text.length < 170 && result.hits[0].snippets[0].text.endsWith("…"), result.hits[0]?.snippets[0]?.text);
    check("按工具筛选", searchSessions("webpack", "codex").hits.length === 0 && searchSessions("migration", "codex").hits.length === 1);
    check("第二次搜索不再重抽", searchSessions("webpack").indexed === 0);
    check("角色名和消息 ID 不算正文命中", searchSessions("assistant").hits.length === 0 && searchSessions("m0").hits.length === 0);
    check("多词搜索不能用角色名凑齐条件", searchSessions("webpack assistant").hits.length === 0);
    const cacheIndex = path.join(process.env.TOKENPULSE_DATA_DIR, "session-text", "index.json");
    for (const files of [null, [], "broken"]) {
      fs.writeFileSync(cacheIndex, JSON.stringify({ version: 1, files }));
      let recovered = false;
      try { recovered = searchSessions("webpack").hits.length === 1; } catch {}
      check(`损坏的缓存索引自动重建：${JSON.stringify(files)}`, recovered);
    }
    fs.rmSync(cacheIndex, { force: true });
    const resumed = path.join(codexDir, "sessions", "2026", "09", "26", "rollout-resumed.jsonl");
    write(resumed, [
      { type: "session_meta", timestamp: "2026-09-26T11:00:00Z", payload: { id: "codex-1", cwd: project } },
      { type: "response_item", timestamp: "2026-09-26T11:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续检查新的内容" }] } },
    ]);
    check("续接会话只搜详情实际打开的文件，避免无法跳转的旧命中", searchSessions("migration").hits.length === 0);
    fs.rmSync(resumed);
    check("移除续接文件后可以搜索剩下的原会话", searchSessions("migration").hits.length === 1);

    // 会话里新说了一句：只重抽这一个文件
    fs.appendFileSync(claudeFile, JSON.stringify({ type: "user", uuid: "u3", timestamp: "2026-09-24T10:05:00Z", message: { content: "再加一个 vite 的版本" } }) + "\n");
    result = searchSessions("vite");
    check("会话文件变了：只重抽它，新内容能搜到", result.indexed === 1 && result.hits[0]?.key === "claude:claude-1");

    // 缓存里只有文字，没有工具输出；会话删了，缓存的文字也删
    const textFile = sessions.sessionTextFile(claudeFile);
    check("缓存的文字在数据目录里", fs.existsSync(textFile) && textFile.startsWith(process.env.TOKENPULSE_DATA_DIR) && !fs.readFileSync(textFile, "utf8").includes("secretOutputOnly"));
    sessions.deleteLocalSessionFiles("claude", "claude-1");
    check("删除对话时缓存的文字一起删", !fs.existsSync(textFile) && searchSessions("webpack").hits.length === 0);
    const codexText = sessions.sessionTextFile(codexFile);
    fs.rmSync(codexFile);
    searchSessions("migration");
    check("会话在 CLI 里被删掉：下次搜索时清掉缓存", !fs.existsSync(codexText));
  } catch (error) {
    console.error(error);
    results.push(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 通过`);
  assert.equal(passed, results.length, "session search regression failed");
})();
