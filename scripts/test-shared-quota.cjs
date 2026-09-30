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
// 0.3.9：同期有本机请求的区间直接折算（同一时刻也在聊天分不出来，只会让容量略偏小），不再要求校准
assert.ok(Math.abs(result.budget.costUsd-0.03/66*100)<1e-9,'每个区间都有本机请求：按本机费用 ÷ 涨幅折算');
const report=analyzeAccount('claude',samples,[{hour:now-3600000,account:id,model:'claude-sonnet-5',tokens:3000,costUsd:.03,requests:3}],now);
assert.equal(report.week.used,66);assert.equal(report.week.capacity,undefined,'按小时账的旧倒推入口仍然关闭（共享账号的容量由 report.ts 用干净区间补上）');
assert.equal(capacityHistory(samples,[], 'week',now).unavailableReason,'unattributed');
console.log('PASS shared-pool baseline: official usage preserved; clean local intervals converted without calibration');
// 0.3.9：用户在设置里声明「只在本机用 Code，不聊天」的账号，按以前的方式直接折算
{
  const local=analyzeAccount('claude',samples,[{hour:now-3600000,account:id,model:'claude-sonnet-5',tokens:3000,costUsd:.03,requests:3}],now,undefined,true);
  assert.equal(local.quotaScope,'local_only');
  assert.ok(Math.abs(local.week.capacity.tokens-3000/0.66)<1,'只在本机用 Code：本机用量 ÷ 已用百分比');
  assert.equal(local.week.capacityReason,undefined);
  assert.equal(local.capacityHistory.week.unavailableReason,undefined,'历史容量恢复显示');
  const study=analyzeModelStudy(q,samples,rows,catalog,now,[],true);
  assert.ok(study.budget.costUsd>0&&study.localOnly===true);
  console.log('PASS local-only accounts: capacity, history and model budget computed directly');
}

