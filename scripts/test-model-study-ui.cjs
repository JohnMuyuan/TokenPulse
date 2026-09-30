const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, ipcMain, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-model-ui-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(root, 'home'); process.env.TOKENPULSE_DATA_DIR = path.join(root, 'data');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
app.setPath('userData', path.join(root, 'electron')); app.commandLine.appendSwitch('lang', 'zh-CN'); process.argv.push('--hidden');
const appRoot = process.env.TOKENPULSE_TEST_APP || path.resolve(__dirname, '..');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const now = Date.now(), minute = 60000, iso = at => new Date(at).toISOString();
const dateKey = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const accounts = ['qa-study', 'qa-other'].map((ref,i) => ({ id:'chatgpt:'+ref, kind:'chatgpt', ref, email:'', label:'QA '+i, createdAt:now, lastSeenAt:now }));
write(path.join(root, 'data', 'prefs.json'), { autoLaunch:false, autoUpdate:false, closeToTray:true, startMinimized:true, language:'zh', notifyAt:0, notifyMismatch:false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' });
write(path.join(root, 'data', 'official-accounts.json'), { version:2, accounts, active:{}, removed:[] });
write(path.join(root, 'data', 'quota-calibrations.json'), {version:1,sessions:accounts.map(a=>({id:'test-'+a.ref,kind:'chatgpt',accountId:a.id,startAt:now-50*minute,endAt:now+10*minute,confirmedLocalOnly:true}))});
write(path.join(root, 'home', '.codex', 'models_cache.json'), { fetched_at:iso(now), models:[{slug:'gpt-qa',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'high'}],default_reasoning_level:'high'}] });
const samples = accounts.flatMap(a => Array.from({length:4},(_,i)=>({account:a.id,at:now-(3-i)*5*minute,five:i*2,fiveReset:iso(now+2*3600000),week:i,weekReset:iso(now+3*86400000),plan:'plus'})));
write(path.join(root,'data','quota-history.json'),{version:1,accounts:{chatgpt:samples}});
const records=accounts.flatMap((a,index)=>Array.from({length:3},(_,i)=>({id:a.ref+'-'+i,at:now-(2-i)*5*minute-minute,kind:'codex',file:'fixture-'+a.ref,model:'gpt-qa',requested:'gpt-qa',effort:'high',effortSource:'turn_context.effort',accountRef:a.ref,input:index?3200:800,output:index?800:200,cacheRead:index?1600:400,cacheWrite:0,reasoning:100,costUsd:0.01,calls:1})));
records.push({...records[0],id:'unknown-effort',at:now-17*minute,effort:undefined,effortSource:undefined});
const months=new Map();for(const r of records){const m=dateKey(r.at).slice(0,7);if(!months.has(m))months.set(m,[]);months.get(m).push(JSON.stringify(r));}
for(const[m,rows]of months)write(path.join(root,'data','requests',m+'.jsonl'),rows.join('\n')+'\n');
write(path.join(root,'data','usage-rollups.json'),{version:1,files:Object.fromEntries(accounts.map(a=>['fixture-'+a.ref,{kind:'codex',official:true,days:{[dateKey(now)]:{'Codex CLI':{'gpt-qa':records.filter(r=>r.file==='fixture-'+a.ref).reduce((b,r)=>({input:b.input+r.input,output:b.output+r.output,cacheRead:b.cacheRead+r.cacheRead,cacheWrite:0,reasoning:b.reasoning+r.reasoning,costUsd:b.costUsd+r.costUsd,requests:b.requests+1}),{input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,costUsd:0,requests:0})}}}}]))});
require(path.join(appRoot,'build/core/quota.js')).fetchOfficialQuota=async()=>({});
let failStudy=false, delayFirst=false;const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>handle(channel,channel==='models:study'?async(event,q)=>{if(failStudy)throw Error('Simulated model study failure');const result=await handler(event,q);if(delayFirst&&q.accountId==='chatgpt:qa-study')await new Promise(r=>setTimeout(r,250));return result;}:handler);
const watchdog=setTimeout(()=>{console.error('FAIL model-study UI timed out');app.exit(1);},30000);
app.on('web-contents-created',(_,contents)=>contents.once('did-finish-load',async()=>{
 const evaluate=code=>contents.executeJavaScript(code).catch(e=>{throw new Error(e.message+' ← '+String(code).slice(0,160));}),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async code=>{const end=Date.now()+10000;while(!await evaluate('Promise.resolve('+code+').then(v=>!!v)')){assert.ok(Date.now()<end,'Timed out: '+code);await delay(30);}};
 try {
  const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const count = sel => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const Q = '#quota-model-study', U = '#quota-model-timeline';
  const tab = id => `document.querySelector('#account-tabs [data-account="${id}"]').click()`;
  await until("current?.accounts.some(a => a.accountId === 'chatgpt:qa-study')");
  await evaluate("state.account='chatgpt:qa-study'; navigate('quota')");
  await until(`document.querySelector('${Q} .ms-row') && !document.querySelector('${Q}').hasAttribute('aria-busy')`);
  // 两个窗口一次列出，不用查询：5 小时按整窗预算换算出 Token；周窗口样本不足，只给相对容量
  assert.equal(await text(`${Q} .ms-row[data-effort=high] .ms-cap.five b`), '50.0K');
  assert.equal(await text(`${Q} .ms-row[data-effort=low] .ms-cap.five b`), '50.0K', '没用过的等级也按同模型单价换算');
  assert.match(await text(`${Q} .ms-row[data-effort=high] .ms-cap.week b`), /^×/, '周窗口不能拿五小时的预算');
  assert.equal(await text(`${Q} .ms-budget.five .ms-budget-value`), '$0.50按本机区间折算 · API 等价参考');
  assert.equal(await count(`${Q} .ms-row`), 2, '未记录等级不进排行');
  assert.equal(await count(`${Q} .ms-row[data-effort=unknown]`), 0);
  await evaluate(`document.querySelector('${Q} .seg button[data-value=name]').click()`);
  assert.equal(await evaluate(`document.querySelector('${Q} .ms-row').dataset.effort`), 'low');
  await evaluate(`document.querySelector('${Q} .seg button[data-value=recent]').click()`);
  assert.equal(await evaluate(`document.querySelector('${Q} .ms-row').dataset.effort`), 'high');
  await evaluate(`document.querySelector('${Q} [data-level=low]').click()`);
  assert.equal(await count(`${Q} .ms-row`), 1);
  await evaluate(`document.querySelector('${Q} [data-level=all]').click()`);

  // 0.3.9：时间线移到额度详情，跟随上方账号标签；用量明细里不再有时间线
  assert.equal(await evaluate(`document.querySelector('${U}').closest('.page').id`), 'page-quota');
  assert.equal(await evaluate("document.querySelector('#page-usage .model-study')"), null, '用量明细不再放时间线');
  assert.equal(await count(`${U} .ms-account`), 0, '账号跟随标签，不再有第二个账号选择器');
  await until(`document.querySelectorAll('${U} .ms-cycle.five .ms-run').length > 0 && !document.querySelector('${U}').hasAttribute('aria-busy')`);
  assert.match(await text(`${U} .ms-cycle.five .ms-cycle-stats`), /4\.0K Tokens · 4 次调用/);
  assert.equal(await count(`${U} .ms-cycle.five .ms-lane`), 2, '未记录等级单独一条轨道');
  assert.ok(await evaluate(`[...document.querySelectorAll('${U} .ms-cycle.five .ms-lane-level')].some(n => n.textContent === '未记录等级')`));
  assert.ok(await count(`${U} .ms-cycle.week .ms-quota-line`) === 1, '周期上方画官方额度曲线');
  await evaluate(`document.querySelector('${U} .ms-combo').click()`);
  assert.ok(await evaluate(`document.querySelector('${U}').classList.contains('ms-focusing')`));
  await evaluate(`document.querySelector('${U} .ms-combo').click()`);
  assert.ok(!await evaluate(`document.querySelector('${U}').classList.contains('ms-focusing')`));

  // 失败：不保留旧账号的数据；重试后恢复
  failStudy = true;
  await evaluate(tab('chatgpt:qa-other'));
  await until(`document.querySelector('${U} [role=alert]') !== null`);
  assert.equal(await count(`${U} .ms-run`), 0, '失败不保留旧数据');
  failStudy = false;
  await evaluate(`document.querySelector('${U} [data-action=retry-study]').click()`);
  await until(`/12\.0K Tokens/.test(document.querySelector('${U} .ms-cycle.five .ms-cycle-stats')?.textContent || '')`);
  // 迟到的旧账号结果不许覆盖当前账号
  await evaluate('window.tokenpulse.refresh()');
  await delay(300);
  delayFirst = true;
  await evaluate(tab('chatgpt:qa-study') + ';' + tab('chatgpt:qa-other'));
  await delay(450);
  assert.match(await text(`${U} .ms-cycle.five .ms-cycle-stats`), /12\.0K Tokens/, '旧账号的迟到结果不得覆盖当前账号');
  delayFirst = false;

  // 夜间模式：时间线里所有文字（坐标 100% / 50% / 0%、时间、轨道名）都不能是默认黑色
  await evaluate("setThemeMode('dark')"); await delay(150);
  const black = await evaluate(`[...document.querySelectorAll('${U} .ms-tl text')].filter(n => getComputedStyle(n).fill === 'rgb(0, 0, 0)').map(n => n.getAttribute('class') + ':' + n.textContent)`);
  assert.deepEqual(black, [], '夜间模式时间线文字不能是黑色');
  await evaluate("setThemeMode('light')"); await delay(900);
  const win = BrowserWindow.fromWebContents(contents); win.setSize(900, 850); await delay(250);
  for (const id of [Q, U]) assert.equal(await evaluate(`document.querySelector('${id}').scrollWidth <= document.querySelector('${id}').clientWidth + 1`), true, `${id} 窄窗口只在图表内部滚动`);
  contents.debugger.attach('1.3'); await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${Q} .ms-chip')).transitionDuration`), '0s'); contents.debugger.detach();
  // 0.3.9：本机以外的使用。假历史改成：前面先有一段本机没有请求的上涨（+3%），后面才是本机 Code 的上涨
  await evaluate("state.account='chatgpt:qa-study'; navigate('quota')");
  // 还没有本机以外的上涨：汇总缩成一行（没有底色），说明只在感叹号里
  await until(`document.querySelector('${U} .ms-cycle.five .ms-off-summary')`);
  assert.equal(await evaluate(`document.querySelector('${U} .ms-cycle.five .ms-off-summary').classList.contains('empty')`), true);
  assert.match(await text(`${U} .ms-cycle.five .ms-off-head > p`), /^本机以外 · 未检测到$/);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${U} .ms-cycle.five .ms-off-summary')).backgroundColor`), 'rgba(0, 0, 0, 0)');
  const offBase = samples.filter(s => s.account === 'chatgpt:qa-study');
  const shifted = [
    ...[40, 35, 30, 25, 20].map((ago, i) => ({ ...offBase[0], at: now - ago * minute, five: i === 0 ? 0 : 3, week: i === 0 ? 0 : 3 })),
    ...offBase.map(s => ({ ...s, five: s.five + 3, week: s.week + 3 })),
  ];
  write(path.join(root,'data','quota-history.json'),{version:1,accounts:{chatgpt:[...samples.filter(s => s.account !== 'chatgpt:qa-study'), ...shifted]}});
  await evaluate("window.tokenpulse.refresh()");
  await until(`document.querySelector('${U} .ms-cycle.five .ms-off.detected') && !document.querySelector('${U}').hasAttribute('aria-busy')`);
  const study = await evaluate("window.tokenpulse.modelStudy({kind:'chatgpt',accountId:'chatgpt:qa-study'}).then(s=>({off:s.five.offMachine.points,detected:s.five.offMachine.detected.length,budget:s.five.budget.costUsd,used:s.five.selected.used}))");
  assert.equal(study.off, 3, '本机没有请求的 3 个点识别为本机以外'); assert.equal(study.detected, 1); assert.equal(study.used, 9, '官方已用保持真实值');
  // 本机区间：-35 到 0 分钟涨了 6 个点，其间 4 条本机请求（含一条未记录等级的）共 0.04 美元；前面本机以外的 3 个点不进分母
  assert.ok(Math.abs(study.budget - 0.04 / 6 * 100) < 1e-9, '容量只用本机区间折算，本机以外的 3 个点不进分母：' + study.budget);
  assert.match(await text(`${U} .ms-cycle.five .ms-off-summary`), /本机以外 \+3\.0%/);
  assert.match(await text(`${U} .ms-cycle.five .ms-off-summary`), /1 段待标注/);
  // 说明收进感叹号：常驻的只剩结论，长句只在浮层里
  assert.doesNotMatch(await text(`${U} .ms-cycle.five .ms-off-head > p`), /不计入容量折算/);
  assert.match(await text(`${U} .ms-cycle.five .ms-off-head .info-tip-pop`), /不计入容量折算/);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${U} .ms-cycle.five .ms-off-head .info-tip-pop')).display`), 'none');
  assert.equal(await evaluate(`document.querySelector('${U} .ms-cycle.five .ms-off-summary').classList.contains('empty')`), false);
  assert.match(await text(`${Q} .ms-budget.five .ms-budget-value`), /\$0\.67按本机区间折算/);
  // 点虚线块：打开标注，选等级、写备注；填表的时候定时刷新不能把表单冲掉
  await evaluate(`document.querySelector('${U} .ms-cycle.five .ms-off.detected').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await until(`document.querySelector('${U} .ms-cycle.five .ms-mark-editor')`);
  assert.equal(await evaluate(`document.querySelector('${U} .ms-mark-editor select[aria-label="用了什么模型"]').value`), 'gpt-qa', '默认填这个周期里用得最多的模型');
  await evaluate(`(() => { const f = document.querySelector('${U} .ms-mark-editor'); const e = f.querySelector('select[aria-label="思考等级"]'); e.value = 'high'; e.dispatchEvent(new Event('change')); const n = f.querySelector('input[aria-label="备注"]'); n.value = '网页上聊天'; n.dispatchEvent(new Event('input')); })()`);
  const info = await text(`${U} .ms-mark-info`);
  assert.match(info, /涨了 3\.0 个百分点.*约相当于 2\.0K Tokens/, '按这个模型 × 等级的整窗容量换算：' + info);
  await evaluate('window.tokenpulse.refresh()'); await delay(600);
  assert.equal(await evaluate(`document.querySelector('${U} .ms-mark-editor input[aria-label="备注"]')?.value`), '网页上聊天', '刷新不能冲掉正在填的标注');
  await evaluate(`document.querySelector('${U} .ms-mark-editor').requestSubmit()`);
  await until(`document.querySelector('${U} .ms-cycle.five .ms-off.marked') && !document.querySelector('${U} .ms-mark-editor')`);
  await until("[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('已标注'))");
  const marked = await evaluate("window.tokenpulse.modelStudy({kind:'chatgpt',accountId:'chatgpt:qa-study'}).then(s=>s.five.offMachine)");
  assert.equal(marked.detected.length, 0); assert.equal(marked.marks.length, 1); assert.equal(marked.marks[0].effort, 'high'); assert.equal(marked.marks[0].note, '网页上聊天');
  assert.equal(Math.round(marked.marks[0].equivalentTokens), 2000, "整窗 0.04/6×100 美元 ÷ 每 Token 0.00001 美元 × 3%");
  assert.match(await text(`${U} .ms-cycle.five .ms-off-summary`), /gpt-qa · high/);
  // 放大：按钮、拖选、Ctrl + 滚轮；回到整个周期
  const label = () => text(`${U} .ms-cycle.five .ms-zoom-label`);
  assert.equal(await label(), '整个周期');
  await evaluate(`document.querySelector('${U} .ms-cycle.five .ms-zoom-btn[aria-label$="放大"]').click()`);
  assert.match(await label(), /^显示 /);
  await evaluate(`document.querySelector('${U} .ms-cycle.five .ms-zoom-btn[aria-label$="回到整个周期"]').click()`);
  assert.equal(await label(), '整个周期');
  await evaluate(`(() => { const svg = document.querySelector('${U} .ms-cycle.five .ms-tl svg'), b = svg.getBoundingClientRect(); const y = b.top + 40; const fire = (type, x) => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 7, button: 0 })); fire('pointerdown', b.left + b.width * .55); fire('pointermove', b.left + b.width * .7); fire('pointermove', b.left + b.width * .85); fire('pointerup', b.left + b.width * .85); })()`);
  await until(`document.querySelector('${U} .ms-cycle.five .ms-select-actions')`);
  assert.ok(await evaluate(`[...document.querySelectorAll('${U} .ms-select-actions button')].some(b => b.textContent === '标注为本机以外的使用')`));
  await evaluate(`[...document.querySelectorAll('${U} .ms-select-actions button')].find(b => b.textContent === '放大到这段').click()`);
  assert.match(await label(), /^显示 /, '拖选后放大到这段');
  await evaluate(`document.querySelector('${U} .ms-cycle.five .ms-zoom-btn[aria-label$="回到整个周期"]').click()`);
  await evaluate(`(() => { const svg = document.querySelector('${U} .ms-cycle.five .ms-tl svg'), b = svg.getBoundingClientRect(); svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: b.left + b.width * .7, clientY: b.top + 40 })); })()`);
  assert.match(await label(), /^显示 /, 'Ctrl + 滚轮放大');
  await evaluate(`document.querySelector('${U} .ms-cycle.five .ms-zoom-btn[aria-label$="回到整个周期"]').click()`);
  // 修改 → 删除标注：又变回待标注
  await evaluate(`document.querySelector('${U} .ms-cycle.five .ms-off.marked').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await until(`[...document.querySelectorAll('${U} .ms-mark-editor button')].some(b => b.textContent === '删除标注')`);
  await evaluate(`[...document.querySelectorAll('${U} .ms-mark-editor button')].find(b => b.textContent === '删除标注').click()`);
  await until(`document.querySelector('${U} .ms-cycle.five .ms-off.detected') && !document.querySelector('${U} .ms-mark-editor')`);
  // Esc 关掉编辑区
  await evaluate(`document.querySelector('${U} .ms-off-add').click()`);
  await until(`document.querySelector('${U} .ms-mark-editor')`);
  await evaluate(`document.querySelector('${U} .ms-mark-editor select').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(`!document.querySelector('${U} .ms-mark-editor')`);
  // 夜间模式：新加的文字也不能是默认黑色
  await evaluate("setThemeMode('dark')"); await delay(150);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('${U} .ms-tl text, ${U} .ms-off-summary *')].filter(n => (n.tagName === 'text' ? getComputedStyle(n).fill : getComputedStyle(n).color) === 'rgb(0, 0, 0)').map(n => n.className?.baseVal ?? n.className)`), []);
  await evaluate("setThemeMode('light')"); await delay(300);
  console.log('PASS 0.3.9 off-machine timeline: detection, summary, clean budget, mark editor with token equivalent, refresh keeps draft, save/delete, zoom buttons, drag-select, ctrl+wheel, Esc, dark mode');
  // 0.3.9：设置 → 账号里的「只在本机用 Code」开关
  assert.ok(await evaluate("document.querySelector('#quota-detail .quota-context h2 .quota-scope-tip') !== null"), '默认在标题旁放共享额度说明的感叹号');
  assert.equal(await evaluate("document.querySelector('#quota-detail .ms-attribution-note')"), null, '共享额度说明不再常驻');
  // 说明平时隐藏，聚焦感叹号才显示；浮层里的「在设置里打开」按钮可以点到
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#quota-detail .quota-scope-tip .info-tip-pop')).display"), 'none');
  // 隐藏的测试窗口里 focus() 不触发 focus 事件，这里用悬停打开（键盘聚焦走同一个 open）
  await evaluate("document.querySelector('#quota-detail .quota-scope-tip').dispatchEvent(new MouseEvent('mouseenter'))");
  // 打开时浮层挂在 body 上、fixed 定位：不会被卡片裁掉，也不会被后面的面板盖住
  await until("document.querySelector('body > .info-tip-pop.open')");
  assert.match(await text('body > .info-tip-pop.open'), /官方已用是整个账号的/);
  assert.ok(await evaluate("Boolean(document.querySelector('body > .info-tip-pop.open button.text-btn'))"));
  assert.ok(await evaluate("(() => { const p = document.querySelector('body > .info-tip-pop.open'), r = p.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 6); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && p.contains(hit); })()"), '浮层完整显示、在最上层');
  await evaluate("document.querySelector('#quota-detail .quota-scope-tip').dispatchEvent(new MouseEvent('mouseleave'))");
  await until("!document.querySelector('body > .info-tip-pop.open') && document.querySelector('#quota-detail .quota-scope-tip .info-tip-pop')");
  // 共享账号的额度容量趋势也有折线了（只用本机区间折算）
  assert.match(await text('#quota-detail .capacity-panel h2'), /额度容量趋势/);
  assert.ok(await evaluate("Boolean(document.querySelector('#quota-detail .capacity-chart svg')) && !document.querySelector('#quota-detail .capacity-locked')"), '共享账号也按本机区间画出容量趋势');
  await evaluate("openSettings('accounts')");
  await until("document.querySelector('#official-accounts [data-local-only=\"chatgpt:qa-study\"]')");
  assert.equal(await evaluate("document.querySelector('#official-accounts [data-local-only=\"chatgpt:qa-study\"]').getAttribute('aria-checked')"), 'false');
  await evaluate("document.querySelector('#official-accounts [data-local-only=\"chatgpt:qa-study\"]').click()");
  await until("window.tokenpulse.readPrefs().then(p => (p.localOnlyAccounts || []).includes('chatgpt:qa-study'))");
  await until("[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('只在本机用 Code'))");
  assert.equal(await evaluate("document.querySelector('#official-accounts [data-local-only=\"chatgpt:qa-study\"]').getAttribute('aria-checked')"), 'true');
  await evaluate("closeModal ? closeModal('settings') : document.querySelector('#settings [data-close]')?.click()");
  await until("current?.accounts.find(a => a.accountId === 'chatgpt:qa-study')?.quotaScope === 'local_only'");
  await evaluate("state.account='chatgpt:qa-study'; navigate('quota')");
  await until("!document.querySelector('#quota-model-study').hasAttribute('aria-busy') && document.querySelector('#quota-model-study .ms-row')");
  await delay(200);
  assert.equal(await evaluate("document.querySelector('#quota-detail .quota-scope-tip')"), null, '只在本机用 Code 时不显示共享额度说明');
  assert.equal(await evaluate("document.querySelector('#quota-model-study .ms-calibration')"), null, '只在本机用 Code 时不显示校准入口');
  assert.equal(await evaluate("document.querySelector('#page-quota .ms-attribution-note')"), null, '时间线里的归因说明也不显示');
  assert.match(await text('#quota-detail .capacity-panel h2'), /额度容量趋势/);
  // 打开后额度容量趋势的周 / 5 小时、Tokens / 费用切换回来
  await evaluate("document.querySelector('#quota-detail [data-cap-window=five]').click(); document.querySelector('#quota-detail [data-cap-metric=costUsd]').click()");
  assert.equal(await evaluate("state.capWindow + '/' + state.capMetric"), 'five/costUsd');
  assert.ok(await evaluate("Boolean(document.querySelector('#quota-detail .capacity-chart svg, #quota-detail .capacity-chart .empty'))"));
  await evaluate("document.querySelector('#quota-detail [data-cap-window=week]').click(); document.querySelector('#quota-detail [data-cap-metric=tokens]').click()");
  console.log('PASS 0.3.9 local-only switch: settings toggle, prefs saved, toast, notes and calibration hidden, capacity trend restored');
  // ---------- 0.3.12：自己添加模型 + 思考等级依据 ----------
  await evaluate("state.account='chatgpt:qa-study'; navigate('quota')");
  await until("!document.querySelector('#quota-model-study').hasAttribute('aria-busy') && document.querySelector('#quota-model-study [data-action=add-model]')");
  await evaluate("document.querySelector('#quota-model-study [data-action=add-model]').click()");
  await until("document.querySelector('#ms-add .ms-add-item')");
  await evaluate("(() => { const i = document.querySelector('#ms-add .ms-add-search'); i.value = 'gpt-6.1-sol'; i.dispatchEvent(new Event('input')); })()");
  await until("document.querySelector('#ms-add .ms-add-item[data-model=\"gpt-6.1-sol\"]')");
  assert.match(await text('#ms-add .ms-add-item[data-model="gpt-6.1-sol"]'), /\$2 \/ \$10/, '候选带单价（来自知识库）');
  await evaluate("document.querySelector('#ms-add .ms-add-item[data-model=\"gpt-6.1-sol\"]').click()");
  await until("document.querySelector('#ms-add .ms-add-detail [data-effort=high]')");
  await evaluate("['high', 'medium', 'not_supported'].forEach(e => document.querySelector(`#ms-add .ms-add-detail [data-effort=${e}]`).click())");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#ms-add .ms-add-detail .ms-chip.on')].map(b => b.dataset.effort)"), ['medium', 'high']);
  await evaluate("document.querySelector('#ms-add [data-action=add-confirm]').click()");
  await until("window.tokenpulse.readPrefs().then(p => (p.studyModels?.chatgpt || []).some(m => m.model === 'gpt-6.1-sol' && m.efforts.join() === 'medium,high'))");
  await until("document.querySelector('#ms-add .ms-add-pill')");
  // 别家的型号：给提示、不能加
  await evaluate("(() => { const i = document.querySelector('#ms-add .ms-add-search'); i.value = 'claude-x-qa'; i.dispatchEvent(new Event('input')); })()");
  await until("document.querySelector('#ms-add .ms-add-item.custom')");
  await evaluate("document.querySelector('#ms-add .ms-add-item.custom').click()");
  assert.ok(await evaluate("Boolean(document.querySelector('#ms-add .ms-add-warn')) && document.querySelector('#ms-add [data-action=add-confirm]').disabled"), '别家的型号不能加');
  // 夜间模式：对话框里没有默认黑字
  await evaluate("setThemeMode('dark')"); await delay(150);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#ms-add *')].filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim()) && getComputedStyle(n).color === 'rgb(0, 0, 0)').map(n => n.className)"), []);
  await evaluate("setThemeMode('light')");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await until("!document.querySelector('#ms-add')");
  // 表格里出现，带「你添加的」和思考等级依据
  await until("document.querySelector('#quota-model-study .ms-row[data-model=\"gpt-6.1-sol\"]')");
  const added = await evaluate("[...document.querySelectorAll('#quota-model-study .ms-row[data-model=\"gpt-6.1-sol\"]')].map(r => ({ effort: r.dataset.effort, user: !!r.querySelector('.ms-user-tag'), tag: r.querySelector('.ms-basis.effort')?.textContent || '', label: r.getAttribute('aria-label') }))");
  assert.ok(added.length >= 1 && added.every(r => r.user), '你添加的');
  assert.ok(added.some(r => r.tag === '等级参考' && /Epoch AI/.test(r.label)), '没用过的等级标「等级参考」，悬停写明 Epoch AI：' + JSON.stringify(added));
  assert.ok(added.every(r => /你添加的：没验证/.test(r.label)));
  // 行上的 × 移除
  await evaluate("document.querySelector('#quota-model-study .ms-row[data-model=\"gpt-6.1-sol\"] .ms-user-remove').click()");
  await until("!document.querySelector('#quota-model-study .ms-row[data-model=\"gpt-6.1-sol\"]')");
  assert.deepEqual(await evaluate("window.tokenpulse.readPrefs().then(p => p.studyModels?.chatgpt || [])"), []);
  console.log('PASS 0.3.12 add models + effort basis: picker from knowledge with prices, effort chips, saved to prefs, other-provider guard, dark mode, row tag "你添加的", "等级参考" with Epoch AI source, remove');
  console.log('PASS 0.3.8 model sections: both windows listed without querying, budget conversion, relative fallback, sorting, level filter, timeline lanes and quota curve (in quota page, following account tabs), focus, failure without stale data, late responses, 900px and reduced motion');
  clearTimeout(watchdog); app.exit(0);
 } catch(e){console.error('FAIL',e.message);clearTimeout(watchdog);app.exit(1);}
}));
if (process.env.TOKENPULSE_TEST_APP) {
 const { nativeImage } = require('electron'); const icons = require(path.join(appRoot,'build/main/icon.js')); const resources = path.dirname(appRoot);
 icons.trayIcon = () => nativeImage.createFromPath(path.join(resources,'packaging/tray.png'));
 icons.windowIcon = () => nativeImage.createFromPath(path.join(resources,'packaging/icon.png'));
}
require(path.join(appRoot,'build/main/index.js'));
