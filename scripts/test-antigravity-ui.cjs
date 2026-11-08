/*
 * Google Antigravity 的额度界面（renderer/antigravity-quota.js、main/antigravity-quota.ts）。
 * 本机 language server 用假的 http 服务器代替（daemon/hub_*.json 指过去），对话库用 node:sqlite 造；
 * 一次性的 HOME / 数据目录 / Antigravity 目录，不碰真实的 ~/.gemini 和 ~/.tokenpulse。截图用 TP_SHOTS（只有测试数据）。
 * 跑法：npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs（先 npm run compile）
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-agy-ui-'));
const agy = path.join(root, 'antigravity');
Object.assign(process.env, { TOKENPULSE_DATA_DIR: path.join(root, 'data'), TOKENPULSE_ANTIGRAVITY_DIR: agy, AGENT_SWITCH_HOME: path.join(root, 'home'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), PI_CODING_AGENT_DIR: path.join(root, 'pi'), TOKENPULSE_DSH_HOME: path.join(root, 'dsh'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), GROK_HOME: path.join(root, 'grok'), AGENT_SWITCH_CC_DB: path.join(root, 'missing.db') });
for (const dir of ['data', 'home', 'antigravity/conversations', 'antigravity/daemon']) fs.mkdirSync(path.join(root, dir), { recursive: true });
// 提醒线关掉：测试里不弹真的系统通知
fs.writeFileSync(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
const NOW = Date.now(), H = 3600000, iso = at => new Date(at).toISOString();
const RESET_A = Math.floor((NOW + 3 * H) / 1000) * 1000, RESET_B = Math.floor((NOW + 4.5 * H) / 1000) * 1000;
const RESET_A_WEEK = Math.floor((NOW + 120 * H) / 1000) * 1000, RESET_B_WEEK = Math.floor((NOW + 144 * H) / 1000) * 1000;
// 包含上一周期（触发周窗口提前重置顺延说明与时间线历史周期切换）和当前窗口的三次采样：Gemini 一组从 10% 涨到 30%（每小时 10 个点），Claude 一组没动
const KEY_A = 'Gemini 3.8 Flash|Gemini 4 Argon', KEY_B = 'Claude Opus 5.5|GPT-OSS 120B';
fs.writeFileSync(path.join(root, 'data', 'antigravity-quota.json'), JSON.stringify({
  history: [
    {
      at: NOW - 6 * H,
      groups: [
        { key: KEY_A, used: 25, resetAt: iso(RESET_A - 5 * H), weekUsed: 15, weekResetAt: iso(RESET_A_WEEK - 24 * H) },
        { key: KEY_B, used: 5, resetAt: iso(RESET_B - 5 * H), weekUsed: 10, weekResetAt: iso(RESET_B_WEEK) },
      ],
    },
    ...[2, 1].map(ago => ({
      at: NOW - ago * H,
      groups: [
        { key: KEY_A, used: 30 - ago * 10, resetAt: iso(RESET_A), weekUsed: 20 - ago * 2, weekResetAt: iso(RESET_A_WEEK) },
        { key: KEY_B, used: 0, resetAt: iso(RESET_B), weekUsed: 10, weekResetAt: iso(RESET_B_WEEK) },
      ],
    })),
  ],
  notified: {},
}));

/* ---------- 对话库：今天两次生成 ---------- */
const { DatabaseSync } = require('node:sqlite');
const varint = n => { const out = []; let x = BigInt(n); do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; out.push(b); } while (x); return Buffer.from(out); };
const num = (no, n) => Buffer.concat([varint(no * 8), varint(n)]);
const bytes = (no, buf) => Buffer.concat([varint(no * 8 + 2), varint(buf.length), buf]);
const str = (no, s) => bytes(no, Buffer.from(s, 'utf8'));
const msg = (no, ...parts) => bytes(no, Buffer.concat(parts));
const time = (no, ms) => msg(no, num(1, Math.floor(ms / 1000)), num(2, 0));
const step = (start, input, output, gen) => Buffer.concat([time(1, start), time(6, start + 3000), msg(9, num(1, 1417), num(2, input), num(3, output), num(5, 50000), num(9, 20), num(10, output - 20), str(11, 'resp-' + gen)), num(11, 1417), msg(20, num(3, gen))]);
{
  const db = new DatabaseSync(path.join(agy, 'conversations', 'cccccccc-0000-4000-8000-000000000003.db'));
  db.exec('create table steps (idx integer primary key, step_type integer, status integer, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob, size integer);');
  // 会话页用的内容：用户的话（14：19.2）、回复（15：20.1 正文、20.7 工具调用）、工具执行（132：5.4 调用、140.2.1 输出）
  const payload = (type, at, ...rest) => Buffer.concat([num(1, type), num(4, 3), msg(5, time(1, at), num(11, 1417), msg(20, num(3, 0))), ...rest]);
  const put = db.prepare('insert into steps values (?, ?, ?, ?, ?)');
  put.run(0, 14, 3, null, payload(14, NOW - 2 * H - 5000, msg(19, str(2, '把首页的额度卡片改成分组显示'))));
  put.run(1, 15, 3, step(NOW - 2 * H, 1000, 400, 0), payload(15, NOW - 2 * H, msg(20, msg(7, str(1, 'call_1'), str(2, 'view_file'), str(3, JSON.stringify({ AbsolutePath: 'D:\\demo\\card.js' }))))));
  put.run(2, 132, 3, null, Buffer.concat([num(1, 132), num(4, 3), msg(5, time(1, NOW - 2 * H + 1000), msg(4, str(1, 'call_1'), str(2, 'view_file'), str(3, '{}'))), msg(140, msg(2, str(1, 'function card() {}')))]));
  put.run(3, 15, 3, step(NOW - H, 2000, 600, 1), payload(15, NOW - H, msg(20, str(1, '改好了：两组额度各占一行。'))));
  const gen = Buffer.concat([msg(1, str(19, 'gemini-4-argon-b'), msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_M417')))]);
  db.prepare('insert into gen_metadata values (?, ?, ?)').run(0, gen, gen.length);
  db.close();
  const sum = new DatabaseSync(path.join(agy, 'conversation_summaries.db'));
  sum.exec('create table conversation_summaries (conversation_id text primary key, title text, workspace_uris text, status text, nesting_depth integer, killed numeric, last_modified_time datetime, last_user_input_time datetime)');
  sum.prepare('insert into conversation_summaries values (?, ?, ?, ?, 0, 0, ?, ?)').run('cccccccc-0000-4000-8000-000000000003', '额度卡片分组', JSON.stringify([require('node:url').pathToFileURL(path.join(root, 'demo-app')).href]), 'CASCADE_RUN_STATUS_IDLE', new Date(NOW - H).toISOString().replace('T', ' ').replace('Z', '0000+00:00'), new Date(NOW - 2 * H).toISOString().replace('T', ' ').replace('Z', '0000+00:00'));
  sum.close();
}

/* ---------- 假的 language server ---------- */
const CSRF = 'csrf-ui-' + 'x'.repeat(20);
let mode = 'normal';
const status = () => ({ userStatus: { name: 'QA', email: 'qa-agy@example.com', planStatus: { planInfo: { planName: 'Pro', monthlyPromptCredits: 50000, monthlyFlowCredits: 150000 }, availablePromptCredits: 48000, availableFlowCredits: 149500 }, userTier: { name: 'Google AI Ultra' }, cascadeModelConfigData: { clientModelConfigs: [
  ...['Gemini 4 Argon (High)', 'Gemini 4 Argon (Low)', 'Gemini 3.8 Flash (Medium)'].map((label, i) => ({ label, modelOrAlias: { model: ['MODEL_PLACEHOLDER_M417', 'MODEL_PLACEHOLDER_M419', 'MODEL_PLACEHOLDER_M319'][i] }, quotaInfo: { remainingFraction: 0.7, resetTime: iso(RESET_A) } })),
  ...['Claude Opus 5.5 (Low)', 'GPT-OSS 120B (Medium)'].map((label, i) => ({ label, modelOrAlias: { model: ['MODEL_PLACEHOLDER_M400', 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM'][i] }, quotaInfo: mode === 'out' ? { resetTime: iso(RESET_B) } : { remainingFraction: 1, resetTime: iso(RESET_B) } })),
] } } });
const summary = () => ({ groups: [
  { title: 'Gemini Models', buckets: [{ id: 'gemini_5h', window: '5h', remainingFraction: 0.7, resetTime: iso(RESET_A) }, { id: 'gemini_weekly', window: 'weekly', remainingFraction: 0.8, resetTime: iso(RESET_A_WEEK) }] },
  { title: 'Claude and GPT models', buckets: [{ id: '3p_5h', window: '5h', remainingFraction: mode === 'out' ? 0 : 1, resetTime: iso(RESET_B) }, { id: '3p_weekly', window: 'weekly', remainingFraction: 0.9, resetTime: iso(RESET_B_WEEK) }] },
] });
const hits = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    hits.push({ url: req.url, csrf: req.headers['x-codeium-csrf-token'] });
    if (req.headers['x-codeium-csrf-token'] !== CSRF) { res.writeHead(403).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url.endsWith('/RetrieveUserQuotaSummary') ? summary() : status()));
  });
});

app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});
const watchdog = setTimeout(() => { console.error('FAIL antigravity UI timed out'); app.exit(1); }, 90000);
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
app.on('web-contents-created', (_event, wc) => wc.once('did-finish-load', async () => {
  const e = code => wc.executeJavaScript(code).catch(error => { throw new Error(error.message + ' ← ' + String(code).slice(0, 160)); });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (code, ms = 15000) => { const end = Date.now() + ms; while (!await e(`Promise.resolve(${code}).then(v => !!v)`)) { assert.ok(Date.now() < end, 'Timed out: ' + code); await pause(60); } };
  const text = sel => e(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
  const shot = async name => { if (!process.env.TP_SHOTS) return; fs.mkdirSync(process.env.TP_SHOTS, { recursive: true }); const win = BrowserWindow.fromWebContents(wc); if (!win.isVisible()) { win.setSize(1440, 900); win.showInactive(); } await pause(800); fs.writeFileSync(path.join(process.env.TP_SHOTS, name + '.png'), (await wc.capturePage()).toPNG()); };
  try {
    // 总览：一张 Antigravity 卡片，两组额度
    await until("typeof navigate === 'function' && document.querySelector('#quota-cards [data-antigravity] .agy-mini')");
    const card = '#quota-cards [data-antigravity]';
    assert.equal(await e(`document.querySelectorAll('${card} .agy-mini').length`), 2);
    assert.match(await text(card), /Antigravity[\s\S]*Google AI Ultra[\s\S]*节奏正常/);
    assert.match(await text(`${card} .agy-mini[data-group="${KEY_A}"]`), /Gemini 4 Argon · Gemini 3\.8 Flash[\s\S]*已用 30\.0%[\s\S]*后重置[\s\S]*周额度[\s\S]*周已用 20\.0%/);
    assert.equal(await text(`${card} .ring-center`), '70.0%', '圆环中间是剩得最少的那一组');
    assert.equal(await e(`document.querySelectorAll('${card} .ring-value').length`), 2, '两组各一个环');
    assert.ok(hits.some(h => h.url === '/exa.language_server_pb.LanguageServerService/GetUserStatus') && hits.some(h => h.url === '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'));
    await shot('agy-overview');
    pass('antigravity UI: the overview has an Antigravity card with one row per quota group and a double ring');

    // 额度详情：Antigravity 的标签，两组各一张窗口卡、预测、走势图；没有官方账号那两块
    await e("navigate('quota')");
    await until("document.querySelector('#account-tabs button[data-antigravity]')");
    await e("document.querySelector('#account-tabs button[data-antigravity]').click()");
    await until("document.querySelectorAll('#quota-detail .agy-group').length === 2");
    assert.equal(await e("document.getElementById('page-quota').classList.contains('agy-mode')"), true);
    assert.equal(await e("getComputedStyle(document.getElementById('quota-model-study')).display"), 'none');
    assert.match(await text('#quota-detail .agy-context'), /Google Antigravity[\s\S]*Google AI Ultra · Pro/);
    assert.match(await text(`#quota-detail .agy-group[data-group="${KEY_A}"]`), /剩余额度[\s\S]*已用 30\.0%[\s\S]*按最近的速度，重置时大约用到 60\.0%[\s\S]*周额度窗口[\s\S]*80\.0%[\s\S]*周已用 20\.0%[\s\S]*Token 与费用[\s\S]*10\.00/);
    assert.match(await text(`#quota-detail .agy-group[data-group="${KEY_B}"]`), /100\.0%[\s\S]*这个窗口里还没有新增用量[\s\S]*周额度窗口[\s\S]*90\.0%/);
    assert.equal(await e("document.querySelectorAll('#quota-detail .agy-chart .agy-line').length"), 2, '走势图每组一条线');
    assert.equal(await e("document.querySelectorAll('#quota-detail .agy-chart .agy-line-week').length"), 2, '周额度走势虚线每组一条');
    assert.ok(await e("!!document.querySelector('#quota-detail .agy-capacity') && !!document.querySelector('#quota-detail .agy-model-study') && !!document.querySelector('#quota-detail .agy-requests')"), '容量趋势、模型换算与账号请求面板齐全');
    // 周额度二级窗口：进度条底槽与背景区分，且提前重置说明与上方预测条之间留有合理间距（不重叠或贴边）
    const weekBoxLayout = await e(`(() => {
      const box = document.querySelector('#quota-detail .agy-group[data-group="${KEY_A}"] .agy-week-box');
      const track = box?.querySelector('.track');
      const pred = box?.querySelector('.agy-week-pred');
      const note = box?.querySelector('.reset-card-note');
      if (!box || !track || !pred || !note) return null;
      return {
        boxBg: getComputedStyle(box).backgroundColor,
        trackBg: getComputedStyle(track).backgroundColor,
        gap: Math.round(note.getBoundingClientRect().top - pred.getBoundingClientRect().bottom),
      };
    })()`);
    assert.ok(weekBoxLayout, '周额度窗口包含进度条、预测条和提前重置说明');
    assert.notEqual(weekBoxLayout.trackBg, weekBoxLayout.boxBg, '周额度进度条轨道背景与卡片底色明显区分');
    assert.ok(weekBoxLayout.gap >= 6, `周额度提前重置说明与上方预测条不重叠（实际间距 ${weekBoxLayout.gap}px）`);
    // 模型与思考等级 · 时间线：切换历史周期不会丢失 extra 账号变成「还没有带账号标识的官方额度周期」
    await until("document.querySelector('#quota-model-timeline .ms-cycle.five .ms-cycle-pos')?.textContent?.includes('/ 2')");
    assert.equal(await text('#quota-model-timeline .ms-cycle.five .ms-cycle-pos'), '1 / 2');
    await e("document.querySelector('#quota-model-timeline .ms-cycle.five .ms-step').click()");
    await until("document.querySelector('#quota-model-timeline .ms-cycle.five .ms-cycle-pos')?.textContent === '2 / 2'");
    assert.ok(!(await text('#quota-model-timeline')).includes('还没有带账号标识的官方额度周期'), '切换历史周期后正常显示 Antigravity 时间线');
    await e("document.querySelectorAll('#quota-model-timeline .ms-cycle.five .ms-step')[1].click()");
    await until("document.querySelector('#quota-model-timeline .ms-cycle.five .ms-cycle-pos')?.textContent === '1 / 2'");
    pass('antigravity UI: the quota page shows each group with remaining, reset, pace forecast and a 7-day chart, without the official-account sections');

    // 本机用量：扫到的 Antigravity 对话；型号按额度接口的标签显示
    await until("/Gemini|gemini/.test(document.querySelector('#quota-detail .agy-local')?.textContent || '') && document.querySelector('#quota-detail .agy-model')?.textContent === 'gemini-4-argon'", 30000);
    assert.match(await text('#quota-detail .agy-local'), /今天[\s\S]*Tokens[\s\S]*2 次请求/);
    await e("document.querySelector('#quota-detail [data-action=agy-usage]').click()");
    await until("document.body.dataset.page === 'usage'");
    assert.equal(await e("document.getElementById('source-filter').value"), 'Antigravity', '用量明细的工具筛选跟着切到 Antigravity');
    await shot('agy-usage');
    pass('antigravity UI: local usage from Antigravity conversations, with a link that opens Usage filtered to Antigravity');

    // 会话管理：Antigravity 的对话列出来、能看；支持 Antigravity CLI 的「回复对话」「在终端里继续」「复制继续命令」
    const KEY = 'antigravity:cccccccc-0000-4000-8000-000000000003';
    await e("navigate('sessions')");
    await until(`document.querySelector('.sw-item[data-key="${KEY}"]')`, 20000);
    assert.ok(await e("!!document.querySelector('.sw-kinds button[data-kind=antigravity]')"), '筛选里有 Antigravity');
    await e(`document.querySelector('.sw-item[data-key="${KEY}"]').click()`);
    await until("/改好了：两组额度各占一行/.test(document.querySelector('.sw-messages')?.textContent || '')");
    const thread = await text('.sw-messages');
    assert.match(thread, /把首页的额度卡片改成分组显示[\s\S]*view_file[\s\S]*改好了：两组额度各占一行/);
    assert.match(await text('.sw-head'), /额度卡片分组[\s\S]*demo-app/);
    assert.ok(await e(`!!document.querySelector('.sw-item[data-key="${KEY}"] .sw-item-usage')`), '会话列表显示 Token 与费用徽标');
    assert.match(await text('.sw-usage-bar'), /总 Token[\s\S]*缓存命中[\s\S]*API 等价/);
    await e("document.querySelector('.sw-usage-toggle').click()");
    assert.equal(await e("document.querySelector('.sw-usage-panel').hidden"), false, '点击展开会话用量详情');
    assert.match(await text('.sw-usage-panel'), /总 Token 消耗[\s\S]*缓存命中率[\s\S]*API 等价花费[\s\S]*模型占比分布[\s\S]*gemini-4-argon/);
    assert.equal(await e("[...document.querySelectorAll('.sw-actions button')].some(b => b.textContent.includes('回复对话'))"), true, '支持在 TokenPulse 里通过 Antigravity CLI 回复');
    assert.ok(await e("!!document.querySelector('.sw-composer textarea')"), '展示 Antigravity 回复输入框');
    await e("document.querySelector('.sw-actions button[aria-haspopup=menu]').click()");
    await until("!document.getElementById('option-menu').hidden");
    const menu = await text('#option-menu');
    assert.ok(menu.includes('在终端里继续') && menu.includes('复制继续命令') && menu.includes('agy.exe --conversation cccccccc-0000-4000-8000-000000000003') && menu.includes('删除对话'), menu);
    await e("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await shot('agy-sessions');
    pass('antigravity UI: sessions lists and shows Antigravity conversations, with CLI reply and terminal resume actions');

    // 有一组用完：刷新后卡片变红
    mode = 'out';
    await e("navigate('overview')");
    await until(`document.querySelector('${card} [data-action=agy-refresh]')`);
    await e(`document.querySelector('${card} [data-action=agy-refresh]').click()`);
    await until(`document.querySelector('${card} .badge')?.textContent === '有一组用完了'`);
    assert.match(await text(`${card} .agy-mini[data-group="${KEY_B}"]`), /已用 100\.0%/);
    pass('antigravity UI: an exhausted group (no remainingFraction) turns the card red after a refresh');

    // Antigravity 关掉了：留着上一次的数，写明没开着
    await new Promise(resolve => server.close(resolve));
    for (const name of fs.readdirSync(path.join(agy, 'daemon'))) fs.rmSync(path.join(agy, 'daemon', name));
    await e(`document.querySelector('${card} [data-action=agy-refresh]').click()`);
    await until(`document.querySelector('${card} .badge')?.textContent === '没有开着'`);
    assert.equal(await e(`document.querySelectorAll('${card} .agy-mini').length`), 2, '上一次的额度还在');
    await e("navigate('quota')");
    await until("document.querySelector('#quota-detail .agy-note')");
    assert.match(await text('#quota-detail .agy-note'), /Antigravity 现在没有开着/);
    assert.equal(await e(`document.documentElement.outerHTML.includes(${JSON.stringify(CSRF)}) || document.documentElement.outerHTML.includes('qa-agy@example.com')`), false, '界面里没有令牌和邮箱');
    pass('antigravity UI: when Antigravity is closed the last quota stays with a note; no token or email reaches the page');

    // 夜间没有默认黑字；900px 不横向溢出；英文
    await e("setThemeMode('dark')"); await pause(200);
    assert.deepEqual(await e("[...document.querySelectorAll('#quota-detail *, #quota-cards [data-antigravity] *')].filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim()) && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.className)"), []);
    await e("setThemeMode('light')");
    BrowserWindow.fromWebContents(wc).setSize(900, 800); await pause(300);
    assert.equal(await e("document.getElementById('page-quota').scrollWidth <= document.getElementById('page-quota').clientWidth + 1"), true);
    await e("localStorage.setItem('tokenpulse-lang', 'en'); location.reload()");
    await until("document.documentElement.lang.startsWith('en') && typeof navigate === 'function' && document.querySelector('#quota-cards [data-antigravity] .agy-mini')");
    await pause(400);
    const en = await text('#quota-cards [data-antigravity]');
    assert.ok(!/[一-鿿]/.test(en), en);
    await e("state.account = 'antigravity'; navigate('quota')");
    await until("document.querySelector('#quota-detail .agy-group')");
    await pause(400);
    const enPage = await text('#quota-detail');
    assert.ok(!/[一-鿿]/.test(enPage), enPage.match(/.{0,40}[一-鿿].{0,40}/)?.[0]);
    await e(`PulseSessions.open(${JSON.stringify(KEY)})`);
    await until("document.querySelector('.sw-usage-bar')");
    await e("if (document.querySelector('.sw-usage-panel')?.hidden) document.querySelector('.sw-usage-toggle').click()");
    await pause(300);
    const enUsage = (await text('.sw-usage-bar')) + ' ' + (await text('.sw-usage-panel'));
    assert.ok(!/[一-鿿]/.test(enUsage), enUsage);
    pass('antigravity UI: dark mode has no default black text, 900px does not overflow, English is fully translated');

    console.log(`${checks}/${checks} antigravity UI checks passed`);
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error('FAIL antigravity UI', error); clearTimeout(watchdog); app.exit(1); }
}));
app.on('quit', () => { try { server.close(); } catch { /* 已经关了 */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄没放完就留给系统清理 */ } });
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(agy, 'daemon', 'hub_1.json'), JSON.stringify({ pid: process.pid, httpsPort: 1, httpPort: server.address().port, lsVersion: '2.29.0', csrfToken: CSRF }));
  require('../build/main/index.js');
});
