'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {readBody,canEdit}=require('./design-store');
const {buildRoutes,selectRoutes,inspectionQueue,witnessKey}=require('./flow-routes');
const {digest,tuple,refKey,flowKey}=require('./flow-route-graph');
const {readRules,evaluateEvidence}=require('./flow-route-rules');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const choices=new Set(['ok','issue','unsure','pending']);
const listLimit=40;
const getActor=req=>req.accountAccess?.user?.id || 'local';
const reviewTable='wb_flow_route_reviews';
async function createReviewStore(db,root) {
  const folder=path.join(root,'portal','.runtime','route-reviews');
  if(db) await db.pool.query(`CREATE TABLE IF NOT EXISTS ${reviewTable} (
    entry_key CHAR(32) CHARACTER SET ascii NOT NULL, actor_key CHAR(32) CHARACTER SET ascii NOT NULL,
    record_key CHAR(32) CHARACTER SET ascii NOT NULL, revision INT NOT NULL, payload JSON NOT NULL,
    PRIMARY KEY(entry_key,actor_key,record_key)) ENGINE=InnoDB`);
  function file(p,actor){return path.join(folder,digest([p,actor])+'.json');}
  function fileRows(p,actor){const filename=file(p,actor);return fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):[];}
  return {
    async read(p,actor) {
      if(!db) return fileRows(p,actor);
      const [rows]=await db.pool.execute(`SELECT payload FROM ${reviewTable} WHERE entry_key=? AND actor_key=?`,[digest(p),digest(actor)]);
      return rows.map(r=>r.payload);
    },
    async save(p,actor,record,previous) {
      const recordKey=digest([record.id,record.signature,record.caseId]);
      record.revision=previous+1;record.updatedAt=new Date().toISOString();
      if(db) {
        const keys=[digest(p),digest(actor),recordKey],payload=JSON.stringify(record);
        if(previous===0) {
          try {await db.pool.execute(`INSERT INTO ${reviewTable} VALUES(?,?,?,1,?)`,[...keys,payload]);}
          catch(e){if(e.code==='ER_DUP_ENTRY')fail('核验结论已在其他窗口更新，请重新载入。',409);throw e;}
        } else {
          const [r]=await db.pool.execute(`UPDATE ${reviewTable} SET revision=?,payload=? WHERE entry_key=? AND actor_key=? AND record_key=? AND revision=?`,[record.revision,payload,...keys,previous]);
          if(!r.affectedRows) fail('核验结论已在其他窗口更新，请重新载入。',409);
        }
      } else {
        fs.mkdirSync(folder,{recursive:true,mode:0o700});
        const target=file(p,actor),lock=target+'.lock';
        try{fs.closeSync(fs.openSync(lock,'wx',0o600));}catch(e){if(e.code==='EEXIST')fail('核验记录正在写入，请稍后重试。',409);throw e;}
        try {
          const rows=fileRows(p,actor),index=rows.findIndex(r=>r.id===record.id && r.signature===record.signature && r.caseId===record.caseId);
          if((rows[index]?.revision || 0)!==previous) fail('核验记录已变化，请重新载入。',409);
          if(index<0)rows.push(record);else rows[index]=record;
          const tmp=target+'.'+crypto.randomUUID();fs.writeFileSync(tmp,JSON.stringify(rows),{mode:0o600});fs.renameSync(tmp,target);
        } finally {fs.unlinkSync(lock);}
      }
      return record;
    }
  };
}
function indexReviews(records) {
  const byId=new Map();
  for(const record of records.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))) {
    if(!byId.has(record.id)) byId.set(record.id,[]);
    byId.get(record.id).push(record);
  }
  return byId;
}
function reviewFor(row,byId,caseId='') {
  const records=(byId.get(row.id)||[]).filter(r=>r.caseId===caseId);
  return records.find(r=>r.signature===row.signature) || (records.length?{...records[0],status:'stale',priorStatus:records[0].status,revision:0}:{status:'pending',revision:0});
}
function summaryRecord(record) {
  if(!record)return record;
  const {witness,...summary}=record;
  return summary;
}
function compareVersions(previous,current) {
  function elements(workspace) {
    const items=new Map();
    for(const flow of workspace.flows) {
      for(const node of flow.nodes) {
        const {x,y,width,height,...value}=node;
        items.set(tuple(flow.id,'node',node.id),{ref:{flowId:flow.id,nodeId:node.id},label:node.label,flow:flow.name,kind:'节点',value});
      }
      for(const edge of flow.edges) {
        const value={source:edge.source,target:edge.target,label:edge.label,trace:edge.trace || ''};
        items.set(tuple(flow.id,'edge',edge.id),{ref:{flowId:flow.id,nodeId:edge.source,edgeId:edge.id},label:edge.label || edge.id,flow:flow.name,kind:'连线',value});
      }
      items.set(tuple(flow.id),{ref:{flowId:flow.id},label:flow.name,flow:flow.name,kind:'流程',value:{name:flow.name,parent:flow.parent,kind:flow.kind}});
    }
    return items;
  }
  const before=elements(previous),after=elements(current),changes=[];
  for(const k of new Set([...before.keys(),...after.keys()])) {
    const a=before.get(k),b=after.get(k);
    if(a && b && require('node:util').isDeepStrictEqual(a.value,b.value))continue;
    const {value,...item}=b || a;
    changes.push({...item,change:!a?'新增':!b?'移除':'修改',before:a?.label,after:b?.label});
  }
  return {from:previous.revision,to:current.revision,changes};
}
function normalize(q) {
  const opts={};
  for(const k of ['through','node','entry','query','rule','status']) if(typeof q[k]==='string' && q[k]) opts[k]=q[k].slice(0,550);
  opts.mode=q.mode==='current'?'current':'all';opts.view=q.view==='all'?'all':'queue';
  if(opts.view==='queue' && ['pending','ok','issue','unsure','stale'].includes(q.review))opts.review=q.review;
  if(opts.view==='queue' && ['pending','passed','failed','partial','incomplete'].includes(q.test))opts.test=q.test;
  return opts;
}
function rankOf(value='0'){const s=String(value);if(!/^\d{1,400}$/.test(s)) fail('路线序号无效');return BigInt(s);}
async function readWorkspaceSet(store,p) {
  const {workspace}=await store.read(p), sets=new Map([[p,workspace]]), flowList=[],requested=new Set();
  const missing=[];
  const pending=workspace.flows.map(f=>({entryPath:p,flowId:f.id})).concat(workspace.references || []);
  while(pending.length) {
    const r=pending.shift(),key=flowKey(r.entryPath,r.flowId);
    if(requested.has(key))continue;requested.add(key);
    if(!sets.has(r.entryPath)) {
      try{sets.set(r.entryPath,(await store.read(r.entryPath)).workspace);}catch{sets.set(r.entryPath,null);}
    }
    const flow=sets.get(r.entryPath)?.flows.find(f=>f.id===r.flowId);
    if(!flow){missing.push({kind:'structure',message:'关联流程不可读取 · '+r.flowId,ref:r});continue;}
    flowList.push({...flow,entryPath:r.entryPath});
    for(const n of flow.nodes) for(const d of [n.call,n.target,n.recovery]) if(d && !requested.has(flowKey(d.entryPath,d.flowId))) pending.push(d);
  }
  return {workspace,flowList,missing,version:[...sets].map(([k,v])=>[k,v?.revision || 0]),externalFlows:(workspace.references || []).map(r=>flowKey(r.entryPath,r.flowId))};
}
async function createRouteService({db,store,root,tests,accessMode,sendJson}) {
  const reviews=await createReviewStore(db,root);
  const models=new Map();
  async function inspect(p,opts) {
    const snapshot=await readWorkspaceSet(store,p);
    const rules=readRules(root,p);rules.externalFlows=snapshot.externalFlows;
    const key=digest([p,snapshot.version,rules,opts.mode]);
    let named=models.get(key);
    if(!named) {
      const model=buildRoutes(snapshot.flowList,p,{mode:opts.mode,rules});
      const missingCases=rules.cases.filter(c=>{
        const ctx=model.graph.nodes.get(tuple(p,c.flowId,c.nodeId));
        return !ctx || (c.edgeId && !ctx.edges.some(e=>e.id===c.edgeId));
      }).map(c=>({ref:{entryPath:p,flowId:c.flowId,nodeId:c.nodeId},kind:'source',message:'缺路线 · '+c.when}));
      const issues=[...snapshot.missing,...rules.issues,...model.graph.issues,...missingCases];
      const uniqueIssues=[...new Map(issues.map(i=>[tuple(i.ref,i.message),i])).values()];
      const meta={path:p,revision:snapshot.workspace.revision,baseline:rules.baseline,
        flows:snapshot.flowList.map(f=>({id:f.id,name:f.name,entryPath:f.entryPath})),
        roots:model.roots.map(r=>({key:refKey(r.ref),name:r.label,flow:r.flow})),
        cases:rules.cases,methods:rules.methods.map(m=>({id:m.id,method:m.method,file:m.file,changed:!!m.changed,unavailable:!!m.unavailable})),
        issues:uniqueIssues,uncovered:model.graph.uncovered.map(ref=>({ref,label:model.graph.nodes.get(refKey(ref)).node.label})),
        unusedEdges:model.graph.unusedEdges,limited:model.limited.size};
      named={model,meta,selections:new Map()};models.set(key,named);
      if(models.size>3)models.delete(models.keys().next().value);
    }
    const {review,test,...graphOptions}=opts;
    const filterKey=JSON.stringify(graphOptions);
    let sel=named.selections.get(filterKey);
    if(!sel) {
      const base=selectRoutes(named.model,opts);
      const list=opts.view==='queue'?inspectionQueue(named.model,base):base;
      sel={list,combinationCount:base.count.toString()};named.selections.set(filterKey,sel);
      if(named.selections.size>5)named.selections.delete(named.selections.keys().next().value);
    }
    return {...sel,meta:named.meta};
  }
  async function recentRuns(p) {
    if(!tests || !db)return [];
    const entry=await tests.entry(p);
    const [rows]=await db.pool.execute("SELECT payload FROM wb_test_runs WHERE entry_id=? AND (JSON_EXTRACT(payload,'$.routeAudit.id') IS NOT NULL OR JSON_EXTRACT(payload,'$.businessEvidence[*].routeId') IS NOT NULL) ORDER BY created_at DESC",[entry]);
    return rows.map(r=>r.payload);
  }
  function personalList(result,opts,byId,runs,bindings) {
    if(opts.view!=='queue')return result;
    const {list,meta}=result,matches=[],observed=new Set();
    for(const r of runs){observed.add(r.routeAudit?.id);for(const e of r.businessEvidence || [])observed.add(e.routeId);}
    let reviewed=0;
    for(let i=0n;i<list.count;i++) {
      const row=list.at(i),status=reviewFor(row,byId).status;
      if(['ok','issue','unsure'].includes(status))reviewed++;
      if(opts.review && opts.review!==status)continue;
      if(opts.test){
        const test=observed.has(row.id)?decorate(list.at(i,true),byId,runs,meta,bindings).test:'pending';
        if(test!==opts.test)continue;
      }
      matches.push(i);
    }
    const projection=opts.review || opts.test?{count:BigInt(matches.length),at:(rank,detail)=>matches[Number(rank)]===undefined?null:list.at(matches[Number(rank)],detail)}:list;
    return {...result,list:projection,progress:{total:String(list.count),reviewed}};
  }
  function decorate(row,byId,runs,meta,bindings) {
    row={...row,cases:row.cases.map(c=>({...c,driver:bindings.find(b=>b.id===c.id)?.driver || c.driver}))};
    const candidates=runs.filter(r=>r.routeAudit?.id===row.id || r.businessEvidence?.some(e=>e.routeId===row.id));
    const evidence=evaluateEvidence(row,candidates,meta.baseline,meta.path);
    const caseStates=(row.cases || []).map(c=>({id:c.id,review:summaryRecord(reviewFor(row,byId,c.id)),test:evidence.find(e=>e.scenario===c.id)?.status || 'pending'}));
    const statuses=new Set(caseStates.map(c=>c.test));
    const test=statuses.has('failed')?'failed':statuses.size===1?[...statuses][0]:statuses.has('passed')?'partial':statuses.has('incomplete')?'incomplete':'pending';
    return {...row,review:summaryRecord(reviewFor(row,byId)),caseStates,test,evidence,
      runs:candidates.filter(r=>r.routeAudit?.signature===row.signature).map(r=>({id:r.id,status:r.status,reason:r.reason,scenario:r.routeAudit?.caseId,environment:r.environment?.name,createdAt:r.createdAt}))};
  }
  async function availableDrivers(p) {
    if(!tests)return [];
    const [{links},envs]=await Promise.all([tests.links(p),tests.executor.environments()]);
    return links.flatMap(l=>envs.filter(e=>e.business && e.resourceKeys?.includes([l.projectId,l.branchId,l.type,l.resourceId].join(':')))
      .map(e=>({linkId:l.id,environmentId:e.id,name:l.name+' · '+e.name,ready:e.ready,reason:e.reason})));
  }
  async function previousSnapshot(p,revision) {
    if(db){
      const [rows]=await db.pool.execute("SELECT v.payload FROM wb_versions v JOIN wb_entries e ON e.id=v.entry_id WHERE e.path_hash=? AND v.kind='flow' AND v.revision<? ORDER BY v.revision DESC LIMIT 1",[require('./stable-identities').sha(p),revision]);
      return rows[0]?.payload;
    }
    const dir=path.join(root,p,'流程设计','.flow-history');
    if(!fs.existsSync(dir) || !fs.realpathSync(dir).startsWith(fs.realpathSync(root)+path.sep))return null;
    const prior=fs.readdirSync(dir).filter(n=>/^\d+\.json$/.test(n)).map(n=>Number.parseInt(n,10)).filter(n=>n<revision).sort((a,b)=>b-a)[0];
    const file=path.join(dir,prior+'.json');return prior && !fs.lstatSync(file).isSymbolicLink()?JSON.parse(fs.readFileSync(file,'utf8')):null;
  }
  function checkedRow(result,body) {
    const item=result.list.at(rankOf(body.rank),true);
    if(!item || item.id!==body.id || item.signature!==body.signature || result.meta.revision!==body.revision) fail('路线或条件已变化，请重新载入后核验。',409);
    if(body.caseId && !item.caseIds.includes(body.caseId))fail('场景不属于这条路线');
    return item;
  }
  return async(req,res,url)=>{
    try {
      const p=url.searchParams.get('path'),actor=getActor(req);
      if(!p)fail('请选择需求');
      if(req.method==='GET') {
        const q=Object.fromEntries(url.searchParams),opts=normalize(q);
        if(url.pathname.endsWith('/changes')) {
          const {workspace}=await store.read(p),prior=await previousSnapshot(p,workspace.revision);
          return sendJson(res,200,prior?compareVersions(prior,workspace):{from:null,to:workspace.revision,changes:[]});
        }
        if(url.pathname.endsWith('/drivers')) {
          await store.read(p);
          const [items,bindings]=await Promise.all([availableDrivers(p),reviews.read(p,'config:route-drivers')]);
          return sendJson(res,200,{items,bindings:bindings.map(b=>({id:b.id,revision:b.revision,driver:b.driver}))});
        }
        const [result,records,bindings]=await Promise.all([inspect(p,opts),reviews.read(p,actor),reviews.read(p,'config:route-drivers')]);
        const byId=indexReviews(records),{meta,combinationCount}=result,offset=rankOf(q.offset);
        if(q.record) {
          const record=(byId.get(q.record)||[]).find(r=>r.signature===q.signature && r.caseId===(q.caseId || ''));
          if(!record)fail('未找到这项个人核验记录',404);
          const settings=normalize(record.options);delete settings.review;delete settings.test;
          const original=await inspect(p,settings);
          let rank=rankOf(record.rank);
          if(original.list.at(rank)?.id!==record.id)rank=original.list.locate(record);
          if(rank===undefined && settings.view==='queue'){
            settings.view='all';rank=(await inspect(p,settings)).list.locate(record);
          }
          return sendJson(res,200,{rank:rank?.toString() ?? null,options:settings,record:summaryRecord(record)});
        }
        const runs=await recentRuns(p),{list,progress}=personalList(result,opts,byId,runs,bindings),count=list.count;
        if(q.detail==='1') {
          const row=list.at(offset,true);if(!row)fail('此路线已变化或不存在',404);
          return sendJson(res,200,{row:decorate(row,byId,runs,meta,bindings),revision:meta.revision});
        }
        const take=Math.max(1,Math.min(listLimit,Number.parseInt(q.limit,10)||12)),rows=[];
        let focus;
        for(let i=offset;i<count && rows.length<take;i++) {
          const item=decorate(list.at(i,true),byId,runs,meta,bindings);
          if(q.focus===String(i))focus=item;
          const {steps,outcomes,cases,caseStates,evidence,runs:linked,...summary}=item;rows.push({...summary,rank:String(i)});
        }
        const history=records.filter(r=>r.status!=='pending').map(summaryRecord);
        return sendJson(res,200,{...(q.meta==='0'?{}:{meta}),revision:meta.revision,rows,focus,progress,offset:String(offset),count:String(count),combinationCount,history,
          canEdit:canEdit(req,accessMode)});
      }
      if(req.method!=='POST')fail('不支持的方法',405);
      const body=await readBody(req,accessMode);
      const opts=normalize(body.options || {}),result=await inspect(p,opts);
      let display=result;
      if(opts.review || opts.test){
        const [records,runs,bindings]=await Promise.all([reviews.read(p,actor),recentRuns(p),reviews.read(p,'config:route-drivers')]);
        display=personalList(result,opts,indexReviews(records),runs,bindings);
      }
      const row=checkedRow(display,body);
      if(url.pathname==='/api/flow-routes/review') {
        if(!choices.has(body.status) || typeof body.note!=='string' || body.note.length>2000 || !Number.isInteger(body.expected) || body.expected<0)fail('核验结论或备注格式无效');
        const saved=await reviews.save(p,actor,{id:row.id,signature:row.signature,caseId:body.caseId || '',title:row.title,entry:row.entry,
          rank:String(body.rank),options:opts,status:body.status,note:body.note,flowRevision:result.meta.revision,root:row.root,
          witness:row.steps.map(witnessKey),via:row.via,caseName:row.cases.find(c=>c.id===body.caseId)?.when || ''},body.expected);
        return sendJson(res,200,{record:summaryRecord(saved)});
      }
      if(url.pathname.endsWith('/binding')) {
        if(!body.caseId || !Number.isInteger(body.expected) || body.expected<0)fail('请选择当前场景和绑定版本');
        const driver=(await availableDrivers(p)).find(d=>d.linkId===body.linkId && d.environmentId===body.environmentId);
        if(!driver)fail('请选择已关联到本需求且获准使用测试库的资源',409);
        const {linkId,environmentId,name}=driver;
        const saved=await reviews.save(p,'config:route-drivers',{id:body.caseId,signature:'driver-v1',caseId:'',driver:{linkId,environmentId,name}},body.expected);
        return sendJson(res,200,{driver:saved.driver,revision:saved.revision});
      }
      if(url.pathname==='/api/flow-routes/run') {
        if(!tests || !body.caseId)fail('请选择有测试驱动的具体场景');
        const c=row.cases.find(c=>c.id===body.caseId);
        const binding=(await reviews.read(p,'config:route-drivers')).find(b=>b.id===c.id)?.driver || c.driver;
        if(!binding || !c.assertions.length)fail('该场景尚未绑定可执行的测试驱动',409);
        const approved=(await availableDrivers(p)).find(d=>d.linkId===binding.linkId && d.environmentId===binding.environmentId);
        if(!approved?.ready)fail(approved?.reason || '此场景尚无就绪的受控业务环境',409);
        const audit={id:row.id,signature:row.signature,caseId:c.id};
        const run=await tests.start(p,{linkId:binding.linkId,environmentId:binding.environmentId,routeAudit:audit},req.accountAccess?.user);
        return sendJson(res,202,{id:run.id,status:run.status});
      }
      fail('路线操作不存在',404);
    } catch(e){sendJson(res,e.status || 500,{error:e.status?e.message:'路线核验读取或保存失败，请重新载入。'});}
  };
}
module.exports={createRouteService,createReviewStore,reviewFor,compareVersions};
