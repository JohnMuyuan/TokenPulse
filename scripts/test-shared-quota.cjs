const assert=require('node:assert/strict');
const {analyzeModelStudy}=require('../build/core/model-study');
const {analyzeAccount,capacityHistory,analyzeWindow}=require('../build/core/quota-monitor');
const now=Date.UTC(2026,8,28,12), minute=60000, id='claude:shared-test';
const q={kind:'claude',accountId:id,window:'week'};
const samples=[0,22,44,66].map((pct,i)=>({account:id,at:now-(3-i)*5*minute,week:pct,weekReset:new Date(now+3*86400000).toISOString(),five:pct,fiveReset:new Date(now+3600000).toISOString()}));
const rows=[1,2,3].map(i=>({key:'r'+i,at:now-(3-i)*5*minute-minute,source:'Claude Code',model:'claude-sonnet-5',effort:'high',session:'test',input:800,output:200,cacheRead:400,cacheWrite:0,reasoning:50,tokens:1000,costUsd:.01,priced:true,calls:1,official:true,account:{id,label:'Test',basis:'session'},status:'match',statusLabel:'match',reasons:[],channel:'Anthropic'}));
const catalog=[{model:'claude-sonnet-5',effort:'high',origins:['observed']}];
const result=analyzeModelStudy(q,samples,rows,catalog,now);
assert.equal(result.selected.used,66,'官方账号总额度必须保持真实值');
assert.equal(result.totals.tokens,3000,'本机 Code Token 不因聊天消耗而改变');
assert.equal(result.budget.costUsd,null,'未确认使用来源时，聊天和 Code 同期消费不能被强行换成整窗美元预算');
assert.equal(result.capacities[0].capacityTokens,null,'不得把全账号百分点分配给仅可见的 Code 请求');
const report=analyzeAccount('claude',samples,[{hour:now-3600000,account:id,model:'claude-sonnet-5',tokens:3000,costUsd:.03,requests:3}],now);
assert.equal(report.week.used,66);assert.equal(report.week.capacity,undefined,'旧容量入口也必须停止未经归因的整窗倒推');
assert.equal(capacityHistory(samples,[], 'week',now).unavailableReason,'unattributed');
assert.equal(analyzeWindow({current:66,startAt:now-3600000,resetAt:now+3600000,points:[],lookbackMs:3600000,minSpanMs:1,minElapsedMs:1},[{hour:now-3600000,model:'claude-sonnet-5',tokens:3000,costUsd:.03,requests:3}],now).capacity,undefined);
console.log('PASS shared-pool counterexample: official usage preserved; unverified absolute capacity withheld');

