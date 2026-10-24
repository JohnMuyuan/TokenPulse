'use strict';
/*
 * 桌宠（0.3.61）里不依赖窗口的部分：
 * - core/agent-activity.ts：从 Claude Code / Codex 会话文件推断任务状态，扫描器找最近的会话、发现「刚做完」；
 * - core/desk-pet-model.ts：设置项的收口、宠物跟的额度、睡觉判断、宠物和对话气泡放在哪；
 * - core/pet-pack.ts：自定义宠物文件夹的校验、导入、列表、删除。
 * 宠物窗口和对话气泡的界面在 test-desk-pet-ui.cjs（Electron）。全部在临时目录里跑，不碰真实的 ~/.claude、~/.codex、~/.tokenpulse。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-desk-pet-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
const activity = require('../build/core/agent-activity');
const model = require('../build/core/desk-pet-model');
const packs = require('../build/core/pet-pack');
const { readPrefs } = require('../build/main/prefs');

const T0 = Date.parse('2026-10-22T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const line = value => JSON.stringify(value);
const claudeUser = (s, text, extra = {}) => line({ type: 'user', timestamp: at(s), sessionId: 'c-1', cwd: 'D:\\work\\demo-app', message: { role: 'user', content: text }, ...extra });
const claudeAsst = (s, blocks, stop, extra = {}) => line({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', stop_reason: stop, content: blocks }, ...extra });
const toolResult = s => line({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });

let failed = false;
const check = (name, fn) => { try { fn(); console.log('PASS', name); } catch (error) { failed = true; console.error('FAIL', name, '\n', error.stack || error.message); } };
const checkAsync = async (name, fn) => { try { await fn(); console.log('PASS', name); } catch (error) { failed = true; console.error('FAIL', name, '\n', error.stack || error.message); } };

check('desk pet: Claude Code turn states from the session tail', () => {
  const prompt = claudeUser(0, '把额度卡片改成分级提示');
  assert.deepEqual(activity.inferClaude([prompt]), { status: 'thinking', since: T0, at: T0, tool: undefined, doneAt: undefined });
  const tool = claudeAsst(5, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], 'tool_use');
  assert.equal(activity.inferClaude([prompt, claudeAsst(3, [{ type: 'thinking', thinking: '…' }], 'tool_use'), tool]).status, 'tool');
  assert.equal(activity.inferClaude([prompt, tool]).tool, 'Bash');
  assert.equal(activity.inferClaude([prompt, tool, toolResult(9)]).status, 'thinking', '工具有结果了：模型接着想');
  const done = activity.inferClaude([prompt, tool, toolResult(9), claudeAsst(20, [{ type: 'text', text: '改好了' }], 'end_turn')]);
  assert.equal(done.status, 'done'); assert.equal(done.doneAt, T0 + 20000); assert.equal(done.since, T0);
  // stop_hook_summary / turn_duration 也算这一轮结束（有的版本 end_turn 行在读到的范围之前）
  assert.equal(activity.inferClaude([prompt, tool, toolResult(9), line({ type: 'system', subtype: 'turn_duration', timestamp: at(30) })]).status, 'done');
  // 用户中断
  assert.equal(activity.inferClaude([prompt, tool, claudeUser(12, '[Request interrupted by user for tool use]')]).status, 'done');
  // 斜杠命令、CLI 自己塞进来的东西不算新一轮
  assert.equal(activity.inferClaude([prompt, claudeAsst(4, [{ type: 'text', text: 'hi' }], 'end_turn'), claudeUser(8, '<command-name>/clear</command-name>'), claudeUser(9, '<local-command-stdout></local-command-stdout>')]).status, 'done');
  // 子代理、meta 行不影响主会话
  assert.equal(activity.inferClaude([prompt, claudeAsst(4, [{ type: 'text', text: 'x' }], 'end_turn'), claudeUser(6, 'sub task', { isSidechain: true }), claudeAsst(7, [{ type: 'tool_use', name: 'Read' }], 'tool_use', { isSidechain: true })]).status, 'done');
  // 读到的尾巴从一轮中间开始：以第一条回复为准
  const mid = activity.inferClaude([toolResult(1), claudeAsst(2, [{ type: 'tool_use', name: 'Edit' }], 'tool_use')]);
  assert.equal(mid.status, 'tool'); assert.equal(mid.since, T0 + 1000);
  assert.equal(activity.inferClaude(['not json', '{"broken"', line({ type: 'mode' })]), null, '没有对话行');
  // 下一轮开始：since 换成新的提问时间
  const next = activity.inferClaude([prompt, claudeAsst(4, [{ type: 'text', text: 'a' }], 'end_turn'), claudeUser(60, '再加个测试')]);
  assert.equal(next.status, 'thinking'); assert.equal(next.since, T0 + 60000); assert.equal(next.doneAt, undefined);
});

check('desk pet: Codex turn states from task_started / task_complete and pending tool calls', () => {
  const ev = (s, type) => line({ type: 'event_msg', timestamp: at(s), payload: { type } });
  const item = (s, payload) => line({ type: 'response_item', timestamp: at(s), payload });
  const started = ev(0, 'task_started');
  assert.equal(activity.inferCodex([started]).status, 'thinking');
  const call = (s, id, name) => item(s, { type: 'function_call', call_id: id, name, arguments: '{}' });
  const out = (s, id) => item(s, { type: 'function_call_output', call_id: id, output: 'ok' });
  assert.deepEqual(activity.inferCodex([started, call(2, 'a', 'shell')]), { status: 'tool', since: T0, at: T0 + 2000, tool: 'shell', doneAt: undefined });
  assert.equal(activity.inferCodex([started, call(2, 'a', 'shell'), call(3, 'b', 'apply_patch'), out(4, 'b')]).tool, 'shell', '并行调用：还有没回来的就仍在跑工具');
  assert.equal(activity.inferCodex([started, call(2, 'a', 'shell'), out(4, 'a')]).status, 'thinking');
  assert.equal(activity.inferCodex([started, call(2, 'a', 'shell'), out(4, 'a'), ev(9, 'task_complete')]).status, 'done');
  assert.equal(activity.inferCodex([started, ev(5, 'turn_aborted')]).doneAt, T0 + 5000);
  assert.equal(activity.inferCodex([started, ev(5, 'task_complete'), item(6, { type: 'message', role: 'assistant', content: [] })]).status, 'done', '结束之后的零碎行不重新算在跑');
  assert.equal(activity.inferCodex([item(1, { type: 'reasoning' })]).status, 'thinking', '尾巴从一轮中间开始');
  assert.equal(activity.inferCodex([line({ type: 'session_meta', payload: {} })]), null);
});

check('desk pet: live status — stale turns drop out, long tool calls may be waiting for the user', () => {
  const now = T0 + 3600_000;
  assert.equal(activity.liveStatus({ status: 'thinking', since: 0, at: 0 }, now - 5000, now), 'thinking');
  assert.equal(activity.liveStatus({ status: 'tool', since: 0, at: 0 }, now - 60_000, now), 'tool');
  assert.equal(activity.liveStatus({ status: 'tool', since: 0, at: 0 }, now - activity.WAITING_MS - 1, now), 'waiting');
  assert.equal(activity.liveStatus({ status: 'thinking', since: 0, at: 0 }, now - activity.STALE_MS - 1, now), null, '一轮没结束却 10 分钟没动：多半退出了');
  assert.equal(activity.liveStatus({ status: 'done', since: 0, at: 0 }, now - 86400_000, now), 'done');
});

check('desk pet: session heads give the title, project and subagent flag', () => {
  const head = activity.claudeHead([line({ type: 'ai-title', aiTitle: '额度卡片分级' }), claudeUser(0, '<system-reminder>x</system-reminder>帮我改额度卡片')]);
  assert.deepEqual(head, { id: 'c-1', cwd: 'D:\\work\\demo-app', title: '额度卡片分级', prompt: '帮我改额度卡片', side: false });
  assert.equal(activity.claudeHead([claudeUser(0, 'x', { isSidechain: true })]).side, true);
  const codex = activity.codexHead([line({ type: 'session_meta', payload: { id: 'x-9', cwd: '/home/me/proj' } }), line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>env</environment_context>' }, { type: 'input_text', text: '补单元测试' }] } })]);
  assert.deepEqual(codex, { id: 'x-9', cwd: '/home/me/proj', prompt: '补单元测试', side: false });
  assert.equal(activity.codexHead([line({ type: 'session_meta', payload: { id: 's', parent_thread_id: 'p' } })]).side, true);
});

(async () => {
  await checkAsync('desk pet: scanner finds recent sessions, skips subagents and old files, reports turns that just finished', async () => {
    const home = path.join(root, 'home'), claude = path.join(home, '.claude', 'projects'), codex = path.join(home, '.codex', 'sessions');
    const now = new Date();
    const day = path.join(codex, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    fs.mkdirSync(path.join(claude, 'D--work-demo-app'), { recursive: true }); fs.mkdirSync(day, { recursive: true });
    const recent = s => new Date(Date.now() - s * 1000).toISOString();
    const running = path.join(claude, 'D--work-demo-app', 'c-1.jsonl');
    fs.writeFileSync(running, [line({ type: 'ai-title', aiTitle: '额度卡片分级' }), line({ type: 'user', timestamp: recent(120), sessionId: 'c-1', cwd: 'D:\\work\\demo-app', message: { content: '改额度卡片' } }), line({ type: 'assistant', timestamp: recent(5), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } })].join('\n') + '\n');
    const finished = path.join(claude, 'D--work-demo-app', 'c-2.jsonl');
    fs.writeFileSync(finished, [line({ type: 'user', timestamp: recent(200), sessionId: 'c-2', cwd: 'D:\\work\\demo-app', message: { content: '写说明' } }), line({ type: 'assistant', timestamp: recent(100), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })].join('\n') + '\n');
    const old = path.join(claude, 'D--work-demo-app', 'c-old.jsonl');
    fs.writeFileSync(old, line({ type: 'user', timestamp: recent(9000), sessionId: 'c-old', message: { content: '很久以前' } }) + '\n');
    const longAgo = new Date(Date.now() - 3 * 3600_000); fs.utimesSync(old, longAgo, longAgo);
    // 子代理文件在 <会话>/subagents/ 下，不在项目目录这一层：扫描本来就不进去
    fs.mkdirSync(path.join(claude, 'D--work-demo-app', 'c-1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'D--work-demo-app', 'c-1', 'subagents', 'agent-a.jsonl'), line({ type: 'user', timestamp: recent(3), isSidechain: true, message: { content: 'sub' } }) + '\n');
    const codexFile = path.join(day, 'rollout-2026-10-22T10-00-00-x-1.jsonl');
    fs.writeFileSync(codexFile, [line({ type: 'session_meta', timestamp: recent(60), payload: { id: 'x-1', cwd: '/home/me/tokenpulse' } }), line({ type: 'event_msg', timestamp: recent(60), payload: { type: 'task_started' } }), line({ type: 'response_item', timestamp: recent(50), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '补单元测试' }] } })].join('\n') + '\n');
    fs.writeFileSync(path.join(day, 'rollout-2026-10-22T10-00-01-x-2.jsonl'), [line({ type: 'session_meta', payload: { id: 'x-2', parent_thread_id: 'x-1' } }), line({ type: 'event_msg', timestamp: recent(5), payload: { type: 'task_started' } })].join('\n') + '\n');
    fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), line({ id: 'x-1', thread_name: '会话解析单元测试' }) + '\n');

    const scanner = new activity.ActivityScanner({ claude, codex, codexIndex: path.join(home, '.codex', 'session_index.jsonl') });
    const first = await scanner.scan();
    assert.deepEqual(first.running.map(t => [t.key, t.status, t.title, t.project, t.tool ?? '']).sort(), [['claude:c-1', 'tool', '额度卡片分级', 'demo-app', 'Bash'], ['codex:x-1', 'thinking', '会话解析单元测试', 'tokenpulse', '']]);
    assert.deepEqual(first.recent.map(t => t.key), ['claude:c-2'], '十分钟内做完的放在「刚完成」');
    assert.deepEqual(first.finished, [], '第一次扫描不算刚做完，免得一启动就庆祝');
    // c-1 这一轮结束：下一次扫描报出来
    fs.appendFileSync(running, line({ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '好了' }] } }) + '\n');
    const second = await scanner.scan();
    assert.deepEqual(second.finished, ['claude:c-1']);
    assert.deepEqual(second.running.map(t => t.key), ['codex:x-1']);
    assert.deepEqual(second.recent.map(t => t.key), ['claude:c-1', 'claude:c-2'], '最近做完的在前');
    const third = await scanner.scan();
    assert.deepEqual(third.finished, [], '只报一次');
    // 大文件只读两头：标题在开头、状态在结尾
    const big = path.join(claude, 'D--work-demo-app', 'c-3.jsonl');
    const filler = line({ type: 'progress', data: 'x'.repeat(2000) });
    fs.writeFileSync(big, [line({ type: 'user', timestamp: recent(30), sessionId: 'c-3', cwd: '/w/big', message: { content: '很长的会话' } }), ...Array(200).fill(filler), line({ type: 'assistant', timestamp: recent(1), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Grep' }] } })].join('\n') + '\n');
    const fresh = new activity.ActivityScanner({ claude, codex, codexIndex: path.join(home, '.codex', 'session_index.jsonl') });
    const scanned = await fresh.scan();
    const bigTask = scanned.running.find(t => t.key === 'claude:c-3');
    assert.ok(bigTask, '大文件也认出来'); assert.equal(bigTask.title, '很长的会话'); assert.equal(bigTask.tool, 'Grep');
    // 目录不存在不报错
    assert.deepEqual((await new activity.ActivityScanner({ claude: path.join(root, 'none'), codex: path.join(root, 'none'), codexIndex: path.join(root, 'none.jsonl') }).scan()).running, []);
  });

  check('desk pet: settings are normalized, defaults keep the pet off', () => {
    const prefs = readPrefs();
    assert.equal(prefs.deskPet, false, '默认关闭');
    assert.deepEqual([prefs.deskPetKind, prefs.deskPetScale, prefs.deskPetOpacity, prefs.deskPetOnTop, prefs.deskPetAccount, prefs.deskPetFidget, prefs.deskPetBadge, prefs.deskPetPos], ['squirrel', 2, 100, true, '', true, true, null]);
    assert.deepEqual(model.normalizeDeskPet({ deskPet: 'yes', deskPetKind: '../evil', deskPetScale: 7, deskPetOpacity: 5, deskPetOnTop: 0, deskPetAccount: 42, deskPetFidget: false, deskPetBadge: undefined, deskPetPos: { x: 'a', y: 1 } }),
      { deskPet: false, deskPetKind: 'squirrel', deskPetScale: 2, deskPetOpacity: 30, deskPetOnTop: true, deskPetAccount: '', deskPetFidget: false, deskPetBadge: true, deskPetPos: null });
    assert.deepEqual(model.normalizeDeskPet({ deskPetKind: 'pet-0a1b2c3d', deskPetScale: '3', deskPetOpacity: 85.4, deskPetPos: { x: 100.6, y: -200.2 } }), { deskPetKind: 'pet-0a1b2c3d', deskPetScale: 3, deskPetOpacity: 85, deskPetPos: { x: 101, y: -200 } });
    assert.deepEqual(model.normalizeDeskPet({ theme: 'dark' }), {}, '不认识的字段不动');
    assert.equal(prefs.deskPetMini, false, '极简模式默认关');
    assert.deepEqual(model.normalizeDeskPet({ deskPetMini: 'true' }), { deskPetMini: false });
    assert.deepEqual(model.normalizeDeskPet({ deskPetMini: true }), { deskPetMini: true });
  });

  check('desk pet: flinging, the right-edge mini mode and the jump into it', () => {
    const work = { x: 0, y: 0, width: 1920, height: 1040 }, size = model.petWindowSize(2), sprite = { width: 144, height: 112 };
    // 松手速度：最后一个点和它之前 40～120 毫秒的点
    const trail = [{ x: 0, y: 0, t: 0 }, { x: 40, y: 0, t: 20 }, { x: 100, y: 10, t: 50 }, { x: 160, y: 20, t: 80 }];
    const v = model.releaseVelocity(trail, 90);
    assert.ok(Math.abs(v.x - 2) < 1e-9 && Math.abs(v.y - 1 / 3) < 1e-9, `用 t=80 和 t=20 的点算，实际 ${JSON.stringify(v)}`);
    assert.deepEqual(model.releaseVelocity(trail, 200), { x: 0, y: 0 }, '停了一会儿才松手：只是放下');
    assert.deepEqual(model.releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 50 }], 55), { x: 0, y: 0 }, '太慢不算甩');
    assert.deepEqual(model.releaseVelocity([{ x: 0, y: 0, t: 0 }], 5), { x: 0, y: 0 }, '只有一个点');
    const fast = model.releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 0, y: 1000, t: 50 }], 50);
    assert.ok(Math.abs(Math.hypot(fast.x, fast.y) - 4) < 1e-9, '太快的按上限算');
    // 甩出去：越来越慢、停在屏幕里；碰边弹回来；用力撞右边就停在右边
    const box = { minX: 0, maxX: work.width - size.width, minY: 0, maxY: work.height - size.height };
    const slide = model.flingPath({ x: 500, y: 400 }, { x: 1, y: 0 }, box);
    assert.equal(slide.hitRight, false);
    assert.ok(slide.points.length > 5 && slide.points.length <= 150);
    const steps = slide.points.map((p, i) => p.x - (i ? slide.points[i - 1].x : 500));
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1] + 1, '一帧比一帧慢（取整差一像素）');
    assert.ok(steps[steps.length - 1] < steps[0] / 4, '最后慢下来');
    const bounce = model.flingPath({ x: 100, y: 400 }, { x: -2, y: 0 }, box);
    assert.ok(bounce.points.some(p => p.x === 0), '碰到左边');
    assert.ok(bounce.points[bounce.points.length - 1].x > 0, '弹回来一点');
    for (const p of model.flingPath({ x: 900, y: 500 }, { x: 0.5, y: 3 }, box).points) assert.ok(p.y >= box.minY && p.y <= box.maxY, '一直在屏幕里');
    const hit = model.flingPath({ x: 1500, y: 400 }, { x: 3, y: 0 }, box);
    assert.equal(hit.hitRight, true); assert.equal(hit.points[hit.points.length - 1].x, box.maxX);
    assert.equal(model.flingPath({ x: 1200, y: 400 }, { x: 0, y: 0 }, box).points.length, 0, '没有速度不动');
    // 极简模式：窗口贴屏幕右边（整个窗口还在这块屏幕里），高度跟着原来的位置
    const mini = model.miniBounds({ x: 500, y: 600 }, size, work);
    assert.deepEqual(mini, { x: 1920 - 240, y: 600 - 142, width: 240, height: 142 });
    assert.equal(model.miniBounds(null, size, work).x, 1680);
    assert.equal(model.miniSpriteCenter(work, sprite), Math.round(1920 - 144 * model.MINI_SHOW / 2), '气泡对着露出来的那截');
    assert.ok(model.MINI_SHOW < model.MINI_PEEK && model.MINI_PEEK < 1, '平时露一半，探出来多一些，但不整个出来');
    assert.equal(model.reachesRightEdge(model.petBounds(null, size, work), sprite, work), false, '默认位置不算贴边');
    assert.equal(model.reachesRightEdge({ x: 1920 - 240 + 40, y: 0, width: 240, height: 142 }, sprite, work), true, '拖得伸出屏幕右边：贴边');
    assert.equal(model.reachesRightEdge({ x: 1920 - 240 + 4, y: 0, width: 240, height: 142 }, sprite, work), false, '离右边还远');
    // 跳过去：两头准、中间高
    const from = { x: 100, y: 500 }, to = { x: 400, y: 500 };
    assert.deepEqual(model.jumpPoint(from, to, 0, 80), from); assert.deepEqual(model.jumpPoint(from, to, 1, 80), to);
    assert.deepEqual(model.jumpPoint(from, to, 0.5, 80), { x: 250, y: 420 }, '最高处比两头高 arc');
    assert.deepEqual(model.jumpPoint(from, to, 3, 80), to, 'u 超出范围按 1 算');
  });

  check('desk pet: which quota the pet shows, and when it sleeps', () => {
    const title = a => 'T-' + a.kind;
    const snapshot = { accounts: [
      { kind: 'claude', key: 'acc-a', five: { used: 30, pressure: 'none' }, week: { used: 62, pressure: 'none' } },
      { kind: 'chatgpt', key: 'acc-b', five: { used: 5, pressure: 'high' }, week: { used: 20, pressure: 'none' } },
      { kind: 'grok', key: 'acc-c', five: null, week: { used: 140 } },
      { kind: 'claude', key: 'acc-d', five: null, week: null },
    ] };
    assert.deepEqual(model.petQuota(snapshot, '', title), { quota: 38, mood: 'ok', account: 'T-claude', accountId: 'acc-a' }, '默认第一个账号；剩余按用得多的那个窗口');
    assert.deepEqual(model.petQuota(snapshot, 'acc-b', title), { quota: 80, mood: 'tight', account: 'T-chatgpt', accountId: 'acc-b' }, '压力高就紧张，哪怕还剩很多');
    assert.equal(model.petQuota(snapshot, 'acc-c', title).mood, 'empty');
    assert.equal(model.petQuota(snapshot, 'acc-c', title).quota, 0, '超过 100% 按 100 算');
    assert.equal(model.petQuota(snapshot, 'acc-d', title).accountId, 'acc-a', '指定的账号没有额度数据：回到第一个');
    assert.deepEqual(model.petQuota({ accounts: [{ kind: 'claude', week: { used: 88, pressure: 'none' } }] }, '', title).mood, 'tight', '剩不到 15% 也算紧张');
    assert.deepEqual(model.petQuota(null, '', title), { quota: null, mood: 'ok', account: '', accountId: '' });
    // 没指定账号：跟着正在用的——有任务在跑的那家、它的 CLI 当前登录的账号
    const many = { accounts: [
      { kind: 'claude', key: 'k-c1', accountId: 'claude:one', five: { used: 10 }, week: { used: 10 } },
      { kind: 'claude', key: 'k-c2', accountId: 'claude:two', five: { used: 50 }, week: { used: 20 } },
      { kind: 'chatgpt', key: 'k-g1', accountId: 'chatgpt:one', five: { used: 70 }, week: { used: 30 } },
      { kind: 'chatgpt', key: 'k-g2', accountId: 'chatgpt:two', five: null, week: null },
    ] };
    const pick = (pickId, using) => model.pickPetAccount(many.accounts, pickId, using)?.key;
    assert.equal(pick('', { kinds: ['claude'], current: { claude: 'claude:two' } }), 'k-c2', 'Claude Code 在跑：用 Claude 当前登录的账号');
    assert.equal(pick('', { kinds: ['chatgpt', 'claude'], current: { claude: 'claude:two', chatgpt: 'chatgpt:one' } }), 'k-g1', 'Codex 最近有动静：用 ChatGPT 当前登录的');
    assert.equal(pick('', { kinds: ['chatgpt'], current: { chatgpt: 'chatgpt:two' } }), 'k-g1', '当前登录的那个没有额度数据：用那家第一个有数据的');
    assert.equal(pick('', { kinds: ['chatgpt'], current: {} }), 'k-g1', '不知道谁登录着：用那家第一个');
    assert.equal(pick('', { kinds: [], current: { claude: 'claude:two' } }), 'k-c2', '没有任务：排第一的那家，优先它当前登录的');
    assert.equal(pick('', undefined), 'k-c1', '什么都不知道：排第一的账号');
    assert.equal(pick('k-g1', { kinds: ['claude'], current: { claude: 'claude:two' } }), 'k-g1', '手动指定的优先');
    assert.equal(pick('k-g2', { kinds: ['claude'], current: { claude: 'claude:two' } }), 'k-c2', '指定的没有额度数据：回到跟着正在用的');
    assert.equal(model.petQuota(many, '', title, { kinds: ['chatgpt'], current: { chatgpt: 'chatgpt:one' } }).accountId, 'k-g1');
    assert.equal(model.pickPetAccount([], '', { kinds: ['claude'], current: {} }), undefined);
    const busy = { running: [{}], recent: [], finished: [], at: 0 };
    assert.equal(model.petMode(busy, 9999), 'work', '有任务在跑就干活，不睡');
    assert.equal(model.petMode(null, model.SLEEP_AFTER_SECONDS - 1), 'idle');
    assert.equal(model.petMode({ running: [], recent: [], finished: [], at: 0 }, model.SLEEP_AFTER_SECONDS), 'sleep');
  });

  check('desk pet: window placement keeps the pet on screen; the speech bubble sits above it (or beside it at the top edge)', () => {
    assert.deepEqual(model.petWindowSize(2), { width: 240, height: 142 });
    assert.deepEqual(model.petWindowSize(3), { width: 240, height: 198 });
    assert.deepEqual(model.petWindowSize(1), { width: 240, height: 86 });
    const work = { x: 0, y: 0, width: 1920, height: 1040 }, size = model.petWindowSize(2);
    const home = model.petBounds(null, size, work);
    assert.deepEqual(home, { x: 1920 - 240 - 12, y: 1040 - 142 - 4, width: 240, height: 142 }, '默认右下角');
    assert.deepEqual(model.anchorOf(model.petBounds({ x: 500, y: 600 }, size, work)), { x: 500, y: 600 }, '脚下中点放回原处');
    assert.deepEqual(model.petBounds({ x: 99999, y: -50 }, size, work), { x: 1680, y: 0, width: 240, height: 142 }, '拖出屏幕外的拉回来');
    assert.deepEqual(model.petBounds({ x: -1000, y: 500 }, size, { x: -1920, y: 0, width: 1920, height: 1080 }), { x: -1120, y: 358, width: 240, height: 142 }, '左边的副屏是负坐标');
    const sprite = { width: 144, height: 112 }, box = { width: 236, height: 130 };
    // 气泡外沿每边 6 像素（描边和投影），尾巴那一边再加 12
    assert.deepEqual(model.bubbleBounds(home, sprite, box, work), { x: 1664, y: 787, width: 248, height: 154, side: 'down', at: 124 }, '默认在宠物头顶，尾巴朝下指着宠物中间');
    const edge = model.bubbleBounds({ x: 1680, y: 600, width: 240, height: 142 }, sprite, box, work);
    assert.deepEqual([edge.x, edge.side, edge.at], [1668, 'down', 132], '贴着屏幕右边：气泡收进屏幕，尾巴还是对着宠物');
    const top = model.bubbleBounds({ x: 900, y: 0, width: 240, height: 142 }, sprite, box, work);
    assert.deepEqual(top, { x: 1078, y: 4, width: 260, height: 142, side: 'left', at: 65 }, '贴着屏幕顶：放到宠物右边，尾巴在气泡左边');
    const corner = model.bubbleBounds({ x: 1680, y: 0, width: 240, height: 142 }, sprite, box, work);
    assert.deepEqual([corner.x, corner.side], [1482, 'right'], '右上角：放到左边，尾巴在气泡右边');
    assert.ok(model.bubbleBounds(home, sprite, { width: 236, height: 5000 }, work).height <= 1040 - 8, '比屏幕还高就收在可用区域里');
  });

  check('desk pet: custom pet folders are validated, imported as copies, listed and removed', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
    const folder = path.join(root, 'my-cat');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'idle.png'), png); fs.writeFileSync(path.join(folder, 'work.gif'), gif);
    const write = manifest => fs.writeFileSync(path.join(folder, 'pet.json'), JSON.stringify(manifest));
    assert.equal(packs.imageType(png), 'png'); assert.equal(packs.imageType(gif), 'gif');
    assert.equal(packs.imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp'); assert.equal(packs.imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
    assert.equal(packs.imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
    assert.throws(() => packs.readPetFolder(path.join(root, 'nothing')), /没有 pet\.json/);
    write({ name: '我的猫', states: { work: 'work.gif' } }); assert.throws(() => packs.readPetFolder(folder), /至少要有 idle/);
    write({ name: '', states: { idle: 'idle.png' } }); assert.throws(() => packs.readPetFolder(folder), /名字/);
    write({ name: '我的猫', states: { idle: '../idle.png' } }); assert.throws(() => packs.readPetFolder(folder), /同一个文件夹/);
    write({ name: '我的猫', states: { idle: 'missing.png' } }); assert.throws(() => packs.readPetFolder(folder), /找不到/);
    fs.writeFileSync(path.join(folder, 'evil.png'), '<svg onload="alert(1)"></svg>');
    write({ name: '我的猫', states: { idle: 'evil.png' } }); assert.throws(() => packs.readPetFolder(folder), /不是 PNG、GIF、WebP 或 JPEG/, '扩展名是 png 也要看文件头');
    fs.writeFileSync(path.join(folder, 'huge.png'), Buffer.concat([png, Buffer.alloc(packs.PET_FILE_MAX)]));
    write({ name: '我的猫', states: { idle: 'huge.png' } }); assert.throws(() => packs.readPetFolder(folder), /超过 5 MB/);
    fs.writeFileSync(path.join(folder, 'pet.json'), '{nope'); assert.throws(() => packs.readPetFolder(folder), /不是有效的 JSON/);
    write({ name: '我的猫', author: '小明', states: { idle: 'idle.png', work: 'work.gif', dance: 'idle.png' } });
    const pack = packs.importPetPack(folder);
    assert.match(pack.id, /^pet-[a-f0-9]{8}$/);
    assert.deepEqual([pack.name, pack.author, pack.states], ['我的猫', '小明', { idle: 'idle.png', work: 'work.gif' }], '不认识的状态不收');
    assert.ok(path.resolve(packs.petsDir()).startsWith(path.resolve(root)), '复制到数据目录里');
    fs.rmSync(folder, { recursive: true, force: true });
    assert.deepEqual(packs.listPetPacks().map(p => p.id), [pack.id], '原文件夹删了照样能用');
    const images = packs.petPackImages(pack.id);
    assert.equal(images.name, '我的猫'); assert.match(images.images.idle, /^data:image\/png;base64,/); assert.match(images.images.work, /^data:image\/gif;base64,/);
    assert.equal(packs.petPackImages('../../etc'), null); assert.equal(packs.removePetPack('../data'), false); assert.equal(packs.removePetPack('pet-ffffffff'), false);
    assert.equal(packs.removePetPack(pack.id), true); assert.deepEqual(packs.listPetPacks(), []);
  });

  check('desk pet: when quota is tight the pets only sweat now and then, not all the time', () => {
    require('../renderer/pet-engine.js');
    const Pet = globalThis.PulsePet;
    const sweaty = g => g.c.includes('#9AD8FF');
    // 每秒 10 帧跑两分钟，记下每一段紧张的开始和长度
    const run = (name, ctx, ms = 120_000) => {
      const ctl = new Pet.Controller(name), spans = [];
      let on = null, frames = 0, sweatFrames = 0;
      for (let now = 1_000_000; now < 1_000_000 + ms; now += 100) {
        ctl.tick({ ...ctx, fidget: false }, now);
        const n = ctl.nervous;
        if (n && !on) on = { from: now }; else if (!n && on) { spans.push({ from: on.from, ms: now - on.from }); on = null; }
        frames++; if (sweaty(ctl.frame({ ...ctx, fidget: false }))) sweatFrames++;
      }
      return { spans, share: sweatFrames / frames };
    };
    for (const name of ['squirrel', 'hamster', 'octopus']) for (const state of ['idle', 'work']) {
      const ctx = { state, quota: 20, mood: 'tight', tasks: state === 'work' ? 1 : 0 };
      const { spans, share } = run(name, ctx);
      assert.ok(spans.length >= 3 && spans.length <= 6, `${name}/${state}：两分钟里紧张 3～6 次，实际 ${spans.length}`);
      assert.ok(spans[0].from - 1_000_000 <= 2600, '刚变紧张时很快来一次，让人看得出来');
      for (const span of spans) assert.ok(span.ms >= 2000 && span.ms <= 3100, `每次 2～3 秒，实际 ${span.ms}`);
      for (let i = 1; i < spans.length; i++) assert.ok(spans[i].from - spans[i - 1].from >= 22_000, '两次之间至少隔 20 秒');
      assert.ok(share > 0.03 && share < 0.16, `${name}/${state}：冒汗的帧只占一小部分，实际 ${(share * 100).toFixed(1)}%`);
      // 不紧张的时候：皱眉，但不冒汗
      const calm = new Pet.Controller(name);
      assert.equal(sweaty(calm.frame({ ...ctx, t: 0, nervous: false })), false, `${name}/${state} 平时不冒汗`);
      assert.equal(sweaty(calm.frame({ ...ctx, t: 0, nervous: true })), true, `${name}/${state} 紧张时冒汗`);
    }
    const low = run('squirrel', { state: 'idle', quota: 6, mood: 'tight', tasks: 0 }, 300_000).spans;
    for (let i = 1; i < low.length; i++) assert.ok(low[i].from - low[i - 1].from <= 28_100, '剩不到 10%：隔 15～25 秒一次');
    assert.ok(low.length >= 10, '剩不到 10% 更频繁一些');
    assert.equal(run('squirrel', { state: 'idle', quota: 60, mood: 'ok', tasks: 0 }).spans.length, 0, '额度够用：不紧张');
    assert.equal(run('squirrel', { state: 'sleep', quota: 20, mood: 'tight', tasks: 0 }).spans.length, 0, '睡觉时不紧张');
    assert.equal(run('squirrel', { state: 'idle', quota: 0, mood: 'empty', tasks: 0 }).share, 0, '额度用完：累趴着，不冒汗');
  });

  check('desk pet: sleep sequence (yawn, doze, flop) and waking up', () => {
    const Pet = globalThis.PulsePet;
    const ctx = { state: 'idle', quota: 70, mood: 'ok', tasks: 0, fidget: false };
    const play = (ctl, frames, now, c = ctx) => { for (let i = 0; i < frames; i++) ctl.tick(c, now + i * 100); };
    const ctl = new Pet.Controller('squirrel');
    ctl.setMode('idle'); ctl.idle(5);
    play(ctl, 5, 0);
    assert.equal(ctl.action, null); assert.equal(ctl.stateOf(ctx), 'idle');
    ctl.idle(Pet.DOZE_AFTER);
    ctl.tick(ctx, 1000);
    assert.equal(ctl.action, 'yawn', '一分钟没人动：打哈欠'); assert.equal(ctl.stateOf(ctx), 'doze');
    play(ctl, 30, 1100);
    assert.equal(ctl.action, null, '哈欠打完接着打盹'); assert.equal(ctl.stateOf(ctx), 'doze');
    ctl.idle(Pet.DOZE_AFTER + 20); ctl.tick(ctx, 1000 + Pet.DOZE_MS - 100);
    assert.equal(ctl.stateOf(ctx), 'doze', '打盹还没满半分钟');
    ctl.idle(Pet.DOZE_AFTER + 30); ctl.tick(ctx, 1000 + Pet.DOZE_MS);
    assert.equal(ctl.action, 'flop', '一头栽倒'); assert.equal(ctl.stateOf(ctx), 'sleep');
    play(ctl, 20, 40_000);
    assert.equal(ctl.action, null); assert.equal(ctl.stateOf(ctx), 'sleep', '主进程还说 idle，宠物自己已经睡着了');
    ctl.idle(0);
    assert.equal(ctl.action, 'startle', '睡熟了被吵醒：先吓一跳');
    play(ctl, Pet.durOf('squirrel', 'startle'), 50_000);
    assert.equal(ctl.action, 'wake', '然后揉眼睛'); assert.equal(ctl.stateOf(ctx), 'idle');
    // 打盹时有人动：揉揉眼睛就醒
    const doze = new Pet.Controller('hamster');
    doze.setMode('idle'); doze.idle(70); doze.tick(ctx, 0);
    assert.equal(doze.stateOf(ctx), 'doze');
    doze.idle(2);
    assert.equal(doze.action, 'wake'); assert.equal(doze.stateOf(ctx), 'idle');
    // 有任务在跑、极简模式贴边时不犯困
    const busy = new Pet.Controller('octopus'), work = { ...ctx, state: 'work', tasks: 1 };
    busy.setMode('work'); busy.idle(200); play(busy, 50, 0, work);
    assert.equal(busy.stateOf(work), 'work'); assert.notEqual(busy.action, 'yawn');
    const edge = new Pet.Controller('squirrel'), mini = { ...ctx, mini: true };
    edge.setMode('idle'); edge.idle(200); play(edge, 50, 0, mini);
    assert.equal(edge.stateOf(mini), 'idle');
    // 主进程说睡了（5 分钟没人动）：没睡的先打哈欠；醒来吓一跳
    const main = new Pet.Controller('squirrel');
    main.setMode('idle'); main.setMode('sleep');
    assert.equal(main.action, 'yawn'); assert.equal(main.stateOf({ ...ctx, state: 'sleep' }), 'sleep');
    main.setMode('idle');
    assert.equal(main.action, 'startle');
    // 打开窗口时已经在睡：直接睡着，不打哈欠
    const late = new Pet.Controller('squirrel');
    late.setMode('sleep');
    assert.equal(late.action, null); assert.equal(late.drowse, 'asleep');
  });

  check('desk pet: clicks — one opens the bubble after the double-click gap, two pokes, four look around', () => {
    const Pet = globalThis.PulsePet;
    const clicks = new Pet.Clicks(300);
    assert.equal(clicks.press(1000), 1);
    assert.equal(clicks.settle(1200), 0, '还没过 300 毫秒：可能是双击');
    assert.equal(clicks.settle(1301), 1, '单击');
    assert.equal(clicks.settle(1400), 0, '读过就清零');
    assert.equal(clicks.press(2000), 1); assert.equal(clicks.press(2250), 2, '双击');
    assert.equal(clicks.settle(2400), 0); assert.equal(clicks.settle(2600), 2);
    for (const [t, n] of [[3000, 1], [3200, 2], [3400, 3], [3600, 4]]) assert.equal(clicks.press(t), n);
    assert.equal(clicks.settle(4000), 4);
    assert.equal(clicks.press(5000), 1); assert.equal(clicks.press(5400), 1, '隔太久：重新数');
  });

  check('desk pet: the new actions and states draw for every built-in pet', () => {
    const Pet = globalThis.PulsePet;
    const base = { quota: 70, mood: 'ok', tasks: 0, t: 5, look: { x: 0, y: 0 }, from: 0 };
    for (const name of ['squirrel', 'hamster', 'octopus']) {
      const key = g => g.c.join(',');
      const idle = key(Pet.drawPet(name, { ...base, state: 'idle', action: null, at: 0 }));
      assert.notEqual(key(Pet.drawPet(name, { ...base, state: 'doze', action: null, at: 0 })), idle, `${name} 打盹和平时不一样`);
      for (const action of ['poke', 'lookaround', 'flop', 'wave']) {
        const frames = new Set();
        for (let at = 0; at < Pet.durOf(name, action); at += 3) frames.add(key(Pet.drawPet(name, { ...base, state: action === 'flop' ? 'sleep' : 'idle', action, at, t: at })));
        assert.ok(frames.size >= 2, `${name}/${action} 是会动的`);
        assert.ok(![...frames].includes(idle), `${name}/${action} 看得出在做动作`);
        assert.ok(Pet.LABELS[action], `${name}/${action} 有名字`);
      }
      // 影子：平时有，被拎着、贴边时没有
      assert.notEqual(key(Pet.drawPet(name, { ...base, state: 'idle', action: null, at: 0, mini: true })), idle, `${name} 贴边时不画影子`);
    }
  });

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结果 */ }
  if (failed) process.exit(1);
})();
