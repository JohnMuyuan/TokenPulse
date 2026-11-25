/**
 * 后端审计回归（Wave 3）：Antigravity 子系统（protobuf、摘要库、云端额度降级、OAuth 回环关闭、换号与额度槽隔离）。
 * 跑法：node scripts/test-audit-antigravity.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpulse-audit-w3-"));
process.env.HOME = process.env.USERPROFILE = path.join(root, "home");
process.env.TOKENPULSE_DATA_DIR = path.join(root, "data");
process.env.TOKENPULSE_ANTIGRAVITY_DIR = path.join(root, "agy-ide");
process.env.TOKENPULSE_ANTIGRAVITY_CLI_DIR = path.join(root, "agy-cli");

const { pbTime, pbDurationMs } = require("../build/core/protobuf-lite.js");
const { antigravitySummaries, readAntigravityGenerations, antigravitySwarmMeta } = require("../build/core/antigravity.js");
const { fetchAntigravityCloudStatus, writeAgyAccountStore } = require("../build/core/antigravity-accounts.js");
const { decodeDarwinKeyringOutput } = require("../build/core/antigravity-switch.js");
const { AntigravityQuota } = require("../build/main/antigravity-quota.js");

function encodeVarintBig(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}
function encodeFieldVarint(fieldNo, val) {
  return Buffer.concat([encodeVarintBig((fieldNo << 3) | 0), encodeVarintBig(val)]);
}
function encodeFieldBytes(fieldNo, buf) {
  return Buffer.concat([encodeVarintBig((fieldNo << 3) | 2), encodeVarintBig(buf.length), buf]);
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS " + name);
  } catch (err) {
    failed += 1;
    console.error("FAIL " + name + ": " + (err && err.stack ? err.stack : err));
  }
}

(async () => {
  try {
    // 1. pbTime & pbDurationMs handle negative 64-bit two's-complement varints (Go zero time.Time{} & negative Duration)
    await check("pbTime and pbDurationMs decode negative 64-bit two's-complement varints as 0", () => {
      const goZeroTs = encodeFieldVarint(1, -62135596800n);
      assert.equal(pbTime(goZeroTs), 0, "Go zero time.Time{} must return 0");
      const negDur1 = encodeFieldVarint(1, -1n);
      const negDur2 = encodeFieldVarint(2, -500_000_000n);
      assert.equal(pbDurationMs(negDur1), 0, "negative seconds duration clamps to 0");
      assert.equal(pbDurationMs(negDur2), 0, "negative nanos duration clamps to 0");
      // Positive timestamps & durations still work accurately
      const posTs = Buffer.concat([encodeFieldVarint(1, 1762400000n), encodeFieldVarint(2, 250_000_000n)]);
      assert.equal(pbTime(posTs), 1762400000250);
      const posDur = Buffer.concat([encodeFieldVarint(1, 2n), encodeFieldVarint(2, 500_000_000n)]);
      assert.equal(pbDurationMs(posDur), 2500);
    });

    // 2. antigravitySummaries returns null (not empty Map) when conversation_summaries table query throws
    await check("antigravitySummaries returns null when SQLite query fails", () => {
      const dir = path.join(root, "bad-sum");
      fs.mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(path.join(dir, "conversation_summaries.db"));
      db.exec("CREATE TABLE other_table (id TEXT)");
      db.close();
      const res = antigravitySummaries([dir]);
      assert.equal(res, null, "failed query must return null, not empty Map");
    });

    // 3. readAntigravityGenerations guards startAt > 0 so totalMs is not epoch ms
    await check("readAntigravityGenerations does not compute epoch-scale totalMs when startAt is 0", () => {
      const dbFile = path.join(root, "conv-nostart.db");
      const db = new DatabaseSync(dbFile);
      db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)");
      db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
      const usage = Buffer.concat([
        encodeFieldVarint(1, 1001n),
        encodeFieldVarint(2, 500n),
        encodeFieldVarint(3, 100n),
      ]);
      // metadata: NO field 1 (startAt=0), field 7 (finishedAt = 1762400000s), field 9 (usage), field 20 (genInfo with idx=0)
      const finishedTs = encodeFieldVarint(1, 1762400000n);
      const genInfo = encodeFieldVarint(3, 0n);
      const meta = Buffer.concat([
        encodeFieldBytes(7, finishedTs),
        encodeFieldBytes(9, usage),
        encodeFieldBytes(20, genInfo),
      ]);
      // gen_metadata: field 1 (request) -> field 11 (ttft Duration = 1s), NO streamingMs (field 12)
      const genData = encodeFieldBytes(1, encodeFieldBytes(11, encodeFieldVarint(1, 1n)));
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (0, ?)").run(genData);
      db.prepare("INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 15, 3, ?, NULL)").run(meta);
      db.close();
      const res = readAntigravityGenerations(dbFile, 0, {});
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].totalMs, 1000, "totalMs falls back to rawFirstTokenMs (1000ms), not epoch ms");
    });

    // 4. antigravitySwarmMeta handles mixed-case filterRoots
    await check("antigravitySwarmMeta matches mixed-case filterRoots", () => {
      const dir = path.join(root, "swarm-case");
      const bid = "AbCd-1234";
      const swDir = path.join(dir, "brain", bid, ".system_generated", "swarm");
      fs.mkdirSync(swDir, { recursive: true });
      fs.writeFileSync(path.join(swDir, "members.json"), JSON.stringify({ title: "MySwarm", members: [{ name: "w1", conversation_id: "w-1" }] }));
      const meta = antigravitySwarmMeta([dir], new Set([bid]));
      assert.ok(meta.swarmsByCoordinator.has(bid.toLowerCase()), "mixed-case filterRoots matched");
    });

    // 5. fetchAntigravityCloudStatus falls back to second endpoint when first returns 503 on fetchAvailableModels & retrieveUserQuotaSummary
    await check("fetchAntigravityCloudStatus falls back when fetchAvailableModels fails with 503 instead of returning empty groups", async () => {
      const calls = [];
      const res = await fetchAntigravityCloudStatus(
        { token: "tok", expiresAt: Date.now() + 3600_000 },
        {
          postJson: async (url) => {
            calls.push(url);
            if (url.includes("daily-cloudcode-pa")) {
              if (url.includes("loadCodeAssist")) return { status: 200, json: { currentTier: { id: "g1-pro-tier", name: "Google AI Pro" } } };
              return { status: 503, json: null };
            }
            if (url.includes("loadCodeAssist")) return { status: 200, json: { currentTier: { id: "g1-pro-tier", name: "Google AI Pro" } } };
            if (url.includes("fetchAvailableModels")) {
              return {
                status: 200,
                json: {
                  models: {
                    "gemini-3-pro": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.75, resetTime: "2026-10-12T00:00:00Z" } },
                  },
                },
              };
            }
            return { status: 200, json: {} };
          },
        },
      );
      assert.ok(calls.some((u) => u.includes("cloudcode-pa.googleapis.com") && !u.includes("daily-")), "tried fallback endpoint");
      assert.equal(res.status.groups.length, 1, "recovered real quota group from fallback");
      assert.equal(res.status.groups[0].used, 25);
    });

    // 6. decodeDarwinKeyringOutput decodes hex-encoded macOS Keychain JSON
    await check("decodeDarwinKeyringOutput decodes hex output from macOS security -w", () => {
      const json = JSON.stringify({ token: { access_token: "a", refresh_token: "r" }, id_token_email: "alice@example.com" }, null, 2) + "\n";
      const hex = Buffer.from(json, "utf8").toString("hex") + "\n";
      assert.equal(decodeDarwinKeyringOutput(hex), json);
      assert.equal(decodeDarwinKeyringOutput(json), json.replace(/\n$/, ""));
    });

    // 7. AntigravityQuota: timeline/speed must not let non-owner steal legacy history, forgetAccount clears top-level stored, pickPct does not fall back to 5h used on week timeline, timeline uses targetAcc for soloMode
    await check("AntigravityQuota isolates legacy history on timeline/speed, clears top-level on forgetAccount, and skips missing weekUsed", async () => {
      const now = Date.UTC(2026, 9, 10, 12, 0, 0);
      const reset5 = new Date(now + 4 * 3600_000).toISOString();
      const resetW = new Date(now + 5 * 86400_000).toISOString();
      // Seed legacy zero-config history belonging to Account A (recorded in login timeline)
      fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "antigravity-logins.json"), JSON.stringify({
        version: 1,
        spans: [{ id: "antigravity:a", email: "a@example.com", from: now - 86400_000, to: now }],
      }));
      fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, "antigravity-quota.json"), JSON.stringify({
        last: {
          at: now - 60_000, ok: true, plan: "Ultra",
          groups: [{ key: "g1", title: "Gemini Models", models: ["Gemini 3 Pro"], used: 80, resetAt: reset5, week: { used: 12, resetAt: resetW } }],
        },
        history: [
          { at: now - 3600_000, groups: [{ key: "g1", title: "Gemini Models", models: ["Gemini 3 Pro"], used: 75, resetAt: reset5, weekUsed: 10, weekResetAt: resetW }] },
          { at: now - 1800_000, groups: [{ key: "g1", title: "Gemini Models", models: ["Gemini 3 Pro"], used: 85, resetAt: reset5 }] }, // weekUsed missing!
          { at: now - 60_000, groups: [{ key: "g1", title: "Gemini Models", models: ["Gemini 3 Pro"], used: 80, resetAt: reset5, weekUsed: 12, weekResetAt: resetW }] },
        ],
        notified: {},
      }));
      // Register B BEFORE A
      writeAgyAccountStore({
        version: 1,
        accounts: [
          { id: "antigravity:b", ref: "b", email: "b@example.com", label: "B", createdAt: now, lastSeenAt: now },
          { id: "antigravity:a", ref: "a", email: "a@example.com", label: "A", shareMode: "solo", createdAt: now, lastSeenAt: now },
        ],
        removed: [],
      });
      const q = new AntigravityQuota({ now: () => now, fetcher: async () => null });
      // Calling speed() or timeline() for A must NOT let B steal legacy history!
      q.speed(7, "antigravity:a");
      const tlA = q.timeline({ accountId: "antigravity:a" });
      const st = q.state();
      const accB = st.accounts.find((a) => a.id === "antigravity:b");
      const accA = st.accounts.find((a) => a.id === "antigravity:a");
      assert.equal(accB.last ?? null, null, "Account B must NOT steal Account A's legacy history");
      assert.equal(accA.last && accA.last.plan, "Ultra", "Account A keeps its legacy history");

      // Weekly timeline track must NOT plot 85% (5h used) when weekUsed was absent!
      const weekWin = tlA["g0-week"];
      assert.ok(weekWin, "weekly timeline exists");
      assert.ok(weekWin.track.every((pt) => pt.pct < 50), "weekly track must skip sample missing weekUsed (got: " + JSON.stringify(weekWin.track) + ")");

      // Purging both accounts clears top-level stored.last / stored.history so a new Account C never inherits A's Ultra data
      writeAgyAccountStore({ version: 1, accounts: [], removed: ["antigravity:a", "antigravity:b"] });
      q.forgetAccount("antigravity:a");
      q.forgetAccount("antigravity:b");
      assert.equal(q.state().last ?? null, null, "top-level stored.last cleared when all accounts purged");
      q.stop();
    });

    console.log(`\nWave 3: ${passed}/${passed + failed} passed`);
    if (failed > 0) process.exit(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