const { calibrationContains, updateCalibration, readCalibrations, calibrationStatus, forgetCalibrations } = require('../build/core/quota-calibration');
// 同期聊天无法靠“区间内出现 Code 请求”识别，默认必须仍然拒绝绝对换算。
assert.equal(result.attribution.unmatchedPoints,0);
assert.equal(result.attribution.simultaneousUsageUnknown,true);
for (const kind of ['grok','chatgpt']) {
 const aid=kind+':shared-test',model=kind==='grok'?'grok-4.6':'gpt-5.5';
 const copy=analyzeModelStudy({...q,kind,accountId:aid},samples.map(s=>({...s,account:aid})),rows.map(r=>({...r,model,account:{...r.account,id:aid}})),[{model,effort:'high',origins:['observed']}],now);
 assert.equal(copy.selected.used,66);assert.equal(copy.totals.tokens,3000);assert.equal(copy.budget.costUsd,null);
}
const deltas=[0,2,4,6,6,6,6,6,26,46,66,66];
const history=deltas.map((week,i)=>({...samples[0],at:now-(11-i)*5*minute,week,five:week}));
const local=rows.map((r,i)=>({...r,at:now-(51-i*5)*minute}));
const clean={id:'clean',kind:'claude',accountId:id,startAt:now-95*minute,endAt:now-35*minute,confirmedLocalOnly:true};
const protectedReference=analyzeModelStudy(q,history,local,catalog,now,[clean]);
assert.equal(protectedReference.selected.used,66);
assert.equal(protectedReference.totals.tokens,3000);
assert.ok(Math.abs(protectedReference.budget.costUsd-.5)<1e-9,'后来的聊天不污染以前的本机校准参考');
assert.ok(Math.abs(protectedReference.capacities[0].capacityTokens-50000)<1e-8);
assert.ok(Math.abs(protectedReference.capacities[0].remainingTokens-17000)<1e-8,'剩余预测仍使用真实 34% 余量，不能扣掉聊天后虚增');
assert.ok(protectedReference.attribution.unmatchedPoints>=20);
const badScope={...clean,id:'mixed-session',startAt:now-65*minute,endAt:now-5*minute};
const quarantined=analyzeModelStudy(q,history,local,catalog,now,[badScope]);
assert.equal(quarantined.budget.costUsd,null,'校准段发现未匹配增长，整段暂停采用，不能只挑好看的区间');
assert.ok(quarantined.attribution.blockedSessionIds.includes('mixed-session'));
assert.equal(quarantined.selected.used,66);
assert.equal(quarantined.capacities[0].costUsd,.03,'保留本机真实费用参考');
const duplicated=analyzeModelStudy(q,history,local,catalog,now,[clean,{...clean,id:'duplicate'}]);assert.equal(duplicated.budget.points,6,'确认范围重叠不得重复计量');
const sparse=history.filter((_,i)=>i===0||i>=9);
const unresolved=analyzeModelStudy(q,sparse,local,catalog,now);assert.ok(unresolved.attribution.uncertainPoints>0);assert.equal(unresolved.budget.costUsd,null);
// API 价格不同不代表官方扣额权重相同：同组合观测不能被混合价格预算覆盖。
const perModelSamples=Array.from({length:7},(_,i)=>({...samples[0],at:now-(6-i)*5*minute,week:i*2,five:i*2}));
const perModelRows=Array.from({length:6},(_,i)=>({...rows[0],key:'m'+i,at:now-(6-i)*5*minute+minute,model:i<3?'claude-sonnet-5':'claude-opus-5-5',costUsd:i<3?.01:.02}));
const priority=analyzeModelStudy(q,perModelSamples,perModelRows,[...catalog,{model:'claude-opus-5-5',effort:'high',origins:['observed']}],now,[{...badScope,id:'per-model',startAt:now-55*minute,endAt:now+5*minute}]);
for(const c of priority.capacities){assert.equal(c.capacityTokens,50000);assert.equal(c.capacityBasis,'measured');}
const twoCycles=[{at:now-45*minute,five:0,fiveReset:new Date(now-30*minute).toISOString()},{at:now-35*minute,five:8,fiveReset:new Date(now-30*minute).toISOString()},{at:now-25*minute,five:0,fiveReset:new Date(now+270*minute).toISOString()},{at:now-15*minute,five:8,fiveReset:new Date(now+270*minute).toISOString()}].map(s=>({...s,account:id}));
const tooFew=analyzeModelStudy({...q,window:'five'},twoCycles,[{...rows[0],at:now-40*minute},{...rows[1],at:now-20*minute}],catalog,now,[{...badScope,id:'small-sample'}]);
assert.equal(tooFew.budget.intervals,2);assert.equal(tooFew.budget.cycles,2);assert.equal(tooFew.budget.points,16);assert.equal(tooFew.budget.confidence,'insufficient');assert.equal(tooFew.budget.costUsd,null,'高百分点/多周期不能绕过最低样本数');
console.log('PASS shared-pool safeguards across providers, quiet gaps, concurrent-use ambiguity, reference isolation, quarantine and official remaining quota');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenpulse-calibration-'));
assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
const oldDir=process.env.TOKENPULSE_DATA_DIR;process.env.TOKENPULSE_DATA_DIR=root;
try {
 fs.writeFileSync(path.join(root,'official-accounts.json'),JSON.stringify({version:2,active:{},accounts:[{id,kind:'claude',ref:'shared-test',email:'',label:'test',createdAt:now,lastSeenAt:now}]}));
 assert.throws(()=>updateCalibration({kind:'claude',accountId:id,action:'start'},now));
 let state=updateCalibration({kind:'claude',accountId:id,action:'start',confirmedLocalOnly:true,startAt:now-86400000},now);
 const sid=state.active.id;assert.equal(state.active.startAt,now,'客户端不能回填历史时间');assert.equal(state.active.endAt,now+60*minute);
 assert.equal(calibrationContains(state.active,id,now+5*minute,now+15*minute,now+20*minute),false,'前10分钟缓冲不能校准');
 assert.equal(calibrationContains(state.active,id,now+10*minute,now+15*minute,now+20*minute),true);
 assert.throws(()=>updateCalibration({kind:'claude',accountId:id,action:'start',confirmedLocalOnly:true},now+minute));
 assert.throws(()=>updateCalibration({kind:'grok',accountId:'grok:other',action:'discard',sessionId:sid},now+minute));
 state=updateCalibration({kind:'claude',accountId:id,action:'finish',sessionId:sid},now+20*minute);assert.equal(state.active,null);assert.equal(state.sessions[0].stoppedAt,now+20*minute);
 assert.equal(calibrationContains(state.sessions[0],id,now+20*minute,now+25*minute,now+30*minute),false);
 state=updateCalibration({kind:'claude',accountId:id,action:'discard',sessionId:sid},now+25*minute);assert.ok(state.sessions[0].discardedAt);
 assert.equal(calibrationContains(state.sessions[0],id,now+10*minute,now+15*minute,now+30*minute),false);
 updateCalibration({kind:'claude',accountId:id,action:'start',confirmedLocalOnly:true},now+30*minute);
 assert.equal(calibrationStatus('claude',id,now+91*minute).active,null,'60分钟自动结束，不无限期授权');
 assert.throws(()=>updateCalibration({kind:'claude',accountId:id,action:'start',confirmedLocalOnly:true,durationMinutes:9999},now+92*minute));
 const long=updateCalibration({kind:'claude',accountId:id,action:'start',confirmedLocalOnly:true,durationMinutes:240},now+92*minute);assert.equal(long.active.endAt-long.active.startAt,240*minute);
 forgetCalibrations(id);assert.equal(readCalibrations().length,0,'完全删除账号同时清理校准记录');
 console.log('PASS forward-only explicit consent, warmup, account isolation, expiry, finish, revoke and purge');
} finally { if(oldDir===undefined)delete process.env.TOKENPULSE_DATA_DIR;else process.env.TOKENPULSE_DATA_DIR=oldDir;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('tokenpulse-calibration-'));fs.rmSync(root,{recursive:true,force:true}); }
