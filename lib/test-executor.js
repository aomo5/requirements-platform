'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const TYPES={case:'test-case',scenario:'test-scenario',suite:'test-suite'};
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/.test(v);
const businessEnvironment=e=>e.scope==='business' && typeof e.database==='string' && /^[a-zA-Z0-9_-]+$/.test(e.database);
// Keep credentials in the CLI's private login store. Never retain stdout, request bodies or raw reports.
class ApifoxExecutor {
 constructor({cli,configFile,root}){this.cli=cli;this.configFile=configFile;this.root=root;this.children=new Set();this.stopping=false;}
 stop(){this.stopping=true;for(const child of this.children){try{process.kill(-child.pid,'SIGTERM');}catch{/* Already exited. */}}}
 async config(){try {const c=JSON.parse(await fs.readFile(this.configFile,'utf8'));return {environments:Array.isArray(c.environments)?c.environments:[]};}catch(e){if(e.code==='ENOENT')return {environments:[]};throw Error('测试执行器配置无效');}}
 async environments(){return (await this.config()).environments.map(e=>({id:e.id,name:e.name,ready:e.ready===true,business:businessEnvironment(e),reason:e.ready===true?'':(e.reason||'测试资源尚未确认'),resourceKeys:e.allowedResources||[]}));}
 async command(args,{timeout=30000,cwd}={}){
  if(this.stopping)throw Error('执行器正在停止');
  if(!this.cli)fail('尚未配置 Apifox CLI 路径',503);
  const working=cwd||this.root,limit=8*1024*1024;
  let privateDir,output,child,timer,hardTimer,monitor,timedOut=false,overflow=false,terminating=false,finished=false;
  const kill=signal=>{try{if(child?.pid)process.kill(-child.pid,signal);}catch{/* Already exited. */}};
  const terminate=()=>{if(finished||terminating)return;terminating=true;kill('SIGTERM');hardTimer=setTimeout(()=>kill('SIGKILL'),2000);hardTimer.unref();};
  try{
   await fs.mkdir(working,{recursive:true,mode:0o700});
   privateDir=await fs.mkdtemp(path.join(working,'.apifox-command-'));await fs.chmod(privateDir,0o700);
   output=await fs.open(path.join(privateDir,'stdout.private'),'wx+',0o600);await output.chmod(0o600);
   if(this.stopping)throw Error('执行器正在停止');
   // A regular fd makes Node flush writes synchronously, including CLI paths that call process.exit().
   const code=await new Promise((resolve,reject)=>{
    child=spawn(process.execPath,[this.cli,...args],{cwd:working,stdio:['ignore',output.fd,'ignore'],shell:false,detached:true,env:Object.fromEntries(['HOME','PATH','TMPDIR','USER','LOGNAME','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))});
    this.children.add(child);
    timer=setTimeout(()=>{timedOut=true;terminate();},timeout);
    let checking=false;
    monitor=setInterval(async()=>{
     if(finished)return;
     if(this.stopping){terminate();return;}
     if(checking)return;checking=true;
     try{if((await output.stat()).size>limit&&!finished){overflow=true;terminate();}}catch{/* Final read reports I/O failures. */}finally{checking=false;}
    },50);
    child.once('error',()=>reject(Object.assign(Error('Apifox 执行进程无法启动'),{status:503})));
    child.once('close',resolve);
   });
   if(this.stopping)throw Error('执行器已停止');
   if(timedOut)throw Error('执行超时，结果未确认');
   if(overflow||(await output.stat()).size>limit){overflow=true;throw Error('报告超出读取限制');}
   const out=await fs.readFile(path.join(privateDir,'stdout.private'),'utf8');
   if(Buffer.byteLength(out)>limit){overflow=true;throw Error('报告超出读取限制');}
   return {code,out};
  }finally{
   finished=true;
   clearTimeout(timer);clearTimeout(hardTimer);clearInterval(monitor);
   if(terminating||this.stopping||overflow)kill('SIGKILL');
   if(child)this.children.delete(child);
   try{if(output)await output.close();}finally{if(privateDir)await fs.rm(privateDir,{recursive:true,force:true});}
  }
 }
 async resource(input){
  if(!Object.hasOwn(TYPES,input.type)||![input.projectId,input.branchId,input.resourceId].every(id))fail('请填写有效的项目、分支与资源 ID');
  const r=await this.command([TYPES[input.type],'get',input.resourceId,'--project',input.projectId,'--branch',input.branchId]);
  let d;try{d=JSON.parse(r.out);}catch{fail('Apifox资源响应不完整或无法解析，请检查执行器连接',503);}
  if(r.code!==0||d.success!==true||!d.data)fail('Apifox 资源不存在、无权限或尚未登录',503);
  const data=d.data;
  return {type:input.type,projectId:input.projectId,branchId:input.branchId,resourceId:input.resourceId,name:String(data.name||input.resourceId).slice(0,200),url:`https://app.apifox.com/project/${input.projectId}`,verifiedAt:new Date().toISOString()};
 }
 async prepare(resource,environmentId){
  const env=(await this.config()).environments.find(e=>e.id===environmentId);
  if(!env)fail('请选择已配置的受控环境');
  if(env.ready!==true)fail(env.reason||'测试环境前置未就绪',409);
  if((env.scope!=='preflight'&&!businessEnvironment(env))||!id(String(env.apifoxId)))fail('环境缺少已核实的测试库或 Apifox 环境 ID',409);
  if(!Array.isArray(env.allowedResources)||!env.allowedResources.includes(`${resource.projectId}:${resource.branchId}:${resource.type}:${resource.resourceId}`))fail('此资源未获准在该环境执行',403);
  let runtime=null;
  if(businessEnvironment(env)){
   let probe;try{probe=new URL(env.preflightUrl);}catch{fail('业务环境缺少独立驱动前置检查地址',409);}
   if(probe.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(probe.hostname)||probe.pathname!=='/pilot/preflight')fail('首版只允许本机独立驱动前置检查',409);
   try{const response=await fetch(probe,{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw Error();runtime=await response.json();}catch{fail('业务驱动前置检查不可用',409);}
   if(runtime.ready!==true||runtime.resourcesConfirmed!==true||runtime.masterDatabase!==env.database||runtime.slaveDatabase!==env.database||!runtime.codeVersion||!runtime.serviceVersion)fail('业务驱动未确认专用资源、主从测试库或服务版本',409);
  }
  const current=await this.resource(resource);
  const r=await this.command([TYPES[resource.type],'get',resource.resourceId,'--project',resource.projectId,'--branch',resource.branchId]);
  let data;try{data=JSON.parse(r.out).data;}catch{fail('无法读取运行成员快照',503);}
  // Dynamic selections cannot provide a deterministic member snapshot in the first version.
  const members=resource.type==='suite' ? (data.items||[]) : resource.type==='scenario' ? (data.steps||[]) : [{id:resource.resourceId}];
  if(!members.length)fail('资源没有可执行成员',409);
  if(resource.type==='suite'&&members.some(m=>!['STATIC_TEST_SCENARIO','STATIC_TEST_CASE'].includes(m.type)))fail('首版仅运行显式成员套件',409);
  const selection=members.map(m=>({id:String(m.id||''),type:String(m.type||''),testScenarios:(m.testScenarios||[]).map(x=>({id:x.id})),testCases:(m.testCases||[]).map(x=>({id:x.id}))}));
  return {resource:current,environment:{id:env.id,name:env.name,apifoxId:String(env.apifoxId),database:env.database||null,scope:env.scope||'business',onError:['ignore','continue','end'].includes(env.onError)?env.onError:'continue',expectedScenarios:env.expectedScenarios||['PAY-ASYNC-001','PAY-ASYNC-002','DEV-ISOLATE-001'],evidenceUrl:env.scope==='preflight'?null:env.evidenceUrl},selection,parameters:{iterations:1,dataRows:[{iteration:1,...Object.fromEntries(Object.entries(env.parameters||{}).filter(([k,v])=>['prepayCents','consumedCents','deadlineMs','cardBalanceCents','perChargeCents','durationMinutes'].includes(k)&&Number.isSafeInteger(v)))}]},resourceFingerprint:require('node:crypto').createHash('sha256').update(JSON.stringify(data)).digest('hex'),codeVersion:runtime?.codeVersion||env.codeVersion||'未核实',serviceVersion:runtime?.serviceVersion||env.serviceVersion||'未核实'};
 }
 async run(snapshot,runId){
  const dir=path.join(this.root,runId);await fs.mkdir(dir,{recursive:true,mode:0o700});
  const r=snapshot.resource,e=snapshot.environment;
  try{
   const route=snapshot.routeAudit;
   const routeArgs=route?['--env-var',`workbenchRouteId=${route.id}`,'--env-var',`workbenchRouteSignature=${route.signature}`,'--env-var',`workbenchScenario=${route.caseId}`]:[];
   const result=await this.command(['run','--'+TYPES[r.type],r.resourceId,'--project',r.projectId,'--branch',r.branchId,'-e',e.apifoxId,'-n','1','--on-error',e.onError||'continue','--timeout-request','60000','--timeout-script','5000','--env-var',`workbenchRunId=${runId}`,...routeArgs,'-r','json','--out-dir',dir,'--out-file','result','--upload-report','overview','--silent'],{timeout:180000,cwd:dir});
   const files=await fs.readdir(dir);const reports=files.filter(f=>f.endsWith('.json')&&!f.includes('failures'));
   if(reports.length!==1)return {status:'incomplete',reason:'Apifox 未生成唯一 JSON 报告',exitCode:result.code};
   const stat=await fs.stat(path.join(dir,reports[0]));if(stat.size>16*1024*1024)throw Error('报告超出读取限制');
   const raw=JSON.parse(await fs.readFile(path.join(dir,reports[0]),'utf8'));
   const native=nativeReport(result.out,r.projectId);
   const summary={...summarize({...raw,...native}),...native};
   if(e.scope==='business'){
    let evidence;try{const u=new URL(e.evidenceUrl);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/pilot/runs/')throw Error();const response=await fetch(new URL(runId,u),{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw Error();evidence=await response.json();}catch{/* Missing evidence must never promote a run. */}
    const valid=businessEvidenceComplete(route?[route.caseId]:e.expectedScenarios,evidence,runId,e.database);
    summary.businessEvidence=evidence?.runId===runId?evidence.results:[];summary.businessExecuted=valid;
    if(!valid&&summary.status==='passed'){summary.status='incomplete';summary.reason='业务结果或本次数据清理证据未完整取得';}
   }
   if(result.code!==0&&summary.status==='passed'){summary.status='incomplete';summary.reason='执行进程异常退出，报告结果未确认';}
   return {...summary,exitCode:result.code};
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 }
}
function businessEvidenceComplete(expected,evidence,runId,database){
 if(typeof runId!=='string'||!runId.trim()||!database||!Array.isArray(expected)||!expected.length)return false;
 const required=new Set();
 for(const name of expected){if(typeof name!=='string'||!name.trim()||required.has(name))return false;required.add(name);}
 if(evidence?.runId!==runId||!Array.isArray(evidence.results)||evidence.results.length!==required.size)return false;
 const seen=new Set();
 for(const result of evidence.results){
  if(!result||!required.has(result.scenario)||seen.has(result.scenario)||result.runId!==runId||result.executed!==true||result.database!==database||result.cleanupCompleted!==true)return false;
  seen.add(result.scenario);
 }
 return seen.size===required.size;
}
function nativeReport(output,projectId){
 let native={};
   for(const token of output.match(/https:\/\/[^\s<>"']+/g)||[]){
    try{const u=new URL(token),m=/^\/link\/project\/([0-9]+)\/api-test\/test-report\/([0-9]+)$/.exec(u.pathname);
     if(u.hostname==='app.apifox.com'&&m?.[1]===projectId){native={reportId:m[2],reportUrl:u.origin+u.pathname};break;}
    }catch{/* Untrusted output is never rendered directly. */}
   }
 return native;
}
function summarize(raw){
 const report=raw?.result||raw?.run||raw;
 const s=report?.stats,steps=s?.steps,sourceAssertions=s?.assertions;
 const assertions=sourceAssertions?{...sourceAssertions}:null;
 // CLI 2.2.12 suite JSON can serialize merged zero counters as null. Derive only when
 // complete passed steps and an explicit empty failure list independently confirm it.
 if(assertions&&Number.isInteger(assertions.total)&&assertions.total>0&&steps?.total>0&&steps.passed===steps.total&&steps.failed===0&&Array.isArray(report.failures)&&report.failures.length===0&&!report.error){
  if(assertions.failed==null)assertions.failed=0;
  if(assertions.passed==null&&assertions.failed===0)assertions.passed=assertions.total;
 }
 const reportId=raw?.reportId||report?.reportId;
 const base={reportId:id(String(reportId))?String(reportId):null,steps:steps?{total:steps.total,passed:steps.passed,failed:steps.failed}:null,assertions:assertions?{total:assertions.total,passed:assertions.passed,failed:assertions.failed}:null};
 // Native reports can contain credentials. Only allowlisted step names, counts and assertion outcomes leave this adapter.
 const names=new Map();
 const visit=(v,depth=0)=>{if(!v||typeof v!=='object'||depth>20)return;if(v.id&&v.name)names.set(String(v.id),String(v.name).slice(0,200));for(const key of ['children','steps','stepGroups'])if(Array.isArray(v[key]))v[key].forEach(x=>visit(x,depth+1));};
 (report?.stepTree||[]).forEach(x=>visit(x));
 const executions=Array.isArray(report?.executions)?report.executions:[];
 base.failedSteps=executions.filter(x=>x.passed===false||(x.assertions||[]).some(a=>a.passed===false)).map(x=>({id:String(x.id||x.item?.id||'').slice(0,100),name:String(x.name||x.item?.name||'失败步骤').slice(0,200),assertions:(x.assertions||[]).filter(a=>a.passed===false).map(a=>String(a.name||a.assertion||'断言失败').slice(0,200))})).slice(0,100);
 if(!base.failedSteps.length){
  const failures=new Map();for(const f of report?.failures||[]){
   const key=String(f.stepId||f.cursor?.ref||f.at||'unknown').slice(0,100);
   let step=failures.get(key);if(!step){step={id:key,name:names.get(key)||'请求或断言失败',assertions:[]};failures.set(key,step);}
   if(['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','ECONNRESET'].includes(f.error?.code))step.code=f.error.code;
   if(f.error?.test&&!step.assertions.includes(f.error.test))step.assertions.push(String(f.error.test).slice(0,200));
  }
  base.failedSteps=[...failures.values()].slice(0,100);
 }
 // Positive failure evidence is decisive even when a native report omits zero-valued counters.
 if(steps?.failed>0||assertions?.failed>0||report?.error||(report?.failures||[]).length||base.failedSteps.length)return {...base,status:'failed',reason:'存在失败步骤、断言或执行错误'};
 const counts=[steps?.total,steps?.passed,steps?.failed,assertions?.total,assertions?.passed,assertions?.failed];
 if(counts.some(n=>!Number.isInteger(n)||n<0)||!steps.total||!assertions.total)return {...base,status:'incomplete',reason:'报告缺少有效步骤或断言统计'};
 if(steps.passed+steps.failed>steps.total||assertions.passed+assertions.failed>assertions.total)return {...base,status:'incomplete',reason:'报告统计不一致'};
 if(steps.failed||assertions.failed||report.error||(report.failures||[]).length||base.failedSteps.length)return {...base,status:'failed',reason:'存在失败步骤、断言或执行错误'};
 if(steps.total!==steps.passed||assertions.total!==assertions.passed||steps.skipped||assertions.skipped||Object.values(s).some(v=>v?.failed>0)||!base.reportId)return {...base,status:'incomplete',reason:'存在未执行项或缺少原生报告 ID'};
 return {...base,status:'passed',reason:''};
}
module.exports={ApifoxExecutor,summarize,nativeReport,businessEvidenceComplete,TYPES,id,fail};
