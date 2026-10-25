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
fs.writeFileSync(path.join(petFolder, 'pet.json'), JSON.stringify({ name: '测试猫', author: 'QA', states: { idle: 'idle.png', work: 'work.gif', tight: 'work.gif' } }));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [petFolder] });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (probe, label, ms = 10000) => { const end = Date.now() + ms; for (;;) { const value = await probe(); if (value) return value; if (Date.now() > end) throw new Error('等不到：' + label); await delay(60); } };
const live = () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
const petOf = () => live().find(w => w.webContents.getURL().includes('desk-pet.html'));
const bubbleOf = () => live().find(w => w.webContents.getURL().includes('desk-pet-bubble.html'));
const mainOf = () => live().find(w => w.webContents.getURL().includes('index.html'));
setTimeout(() => { console.error('FAIL desk pet UI timed out'); app.exit(1); }, 200000);

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

    // 提示音：做完、出错、可能在等你各响各的；挨得太近只响一声；设置里关掉就不响（动作照做）。测试里不真的放声音，记下要放哪个
    await js("window.__sounds = []; window.PulsePetSound.play = kind => (window.__sounds.push(kind), true); true");
    const sounds = () => js('window.__sounds.slice()');
    pet.webContents.send('desk-pet-state', { ...awake, sound: true });
    await until(() => js("!document.getElementById('dp-stage').dataset.action"), '先把手上的动作做完', 6000);
    pet.webContents.send('desk-pet-event', { type: 'alert', kind: 'error' });
    await until(async () => (await sounds()).join() === 'error', '出错：响一声');
    assert.equal(await js("document.getElementById('dp-stage').dataset.action"), 'startle', '出错：吓一跳');
    pet.webContents.send('desk-pet-event', { type: 'celebrate' });
    await delay(300);
    assert.deepEqual(await sounds(), ['error'], '挨得太近：只响一声');
    await delay(1400);
    pet.webContents.send('desk-pet-event', { type: 'celebrate' });
    await until(async () => (await sounds()).join() === 'error,done', '做完：响做完的调子');
    await delay(1600);
    pet.webContents.send('desk-pet-event', { type: 'alert', kind: 'waiting' });
    await until(async () => (await sounds()).join() === 'error,done,waiting', '可能在等你');
    assert.equal(await js("document.getElementById('dp-stage').dataset.action"), 'wave', '在等你：挥手叫你');
    await delay(1600);
    pet.webContents.send('desk-pet-state', { ...awake, sound: false });
    await delay(100);
    pet.webContents.send('desk-pet-event', { type: 'alert', kind: 'error' });
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'startle'"), '关了提示音动作照做');
    await delay(300);
    assert.deepEqual(await sounds(), ['error', 'done', 'waiting'], '关了就不响');
    assert.equal(await js("typeof window.PulsePetSound === 'object' && document.querySelector('script[src=\"pet-sound.js\"]') !== null"), true);
    console.log('PASS desk pet UI: finished, failed and waiting tasks play their own short sounds, close calls play once, and turning sounds off keeps the moves but stays quiet');

    // 单独关掉一种：动作照做、不响；音量按设置
    await js("window.__sounds = []; window.PulsePetSound.play = (kind, volume) => (window.__sounds.push(kind + '@' + volume), true); true");
    await delay(1600);
    pet.webContents.send('desk-pet-state', { ...awake, sound: true, volume: 40, mute: ['ask'] });
    await delay(100);
    pet.webContents.send('desk-pet-event', { type: 'alert', kind: 'ask' });
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'wave'"), '在问你：挥手叫你');
    await delay(300);
    assert.deepEqual(await sounds(), [], '关掉的那种不响');
    await delay(1600);
    pet.webContents.send('desk-pet-state', { ...awake, sound: true, volume: 40, mute: ['done'] });
    await delay(100);
    pet.webContents.send('desk-pet-event', { type: 'alert', kind: 'ask' });
    await until(async () => (await sounds()).join() === 'ask@0.4', '在问你：响「嗯？」，按音量');
    console.log('PASS desk pet UI: each sound can be muted on its own (the pet still waves) and plays at the chosen volume');

    // 问题卡片：会话里写进一个还没回答的 AskUserQuestion → 屏幕右下角弹卡片（测试时在屏幕外），写着问题和选项，不抢焦点
    const askOf = () => live().find(w => w.webContents.getURL().includes('desk-pet-ask.html'));
    const c1 = path.join(claudeDir, 'c-1.jsonl');
    await delay(1600);
    await js('window.__sounds = []');
    fs.appendFileSync(c1, line({ type: 'assistant', timestamp: ago(0), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [{ header: '方案', question: '额度紧张时用哪种提示？', multiSelect: true, options: [{ label: '分级颜色', description: '按剩余额度变色' }, { label: '弹通知', description: '' }] }] } }] } }) + '\n');
    const askWin = await until(() => { const w = askOf(); return w && w.isVisible() ? w : null; }, '问题卡片', 15000);
    const ajs = code => askWin.webContents.executeJavaScript(code);
    assert.equal(askWin.isFocusable(), false, '卡片不抢焦点');
    await until(() => ajs("document.querySelectorAll('.ak-card').length === 1"), '卡片画出来');
    assert.deepEqual(await ajs("[document.querySelector('.ak-head b').textContent, document.querySelector('.ak-head span').textContent, document.querySelector('.ak-say').textContent, document.querySelector('.ak-question').textContent, [...document.querySelectorAll('.ak-opts li')].map(li => li.textContent), document.querySelector('.ak-multi').textContent, document.querySelector('.ak-foot small').textContent]"),
      ['Claude Code', 'demo-app · 额度卡片分级提示', '有个问题想问你', '方案额度紧张时用哪种提示？', ['1分级颜色按剩余额度变色', '2弹通知'], '可以多选', '回到终端里回答']);
    await until(() => { const b = askWin.getBounds(); return b.width === 332 && b.height > 100; }, '窗口大小 = 卡片 + 描边投影');
    await until(async () => (await sounds()).some(item => item.startsWith('ask@')), '主进程发来「在问你」：响一声').catch(async error => { console.error('heard', await sounds()); throw error; });
    await until(() => js("/1 个在问你/.test(document.getElementById('dp-hint').textContent)"), '悬停提示写着在问你');
    // 点「知道了」：卡片收起；同一个问题不会再弹
    await ajs("document.querySelector('.ak-btn').click()");
    await until(() => !askOf(), '知道了：收起');
    await delay(4500);
    assert.equal(askOf(), undefined, '同一个问题不再弹');
    // 回答了，接着又写好计划等你批准：新卡片
    fs.appendFileSync(c1, [line({ type: 'user', timestamp: ago(0), message: { content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: '分级颜色' }] } }), line({ type: 'assistant', timestamp: ago(0), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: { plan: '# 计划\n1. 改额度卡片\n2. 补测试' } }] } })].join('\n') + '\n');
    const planWin = await until(() => { const w = askOf(); return w && w.isVisible() ? w : null; }, '计划卡片', 15000);
    const pjs = code => planWin.webContents.executeJavaScript(code);
    await until(() => pjs("document.querySelector('.ak-card')?.dataset.tool === 'ExitPlanMode'"), '计划卡片画出来');
    assert.deepEqual(await pjs("[document.querySelector('.ak-say').textContent, document.querySelector('.ak-plan').textContent, document.querySelector('.ak-foot small').textContent]"), ['计划写好了，等你批准', '# 计划\n1. 改额度卡片\n2. 补测试', '回到终端里批准或修改']);
    // 在终端里批准了（有了结果）：卡片自己收起
    fs.appendFileSync(c1, line({ type: 'user', timestamp: ago(0), message: { content: [{ type: 'tool_result', tool_use_id: 'plan-1', content: 'approved' }] } }) + '\n');
    await until(() => !askOf(), '回答了：卡片自己收起', 15000);
    console.log('PASS desk pet UI: a pending question pops a card with the question and options (without taking focus), "Got it" puts it away, a plan waiting for approval gets its own card and answering in the terminal closes it');

    // 极简模式：躲在屏幕右边后面探头（以脚为轴往左歪），鼠标移上去探得更出来、打招呼；从边上拖出来恢复
    const prefsNow = () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'prefs.json'), 'utf8'));
    deskPetMain.setDeskPetMini(true);
    assert.equal(prefsNow().deskPetMini, true, '记住极简模式');
    await until(() => js("document.body.classList.contains('mini') && document.getElementById('dp-stage').dataset.mini === 'tuck'"), '贴边藏着');
    const angle = () => js("(() => { const m = new DOMMatrix(getComputedStyle(document.getElementById('dp-stage')).transform); return Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI); })()");
    // 画面上宠物从屏幕右边探出来多宽（CSS 像素）：截窗口，找最左边一列有颜色的（只看提示条下面）
    const outWidth = async () => {
      const image = await pet.webContents.capturePage(), { width, height } = image.getSize(), bits = image.toBitmap(), k = width / (await js('innerWidth'));
      for (let x = 0; x < width; x++) for (let y = Math.round(34 * k); y < height; y++) if (bits[(y * width + x) * 4 + 3] > 40) return Math.round((width - x) / k);
      return 0;
    };
    await until(async () => await angle() === -30, '平时歪 30 度，只有头探出来');
    const tucked = await outWidth();
    // 测试用的是松鼠：身体 42 格宽，放大两倍是 84 像素；平时探出 55%
    assert.ok(tucked > 84 * 0.4 && tucked < 84 * 0.7, `平时探出一点，实际 ${tucked}`);
    await until(() => js("getComputedStyle(document.getElementById('dp-stage')).transitionDuration !== '0s'"), '探出来有过渡');
    await until(() => js("!document.getElementById('dp-stage').dataset.action"), '揉完眼睛、落地做完', 6000);
    // 从屏幕边往里一格一格移鼠标，碰到宠物就算悬停上了（歪着的宠物要按转回去的位置判断）
    const edge = await js(`(() => { for (let y = innerHeight - 4; y > 40; y -= 4) for (let x = innerWidth - 2; x > innerWidth - 90; x -= 3) {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      if (document.body.classList.contains('hover')) return { x, y }; } return null; })()`);
    assert.ok(edge, '探出来的头能悬停');
    assert.equal(await hover(2, 2), false, '透明的地方不算');
    await hover(edge.x, edge.y);
    await until(() => js("document.getElementById('dp-stage').dataset.mini === 'peek'"), '探出来');
    await until(async () => await angle() === -20, '探出来时身子直一些');
    await until(async () => await outWidth() > tucked + 8, '探得更出来');
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
    // 提示音开关：关掉存下来；打开时试听一下（测试里记下要放哪个，不真放）
    await mjs("window.__played = []; window.PulsePetSound.play = kind => (window.__played.push(kind), true); true");
    const pickSound = label => mjs(`(async () => { document.getElementById('dps-sound').click(); await new Promise(r => setTimeout(r, 50));
      const item = [...document.querySelectorAll('#option-menu .option-item')].find(b => b.textContent.trim().startsWith('${label}')); item.click(); })()`);
    assert.match(await mjs("document.getElementById('dps-sound').textContent"), /^开/);
    await pickSound('关');
    await until(() => JSON.parse(fs.readFileSync(path.join(root, 'data', 'prefs.json'), 'utf8')).deskPetSound === false, '关掉提示音存下来');
    assert.deepEqual(await mjs('window.__played'), [], '关的时候不试听');
    await pickSound('开');
    await until(() => JSON.parse(fs.readFileSync(path.join(root, 'data', 'prefs.json'), 'utf8')).deskPetSound === true, '打开提示音存下来');
    assert.deepEqual(await mjs('window.__played'), ['done'], '打开时试听一下');
    // 问题卡片开关、音量、每种提示音单独关掉 / 换成自己的音频 / 恢复默认
    const prefsFile = () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'prefs.json'), 'utf8'));
    const pickOption = (id, label) => mjs(`(async () => { document.getElementById('${id}').click(); await new Promise(r => setTimeout(r, 50));
      const item = [...document.querySelectorAll('#option-menu .option-item')].find(b => b.textContent.trim().startsWith('${label}')); item.click(); })()`);
    await pickOption('dps-ask', '不弹');
    await until(() => prefsFile().deskPetAsk === false, '不弹问题卡片存下来');
    await pickOption('dps-ask', '弹出卡片');
    await until(() => prefsFile().deskPetAsk === true, '弹问题卡片存下来');
    await pickOption('dps-volume', '50%');
    await until(() => prefsFile().deskPetVolume === 50, '音量存下来');
    assert.deepEqual(await mjs("[...document.querySelectorAll('.dps-sound')].map(row => row.dataset.kind)"), ['done', 'ask', 'waiting', 'error', 'empty']);
    await mjs("document.querySelector('[data-mute=waiting]').click()");
    await until(() => prefsFile().deskPetMute?.join() === 'waiting', '单独关掉「可能在等你」');
    await until(() => mjs("document.querySelector('.dps-sound[data-kind=waiting]').classList.contains('muted') && document.querySelector('[data-play=waiting]').disabled"), '关掉的那一行变灰、不能试听');
    // 换成自己的音频：一段 0.1 秒的 WAV（Chromium 解得出来）
    const wavFile = path.join(root, 'ding.wav'), samples = 800, wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0, 'latin1'); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8, 'latin1'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36, 'latin1'); wav.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 4) * 8000), 44 + i * 2);
    fs.writeFileSync(wavFile, wav);
    const pickFolder = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [wavFile] });
    try {
      await mjs("window.__played = []; document.querySelector('[data-pick=done]').click()");
      await until(() => mjs("document.querySelector('.dps-sound[data-kind=done] small.mine')?.textContent === '自己的音频：ding.wav'"), '换成自己的音频');
      await until(() => mjs("window.PulsePetSound.hasCustom('done') && window.__played.join() === 'done'"), '设置页解码好、试听一下');
      assert.ok(fs.existsSync(path.join(root, 'data', 'pet-sounds', 'done.wav')), '复制到数据目录');
      await until(() => js("window.PulsePetSound.hasCustom('done')"), '桌宠窗口也换上了');
    } finally { dialog.showOpenDialog = pickFolder; }
    await mjs("document.querySelector('[data-reset=done]').click()");
    await until(() => mjs("!document.querySelector('[data-reset=done]') && !window.PulsePetSound.hasCustom('done')"), '恢复默认');
    await until(() => js("!window.PulsePetSound.hasCustom('done')"), '桌宠窗口也恢复默认');
    assert.equal(fs.existsSync(path.join(root, 'data', 'pet-sounds', 'done.wav')), false);
    assert.equal(await mjs("document.getElementById('page-title').textContent"), '额度和任务，看一眼桌面就知道');
    await mjs("document.querySelector('.dps-choice[data-kind=octopus] .dps-pick').click()");
    await until(() => js("document.getElementById('dp-stage').dataset.pet === 'octopus'"), '换成章鱼');
    await mjs("document.getElementById('dps-import').click()");
    await until(() => mjs("document.querySelectorAll('.dps-choice[data-kind^=pet-]').length === 1"), '导入的宠物出现在列表里');
    await until(() => js("document.getElementById('dp-stage').dataset.pet.startsWith('pet-') && !document.getElementById('dp-img').hidden && document.getElementById('dp-img').src.startsWith('data:image/')"), '桌宠换成自定义的图');
    await until(() => js("document.getElementById('dp-badge').hidden === false && document.getElementById('dp-canvas').hidden"), '自定义宠物有额度标签');
    // 额度紧张：自定义宠物和内置的一样，平时用 idle 图，隔一阵紧张一下才换 tight 图（以前一直放 tight 图，看着一直在冒汗）
    const custom = await js("document.getElementById('dp-stage').dataset.pet");
    pet.webContents.send('desk-pet-state', { pet: custom, scale: 3, theme: 'light', fidget: false, badge: true, sound: false, quota: 12, mood: 'tight', account: '', mode: 'idle', tasks: 0, waiting: 0, mini: null });
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'idle'"), '紧张时平时照常待着');
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'tight'"), '隔一阵紧张一下', 5000);
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'idle'"), '两三秒后恢复平静', 5000);
    deskPetMain.pushDeskPet(true);
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

    // 主题包（Clawd on Desk 格式）：用自己画的方块小人测试。导入后 SVG 画在 Shadow DOM 里，动画自带的 CSS 生效；
    // 眼睛跟着鼠标、思考和跑工具分开、多任务换姿势、在问你、绕两圈转晕、双击、出错都换对应的动画
    const themeDir = path.join(root, 'cube-theme');
    fs.mkdirSync(path.join(themeDir, 'assets'), { recursive: true });
    const cube = (color, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 40 40" width="500" height="500"><defs><style>#eyes-js, #body-js { transition: transform 0.2s ease-out; } .bob { animation: bob 1s infinite; } @keyframes bob { 50% { transform: translateY(1px); } }</style></defs>${extra}<g id="shadow-js"><rect x="2" y="18" width="16" height="1" opacity=".4"/></g><g id="body-js"><g class="bob"><rect x="2" y="6" width="16" height="12" fill="${color}"/><g id="eyes-js"><rect x="6" y="10" width="2" height="2"/><rect x="12" y="10" width="2" height="2"/></g></g></g></svg>`;
    const cubeFiles = { 'idle.svg': cube('#e9a'), 'think.svg': cube('#9ae'), 'work.svg': cube('#9e9'), 'busy.svg': cube('#ee9'), 'ask.svg': cube('#fc6'), 'oops.svg': cube('#f66', '<script>window.__hacked = 1</script><rect onclick="window.__hacked = 2" width="1" height="1"/>'), 'dizzy.svg': cube('#c9f'), 'poke.svg': cube('#f9c'), 'drag.svg': cube('#aaa'),
      'juggle.svg': cube('#6cf'), 'look.svg': cube('#cf6'), 'mi.svg': cube('#e9a'), 'me.svg': cube('#9cc'), 'mp.svg': cube('#c9c') };
    for (const [name, content] of Object.entries(cubeFiles)) fs.writeFileSync(path.join(themeDir, 'assets', name), content);
    fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify({
      schemaVersion: 1, name: '方块', author: 'QA', viewBox: { x: -10, y: -10, width: 40, height: 40 }, layout: { contentBox: { x: 0, y: 4, width: 20, height: 16 }, centerX: 10, baselineY: 19 },
      eyeTracking: { enabled: true, states: ['idle', 'mini-idle'], maxOffset: 2, bodyScale: 0.5, shadowStretch: 0.2, shadowShift: 0.5, ids: { eyes: 'eyes-js', body: 'body-js', shadow: 'shadow-js' } },
      states: { idle: ['idle.svg'], thinking: ['think.svg'], working: ['work.svg'], notification: ['ask.svg'], error: ['oops.svg'], dizzy: ['dizzy.svg'] },
      workingTiers: [{ minSessions: 2, file: 'busy.svg' }], jugglingTiers: [{ minSessions: 1, file: 'juggle.svg' }], reactions: { drag: { file: 'drag.svg' }, double: { files: ['poke.svg'], duration: 2000 } },
      idleAnimations: [{ file: 'look.svg', duration: 1500 }],
      timings: { autoReturn: { dizzy: 2500, error: 2000 }, mouseIdleTimeout: 3000 }, hitBoxes: { default: { x: 2, y: 6, w: 16, h: 12 } },
      miniMode: { supported: true, offsetRatio: 0.5, peek: { offsetRatio: 0.25 }, timings: { autoReturn: { 'mini-enter': 800, 'mini-peek': 700 } }, states: { 'mini-idle': ['mi.svg'], 'mini-enter': ['me.svg'], 'mini-peek': ['mp.svg'] } },
    }));
    // 真鼠标别来捣乱：主进程看到的光标固定住（不变就不发），鼠标位置全由测试发
    screen.getCursorScreenPoint = () => ({ x: -19000, y: -19000 });
    const pickTheme = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [themeDir] });
    try {
      await mjs("document.getElementById('dps-import').click()");
      await until(() => mjs("document.querySelectorAll('.dps-choice[data-kind^=pet-]').length === 1"), '主题包出现在列表里');
    } finally { dialog.showOpenDialog = pickTheme; }
    assert.match(await mjs("document.querySelector('.dps-choice[data-kind^=pet-] small').textContent"), /^作者：QA$/);
    assert.match(await mjs("document.querySelector('.dps-choice[data-kind^=pet-] img').src"), /^data:image\/svg\+xml;base64,/, '设置页预览用 idle');
    const themeId = await mjs("document.querySelector('.dps-choice[data-kind^=pet-]').dataset.kind");
    const sroot = "document.getElementById('dp-svg').shadowRoot";
    await until(() => js(`document.getElementById('dp-stage').dataset.pet === '${themeId}' && !document.getElementById('dp-svg').hidden && !!${sroot}.querySelector('svg')`), '桌宠换成主题包，SVG 画在 Shadow DOM 里');
    assert.deepEqual(await js("['dp-canvas', 'dp-img'].map(id => document.getElementById(id).hidden)"), [true, true]);
    const idleView = { pet: themeId, scale: 3, theme: 'light', fidget: false, badge: false, sound: false, quota: 60, mood: 'ok', account: '', mode: 'idle', phase: null, tasks: 0, waiting: 0, asking: 0, mini: null };
    pet.webContents.send('desk-pet-state', idleView);
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'idle.svg'"), '待机动画');
    assert.equal(await js(`getComputedStyle(${sroot}.querySelector('.bob')).animationName`), 'bob', '动画自带的 CSS 生效（只在 Shadow DOM 里）');
    assert.equal(await js(`getComputedStyle(${sroot}.getElementById('eyes-js')).transitionDuration`), '0.06s', '跟随用的元素：自带的 0.2 秒过渡换成很短的，不拖尾');
    assert.equal(await js("getComputedStyle(document.body).transitionDuration"), '0s', '不影响外面');
    // 身体画在舞台底边中间附近、大小按身体框放大（先让它看正前方：身体会跟着眼睛挪）
    pet.webContents.send('desk-pet-cursor', { x: 0, y: 0 });
    // 跟随有 60 毫秒的过渡：等它走完再量
    await delay(150);
    const bodyRect = await js(`(() => { const r = ${sroot}.querySelector('svg rect[fill]').getBoundingClientRect(), s = document.getElementById('dp-stage').getBoundingClientRect(); return { w: r.width, h: r.height, cx: r.left + r.width / 2 - s.left - s.width / 2, bottom: s.bottom - r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    assert.ok(Math.abs(bodyRect.w - 16 * 8.64) < 3 && Math.abs(bodyRect.cx) < 2 && bodyRect.bottom > 0 && bodyRect.bottom < 20, `身体的位置和大小 ${JSON.stringify(bodyRect)}`);
    assert.equal(await hover(bodyRect.x, bodyRect.y), true, '身体上算悬停');
    assert.equal(await hover(2, 2), false, '透明的地方不算');
    // 眼睛跟着鼠标：鼠标在右边远处，眼睛挪满 maxOffset（2），身体跟着挪一半，影子往右拉长。
    // 收到位置就画好，不等下一帧慢慢挪：紧跟着的这次检查（同一条 IPC 通道，排在后面）就已经到位
    pet.webContents.send('desk-pet-cursor', { x: 400, y: 0 });
    assert.equal(await js(`${sroot}.getElementById('eyes-js').style.transform`), 'translate(2px, 0px)', '眼睛立刻往右看');
    assert.equal(await js(`${sroot}.getElementById('body-js').style.transform`), 'translate(1px, 0px)');
    assert.match(await js(`${sroot}.getElementById('shadow-js').style.transform`), /^translate\(1px, 0px\) scaleX\(1\.2\)$/);
    pet.webContents.send('desk-pet-cursor', { x: -400, y: 300 });
    assert.equal(await js(`${sroot}.getElementById('eyes-js').style.transform`), 'translate(-2px, 1px)', '眼睛立刻往左下看（竖着只挪一半）');
    // 思考、跑工具、多任务、在问你
    pet.webContents.send('desk-pet-state', { ...idleView, mode: 'work', phase: 'thinking', tasks: 1 });
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'think.svg' && document.getElementById('dp-stage').dataset.phase === 'thinking'"), '在想');
    assert.equal(await js(`${sroot}.getElementById('eyes-js').style.transform`), '', '不是待机动画：眼睛不跟');
    pet.webContents.send('desk-pet-state', { ...idleView, mode: 'work', phase: 'tool', tasks: 1 });
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'work.svg'"), '跑工具');
    pet.webContents.send('desk-pet-state', { ...idleView, mode: 'work', phase: 'tool', tasks: 2 });
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'busy.svg'"), '两个任务：更忙的姿势');
    pet.webContents.send('desk-pet-state', { ...idleView, mode: 'work', phase: 'waiting', tasks: 1, waiting: 1, asking: 1 });
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'ask.svg'"), '在问你');
    // 出错：换出错的动画；SVG 里的脚本、事件属性早在导入时去掉了
    pet.webContents.send('desk-pet-state', idleView);
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'idle.svg'"), '回到待机');
    pet.webContents.send('desk-pet-event', { type: 'alert', kind: 'error' });
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'error' && document.getElementById('dp-stage').dataset.image === 'oops.svg'"), '出错的动画');
    assert.deepEqual(await js(`[!!${sroot}.querySelector('script'), !!${sroot}.querySelector('[onclick]'), window.__hacked ?? null]`), [false, false, null], '没有脚本');
    await until(() => js("!document.getElementById('dp-stage').dataset.action"), '出错的动画按主题写的 2 秒放完', 4000);
    // 鼠标绕着转两圈：晕
    for (let k = 0; k <= 36; k++) { const a = k * Math.PI / 8; pet.webContents.send('desk-pet-cursor', { x: Math.round(Math.cos(a) * 110), y: Math.round(Math.sin(a) * 110) }); await delay(30); }
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'dizzy' && document.getElementById('dp-stage').dataset.image === 'dizzy.svg'"), '转晕了');
    await until(() => js("!document.getElementById('dp-stage').dataset.action"), '晕 2.5 秒后恢复', 5000);
    // 双击：主题的双击反应
    const tapAt = async () => { await js(`(() => { const s = document.getElementById('dp-stage'), o = { clientX: ${bodyRect.x}, clientY: ${bodyRect.y}, screenX: 0, screenY: 0, button: 0, buttons: 1, pointerId: 11, bubbles: true }; s.dispatchEvent(new PointerEvent('pointerdown', o)); s.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); })()`); };
    await tapAt(); await delay(80); await tapAt();
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'poke' && document.getElementById('dp-stage').dataset.image === 'poke.svg'"), '双击反应');
    console.log('PASS desk pet UI: a Clawd on Desk format theme imports, draws its sanitized SVG in a shadow root with its own CSS, follows the mouse with its eyes, separates thinking from tool work, gets dizzy from circling and plays its reactions');

    // 第二期：子代理在跑换「同时忙好几件」；鼠标不动一阵放随机待机；极简模式用主题自己的探头动画
    await until(() => js("!document.getElementById('dp-stage').dataset.action"), '双击反应放完', 4000);
    pet.webContents.send('desk-pet-state', { ...idleView, mode: 'work', phase: 'thinking', tasks: 1, subagents: 2 });
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'juggle.svg'"), '有子代理在跑');
    pet.webContents.send('desk-pet-state', { ...idleView, fidget: true });
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'idle.svg'"), '回到待机');
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'idle:0' && document.getElementById('dp-stage').dataset.image === 'look.svg'"), '鼠标 3 秒没动：随机待机', 25000);
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'idle.svg'"), '按主题写的 1.5 秒放完', 4000);
    pet.webContents.send('desk-pet-state', { ...idleView, fidget: true, mini: { tuck: { tilt: 30, show: 0.55 }, peek: { tilt: 20, show: 0.75 } } });
    await until(() => js("document.getElementById('dp-stage').dataset.action === 'miniEnter' && document.getElementById('dp-stage').dataset.image === 'me.svg'"), '钻进屏幕边：mini-enter');
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'mi.svg'"), '放完换 mini-idle', 4000);
    assert.equal(await js("document.getElementById('dp-stage').style.transform"), 'none', '主题自己画了探头的样子：不歪');
    // 画面宽度的一半（offsetRatio）藏在窗口右边外面
    const svgBox = () => js(`(() => { const r = ${sroot}.querySelector('svg').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height, edge: innerWidth }; })()`);
    await delay(400);
    const tuckBox = await svgBox();
    assert.ok(Math.abs(tuckBox.left + tuckBox.w / 2 - tuckBox.edge) < 2, `藏一半 ${JSON.stringify(tuckBox)}`);
    pet.webContents.send('desk-pet-cursor', { x: -300, y: 0 });
    assert.equal(await js(`${sroot}.getElementById('eyes-js').style.transform`), 'translate(-2px, 0px)', 'mini-idle 写在 eyeTracking.states 里：眼睛跟着');
    // 鼠标移到露出来的身子上：探出来（mini-peek），往外滑画面宽度的 25%；放够 0.7 秒没有 mini-peek-hold 回 mini-idle
    assert.equal(await hover(tuckBox.left + (6 + 10) / 40 * tuckBox.w, tuckBox.top + (12 + 10) / 40 * tuckBox.h), true, '露出来的身子能悬停');
    await until(() => js("document.getElementById('dp-stage').dataset.mini === 'peek' && document.getElementById('dp-stage').dataset.image === 'mp.svg'"), '探头 mini-peek');
    assert.notEqual(await js("document.getElementById('dp-stage').dataset.action"), 'wave', '主题的探头动画自己会打招呼，不另外挥手');
    await delay(450);
    const peekBox = await svgBox();
    assert.ok(Math.abs(tuckBox.left - peekBox.left - 0.25 * tuckBox.w) < 2, `往外滑 25% ${JSON.stringify([tuckBox, peekBox])}`);
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'mi.svg'"), '探头放完回 mini-idle', 3000);
    assert.equal(await hover(2, 2), false);
    await until(() => js("document.getElementById('dp-stage').dataset.mini === 'tuck'"), '鼠标移开缩回去');
    pet.webContents.send('desk-pet-state', idleView);
    await until(() => js("document.getElementById('dp-stage').dataset.image === 'idle.svg' && !document.body.classList.contains('mini')"), '退出极简模式');
    console.log('PASS desk pet UI: theme phase 2 — subagents switch to the juggling pose, a resting mouse plays the theme\'s idle animations, and mini mode uses the theme\'s own enter / idle / peek animations at its own offsets');
    deskPetMain.pushDeskPet(true);
    await mjs("document.querySelector('.dps-remove').click()"); await mjs("document.querySelector('.dps-remove').click()");
    await until(() => js("document.getElementById('dp-stage').dataset.pet === 'squirrel' && document.getElementById('dp-svg').hidden && !document.getElementById('dp-canvas').hidden"), '删掉后回到松鼠');
    screen.getCursorScreenPoint = realCursor;

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
