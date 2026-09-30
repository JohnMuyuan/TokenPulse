'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain, BrowserWindow } = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-provider-feedback-'));
process.env.TOKENPULSE_DATA_DIR = path.join(dir, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(dir, 'home');
process.env.AGENT_SWITCH_CC_DB = path.join(dir, 'missing.db');
for (const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','GROK_HOME']) delete process.env[key];
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, {recursive:true});
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR,'prefs.json'), JSON.stringify({autoLaunch:false,autoUpdate:false,closeToTray:true,startMinimized:true,language:'zh',notifyAt:0,notifyMismatch:false,ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done' }));
app.setPath('userData', path.join(dir,'electron'));
const sw = require('../build/core/agent-switch');
const id = sw.saveProvider({app:'claude',name:'Feedback QA',baseUrl:'https://feedback.invalid/v1',apiKey:'synthetic-only',model:'qa-model',upstream:'anthropic'});
const secondId = sw.saveProvider({app:'claude',name:'Second QA',baseUrl:'https://second.invalid/v1',apiKey:'synthetic-second',model:'second-model',upstream:'anthropic'});
let releaseState, delayState=false;
let releaseSave, releaseActivate, releaseModels, delaySave=false, failSave=false, delayActivate=false, failActivate=false, delayModels=false;
const counts={save:0,activate:0};
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>handle(channel,async(...args)=>{
  if(channel==='agent:state' && delayState){const state=await handler(...args);await new Promise(resolve=>{releaseState=resolve;});return state;}
  if(channel==='agent:save'){counts.save++;if(delaySave)await new Promise(resolve=>{releaseSave=resolve;});if(failSave)throw Error('QA save failure');}
  if(channel==='agent:activate'){counts.activate++;if(delayActivate)await new Promise(resolve=>{releaseActivate=resolve;});if(failActivate)throw Error('QA activate failure');}
  if(channel==='agent:models'){if(delayModels)await new Promise(resolve=>{releaseModels=resolve;});return {ok:true,result:['stale-qa-model']};}
  if(channel==='agent:probe')return {ok:true,result:{ok:true,status:401}};
  return handler(...args);
});
const watchdog=setTimeout(()=>{console.error('FAIL feedback test timed out');app.exit(1);},40000);
app.on('web-contents-created',(_event,wc)=>{wc.on('console-message',(_e,_l,m,ln,src)=>console.log('RENDERER',ln,src,m));wc.once('did-finish-load',async()=>{
  const e=code=>wc.executeJavaScript(code);
  const until=async code=>{const end=Date.now()+5000;while(!await e(code)){assert.ok(Date.now()<end,code);await new Promise(r=>setTimeout(r,30));}};
  const P='#page-providers';
  try {
    await until("typeof navigate === 'function' && !!current");
    // 0.3.9 起改工具配置前会弹对比确认；这个测试不是测确认框，自动点「确认写入」（确认框在 test-agent-guard-ui.cjs 里单独测）
    await e("setInterval(() => document.querySelector('#pv-confirm .btn-accent')?.click(), 40)");
    await e("navigate('providers')");await until(`document.querySelector('${P} [data-section=claude]')`);
    await e(`document.querySelector('${P} [data-section=claude]').click()`);
    const row=`document.querySelector('${P} .pv-row[data-id="${id}"]')`;
    delayActivate=true;failActivate=true;
    await e(`${row}.querySelector('.pv-use').click()`);await until(`document.querySelector('${P} .pv-use')`);
    assert.equal(await e(`document.querySelector('${P}').getAttribute('aria-busy')`),'true','Activation must immediately expose its pending state');
    assert.equal(await e(`${row}.querySelector('.pv-use').disabled`),true,'Repeated activation must be blocked');
    await e(`${row}.querySelector('.pv-use').click()`);assert.equal(counts.activate,1);
    releaseActivate();delayActivate=false;
    await until(`[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('QA activate failure'))`);
    assert.equal(await e(`${row}.querySelector('.pv-use').disabled`),false);
    failActivate=false;await e(`${row}.querySelector('.pv-use').click()`);await until(`document.querySelector('${P} .pv-current b')?.textContent === 'Feedback QA'`);
    await e(`[...document.querySelectorAll('${P} .pv-current button')].find(b=>b.textContent.includes('编辑')).click()`);
    await e(`document.querySelector('${P} .pv-editor [name=notes]').value='keep unsaved draft'`);
    delaySave=true;failSave=true;
    await e(`document.querySelector('${P} .pv-editor').requestSubmit()`);
    assert.equal(await e(`document.querySelector('${P} .pv-editor [name=notes]').disabled`),true,'Save must freeze the submitted draft');
    await e(`document.querySelector('${P} [data-section=edit-back]').click()`);
    assert.equal(await e(`!!document.querySelector('${P} .pv-editor')`),true);
    releaseSave();delaySave=false;
    await until(`[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('QA save failure'))`);
    assert.equal(await e(`document.querySelector('${P} .pv-editor [name=notes]').value`),'keep unsaved draft');
    assert.equal(await e(`document.querySelector('${P} .pv-editor [name=notes]').disabled`),false);
    // Snapshot pushes must not replace the editor DOM or its draft.
    await e(`void(window.qaEditor=document.querySelector('${P} .pv-editor'))`);
    wc.send('agent-switch',sw.agentView());await new Promise(r=>setTimeout(r,100));
    assert.equal(await e(`window.qaEditor===document.querySelector('${P} .pv-editor')`),true);
    failSave=false;await e(`document.querySelector('${P} .pv-editor').requestSubmit()`);await until(`!document.querySelector('${P} .pv-editor')`);
    assert.equal(sw.agentView().providers.find(p=>p.id===id).notes,'keep unsaved draft');
    await e(`[...document.querySelectorAll('${P} .pv-current button')].find(b=>b.textContent.includes('检测')).click()`);
    await until(`[...document.querySelectorAll('#toast-stack .tp-toast')].some(t => t.textContent.includes('HTTP 401'))`);
    assert.match(await e(`[...document.querySelectorAll('#toast-stack .tp-toast')].map(t => t.textContent).find(t => t.includes('HTTP 401'))`),/不.*验证|未.*验证/);
    // A late models response for old credentials must not fill the new connection.
    await e(`[...document.querySelectorAll('${P} .pv-current button')].find(b=>b.textContent.includes('编辑')).click()`);
    await e(`document.querySelector('${P} [data-section=edit-models]').click()`);delayModels=true;
    await e(`[...document.querySelectorAll('${P} .pv-editor button')].find(b=>b.textContent==='获取模型').click()`);
    await e(`document.querySelector('${P} [data-section=edit-connect]').click();document.querySelector('${P} .pv-editor [name=baseUrl]').value='https://changed.invalid'`);
    releaseModels();delayModels=false;await new Promise(r=>setTimeout(r,100));
    assert.equal(await e(`document.querySelectorAll('${P} .pv-fetched button').length`),0,'Late candidates must not apply to changed credentials');
    // Save failure does not lose the entered key and errors remain in the local panel.
    assert.equal(await e(`document.querySelector('${P} .pv-editor [name=baseUrl]').value`),'https://changed.invalid');
    await e(`document.querySelector('${P} [data-section=edit-back]').click();[...document.querySelectorAll('.tp-toast.pv-unsaved button')].find(b=>b.textContent==='放弃修改').click()`);
    await e(`document.querySelector('${P} [data-section=codex]').click();[...document.querySelectorAll('${P} .pv-head-actions button')].find(b=>b.textContent.includes('添加')).click();document.querySelector('${P} [data-section=edit-models]').click()`);
    await e(`for(let i=0;i<27;i++){[...document.querySelectorAll('${P} .pv-editor button')].find(b=>b.textContent.includes('添加模型')).click();}`);
    assert.equal(await e(`document.querySelectorAll('${P} .pv-slot:not(.pv-slot-head)').length`),24,'Editor must enforce the backend model limit');
    await e("setThemeMode('dark');document.getAnimations().forEach(a=>a.finish())");
    const win=BrowserWindow.fromWebContents(wc);win.setSize(900,800);await new Promise(r=>setTimeout(r,150));
    assert.equal(await e(`document.querySelector('${P}').scrollWidth<=document.querySelector('${P}').clientWidth+1`),true);
    wc.debugger.attach('1.3');await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await e(`void toast('QA reduced motion', { kind: 'pending', key: 'qa-motion' })`);assert.equal(await e(`getComputedStyle(document.querySelector('.tp-toast.pending .tp-toast-icon')).animationName`),'none');await e(`toastKeys.get('qa-motion')?.dispose()`);wc.debugger.detach();
    await e("document.querySelector('#page-providers [data-section=edit-back]').click();[...document.querySelectorAll('.tp-toast.pv-unsaved button')].find(b=>b.textContent==='放弃修改').click();document.querySelector('#page-providers [data-section=claude]').click()");
    delayState=true;
    await e('void window.PulseProviders.show()');
    const waitEnd=Date.now()+3000;while(!releaseState){assert.ok(Date.now()<waitEnd);await new Promise(r=>setTimeout(r,10));}
    await e("document.querySelector('#page-providers .pv-row[data-id=\"" + secondId + "\"] .pv-use').click()");
    await until("document.querySelector('#page-providers .pv-current b')?.textContent==='Second QA'");
    delayState=false;releaseState();await new Promise(r=>setTimeout(r,100));
    assert.equal(await e("document.querySelector('#page-providers .pv-current b').textContent"),'Second QA','Late state reads must not overwrite successful activation');
    await e("[...document.querySelectorAll('#page-providers .pv-current button')].find(b=>b.textContent.includes('编辑')).click()");
    assert.equal(await e("document.querySelector('#page-providers [data-section=edit-preview]') !== null"), true, 'Provider Preview page must exist');
    await e("document.querySelector('#page-providers [data-section=edit-preview]').click()");
    assert.equal(await e("document.querySelector('#page-providers .pv-preview-json') !== null"), true, 'Provider Model preview must render');
    await e("document.querySelector('#page-providers [data-section=edit-back]').click()");
    await e("[...document.querySelectorAll('.tp-toast.pv-unsaved button')].find(b=>b.textContent==='放弃修改')?.click()");
    await e("document.querySelector('#page-providers [data-section=codex]').click();[...document.querySelectorAll('#page-providers .pv-head-actions button')].find(b=>b.textContent.includes('添加')).click();document.querySelector('#page-providers [data-section=edit-models]').click()");
    assert.equal(await e("document.querySelectorAll('#page-providers .pv-level-trigger').length >= 1"), true, 'Reasoning levels must use dropdown multi-select');
    assert.equal(await e("[...document.querySelectorAll('#page-providers .pv-slot input[type=number]')].every(n=>Number(n.value)>0)"), true, 'Model contexts must have presets');
    assert.equal(await e("document.querySelectorAll('.tp-toast').length >= 1"), true, 'Success messages must use global toast');
    console.log('PASS provider feedback: pending lock, failed action retry, frozen save draft, live-push preservation, 401 clarity, stale model response, 24-model limit, dark/narrow/reduced motion');
    clearTimeout(watchdog);app.exit(0);
  }catch(error){console.error('FAIL',error);clearTimeout(watchdog);app.exit(1);}
  });
});
require('../build/main/index.js');