// 本机以外的消耗：额度涨了、同期（前后 5 分钟）本机没有请求 → 自动识别，不进折算
const { cleanCapacity, updateMark, readMarks, forgetMarks, mergeOff } = require('../build/core/quota-offmachine');
const deltas=[0,2,4,6,6,6,6,6,26,46,66,66];
const history=deltas.map((week,i)=>({...samples[0],at:now-(11-i)*5*minute,week,five:week}));
const local=rows.map((r,i)=>({...r,at:now-(51-i*5)*minute}));
{
  const study=analyzeModelStudy(q,history,local,catalog,now);
  assert.equal(study.selected.used,66,'官方已用保持真实值');
  assert.ok(Math.abs(study.budget.costUsd-.5)<1e-9,'只用本机区间：0.03 美元 ÷ 6 个点');
  assert.ok(Math.abs(study.capacities[0].capacityTokens-50000)<1e-8);
  assert.ok(Math.abs(study.capacities[0].remainingTokens-17000)<1e-8,'剩余预测用真实 34% 余量');
  assert.equal(study.offMachine.points,40,'后面两段本机没有请求的涨幅算作本机以外');
  assert.equal(study.offMachine.detected.length,1,'相邻的本机以外区间合成一段');
  // 紧挨着本机请求（5 分钟内）的涨幅说不清，不当成本机以外
  assert.ok(study.offMachine.detected[0].from>=now-15*minute);
  // 标注：这段在网页上用 Sonnet high → 不再显示成待标注，按容量表换算成等价 Token
  const mark={id:'m1',kind:'claude',accountId:id,from:now-20*minute,to:now-5*minute,model:'claude-sonnet-5',effort:'high',source:'chat',note:'',updatedAt:now};
  const marked=analyzeModelStudy(q,history,local,catalog,now,[],false,[mark]);
  assert.equal(marked.offMachine.detected.length,0);
  assert.equal(marked.offMachine.marks[0].points,60);
  assert.equal(marked.offMachine.marks[0].equivalentTokens,30000,'60 个点 × 整窗 50000 Tokens');
  // 标注盖住有本机请求的区间：可能混用，这个区间不进折算
  const mixed=analyzeModelStudy(q,history,local,catalog,now,[],false,[{...mark,id:'m2',from:now-50*minute,to:now-46*minute}]);
  assert.equal(mixed.excluded.offMachine,1);assert.equal(mixed.budget.points,4);
  // 0.3.13：删除（ignored）的一段不算本机以外，也不进折算；待标注的分段（model 为空）照样盖住、不进折算
  const ignored=analyzeModelStudy(q,history,local,catalog,now,[],false,[{...mark,id:'m3',model:'',effort:'unknown',ignored:true}]);
  assert.equal(ignored.offMachine.points,0);assert.equal(ignored.offMachine.detected.length,0);assert.ok(Math.abs(ignored.budget.costUsd-.5)<1e-9,'删掉的不进分母');
  assert.equal(cleanCapacity('claude',history,local,[{...mark,ignored:true}],'week',now).current.offPoints,0);
  const pieces=analyzeModelStudy(q,history,local,catalog,now,[],false,[{...mark,id:'p1',model:'',effort:'unknown',to:now-12*minute},{...mark,id:'p2',model:'',effort:'unknown',from:now-12*minute}]);
  assert.equal(pieces.offMachine.detected.length,0);assert.equal(pieces.offMachine.marks.length,2);assert.equal(pieces.offMachine.markedPoints,marked.offMachine.markedPoints,'切成两段不改变总量');
  // 合并：中间没有本机请求的，相隔 6 小时以内都算一段（用户自己切）；中间有本机请求就分开；不给 rows 按以前的 30 分钟
  const h=60*minute, iv=[{from:0,to:5*minute,points:1},{from:3*h,to:3*h+5*minute,points:2},{from:10*h,to:10*h+5*minute,points:3}];
  assert.deepEqual(mergeOff(iv,[]).map(x=>[x.from,x.to,x.points]),[[0,3*h+5*minute,3],[10*h,10*h+5*minute,3]]);
  assert.equal(mergeOff(iv,[{at:h}]).length,3,'中间有本机请求就不合并');
  assert.equal(mergeOff(iv).length,3);
  // 额度详情的容量（report.ts 用的同一套）：本机以外的 40 个点不进分母
  const capacity=cleanCapacity('claude',history,local,[],'week',now);
  assert.equal(capacity.current.tokens,50000);assert.equal(capacity.current.offPoints,40);
  assert.equal(capacity.history.points[0].cleanPoints,6);assert.equal(capacity.history.basis,'clean');
  // 区间有缺口（采样隔了半小时以上）说不清，不折算
  const sparse=history.filter((_,i)=>i===0||i>=9);
  const unresolved=analyzeModelStudy(q,sparse,local,catalog,now);assert.equal(unresolved.budget.costUsd,null);
  // 两个周期各一个区间：样本数不够，不能绕过最低样本要求
  const twoCycles=[{at:now-45*minute,five:0,fiveReset:new Date(now-30*minute).toISOString()},{at:now-35*minute,five:8,fiveReset:new Date(now-30*minute).toISOString()},{at:now-25*minute,five:0,fiveReset:new Date(now+270*minute).toISOString()},{at:now-15*minute,five:8,fiveReset:new Date(now+270*minute).toISOString()}].map(s=>({...s,account:id}));
  const tooFew=analyzeModelStudy({...q,window:'five'},twoCycles,[{...rows[0],at:now-40*minute},{...rows[1],at:now-20*minute}],catalog,now);
  assert.equal(tooFew.budget.intervals,2);assert.equal(tooFew.budget.confidence,'insufficient');assert.equal(tooFew.budget.costUsd,null);
  for (const kind of ['grok','chatgpt']) {
    const aid=kind+':shared-test',model=kind==='grok'?'grok-4.6':'gpt-5.5';
    const copy=analyzeModelStudy({...q,kind,accountId:aid},history.map(s=>({...s,account:aid})),local.map(r=>({...r,model,account:{...r.account,id:aid}})),[{model,effort:'high',origins:['observed']}],now);
    assert.equal(copy.selected.used,66);assert.equal(copy.offMachine.points,40);assert.ok(Math.abs(copy.budget.costUsd-.5)<1e-9);
  }
  console.log('PASS off-machine usage: detection, merge, lag guard, marks with token equivalents, mixed-mark exclusion, clean capacity, gaps and minimum samples across providers');
}
const { calibrationContains, updateCalibration, readCalibrations, calibrationStatus, forgetCalibrations } = require('../build/core/quota-calibration');
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
 // 本机以外的标注：新建 / 修改 / 删除 / 校验 / 完全删除账号时一起清掉
 assert.throws(()=>updateMark({kind:'claude',accountId:id,from:now,to:now-minute,model:'m'},now),/晚于/);
 assert.throws(()=>updateMark({kind:'claude',accountId:id,from:now-minute,to:now,model:''},now),/模型/);
 assert.throws(()=>updateMark({kind:'claude',accountId:id,from:now+86400000,to:now+86400000+minute,model:'m'},now),/还没发生/);
 let marks=updateMark({kind:'claude',accountId:id,from:now-30*minute,to:now-10*minute,model:'claude-opus-5',effort:'high',source:'chat',note:'网页'},now);
 assert.equal(marks.length,1);assert.equal(marks[0].effort,'high');
 marks=updateMark({kind:'claude',accountId:id,id:marks[0].id,from:now-40*minute,to:now-10*minute,model:'claude-opus-5',effort:'bogus'},now);
 assert.equal(marks.length,1);assert.equal(marks[0].from,now-40*minute);assert.equal(marks[0].effort,'unknown','不认识的等级按不确定存');
 assert.throws(()=>updateMark({kind:'claude',accountId:'claude:other',action:'delete',id:marks[0].id},now));
 updateMark({kind:'claude',accountId:id,from:now-5*minute,to:now,model:'claude-opus-5'},now);
 assert.equal(updateMark({kind:'claude',accountId:id,action:'delete',id:marks[0].id},now).length,1);
 // 0.3.13 剪辑：分割检测到的一段 → 两条待标注；分割一条标注 → 后一段复制模型；删除 / 恢复；越界报错
 forgetMarks(id);
 assert.throws(()=>updateMark({kind:'claude',accountId:id,action:'split',from:now-60*minute,to:now-30*minute,at:now-20*minute},now),/中间/);
 marks=updateMark({kind:'claude',accountId:id,action:'split',from:now-60*minute,to:now-30*minute,at:now-45*minute},now);
 assert.deepEqual(marks.map(m=>[m.from,m.to,m.model,m.effort,!!m.ignored]),[[now-60*minute,now-45*minute,'','unknown',false],[now-45*minute,now-30*minute,'','unknown',false]]);
 marks=updateMark({kind:'claude',accountId:id,id:marks[0].id,from:marks[0].from,to:marks[0].to,model:'claude-opus-5',effort:'high',source:'chat'},now);
 const labeled=marks.find(m=>m.model);
 marks=updateMark({kind:'claude',accountId:id,action:'split',id:labeled.id,at:now-50*minute},now);
 assert.equal(marks.length,3);assert.deepEqual(marks.filter(m=>m.model).map(m=>[m.from,m.to,m.effort]),[[now-60*minute,now-50*minute,'high'],[now-50*minute,now-45*minute,'high']],'分割标注：两段都带模型和等级');
 assert.throws(()=>updateMark({kind:'claude',accountId:id,action:'split',id:labeled.id,at:now-40*minute},now),/中间/);
 marks=updateMark({kind:'claude',accountId:id,action:'ignore',id:marks[2].id},now);assert.equal(marks[2].ignored,true);
 marks=updateMark({kind:'claude',accountId:id,action:'restore',id:marks[2].id},now);assert.equal(marks[2].ignored,undefined);
 marks=updateMark({kind:'claude',accountId:id,action:'ignore',from:now-25*minute,to:now-20*minute},now);assert.equal(marks.at(-1).ignored,true);assert.equal(marks.at(-1).model,'');
 assert.throws(()=>updateMark({kind:'claude',accountId:'claude:other',action:'ignore',id:marks[0].id},now),/找不到/);
 assert.throws(()=>updateMark({kind:'claude',accountId:id,action:'restore',id:'nope'},now),/找不到/);
 forgetMarks(id);assert.equal(readMarks().length,0);
 console.log('PASS calibration store (kept for old records) and off-machine marks: create, edit, validate, delete, purge; 0.3.13 split / ignore / restore, ignored excluded from off-machine and capacity, pending pieces, merge across quiet gaps');
} finally { if(oldDir===undefined)delete process.env.TOKENPULSE_DATA_DIR;else process.env.TOKENPULSE_DATA_DIR=oldDir;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('tokenpulse-calibration-'));fs.rmSync(root,{recursive:true,force:true}); }
