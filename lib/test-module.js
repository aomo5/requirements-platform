'use strict';
const crypto=require('node:crypto');
const {readBody,canEdit}=require('./design-store');
const {fail}=require('./test-executor');
const SCHEMA=[
 `CREATE TABLE IF NOT EXISTS wb_test_links (entry_id CHAR(36) CHARACTER SET ascii PRIMARY KEY, revision INT NOT NULL, payload JSON NOT NULL, FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS wb_test_runs (id CHAR(36) CHARACTER SET ascii PRIMARY KEY, entry_id CHAR(36) CHARACTER SET ascii NOT NULL, created_at VARCHAR(32) NOT NULL, payload JSON NOT NULL, KEY entry_runs(entry_id,created_at), FOREIGN KEY(entry_id) REFERENCES wb_entries(id)) ENGINE=InnoDB`
];
class TestModule {
 constructor(db,executor,{instanceId=crypto.randomUUID(),version='unknown'}={}){this.db=db;this.executor=executor;this.instanceId=instanceId;this.version=version;this.active=false;}
 async init(){for(const sql of SCHEMA)await this.db.pool.query(sql);}
 async entry(p,c=this.db.pool){this.db.find(p);const [[r]]=await c.execute('SELECT id FROM wb_entries WHERE path_hash=?',[require('./stable-identities').sha(p)]);if(!r)fail('需求不存在',404);return r.id;}
 async links(p,c=this.db.pool){const eid=await this.entry(p,c);const [[r]]=await c.execute('SELECT revision,payload FROM wb_test_links WHERE entry_id=?',[eid]);return {revision:r?.revision||0,links:r?.payload||[]};}
 async list(p){const eid=await this.entry(p);const [rows]=await this.db.pool.execute('SELECT payload FROM wb_test_runs WHERE entry_id=? ORDER BY created_at DESC LIMIT 50',[eid]);return { ...await this.links(p),runs:await Promise.all(rows.map(async r=>{const run=r.payload;if(['queued','running'].includes(run.status)&&Date.now()-Date.parse(run.createdAt)>300000){run.status='interrupted';run.reason='执行超过时限或服务中断，结果未确认';run.finishedAt=new Date().toISOString();await this.save(run);}return run;})),environments:await this.executor.environments()};}
 async link(p,body){
  if(!Number.isInteger(body.expectedRevision)||!Array.isArray(body.ruleIds)||body.ruleIds.length>40)fail('缺少有效版本或验收规则');
  const doc=await this.db.document(p);const rules=new Set((doc?.rules||[]).map(r=>r.blockId));
  if(body.ruleIds.some(id=>!rules.has(id)))fail('验收规则已变化，请重新选择');
  const resource=await this.executor.resource(body);
  return this.db.transaction(async c=>{const latest=await this.db.document(p,c);if(body.ruleIds.some(id=>!(latest?.rules||[]).some(r=>r.blockId===id)))fail('验收规则已变化，请重新选择',409);const old=await this.links(p,c);if(old.revision!==body.expectedRevision)fail('关联已变化，请刷新后重试',409);
   if(old.links.length>=100)fail('每个需求最多关联 100 项');
   if(old.links.some(x=>x.type===resource.type&&x.resourceId===resource.resourceId&&x.projectId===resource.projectId&&x.branchId===resource.branchId))fail('资源已关联',409);
   const result={revision:old.revision+1,links:[...old.links,{...resource,id:crypto.randomUUID(),ruleIds:body.ruleIds}]};
   await c.execute('INSERT INTO wb_test_links VALUES (?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),payload=VALUES(payload)',[await this.entry(p,c),result.revision,JSON.stringify(result.links)]);return result;
  });
 }
 async unlink(p,body){return this.db.transaction(async c=>{const old=await this.links(p,c);if(old.revision!==body.expectedRevision)fail('关联已变化，请刷新后重试',409);const links=old.links.filter(x=>x.id!==body.linkId);if(links.length===old.links.length)fail('关联不存在',404);await c.execute('UPDATE wb_test_links SET revision=?,payload=? WHERE entry_id=?',[old.revision+1,JSON.stringify(links),await this.entry(p,c)]);return {revision:old.revision+1,links};});}
 async save(run){await this.db.pool.execute('UPDATE wb_test_runs SET payload=? WHERE id=?',[JSON.stringify(run),run.id]);}
 async start(p,body,user){
  if(this.stopping)fail('服务正在停止，请稍后再试',503);
  if(this.active)fail('执行器正在运行，请稍后再试',409);
  this.active=true;
  let run;
  try{
   this.lock=await this.db.pool.getConnection();
   const [[lease]]=await this.lock.query("SELECT GET_LOCK('requirements_workbench_apifox_executor',0) AS acquired");
   if(!lease.acquired){this.lock.release();this.lock=null;fail('执行器正在运行，请稍后再试',409);}
   const link=(await this.links(p)).links.find(x=>x.id===body.linkId);if(!link)fail('请先关联已核实的 Apifox 资源',404);
   const env=(await this.executor.environments()).find(e=>e.id===body.environmentId);if(!env)fail('请选择已配置的受控环境');
   const doc=await this.db.document(p);
   run={id:crypto.randomUUID(),path:p,status:'queued',createdAt:new Date().toISOString(),actor:user?{id:user.id,name:user.displayName}:{name:'本机用户'},requirementRevision:doc?.revision||0,ruleIds:link.ruleIds,resource:link,environment:env,instanceId:this.instanceId,workbenchVersion:this.version};
   if(body.routeAudit)run.routeAudit=body.routeAudit;
   await this.db.pool.execute('INSERT INTO wb_test_runs VALUES (?,?,?,?)',[run.id,await this.entry(p),run.createdAt,JSON.stringify(run)]);
   this.task=new Promise(resolve=>setImmediate(()=>this.execute(run).catch(()=>{/* The durable record remains visible. */}).finally(resolve)));return run;
  }catch(e){await this.releaseLock();this.active=false;throw e;}
 }
 async shutdown(){this.stopping=true;this.executor.stop?.();await this.task;}
 async releaseLock(){if(this.lock){try{await this.lock.query("SELECT RELEASE_LOCK('requirements_workbench_apifox_executor')");}finally{this.lock.release();this.lock=null;}}}
 async execute(run){
  try{
   const snapshot=await this.executor.prepare(run.resource,run.environment.id);
   if(run.routeAudit)snapshot.routeAudit=run.routeAudit;
   Object.assign(run,snapshot,{status:'running',startedAt:new Date().toISOString()});await this.save(run);
   Object.assign(run,await this.executor.run(snapshot,run.id));
   if(snapshot.environment.scope==='preflight'){run.businessExecuted=false;run.reason='业务驱动及专用资源尚未就绪；本次仅核验执行器和驱动前置。'+(run.reason||'');if(run.status==='passed')run.status='blocked';}
  }catch(e){run.status=this.stopping?'interrupted':run.startedAt?'incomplete':'blocked';run.reason=e.status?e.message:'执行未完成，请核查服务端认证、进程或报告格式';}
  finally{run.finishedAt=new Date().toISOString();try{await this.save(run);}finally{try{await this.releaseLock();}finally{this.active=false;}}}
 }
}
function createTestHandler(module,sendJson,accessMode='local'){return async(req,res,url)=>{try{
 if(!module)fail('测试模块需要 MySQL 存储',503);
 const p=url.searchParams.get('path');module.db.find(p);
 if(req.method==='GET'&&url.pathname==='/api/tests'){const result=await module.list(p);sendJson(res,200,{...result,canEdit:canEdit(req,accessMode)});return;}
 if(req.method==='POST'){
  const body=await readBody(req,accessMode);
  // Never forward arbitrary client command, environment values or resource metadata to the runner.
  if(url.pathname==='/api/tests/links'){sendJson(res,201,await module.link(p,body));return;}
  if(url.pathname==='/api/tests/unlink'){sendJson(res,200,await module.unlink(p,body));return;}
  if(url.pathname==='/api/tests/runs'){sendJson(res,202,{run:await module.start(p,{linkId:body.linkId,environmentId:body.environmentId},req.accountAccess?.user)});return;}
 }
 sendJson(res,405,{error:'不支持的测试操作'});
 }catch(e){sendJson(res,e.status||500,{error:e.status?e.message:'测试操作失败，请保留输入并重试'});}};}
module.exports={TestModule,createTestHandler,SCHEMA};
