/*
 * 桌宠（0.3.61）：真的把应用跑起来，打开桌宠。
 * 临时数据目录和临时主目录（里面放几份假的 Claude Code / Codex 会话），不碰真实的 ~/.tokenpulse、~/.claude、~/.codex；
 * 宠物和对话气泡窗口放到屏幕外面（TOKENPULSE_DESK_PET_OFFSCREEN），测试时不在用户眼前闪。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow, dialog, screen } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-desk-pet-ui-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
const home = path.join(root, 'home');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = home; process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
process.env.TOKENPULSE_DESK_PET_OFFSCREEN = '1';
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
// 窗口放在屏幕外，Windows 有时把它算成被挡住（visibilityState = hidden），宠物页面就停下动画不走帧；测试里关掉遮挡计算
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: true, startMinimized: true, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require(path.join(appRoot, 'package.json')).version, onboarding: 'done', theme: 'light', deskPet: true }));
require(path.join(appRoot, 'build/core/quota.js')).fetchOfficialQuota = async () => ({});

// 两份正在跑的会话：Claude Code 在跑工具，Codex 刚开始一轮
const line = value => JSON.stringify(value), ago = s => new Date(Date.now() - s * 1000).toISOString();
const claudeDir = path.join(home, '.claude', 'projects', 'D--work-demo-app');
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, 'c-1.jsonl'), [line({ type: 'ai-title', aiTitle: '额度卡片分级提示' }), line({ type: 'user', timestamp: ago(300), sessionId: 'c-1', cwd: 'D:\\work\\demo-app', message: { content: '把额度卡片改成分级提示' } }), line({ type: 'assistant', timestamp: ago(2), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } })].join('\n') + '\n');
const now = new Date(), day = path.join(home, '.codex', 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
fs.mkdirSync(day, { recursive: true });
fs.writeFileSync(path.join(day, 'rollout-x-1.jsonl'), [line({ type: 'session_meta', timestamp: ago(60), payload: { id: 'x-1', cwd: '/home/me/tokenpulse' } }), line({ type: 'event_msg', timestamp: ago(60), payload: { type: 'task_started' } }), line({ type: 'response_item', timestamp: ago(59), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '补齐会话解析的单元测试' }] } })].join('\n') + '\n');
// 自定义宠物：一张 1×1 的 PNG 当 idle，一张 GIF 当 work
const petFolder = path.join(root, 'my-cat');
fs.mkdirSync(petFolder, { recursive: true });
fs.writeFileSync(path.join(petFolder, 'idle.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex'));
fs.writeFileSync(path.join(petFolder, 'work.gif'), Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));
fs.writeFileSync(path.join(petFolder, 'pet.json'), JSON.stringify({ name: '测试猫', author: 'QA', states: { idle: 'idle.png', work: 'work.gif' } }));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [petFolder] });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (probe, label, ms = 10000) => { const end = Date.now() + ms; for (;;) { const value = await probe(); if (value) return value; if (Date.now() > end) throw new Error('等不到：' + label); await delay(60); } };
const live = () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
const petOf = () => live().find(w => w.webContents.getURL().includes('desk-pet.html'));
const bubbleOf = () => live().find(w => w.webContents.getURL().includes('desk-pet-bubble.html'));
const mainOf = () => live().find(w => w.webContents.getURL().includes('index.html'));
setTimeout(() => { console.error('FAIL desk pet UI timed out'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  let failed = false;
  try {
    const pet = await until(() => { const w = petOf(); return w && w.isVisible() ? w : null; }, '宠物窗口');
    const js = code => pet.webContents.executeJavaScript(code);
    assert.equal(pet.isFocusable(), false, '宠物不抢焦点');
    assert.deepEqual([pet.getBounds().width, pet.getBounds().height], [240, 142], '中等大小');
    await until(() => js("document.getElementById('dp-stage').dataset.pet === 'squirrel'"), '默认松鼠');
    const painted = () => js("(() => { const c = document.getElementById('dp-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()");
    assert.ok(await painted() > 1000, '画出来了');
    assert.deepEqual(await js("['dp-img', 'dp-badge'].map(id => getComputedStyle(document.getElementById(id)).display)"), ['none', 'none'], '内置宠物不显示图片框和额度标签（这个窗口不加载 app.css，hidden 要自己管）');
    assert.equal(await js("Math.round(document.getElementById('dp-stage').getBoundingClientRect().bottom) === innerHeight"), true, '宠物贴着窗口底边');
    await until(() => js("document.getElementById('dp-stage').dataset.mode === 'work'"), '有任务在跑：干活');
    assert.match(await js("document.getElementById('dp-hint').textContent"), /^2 个任务进行中 · 还没有额度数据$/);
    console.log('PASS desk pet UI: the pet window opens when enabled, does not take focus, draws the squirrel and starts working on running sessions');

    // 鼠标在宠物身上才算悬停（透明的地方不接鼠标）
    const hover = (x, y) => js(`document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true })), document.body.classList.contains('hover')`);
    // 找一个真的画了东西的像素（干活时松鼠侧着身来回跑，不在正中间）
    const box = await js(`(() => { const c = document.getElementById('dp-canvas'), r = c.getBoundingClientRect(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = Math.floor(d.length / 8) * 4 + 3; i < d.length; i += 4) if (d[i]) { const p = (i - 3) / 4; return { x: r.left + (p % c.width + 0.5) * r.width / c.width, y: r.top + (Math.floor(p / c.width) + 0.5) * r.height / c.height }; } })()`);
    assert.equal(await hover(box.x, box.y), true, '宠物身上');
    assert.equal(await hover(2, 2), false, '透明的角落');
    console.log('PASS desk pet UI: hover only counts on the pet itself, not the transparent corners');

    // 拖动：光标停住、鼠标没松开时，宠物也要停住。屏幕缩放 150% 时反复 setBounds(getBounds()) 窗口会一像素一像素长大，
    // 宠物画在底边中间，看起来就是自己在漂。光标是假的（测试时不动真鼠标），位置挑在屏幕外
    const realCursor = screen.getCursorScreenPoint;
    const size = [pet.getBounds().width, pet.getBounds().height];
    let cursor = { x: -19000, y: -19000 };
    screen.getCursorScreenPoint = () => ({ ...cursor });
    try {
      await js("window.tokenpulse.deskPet.drag('start')");
      await delay(80);
      const grabbed = pet.getBounds();
      cursor = { x: -19000 + 137, y: -19000 + 91 };
      await until(() => pet.getBounds().x === grabbed.x + 137 && pet.getBounds().y === grabbed.y + 91, '跟着光标走');
      const held = pet.getBounds();
      await delay(900);
      assert.deepEqual(pet.getBounds(), held, '光标不动，宠物不漂、窗口不变大');
      assert.ok(Math.abs(held.width - size[0]) <= 1 && Math.abs(held.height - size[1]) <= 1, '拖动不改窗口大小（非整数倍缩放下换算可能差一像素，但不会越来越大）');
      cursor = { x: -19000 + 40, y: -19000 + 12 };
      await until(() => pet.getBounds().x === grabbed.x + 40, '再动一下');
      await js("window.tokenpulse.deskPet.drag('end')");
      await until(() => { const pos = JSON.parse(fs.readFileSync(path.join(root, 'data', 'prefs.json'), 'utf8')).deskPetPos; return pos && pos.x === grabbed.x + 40 + size[0] / 2 && pos.y === grabbed.y + 12 + size[1]; }, '松手记住脚下中点');
    } finally { screen.getCursorScreenPoint = realCursor; }
    console.log('PASS desk pet UI: dragging follows the cursor, stays put while the cursor holds still and saves where it was dropped');

    // 点一下：冒出对话气泡。还没有官方账号：宠物说没拿到额度，下面一行任务摘要；宠物的悬停提示让开
    await js('window.tokenpulse.deskPet.click()');
    const bubble = await until(() => { const w = bubbleOf(); return w && w.isVisible() ? w : null; }, '气泡');
    const bjs = code => bubble.webContents.executeJavaScript(code);
    await until(() => bjs("!!document.querySelector('.bb-say')"), '气泡画出来');
    assert.match(await bjs("document.querySelector('.bb-say').textContent"), /^(还没拿到额度数据呢|额度数据还在路上～)$/);
    assert.equal(await bjs("document.querySelectorAll('.bb-note').length"), 1, '没有官方账号时给一句说明');
    await until(() => bjs("document.querySelector('.bb-line')?.textContent === '2 个任务在跑›'"), '一行任务摘要');
    assert.equal(await bjs("document.querySelectorAll('#bb-tail rect').length"), 21, '像素尾巴');
    assert.equal(bubble.isFocusable(), true, '气泡接焦点（失焦收起、Esc 收起）');
    await until(() => js("document.body.classList.contains('talking')"), '宠物的悬停提示让开');
    // 尾巴朝下时高度多 12，在侧边时宽度多 12（测试时宠物在屏幕外，上面放不下，尾巴在侧边）
    const fits = async () => { const [w, h, side] = await bjs("[document.getElementById('bb').offsetWidth, document.getElementById('bb').offsetHeight, document.body.dataset.side]"), b = bubble.getBounds(); const down = side === 'down'; return Math.abs(b.width - (w + 12 + (down ? 0 : 12))) <= 1 && Math.abs(b.height - (h + 12 + (down ? 12 : 0))) <= 1; };
    await until(fits, '窗口大小 = 气泡 + 描边 + 尾巴');
    // 点那一行：气泡收起，主窗口打开会话管理
    let asked = new Promise(resolve => { const contents = mainOf().webContents, send = contents.send.bind(contents); contents.send = (channel, ...args) => { if (channel === 'open-page') { contents.send = send; resolve(args[0]); } return send(channel, ...args); }; });
    await bjs("document.querySelector('button.bb-line').click()");
    assert.deepEqual(await asked, { page: 'sessions' });
    await until(() => !bubble.isVisible() && mainOf().isVisible(), '气泡收起、主窗口出来');
    await until(() => js("!document.body.classList.contains('talking')"), '悬停提示回来');
    mainOf().hide();
    console.log('PASS desk pet UI: clicking the pet pops a pixel speech bubble with the quota and a one-line task summary that opens Sessions');

    // 右键「查看任务」：同一个气泡换成任务列表，两个任务；点一条打开会话管理
    const deskPetMain = require(path.join(appRoot, 'build/main/desk-pet.js'));
    deskPetMain.openDeskPetBubble('tasks');
    await until(() => bubble.isVisible(), '气泡又出来');
    await until(() => bjs("document.querySelectorAll('.bb-task').length === 2"), '两个任务');
    const rows = await bjs("[...document.querySelectorAll('.bb-task')].map(r => [r.dataset.key, r.querySelector('b').textContent, r.querySelector('small').textContent, r.querySelector('.bb-chip').textContent])");
    const byKey = Object.fromEntries(rows.map(r => [r[0], r.slice(1)]));
    assert.equal(byKey['claude:c-1'][0], '额度卡片分级提示'); assert.match(byKey['claude:c-1'][1], /^Claude Code · demo-app · 已运行 \d+ 分钟$/); assert.equal(byKey['claude:c-1'][2], '执行工具');
    assert.equal(byKey['codex:x-1'][0], '补齐会话解析的单元测试'); assert.match(byKey['codex:x-1'][1], /^Codex · tokenpulse · 已运行 (1|不到 1) 分钟$/); assert.equal(byKey['codex:x-1'][2], '思考中');
    assert.equal(await bjs("document.querySelector('.bb-say').textContent"), '2 个任务在跑～');
    assert.equal(await bjs("document.getElementById('bb').classList.contains('tasks')"), true, '任务列表宽一些');
    asked = new Promise(resolve => { const contents = mainOf().webContents, send = contents.send.bind(contents); contents.send = (channel, ...args) => { if (channel === 'open-page') { contents.send = send; resolve(args[0]); } return send(channel, ...args); }; });
    await bjs("document.querySelector('.bb-task').click()");
    assert.deepEqual(await asked, { page: 'sessions' });
    await until(() => !bubble.isVisible(), '点任务后收起');
    mainOf().hide();
    // 主窗口藏起来以后 Windows 还会把焦点挪一下：等它落定再开气泡，免得气泡一出来就失焦收起
    await delay(500);
    console.log('PASS desk pet UI: "Show tasks" turns the bubble into the running task list; picking a task opens Sessions');

    // 有额度时怎么画：主进程送来的数据直接喂给气泡（挑哪个账号在 test-desk-pet.cjs 里测）
    deskPetMain.openDeskPetBubble('quota');
    await until(() => bubble.isVisible(), '气泡再出来');
    const base = { now: Date.now(), theme: 'light', view: 'quota', opened: 1000, place: { side: 'down', at: 120 }, scanned: true, tasks: { running: [], recent: [] } };
    const send = data => bubble.webContents.send('desk-pet-bubble', { ...base, ...data });
    send({ quota: 10, mood: 'tight', account: { kind: 'claude', name: 'Claude · ada', plan: 'Max', checkedAt: Date.now(), five: { used: 38, resetAt: Date.now() + 2 * 3600e3 + 13 * 60e3, high: false }, week: { used: 90, resetAt: Date.now() + 3 * 86400e3, high: true } } });
    await until(() => bjs("document.querySelector('.bb-acc b')?.textContent === 'Claude · ada'"), '账号名');
    assert.deepEqual(await bjs("[...document.querySelectorAll('.bb-meter')].map(m => [m.dataset.window, m.querySelector('.bb-label').textContent, m.querySelectorAll('i.on').length, m.querySelector('.bb-cells').className, m.querySelector('.bb-pct').textContent])"),
      [['five', '5 小时', 6, 'bb-cells ok', '62%'], ['week', '周', 1, 'bb-cells tight', '10%']], '剩多少亮多少格；压力高的那个窗口变黄');
    assert.match(await bjs("document.querySelector('.bb-reset').textContent"), /^2 小时 1[23] 分后重置$/);
    assert.equal(await bjs("document.querySelector('.bb-say').className"), 'bb-say tight');
    assert.equal(await bjs("document.querySelector('.bb-plan').textContent"), 'Max');
    assert.equal(await bjs("document.querySelector('.bb-line').textContent"), '没有任务在跑');
    send({ quota: 0, mood: 'empty', opened: 1001, account: { kind: 'chatgpt', name: 'ChatGPT', plan: '', checkedAt: Date.now() - 3600e3, five: { used: 100, resetAt: Date.now() + 40 * 60e3, high: true }, week: { used: 70, resetAt: Date.now() + 86400e3, high: false } } });
    await until(() => bjs("document.querySelector('.bb-say').textContent === '额度用完啦，40 分钟后恢复'"), '用完了说什么时候恢复');
    assert.equal(await bjs("document.querySelectorAll('.bb-meter')[0].querySelectorAll('i.on').length"), 0, '用完了一格都不亮');
    assert.equal(await bjs("document.querySelector('.bb-note').textContent"), '额度超过 30 分钟没有更新');
    // 宠物贴着屏幕顶时尾巴在侧边：气泡让出左边 12 像素
    send({ quota: 80, mood: 'ok', opened: 1002, place: { side: 'left', at: 50 }, account: { kind: 'claude', name: 'Claude', plan: '', checkedAt: Date.now(), five: { used: 20, resetAt: 0, high: false }, week: null } });
    await until(() => bjs("document.getElementById('bb').offsetLeft === 18"), '尾巴在左边');
    assert.equal(await bjs("Math.min(...[...document.querySelectorAll('#bb-tail rect')].map(r => +r.getAttribute('x')))"), 6, '尾巴尖在左边外沿');
    assert.match(await bjs("document.querySelector('.bb-say').textContent"), /^(额度还很充足～|还剩 80%，放心用！)$/);
    // Esc 收起
    assert.equal(bubble.isVisible(), true, 'Esc 之前气泡还开着');
    await bjs("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await until(() => !bubble.isVisible(), 'Esc 收起');
    console.log('PASS desk pet UI: the bubble draws 10-cell meters per window, says when used-up quota comes back, flags stale quota, moves the tail aside and closes on Esc');

    // 鼠标不在上面：8 秒后自己收起
    await js('window.tokenpulse.deskPet.click()');
    await until(() => bubble.isVisible(), '再点开');
    const shownAt = Date.now();
    await until(() => !bubble.isVisible(), '8 秒后自己收起', 12000);
    assert.ok(Date.now() - shownAt >= 7500, '不会太早收起');
    console.log('PASS desk pet UI: the bubble closes by itself after 8 seconds without the mouse on it');

    // 主进程发来的事件和状态
    pet.webContents.send('desk-pet-event', { type: 'celebrate' });
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'celebrate'"), '庆祝');
    pet.webContents.send('desk-pet-state', { pet: 'squirrel', scale: 2, theme: 'dark', fidget: true, badge: true, quota: 0, mood: 'empty', account: 'Claude · A', mode: 'idle', tasks: 0, waiting: 0 });
    await until(() => js("document.getElementById('dp-stage').dataset.mode === 'idle'"), '空闲');
    assert.equal(await js("document.getElementById('dp-hint').textContent"), '额度用完了 · Claude · A');
    assert.equal(await js('document.documentElement.dataset.theme'), 'dark');
    pet.webContents.send('desk-pet-state', { pet: 'squirrel', scale: 2, theme: 'light', fidget: true, badge: true, quota: 40, mood: 'ok', account: '', mode: 'sleep', tasks: 0, waiting: 0 });
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'yawn'"), '睡前打哈欠');
    console.log('PASS desk pet UI: celebrate event, quota-empty hint, theme and the yawn before sleeping');

    // 双击戳一下，不开气泡；连点四下东张西望
    const awake = { pet: 'squirrel', scale: 2, theme: 'light', fidget: false, badge: true, quota: 60, mood: 'ok', account: '', mode: 'idle', tasks: 0, waiting: 0, mini: null };
    pet.webContents.send('desk-pet-state', awake);
    await until(() => js("document.getElementById('dp-stage').dataset.mode === 'idle'"), '醒过来');
    const spot = () => js(`(() => { const c = document.getElementById('dp-canvas'), r = c.getBoundingClientRect(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = Math.floor(d.length / 2 / 4) * 4 + 3; i < d.length; i += 4) if (d[i]) { const p = (i - 3) / 4, x = r.left + (p % c.width + 0.5) * r.width / c.width; if (x > 2 && x < innerWidth - 2) return { x, y: r.top + (Math.floor(p / c.width) + 0.5) * r.height / c.height }; } })()`);
    const tap = async () => { const at = await spot(); await js(`(() => { const s = document.getElementById('dp-stage'), o = { clientX: ${at.x}, clientY: ${at.y}, screenX: 0, screenY: 0, button: 0, buttons: 1, pointerId: 7, bubbles: true }; s.dispatchEvent(new PointerEvent('pointerdown', o)); s.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); })()`); };
    await tap(); await delay(80); await tap();
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'poke'"), '双击：戳一下');
    await delay(600);
    assert.equal(!!bubbleOf()?.isVisible(), false, '双击不开气泡');
    await delay(900);
    for (let i = 0; i < 4; i++) { await tap(); await delay(60); }
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'lookaround'"), '连点四下：东张西望');
    await delay(600);
    assert.equal(!!bubbleOf()?.isVisible(), false, '连点不开气泡');
    console.log('PASS desk pet UI: a double click pokes the pet and four clicks make it look around, without opening the bubble');

    // 电脑一分钟没人动：打哈欠、打盹；有人动了醒过来
    pet.webContents.send('desk-pet-idle', 5);
    await until(() => js("!document.getElementById('dp-stage').dataset.action"), '东张西望做完', 6000);
    pet.webContents.send('desk-pet-idle', 70);
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'yawn' && document.getElementById('dp-stage').dataset.state === 'doze'"), '打哈欠、打盹');
    await until(() => js("document.getElementById('dp-hint').textContent.startsWith('在打盹')"), '提示写在打盹');
    pet.webContents.send('desk-pet-idle', 0);
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'wake' && document.getElementById('dp-stage').dataset.state === 'idle'"), '有人动了：揉眼睛醒来');
    console.log('PASS desk pet UI: after a minute without input the pet yawns and dozes, and wakes when the user is back');

    // 极简模式：贴屏幕右边只露一截，鼠标移上去探出来打招呼；从边上拖出来恢复
    const prefsNow = () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'prefs.json'), 'utf8'));
    deskPetMain.setDeskPetMini(true);
    assert.equal(prefsNow().deskPetMini, true, '记住极简模式');
    await until(() => js("document.body.classList.contains('mini') && document.getElementById('dp-stage').dataset.mini === 'tuck'"), '贴边藏着');
    const shown = () => js("Math.round(innerWidth - document.getElementById('dp-stage').getBoundingClientRect().left)");
    await until(async () => Math.abs(await shown() - Math.round(144 * 0.45)) <= 1, '只露 45%');
    await until(() => js("getComputedStyle(document.getElementById('dp-stage')).transitionDuration !== '0s'"), '探出来有过渡');
    await until(() => js("!document.getElementById('dp-stage').dataset.action"), '揉完眼睛、落地做完', 6000);
    const edge = await spot();
    assert.equal(await hover(edge.x, edge.y), true, '露出来的那截能悬停');
    await until(() => js("document.getElementById('dp-stage').dataset.mini === 'peek'"), '探出来');
    await until(async () => Math.abs(await shown() - Math.round(144 * 0.85)) <= 1, '探出 85%');
    assert.equal(await js("document.getElementById('dp-stage').dataset.action"), 'wave', '打招呼');
    assert.equal(await hover(2, 2), false);
    await until(() => js("document.getElementById('dp-stage').dataset.mini === 'tuck'"), '鼠标移开缩回去');
    deskPetMain.setDeskPetMini(false);
    assert.equal(prefsNow().deskPetMini, false);
    await until(() => js("!document.body.classList.contains('mini') && document.getElementById('dp-stage').dataset.mini === ''"), '退出极简模式');
    deskPetMain.setDeskPetMini(true);
    await until(() => js("document.body.classList.contains('mini')"), '再进极简模式');
    screen.getCursorScreenPoint = () => ({ x: -19000, y: -19000 });
    try {
      await js("window.tokenpulse.deskPet.drag('start')");
      assert.equal(prefsNow().deskPetMini, false, '从边上拽出来：退出极简模式');
      await until(() => js("!document.body.classList.contains('mini')"), '宠物回到窗口中间');
      await js("window.tokenpulse.deskPet.drag('end')");
      await until(() => js("document.getElementById('dp-stage').dataset.action === 'land'"), '落地');
    } finally { screen.getCursorScreenPoint = realCursor; }
    assert.equal(prefsNow().deskPetMini, false, '测试时不按屏幕边自动贴边');
    console.log('PASS desk pet UI: mini mode tucks the pet at the right edge, peeks out with a wave on hover, and dragging it out leaves mini mode');

    // 设置从主窗口改：大小、宠物、透明度都落到宠物窗口上
    const main = mainOf(), mjs = code => main.webContents.executeJavaScript(code);
    await until(() => mjs('typeof window.PulseDeskPet === "object"'), '主窗口加载好');
    await mjs("window.tokenpulse.writePrefs({ deskPetScale: 3, deskPetKind: 'hamster', deskPetOpacity: 70 })");
    await until(() => pet.getBounds().height === 198, '变大');
    await until(() => js("document.getElementById('dp-stage').dataset.pet === 'hamster'"), '换成仓鼠');
    assert.ok(Math.abs(pet.getOpacity() - 0.7) < 0.02, '半透明');
    console.log('PASS desk pet UI: size, pet and opacity follow the settings');

    // 「桌宠」页：总开关、三只内置 + 导入卡、选章鱼、导入自定义宠物
    await mjs("navigate('pet', { force: true })");
    await until(() => mjs("document.querySelectorAll('#page-pet .dps-choice').length === 4"), '三只宠物和导入卡');
    assert.equal(await mjs("document.getElementById('dps-toggle').getAttribute('aria-checked')"), 'true');
    assert.equal(await mjs("document.querySelector('.dps-choice.on').dataset.kind"), 'hamster', '正在用的标出来');
    assert.equal(await mjs("document.getElementById('page-pet').textContent.includes('null')"), false, '没有把空值写成「null」');
    assert.ok(await mjs("document.querySelectorAll('#page-pet canvas').length") >= 4, '有会动的预览');
    assert.equal(await mjs("document.getElementById('page-title').textContent"), '额度和任务，看一眼桌面就知道');
    await mjs("document.querySelector('.dps-choice[data-kind=octopus] .dps-pick').click()");
    await until(() => js("document.getElementById('dp-stage').dataset.pet === 'octopus'"), '换成章鱼');
    await mjs("document.getElementById('dps-import').click()");
    await until(() => mjs("document.querySelectorAll('.dps-choice[data-kind^=pet-]').length === 1"), '导入的宠物出现在列表里');
    await until(() => js("document.getElementById('dp-stage').dataset.pet.startsWith('pet-') && !document.getElementById('dp-img').hidden && document.getElementById('dp-img').src.startsWith('data:image/')"), '桌宠换成自定义的图');
    await until(() => js("document.getElementById('dp-badge').hidden === false && document.getElementById('dp-canvas').hidden"), '自定义宠物有额度标签');
    // 自定义宠物是 <img>：浏览器不能把图片拖走（以前按住一拖是拖出一张图片的虚影），按住拖动拖的是宠物窗口
    assert.deepEqual(await js("(() => { const i = document.getElementById('dp-img'), s = getComputedStyle(i), e = new DragEvent('dragstart', { bubbles: true, cancelable: true }); i.dispatchEvent(e); return [i.draggable, s.pointerEvents, s.webkitUserDrag, e.defaultPrevented]; })()"), [false, 'none', 'none', true]);
    let pointer = { x: -19000, y: -19000 };
    screen.getCursorScreenPoint = () => ({ ...pointer });
    try {
      const before = pet.getBounds();
      await js(`(() => { const s = document.getElementById('dp-stage'), r = s.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const at = el => document.elementFromPoint(x, y) === el;
        if (!at(s)) throw new Error('图片中间点下去应当落在 stage 上');
        s.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, screenX: 100, screenY: 100, button: 0, buttons: 1, pointerId: 9, bubbles: true }));
        s.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 30, clientY: y + 10, screenX: 130, screenY: 110, buttons: 1, pointerId: 9, bubbles: true })); })()`);
      await until(() => js("document.body.classList.contains('dragging') && document.getElementById('dp-stage').dataset.action === 'drag'"), '自定义宠物拖得动');
      pointer = { x: -19000 + 60, y: -19000 + 20 };
      await until(() => { const b = pet.getBounds(); return b.x !== before.x || b.y !== before.y; }, '窗口跟着光标走');
      await js("document.getElementById('dp-stage').dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, bubbles: true }))");
      await until(() => js("!document.body.classList.contains('dragging')"), '松手');
    } finally { screen.getCursorScreenPoint = realCursor; }
    assert.match(await mjs("document.querySelector('.dps-choice[data-kind^=pet-] b').textContent"), /^测试猫$/);
    // 删除要点两下；删掉正在用的那只，回到松鼠
    await mjs("document.querySelector('.dps-remove').click()");
    assert.equal(await mjs("document.querySelector('.dps-remove').textContent"), '再点一次删除');
    await mjs("document.querySelector('.dps-remove').click()");
    await until(() => mjs("document.querySelectorAll('.dps-choice[data-kind^=pet-]').length === 0"), '删掉了');
    await until(() => js("document.getElementById('dp-stage').dataset.pet === 'squirrel'"), '回到松鼠');
    console.log('PASS desk pet UI: the Desk pet page toggles, previews and switches pets, imports a custom pet (shown with a quota badge) and deletes it with a double click');

    // 关掉：宠物窗口没了
    await mjs("document.getElementById('dps-toggle').click()");
    await until(() => !petOf() && !bubbleOf(), '关掉后窗口销毁');
    await until(() => mjs("document.getElementById('dps-toggle').getAttribute('aria-checked') === 'false' && document.getElementById('dps-reset').disabled"), '开关显示为关、「放回右下角」不可点');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'prefs.json'), 'utf8')).deskPet, false);
    console.log('PASS desk pet UI: turning it off destroys the pet window and saves the setting');
  } catch (error) { failed = true; console.error('FAIL', error.stack || error.message); }
  finally { setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结果 */ } app.exit(failed ? 1 : 0); }, 300); }
});
require(path.join(appRoot, 'build/main/index.js'));
