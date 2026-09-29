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
write(path.join(root, 'data', 'prefs.json'), { autoLaunch:false, autoUpdate:false, closeToTray:true, startMinimized:true, language:'zh', notifyAt:0, notifyMismatch:false, ccSwitch:false });
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
 const evaluate=code=>contents.executeJavaScript(code),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async code=>{const end=Date.now()+10000;while(!await evaluate(code)){assert.ok(Date.now()<end,'Timed out: '+code);await delay(30);}};
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
  assert.equal(await text(`${Q} .ms-budget.five .ms-budget-value`), '$0.50本机专用样本 · API 等价参考');
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
  // 0.3.9：确认/作废走真实 IPC；不允许用新确认授权旧的混用历史。
  await evaluate("state.account='chatgpt:qa-study'; navigate('quota')");
  await until("document.querySelector('#quota-model-study .ms-calibration') && !document.querySelector('#quota-model-study').hasAttribute('aria-busy')");
  await evaluate("document.querySelector('#quota-model-study .ms-calibration').open=true; document.querySelector('#quota-model-study [data-calibration-action=discard]').click()");
  await until("!document.querySelector('#quota-model-study').hasAttribute('aria-busy') && document.querySelector('#quota-model-study .ms-cap.five b').textContent.startsWith('×')");
  assert.equal(await evaluate("document.querySelector('#quota-model-study [data-calibration-action=start]').disabled"),true);
  assert.match(await text(Q+' .ms-budget.five .ms-budget-value'),/6\.0%/,'无校准时显示官方已用，不显示伪造美元余额');
  assert.doesNotMatch(await text(Q+' .ms-budget.five'),/还剩约.*\$/);
  await evaluate("document.querySelector('#quota-model-study [data-calibration-confirm]').click(); document.querySelector('#quota-model-study [data-calibration-duration]').value='120'; document.querySelector('#quota-model-study [data-calibration-duration]').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.querySelector('#quota-model-study [data-calibration-confirm]').checked"),false);
  assert.equal(await evaluate("document.querySelector('#quota-model-study [data-calibration-action=start]').disabled"),true);
  await evaluate("document.querySelector('#quota-model-study [data-calibration-duration]').value='60'; document.querySelector('#quota-model-study [data-calibration-duration]').dispatchEvent(new Event('change'))");
  const startedAfter=Date.now();
  await evaluate("document.querySelector('#quota-model-study [data-calibration-confirm]').click(); document.querySelector('#quota-model-study [data-calibration-action=start]').click()");
  await until("document.querySelector('#quota-model-study [data-calibration-action=finish]') && !document.querySelector('#quota-model-study').hasAttribute('aria-busy')");
  const cal=await evaluate("window.tokenpulse.modelStudy({kind:'chatgpt',accountId:'chatgpt:qa-study'}).then(s=>s.calibration.active)");
  assert.ok(cal.startAt>=startedAfter);assert.equal(cal.endAt-cal.startAt,3600000);
  assert.ok((await text(Q+' .ms-cap.five b')).startsWith('×'),'新校准不能把过去已存在的额度变化倒推成可信预算');
  await evaluate("document.querySelector('#quota-model-study [data-calibration-action=finish]').click()");
  await until("document.querySelector('#quota-model-study [data-calibration-action=start]') && !document.querySelector('#quota-model-study').hasAttribute('aria-busy')");
  // 假历史里增加一笔没有对应 Code 请求的官方额度变化；保留 4K 的本机日志。
  write(path.join(root,'data','quota-history.json'),{version:1,accounts:{chatgpt:[...samples,{...samples[3],account:'chatgpt:qa-study',at:Date.now()-1,five:36,week:33}]}});
  await evaluate("window.tokenpulse.refresh()");
  await evaluate("state.account='chatgpt:qa-study'; navigate('quota')");
  await until("document.querySelector('#quota-model-timeline .ms-unmatched-band') && !document.querySelector('#quota-model-timeline').hasAttribute('aria-busy')");
  const safe=await evaluate("window.tokenpulse.modelStudy({kind:'chatgpt',accountId:'chatgpt:qa-study'}).then(s=>({used:s.five.selected.used,tokens:s.five.totals.tokens,budget:s.five.budget.costUsd}))");
  assert.equal(safe.used,36);assert.equal(safe.tokens,4000);assert.equal(safe.budget,null);
  console.log('PASS 0.3.9 shared-pool UI: explicit consent, forward-only calibration, revoke, no fictitious balance, unmatched growth and unchanged official totals');
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
