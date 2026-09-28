const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenpulse-effort-scan-'));assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
process.env.HOME=process.env.USERPROFILE=path.join(root,'home');process.env.TOKENPULSE_DATA_DIR=path.join(root,'data');
for(const k of ['CODEX_HOME','CLAUDE_CONFIG_DIR','GROK_HOME','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY','OPENAI_BASE_URL'])delete process.env[k];
const {scanLocalUsage,readRollups,writeRollups}=require('../build/core/usage-scan');const {queryRequests,appendRequests}=require('../build/core/request-log');
const start=Date.UTC(2026,8,28,12),stamp=i=>new Date(start+i*60000).toISOString();
const file=path.join(process.env.HOME,'.codex','sessions','rollout-test.jsonl');const claude=path.join(process.env.HOME,'.claude','projects','qa','sample.jsonl');
const rows=[{type:'session_meta',payload:{model_provider:'openai'}},{type:'turn_context',payload:{model:'gpt-qa',effort:'high'}},{type:'token_usage_record',timestamp:stamp(0),payload:{response_id:'first',usage:{input_tokens:100,output_tokens:10}}},{type:'turn_context',payload:{model:'gpt-qa'}},{type:'token_usage_record',timestamp:stamp(1),payload:{response_id:'unknown',usage:{input_tokens:100,output_tokens:10}}},{type:'turn_context',payload:{model:'gpt-qa',effort:'low'}},{type:'token_usage_record',timestamp:stamp(2),payload:{response_id:'last',usage:{input_tokens:100,output_tokens:10}}}];
const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,v)};
write(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
const response=(id,extra)=>({type:'assistant',timestamp:stamp(4),requestId:id,message:{id,model:'claude-opus-5',content:[{type:'text',text:'/effort max'}],usage:{input_tokens:10,output_tokens:5}},...extra});
write(claude,[response('claude-known',{effort:'medium',perTurnEffort:'high'}),response('claude-unknown',{})].map(r=>JSON.stringify(r)).join('\n')+'\n');
const query=()=>queryRequests({from:'2026-09-28',to:'2026-09-28',source:'all',status:'all',search:'',sort:'time',page:0,pageSize:50,all:true});
try{
 scanLocalUsage();let result=query();const byId=Object.fromEntries(result.rows.map(r=>[r.responseId,r]));
 assert.equal(byId.first.effort,'high');assert.equal(byId.unknown.effort,undefined);assert.equal(byId.last.effort,'low');assert.equal(byId['claude-known'].effort,'high');assert.equal(byId['claude-unknown'].effort,undefined);
 const total=result.rows.reduce((s,r)=>s+r.tokens,0), initial=readRollups();
 // 模拟首批已完成、后续批仍需回放的中间状态；旧流水的 last 还没有等级。
 const month=path.join(root,'data','requests','2026-09.jsonl');const old=fs.readFileSync(month,'utf8').trim().split('\n').map(l=>JSON.parse(l));for(const r of old)if(r.id==='last'){delete r.effort;delete r.effortSource;}fs.writeFileSync(month,old.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const initialTokens = Object.values(initial.files).flatMap(f=>Object.values(f.days)).flatMap(s=>Object.values(s)).flatMap(m=>Object.values(m)).reduce((s,b)=>s+b.input+b.output,0);
 const prefix=rows.slice(0,5).map(r=>JSON.stringify(r)).join('\n')+'\n';const state=initial.files[file];state.offset=Buffer.byteLength(prefix);state.replayUntil=fs.statSync(file).size;state.metadataOnlyUntil=fs.statSync(file).size;state.size=fs.statSync(file).size;state.mtimeMs=fs.statSync(file).mtimeMs;state.effort=undefined;initial.requestsCompacted=1;writeRollups(initial);
 scanLocalUsage();result=query();assert.equal(result.rows.find(r=>r.responseId==='last').effort,'low');assert.equal(result.rows.reduce((s,r)=>s+r.tokens,0),total);assert.equal(readRollups().files[file].replayUntil,undefined);
 const finalTokens = Object.values(readRollups().files).flatMap(f=>Object.values(f.days)).flatMap(s=>Object.values(s)).flatMap(m=>Object.values(m)).reduce((s,b)=>s+b.input+b.output,0);assert.equal(finalTokens,initialTokens,'分批补采后总账 Token 不增加');
 const migrated=readRollups();migrated.files[file].v=6;writeRollups(migrated);scanLocalUsage();
 assert.deepEqual(readRollups().files[file].days,migrated.files[file].days,'6→7 元数据补采保留原总账');
 assert.equal(readRollups().files[file].metadataOnlyUntil,undefined);
 const lines=fs.readFileSync(month,'utf8').trim().split('\n').map(l=>JSON.parse(l));assert.equal(lines.length,new Set(lines.map(r=>r.kind+':'+r.id)).size);
 console.log('PASS effort capture: per-turn reset, Claude override, no inference from text, multi-batch enrichment and unique request totals');
}finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('tokenpulse-effort-scan-'));fs.rmSync(root,{recursive:true,force:true});}
