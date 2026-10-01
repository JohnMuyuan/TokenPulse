/*
 * 0.3.15：TokenPulse 写出的工具配置必须是工具自己读得进去的。
 * 起因：切到第三方后 Codex 桌面端显示「无法加载登录要求」（读 config.toml 失败）——
 *   ① 模型目录 tokenpulse-model-catalog.json 缺 Codex 0.159 起必填的字段；
 *   ② 切回官方 / 关掉路由后留下空的 [model_providers.tokenpulse_route]（provider name must not be empty）；
 *   ③ 每切换一次多留几个空行。
 * 覆盖：TOML 删键连整行删、空的自有表整张删；目录必填字段；来回切换文件不变长；启动修复；只读保护下不写；
 * 本机装了 Codex 时用真实的 codex 可执行文件读一遍（没装就跳过）。只用临时目录，不碰真实配置。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const realLocalAppData = process.env.LOCALAPPDATA || '';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-compat-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
const home = path.join(root, 'home');
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_SWITCH_HOME = home;
process.env.AGENT_SWITCH_CC_DB = path.join(root, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];

const toml = require('../build/core/agent-toml');
const models = require('../build/core/agent-models');
const config = require('../build/core/agent-config');
const sw = require('../build/core/agent-switch');
const probe = require('../build/core/codex-probe');

const codexDir = path.join(home, '.codex'), codexFile = path.join(codexDir, 'config.toml'), catalogFile = path.join(codexDir, 'tokenpulse-model-catalog.json');
const grokFile = path.join(home, '.grok', 'config.toml');
const read = file => fs.readFileSync(file, 'utf8');
const freePort = () => new Promise(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };

// 本机的 Codex（桌面端自带的，或 TOKENPULSE_CODEX_EXE 指定的）：有就用它真读一遍配置
function findCodex() {
  if (process.env.TOKENPULSE_CODEX_EXE) return fs.existsSync(process.env.TOKENPULSE_CODEX_EXE) ? process.env.TOKENPULSE_CODEX_EXE : '';
  try {
    const bin = path.join(realLocalAppData, 'OpenAI', 'Codex', 'bin');
    return fs.readdirSync(bin).map(dir => path.join(bin, dir, 'codex.exe')).filter(file => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
  } catch { return ''; }
}
const codexExe = findCodex();
let liveChecks = 0;
function codexLoads(label) {
  if (!codexExe) return;
  const r = spawnSync(codexExe, ['features', 'list'], { env: { ...process.env, CODEX_HOME: codexDir }, encoding: 'utf8', timeout: 60000 });
  const err = (r.stderr || '').split(/\r?\n/).filter(line => line && !line.startsWith('WARNING')).join(' | ');
  assert.equal(r.status, 0, `真实的 Codex 读不了这份配置（${label}）：${err.slice(0, 400)}`);
  liveChecks++;
}

(async () => {
  try {
    /* ---------- TOML ---------- */
    {
      const lines = ['a = 1', 'b = 2', '', 'c = 3 # keep comment', ''];
      toml.upsertKey(lines, 'b', null);
      assert.deepEqual(lines, ['a = 1', '', 'c = 3 # keep comment', ''], '删键连整行一起删，不留空行');
      toml.upsertKey(lines, 'c', null);
      assert.deepEqual(lines, ['a = 1', '', ' # keep comment', ''], '同一行还有注释：只删键值');
      toml.upsertKey(lines, 'a', null); toml.upsertKey(lines, 'missing', null);
      assert.deepEqual(lines, ['', ' # keep comment', '']);
      const crlf = toml.parseToml('x = 1\r\ny = 2\r\n[t]\r\nk = "v"\r\n');
      toml.upsertKey(crlf[0].lines, 'x', null);
      assert.equal(toml.stringifyToml(crlf), 'y = 2\r\n[t]\r\nk = "v"\r\n', 'CRLF 文件也一样');

      const blocks = toml.parseToml('top = 1\n[model_providers.tokenpulse_route]\n\n\n[keep]\n\n[other]\nx = 1\n');
      assert.equal(toml.dropEmptyTable(blocks, 'model_providers.tokenpulse_route'), true);
      assert.equal(toml.dropEmptyTable(blocks, 'other'), false, '有键的表不删');
      assert.equal(toml.dropEmptyTable(blocks, 'nope'), false);
      assert.equal(toml.stringifyToml(blocks), 'top = 1\n[keep]\n\n[other]\nx = 1\n');
      assert.ok(toml.ownTable('model_providers.tokenpulse_route') && toml.ownTable('model.tokenpulse_route') && !toml.ownTable('model_providers.custom') && !toml.ownTable('model.tokenpulse_route_x'));

      // 接管前的快照里就有一张空的自有表（旧版本留下的）：还原后删掉，别的表原样
      const before = 'model = "a"\n[model_providers.tokenpulse_route]\n\n[mcp]\nx = 1\n';
      const after = 'model = "b"\nmodel_provider = "tokenpulse_route"\n[model_providers.tokenpulse_route]\nname = "TokenPulse"\nbase_url = "http://127.0.0.1:1"\n\n[mcp]\nx = 1\n';
      const restored = toml.restoreToml(after, before, after);
      assert.doesNotMatch(restored, /tokenpulse_route/);
      assert.match(restored, /^model = "a"\n/); assert.match(restored, /\[mcp\]\nx = 1/);
      pass('TOML: removing a key removes its line, empty own tables are dropped, restore cleans a leftover empty table');
    }

    /* ---------- 模型目录 ---------- */
    {
      const slot = { role: 'catalog', model: 'gpt-x', displayName: 'GPT X', contextWindow: 128000, reasoningLevels: ['medium', 'high'], defaultReasoningLevel: 'high', oneM: false };
      const bare = models.codexCatalogEntry({ ...slot, reasoningLevels: [], contextWindow: 0 }, null, 0);
      for (const key of models.CODEX_CATALOG_REQUIRED) assert.ok(key in bare, '骨架缺必填字段 ' + key);
      assert.deepEqual(bare.supported_reasoning_levels, [], '没填思考等级也要有这个字段');
      assert.deepEqual([bare.support_verbosity, bare.truncation_policy, bare.experimental_supported_tools], [false, { mode: 'bytes', limit: 10000 }, []]);
      // 模板（本机 models_cache 的一条）缺字段时也补齐；模板自己的值优先
      const viaTemplate = models.codexCatalogEntry(slot, { base_instructions: 'T', model_messages: {}, shell_type: 'unified_exec' }, 2);
      for (const key of models.CODEX_CATALOG_REQUIRED) assert.ok(key in viaTemplate, '用模板时缺必填字段 ' + key);
      assert.equal(viaTemplate.shell_type, 'unified_exec'); assert.equal(viaTemplate.base_instructions, 'T'); assert.equal(viaTemplate.priority, 1002);
      assert.equal(viaTemplate.default_reasoning_level, 'high');
      // 两条之间不共用同一个对象
      const other = models.codexCatalogEntry(slot, null, 1); other.truncation_policy.limit = 1;
      assert.equal(models.CODEX_CATALOG_DEFAULTS.truncation_policy.limit, 10000);
      // 旧版本写在磁盘上的目录：补字段，已有的不动
      const old = { models: [{ slug: 'a', display_name: 'a', priority: 1000, visibility: 'list', supported_in_api: true, shell_type: 'shell_command', base_instructions: 'x', supported_reasoning_levels: [{ effort: 'low', description: 'd' }], support_verbosity: true }] };
      assert.equal(models.patchCodexCatalog(old), true);
      assert.equal(old.models[0].support_verbosity, true, '已有的值不改');
      assert.deepEqual(old.models[0].truncation_policy, { mode: 'bytes', limit: 10000 });
      assert.equal(old.models[0].supported_reasoning_levels.length, 1);
      assert.equal(models.patchCodexCatalog(old), false, '补过一次就不再改');
      assert.equal(models.patchCodexCatalog({ nope: 1 }), false); assert.equal(models.patchCodexCatalog(null), false);
      pass('Codex model catalog: required fields always present (skeleton, template, no reasoning levels), old catalogs patched in place');
    }

    /* ---------- 来回切换 ---------- */
    fs.mkdirSync(codexDir, { recursive: true });
    const seed = '# keep me\nservice_tier = "default"\n\n[model_providers.custom]\nname = "OpenAI"\nrequires_openai_auth = true\nwire_api = "responses"\n\n[mcp_servers.fetch]\ncommand = "uvx"\n';
    fs.writeFileSync(codexFile, seed);
    codexLoads('初始');
    await sw.setProxyPort(await freePort());
    const relay = sw.saveProvider({ app: 'codex', name: 'Codex Relay', baseUrl: 'https://codex.example/v1', apiKey: 'sk-codex-test', model: 'gpt-test', upstream: 'openai-responses' });
    const official = () => sw.agentView().providers.find(item => item.app === 'codex' && item.official).id;
    const thirdParty = [], officialTexts = [];
    for (let round = 0; round < 3; round++) {
      await sw.activateProvider(relay);
      const text = read(codexFile); thirdParty.push(text);
      assert.match(text, /^model_provider = "tokenpulse_route"$/m);
      assert.match(text, /\[model_providers\.tokenpulse_route\]\nname = "TokenPulse"\nbase_url = "https:\/\/codex\.example\/v1"\nwire_api = "responses"\nexperimental_bearer_token = "sk-codex-test"\nrequires_openai_auth = false\n/);
      const catalog = JSON.parse(read(catalogFile));
      assert.ok(catalog.models.length >= 1);
      for (const entry of catalog.models) for (const key of models.CODEX_CATALOG_REQUIRED) assert.ok(key in entry, '写出的目录缺必填字段 ' + key);
      codexLoads('第三方直连，第 ' + (round + 1) + ' 轮');
      await sw.activateProvider(official());
      const back = read(codexFile); officialTexts.push(back);
      assert.doesNotMatch(back, /tokenpulse_route/, '切回官方后不能留下路由表（空表会让 Codex 读取失败）');
      assert.doesNotMatch(back, /^model_provider\s*=/m);
      assert.match(back, /# keep me/); assert.match(back, /\[model_providers\.custom\]\nname = "OpenAI"/); assert.match(back, /\[mcp_servers\.fetch\]\ncommand = "uvx"/);
      codexLoads('切回官方，第 ' + (round + 1) + ' 轮');
    }
    assert.equal(officialTexts[2], officialTexts[0], '来回切换，官方状态的文件不变长'); assert.equal(thirdParty[2], thirdParty[0], '来回切换，第三方状态的文件不变长');
    assert.ok(!/\n[ \t]*\n[ \t]*\n/.test(officialTexts[0].replace(seed, '')) && officialTexts[0].split('\n').length <= seed.split('\n').length + 1, '不留成串的空行');
    pass('Codex third-party ↔ official ×3: route table filled then removed, catalog complete, file does not grow');

    // 本地路由：接管 → 关闭（按快照还原），同样不留空表
    await sw.activateProvider(relay);
    await sw.setAppProxy('codex', true);
    assert.match(read(codexFile), /base_url = "http:\/\/127\.0\.0\.1:\d+\/codex\/v1"/);
    codexLoads('本地路由开');
    await sw.setAppProxy('codex', false);
    codexLoads('本地路由关');
    await sw.activateProvider(official());
    assert.doesNotMatch(read(codexFile), /tokenpulse_route/);
    codexLoads('路由关掉后切回官方');
    pass('Codex local route on / off / back to official stays loadable');

    // Grok：切回官方后同样不留空的 [model.tokenpulse_route]，用户自己的表不动
    fs.mkdirSync(path.dirname(grokFile), { recursive: true });
    fs.writeFileSync(grokFile, '[model.mine]\nmodel = "keep"\nbase_url = "https://mine.example"\n');
    const grok = sw.saveProvider({ app: 'grok', name: 'Grok Relay', baseUrl: 'https://grok.example/v1', apiKey: 'sk-grok-test', model: 'grok-test', upstream: 'openai-responses' });
    const grokTexts = [];
    for (let round = 0; round < 2; round++) {
      await sw.activateProvider(grok);
      assert.match(read(grokFile), /\[model\.tokenpulse_route\]\nname = "TokenPulse · Grok Relay"/);
      await sw.activateProvider(sw.agentView().providers.find(item => item.app === 'grok' && item.official).id);
      grokTexts.push(read(grokFile));
      assert.doesNotMatch(grokTexts[round], /tokenpulse_route/);
      assert.match(grokTexts[round], /\[model\.mine\]\nmodel = "keep"/);
    }
    assert.equal(grokTexts[1], grokTexts[0]);
    pass('Grok third-party ↔ official: own table removed, user tables kept, file does not grow');

    /* ---------- 启动修复 ---------- */
    sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed();
    const broken = '\n\n\nservice_tier = "default"\n\n[model_providers.custom]\nname = "OpenAI"\nrequires_openai_auth = true\n[desktop]\nsansFontSize = 14\n[model_providers.tokenpulse_route]\n\n\n\n\n[windows]\nsandbox = "unelevated"\n';
    const oldCatalog = JSON.stringify({ models: [{ visibility: 'list', supported_in_api: true, shell_type: 'shell_command', base_instructions: 'x', slug: 'm', display_name: 'm', description: 'm', priority: 1000, supported_reasoning_levels: [] }] }, null, 2) + '\n';
    fs.writeFileSync(codexFile, broken); fs.writeFileSync(catalogFile, oldCatalog);
    fs.writeFileSync(grokFile, '[models]\ndefault_reasoning_effort = "high"\n\n[model.tokenpulse_route]\n\n\n[cli]\ninstaller = "internal"\n');
    // 只读保护开着：一个字不写，只提示
    config.configureReadOnly(() => true);
    assert.deepEqual(sw.repairAgentConfigs(), []);
    assert.equal(read(codexFile), broken); assert.equal(read(catalogFile), oldCatalog);
    assert.match(sw.agentView().notice || '', /需要修复.*只读保护/);
    config.configureReadOnly(() => false);
    const fixed = sw.repairAgentConfigs();
    assert.equal(fixed.length, 3, JSON.stringify(fixed));
    const healed = read(codexFile);
    assert.doesNotMatch(healed, /tokenpulse_route/);
    assert.match(healed, /\[desktop\]\nsansFontSize = 14\n\[windows\]\nsandbox = "unelevated"\n/, '别的表原样');
    for (const key of models.CODEX_CATALOG_REQUIRED) assert.ok(key in JSON.parse(read(catalogFile)).models[0], '修复后的目录缺 ' + key);
    assert.doesNotMatch(read(grokFile), /tokenpulse_route/); assert.match(read(grokFile), /\[cli\]\ninstaller = "internal"/);
    assert.match(sw.agentView().notice || '', /已自动修复/);
    codexLoads('启动修复之后');
    assert.deepEqual(sw.repairAgentConfigs(), [], '没东西要修就什么都不写');
    assert.equal(read(codexFile), healed);
    // 正在用的路由表（model_provider 指着它）哪怕是空的也不删：删了 model_provider 就悬空；等用户重新切换时重写
    const inUse = 'model_provider = "tokenpulse_route"\n[model_providers.tokenpulse_route]\n\n';
    fs.writeFileSync(codexFile, inUse);
    assert.deepEqual(sw.repairAgentConfigs(), []); assert.equal(read(codexFile), inUse);
    // 解析不了的文件不碰
    fs.writeFileSync(codexFile, '[broken\n'); assert.deepEqual(sw.repairAgentConfigs(), []); assert.equal(read(codexFile), '[broken\n');
    pass('Startup repair: empty own tables and old catalog fixed with a notice, read-only blocks writes, in-use and unparsable files untouched');

    /* ---------- 切换前让本机的 Codex 试读目录 ---------- */
    {
      // 测试环境（假用户目录）里默认不去找真实机器上的 Codex：试读不发生，照常写目录
      assert.equal(probe.findCodexExe(), process.env.TOKENPULSE_CODEX_EXE && fs.existsSync(process.env.TOKENPULSE_CODEX_EXE) ? process.env.TOKENPULSE_CODEX_EXE : '');
      fs.writeFileSync(codexFile, seed);
      const fakeExe = path.join(root, 'fake-codex.exe'); fs.writeFileSync(fakeExe, 'not a real binary');
      const calls = [];
      let verdict = 'rejected';
      probe.setCodexProbeForTests(async (exe, catalogJson) => { calls.push([exe, JSON.parse(catalogJson).models.length]); return verdict; }, fakeExe);
      // Codex 明确读不了：不写目录，配置照样完整，提示用户
      await sw.activateProvider(relay);
      let text = read(codexFile);
      assert.deepEqual(calls, [[fakeExe, 1]], '切换前试读一次');
      assert.doesNotMatch(text, /model_catalog_json/, '读不了就不引用目录');
      assert.match(text, /^model_provider = "tokenpulse_route"$/m); assert.match(text, /^model = "gpt-test"$/m);
      assert.match(sw.agentView().notice || '', /本机的 Codex 读不了 TokenPulse 生成的模型目录.*没有写入模型目录/);
      codexLoads('目录被拒时不带目录');
      // 同样的目录不重复试；本地路由也一样处理
      await sw.setAppProxy('codex', true);
      assert.equal(calls.length, 1, '同样的目录 + 同一个 Codex 只试一次');
      assert.doesNotMatch(read(codexFile), /model_catalog_json/);
      await sw.setAppProxy('codex', false);
      // 能读：照常写目录
      verdict = 'ok'; probe.setCodexProbeForTests(async (exe, catalogJson) => { calls.push([exe, 0]); return verdict; }, fakeExe);
      await sw.activateProvider(official()); await sw.activateProvider(relay);
      assert.match(read(codexFile), /^model_catalog_json = /m); assert.equal(sw.agentView().notice || '', '');
      // 拿不准（超时、老版本）：放行，而且不记结果，下次再试
      const before = calls.length; verdict = 'unknown'; probe.setCodexProbeForTests(async () => { calls.push(['again', 0]); return 'unknown'; }, fakeExe);
      await sw.activateProvider(official()); await sw.activateProvider(relay); await sw.activateProvider(official()); await sw.activateProvider(relay);
      assert.match(read(codexFile), /^model_catalog_json = /m); assert.equal(calls.length - before, 2, '拿不准的每次都重试');
      // 试读本身出错：同样放行
      probe.setCodexProbeForTests(async () => { throw new Error('boom'); }, fakeExe);
      await sw.activateProvider(official()); await sw.activateProvider(relay);
      assert.match(read(codexFile), /^model_catalog_json = /m);

      // 启动时：配置正引用着目录，而 Codex（更新后）读不了它 → 去掉引用；只读保护下不写
      sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed();
      probe.setCodexProbeForTests(async () => 'rejected', fakeExe);
      const referencing = read(codexFile);
      config.configureReadOnly(() => true);
      await sw.resumeAgentProxy();
      assert.equal(read(codexFile), referencing); assert.match(sw.agentView().notice || '', /发现需要修复.*读不了 TokenPulse 写的模型目录.*只读保护/);
      config.configureReadOnly(() => false);
      await sw.resumeAgentProxy();
      assert.doesNotMatch(read(codexFile), /model_catalog_json/); assert.match(read(codexFile), /^model_provider = "tokenpulse_route"$/m);
      assert.match(sw.agentView().notice || '', /已自动修复：本机的 Codex 读不了 TokenPulse 之前写的模型目录/);
      codexLoads('启动时去掉读不了的目录之后');
      assert.equal(sw.agentDrift().filter(d => d.app === 'codex').length, 0, '自己修的不算「配置被改走」');
      // 别人的目录（比如 CC Switch 的）不管
      const foreign = 'model_catalog_json = \'' + path.join(codexDir, 'cc-switch-model-catalog.json') + '\'\n';
      fs.writeFileSync(codexFile, foreign); await sw.resumeAgentProxy(); assert.equal(read(codexFile), foreign);
      probe.setCodexProbeForTests(null);
      pass('Codex catalog pre-check: rejected → no catalog + notice, verdict cached, unknown/error → write as before, startup drops a catalog the installed Codex cannot read, read-only respected, foreign catalogs untouched');

      // 真实的 Codex：好的目录读得过，缺必填字段的读不过
      if (codexExe) {
        probe.setCodexProbeForTests(null, codexExe);
        const good = JSON.stringify({ models: [models.codexCatalogEntry({ role: 'catalog', model: 'm', displayName: 'M', contextWindow: 0, reasoningLevels: ['high'], defaultReasoningLevel: 'high', oneM: false }, null, 0)] });
        const bad = JSON.parse(good); delete bad.models[0].support_verbosity;
        assert.equal(await probe.probeCodexCatalog(good), 'ok');
        assert.equal(await probe.probeCodexCatalog(JSON.stringify(bad)), 'rejected', '缺必填字段：真实的 Codex 明确拒绝');
        assert.equal(probe.catalogVerdict(good), 'ok'); assert.equal(probe.catalogVerdict(JSON.stringify(bad)), 'rejected'); assert.equal(probe.catalogVerdict('{"models":[]} '), 'unknown');
        assert.equal(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('tokenpulse-codex-probe-')).length, 0, '试读用的临时目录用完就删');
        probe.setCodexProbeForTests(null);
        liveChecks += 2;
        pass('Codex catalog pre-check with the real Codex: good catalog ok, catalog missing a required field rejected, temp dirs removed');
      }
    }

    console.log(codexExe ? `PASS real Codex (${path.basename(path.dirname(codexExe))}) loaded every generated config: ${liveChecks} checks` : 'SKIP real Codex check: codex.exe not found on this machine (set TOKENPULSE_CODEX_EXE to run it)');
    console.log(`${checks}/${checks} tool-config compatibility checks passed`);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    try { sw.releaseAgentSwitch(); await sw.waitAgentProxyClosed(); } catch { /* 已经关了 */ }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('tokenpulse-compat-'));
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
