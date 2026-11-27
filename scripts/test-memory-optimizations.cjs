const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('desk-pet-input compiles and runs lightweight native C# COM helper on Windows', async () => {
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-mem-input-'));
  const prev = process.env.TOKENPULSE_DATA_DIR;
  process.env.TOKENPULSE_DATA_DIR = dir;
  try {
    const mod = require('../build/main/desk-pet-input.js');
    const exe1 = await mod.ensureNativeHelperExe();
    assert.ok(exe1 && fs.existsSync(exe1), '应成功编译并缓存原生 C# COM 监听程序');
    assert.ok(exe1.startsWith(path.join(dir, 'bin')), '缓存位置应在数据目录 bin/ 下');
    const t0 = Date.now();
    const exe2 = await mod.ensureNativeHelperExe();
    assert.equal(exe2, exe1, '第二次调用应直接命中缓存');
    assert.ok(Date.now() - t0 < 200, '命中缓存应瞬时返回');

    const events = [];
    const monitor = new mod.DeskPetInputMonitor((ev) => events.push(ev));
    monitor.start();
    try {
      const deadline = Date.now() + 8000;
      while (!monitor.ready && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(monitor.ready, true, '原生监听进程应输出 ready 握手');
      assert.equal(monitor.active, true);
    } finally {
      monitor.stop();
    }
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(monitor.active, false, 'stop() 后监听进程应立即退出并重置状态');
  } finally {
    if (prev === undefined) delete process.env.TOKENPULSE_DATA_DIR;
    else process.env.TOKENPULSE_DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('request-log pre-filtering, skipSessionMeta and clearRequestLogCaches preserve exact query results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-mem-req-'));
  const prev = process.env.TOKENPULSE_DATA_DIR;
  process.env.TOKENPULSE_DATA_DIR = dir;
  try {
    const reqDir = path.join(dir, 'requests');
    fs.mkdirSync(reqDir, { recursive: true });
    const tOld = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const tNew = new Date(2026, 10, 25, 12, 0, 0).getTime();
    fs.writeFileSync(
      path.join(dir, 'usage-rollups.json'),
      JSON.stringify({
        version: 1,
        files: {
          'f-claude': { kind: 'claude-code', official: true, days: {} },
          'f-agy': { kind: 'antigravity', official: true, days: {} },
        },
      }),
    );
    fs.writeFileSync(
      path.join(reqDir, '2026-11.jsonl'),
      [
        { id: 'c-old', at: tOld, kind: 'claude-code', file: 'f-claude', model: 'claude-sonnet-4-6', input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01, calls: 1 },
        { id: 'c-new', at: tNew, kind: 'claude-code', file: 'f-claude', model: 'claude-sonnet-4-6', input: 200, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.02, calls: 1 },
        // 重放覆盖同一键：只应保留后写值
        { id: 'c-new', at: tNew, kind: 'claude-code', file: 'f-claude', model: 'claude-sonnet-4-6', input: 500, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.05, calls: 1 },
        { id: 'a-new', at: tNew, kind: 'antigravity', file: 'f-agy', model: 'gemini-3-pro', input: 300, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.03, calls: 1 },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const { queryRequests, clearRequestLogCaches } = require('../build/core/request-log.js');
    clearRequestLogCaches();

    const agyRes = queryRequests({
      from: '2026-11-20',
      to: '2026-11-26',
      source: 'Antigravity',
      status: 'all',
      search: '',
      sort: 'time',
      page: 0,
      pageSize: 10,
      all: true,
      skipSessionMeta: true,
    });
    assert.equal(agyRes.rows.length, 1);
    assert.equal(agyRes.rows[0].model, 'gemini-3-pro');

    const weekRes = queryRequests({
      from: '2026-11-20',
      to: '2026-11-26',
      source: 'all',
      status: 'all',
      search: '',
      sort: 'time',
      page: 0,
      pageSize: 10,
      skipSessionMeta: true,
    });
    assert.equal(weekRes.total, 2);
    const claudeRow = weekRes.rows.find((r) => r.source === 'Claude Code');
    assert.equal(claudeRow.input, 500, '同月重放记录应保留后写值');
    clearRequestLogCaches();
  } finally {
    if (prev === undefined) delete process.env.TOKENPULSE_DATA_DIR;
    else process.env.TOKENPULSE_DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AntigravityQuota lightPetAccounts, trimMemory and background hasListener skip full JSONL scan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-mem-agy-'));
  const agyDir = path.join(dir, 'agy');
  fs.mkdirSync(agyDir, { recursive: true });
  const prevData = process.env.TOKENPULSE_DATA_DIR;
  const prevAgy = process.env.TOKENPULSE_ANTIGRAVITY_DIR;
  process.env.TOKENPULSE_DATA_DIR = dir;
  process.env.TOKENPULSE_ANTIGRAVITY_DIR = agyDir;
  try {
    const now = Date.now();
    const resetIso = new Date(now + 3 * 3600_000).toISOString();
    const weekIso = new Date(now + 4 * 86400_000).toISOString();
    fs.writeFileSync(
      path.join(dir, 'antigravity-quota.json'),
      JSON.stringify({
        last: {
          at: now - 60_000,
          ok: true,
          plan: 'Pro',
          groups: [
            { key: 'gemini-3-pro', title: 'Gemini', models: ['gemini-3-pro'], used: 42, resetAt: resetIso, week: { used: 18, resetAt: weekIso } },
          ],
        },
        history: [],
        notified: {},
      }),
    );

    const { AntigravityQuota } = require('../build/main/antigravity-quota.js');
    let publishCalls = 0;
    let bgCalls = 0;
    let visible = false;
    const q = new AntigravityQuota({
      hasListener: () => visible,
      publish: () => { publishCalls++; },
      onBackgroundUpdated: () => { bgCalls++; },
      fetcher: async () => ({
        plan: 'Pro',
        groups: [{ title: 'Gemini', models: ['gemini-3-pro'], used: 55, resetAt: resetIso, week: { used: 22, resetAt: weekIso } }],
      }),
    });

    let recentRowsCalls = 0;
    const origRecentRows = q.recentRows.bind(q);
    q.recentRows = (...args) => { recentRowsCalls++; return origRecentRows(...args); };

    // lightPetAccounts 与 localAccountId 都不应触发 recentRows JSONL 扫描
    const light = q.lightPetAccounts();
    assert.equal(light.length, 1);
    assert.equal(light[0].five.used, 42);
    assert.equal(light[0].week.used, 18);
    assert.equal(typeof q.localAccountId(), 'string');
    assert.equal(recentRowsCalls, 0, '轻量托盘/桌宠查询不应扫描请求流水');

    // 窗口不可见时的后台定时刷新应走 onBackgroundUpdated，不触发 full state() 与 recentRows()
    await q.refresh(false);
    assert.equal(bgCalls, 1);
    assert.equal(publishCalls, 0);
    assert.equal(recentRowsCalls, 0, '后台不可见刷新不应同步扫描 30 天流水');
    assert.equal(q.lightPetAccounts()[0].five.used, 55);

    // 窗口可见后手动刷新才走完整 state() + publish
    visible = true;
    await q.refresh(true);
    assert.ok(publishCalls >= 1);
    assert.ok(recentRowsCalls >= 1);

    q.trimMemory();
    q.stop();
  } finally {
    if (prevData === undefined) delete process.env.TOKENPULSE_DATA_DIR;
    else process.env.TOKENPULSE_DATA_DIR = prevData;
    if (prevAgy === undefined) delete process.env.TOKENPULSE_ANTIGRAVITY_DIR;
    else process.env.TOKENPULSE_ANTIGRAVITY_DIR = prevAgy;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pet-sound auto-closes idle AudioContext and lazily re-decodes custom audio on next play', async () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet-sound.js'), 'utf8');
  let created = 0;
  let closed = 0;
  let decoded = 0;
  let playedBuffers = 0;
  class MockAudioContext {
    constructor() {
      created++;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    createGain() {
      return {
        gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
        connect() {},
      };
    }
    createOscillator() {
      return { type: 'sine', frequency: { value: 440 }, connect() {}, start() {}, stop() {} };
    }
    createBufferSource() {
      return { buffer: null, connect() {}, start() { playedBuffers++; }, stop() {} };
    }
    async decodeAudioData(buf) {
      decoded++;
      assert.ok(buf.byteLength > 0);
      return { duration: 0.4 };
    }
    async close() {
      this.state = 'closed';
      closed++;
    }
  }
  const sandbox = { AudioContext: MockAudioContext, setTimeout, clearTimeout };
  vm.runInNewContext(code, sandbox);
  const sound = sandbox.PulsePetSound;

  const ok = await sound.setCustom('done', new Uint8Array([1, 2, 3, 4]));
  assert.equal(ok, true);
  assert.equal(sound.hasCustom('done'), true);
  assert.equal(created, 1);
  assert.equal(decoded, 1);

  // 空闲关闭 AudioContext 后仍保留 hasCustom 状态
  sound.closeIdle();
  assert.equal(closed, 1, '应关闭空闲 AudioContext 释放 AudioService 进程');
  assert.equal(sound.hasCustom('done'), true, '关闭 AudioContext 后仍应保留自定义音频标记');

  // 再次播放时按需重建 AudioContext 并从原始字节解码播放
  assert.equal(sound.play('done', 0.6), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(created, 2, '再次播放应按需重建 AudioContext');
  assert.equal(decoded, 2, '应按需重新解码自定义音频');
  assert.equal(playedBuffers, 1, '重建后应正常播放自定义音频');
  sound.closeIdle();
});

test('i18n skips building EN dictionary and regex patterns in Chinese mode until needed', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'i18n.js'), 'utf8');
  const zhSandbox = {
    localStorage: { getItem: () => 'zh' },
    navigator: { language: 'zh-CN' },
    document: { body: { hasAttribute: () => false }, documentElement: {} },
  };
  zhSandbox.window = zhSandbox;
  vm.runInNewContext(code, zhSandbox);
  assert.equal(zhSandbox.PulseI18n.lang(), 'zh');
  assert.equal(zhSandbox.PulseI18n._loaded(), false, '中文模式下不应预构建 4000+ 条英文词典和正则表');

  // 显式翻译时再懒构建
  assert.equal(zhSandbox.PulseI18n.t('总览'), 'Overview');
  assert.equal(zhSandbox.PulseI18n._loaded(), true);
});
