"use strict";
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {GiteeApi,fail}=require('./gitee-api');
const {atomicWrite}=require('./stable-identities');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const now=()=>new Date().toISOString();
const START='<!-- wb-gitee-archive:start -->', END='<!-- wb-gitee-archive:end -->';
function projectBody(text){return text.replace(/<!-- wb-gitee-archive:start -->[\s\S]*?<!-- wb-gitee-archive:end -->/g,'').replace(/ ?<!-- wb-rule:[^>]+ -->/g,'').replace(/<!-- wb-sync:[^>]+ -->/g,'').trim();}
const remoteBody=r=>({title:r.title,body:projectBody(r.description)});
const remoteHash=r=>hash({content:remoteBody(r),version:r.updated_at,comments:r.comments,state:r.state});
const labels={unlinked:'未关联',pending:'待同步',syncing:'同步中',synced:'已同步',failed:'失败',conflict:'冲突'};
class GiteeSync {
  constructor({root,store,getTree,secretFile,documents=null,apiFactory=(c,t)=>new GiteeApi(c,t)}){Object.assign(this,{root,store,getTree,secretFile,documents,apiFactory});}
  async config(){return await this.store.get('config')||{apiBase:'https://api.gitee.com/enterprises',enterpriseId:'',enterprisePath:'',programId:'',programName:'',issueTypeId:'',revision:0};}
  token(){try{return fs.readFileSync(this.secretFile,'utf8').trim();}catch(e){if(e.code==='ENOENT')return '';throw e;}}
  async publicConfig(){return {...await this.config(),credentialConfigured:!!this.token()};}
  async saveConfig(input){return this.store.lock(async()=>{
    const old=await this.config();if(input.revision!==old.revision)fail('配置已变化，请重新打开设置',409);
    let u;try{u=new URL(input.apiBase);}catch{fail('平台地址无效');}
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!u.pathname.replace(/\/$/,'').endsWith('/enterprises'))fail('请填写 HTTPS 企业 API 地址（以 /enterprises 结尾）');
    // A server administrator explicitly provisions additional private deployments.
    const allowed=(process.env.GITEE_ALLOWED_HOSTS||'api.gitee.com').split(',');
    if(!allowed.includes(u.hostname))fail('该平台域名未在服务端 GITEE_ALLOWED_HOSTS 中配置');
    for(const key of ['enterpriseId','programId'])if(!/^\d+$/.test(String(input[key]||'')))fail('企业编号与项目编号必须为数字');
    if(input.issueTypeId&&!/^\d+$/.test(String(input.issueTypeId)))fail('需求类型编号必须为数字');
    if(!/^[a-zA-Z0-9_-]+$/.test(input.enterprisePath||''))fail('企业空间名称无效');
    const c={apiBase:u.href.replace(/\/$/,''),enterpriseId:String(input.enterpriseId),enterprisePath:input.enterprisePath,programId:String(input.programId),programName:String(input.programName||'').slice(0,100),issueTypeId:String(input.issueTypeId||''),revision:old.revision+1};
    const changed=['apiBase','enterpriseId','programId'].some(k=>old[k]!==c[k]);
    if(changed&&old.revision){const rows=await this.list();if(rows.some(r=>r.lastSuccessAt||r.createIntent))fail('已有同步基线，不可切换企业或项目；请使用独立工作台配置',409);}
    if(changed&&old.revision&&!input.token)fail('更换平台或企业时请重新提供对应凭据');
    if(input.token){if(typeof input.token!=='string'||/[\r\n]/.test(input.token)||input.token.length>8192)fail('凭据格式无效');fs.mkdirSync(path.dirname(this.secretFile),{recursive:true,mode:0o700});const tmp=this.secretFile+'.tmp';fs.writeFileSync(tmp,input.token,{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,this.secretFile);}
    await this.store.put('config',c);return this.publicConfig();
  });}
  async api(){return this.apiFactory(await this.config(),this.token());}
  async discover(input={}){
    const c=await this.config();
    if(input.apiBase && input.apiBase.replace(/\/$/,'')!==c.apiBase)fail('查询企业编号前请使用当前配置的平台地址');
    const token=input.token||this.token();
    if(typeof token!=='string'||/[\r\n]/.test(token)||token.length>8192)fail('凭据格式无效');
    return this.apiFactory(c,token).discover();
  }
  async test(){return this.store.lock(async()=>{const result=await(await this.api()).test();await this.store.put('connection',{...result,at:now()});return result;});}
  entries(){const entries=new Map(this.getTree().modules.flatMap(m=>m.features).map(e=>[e.path,e]));for(const e of this.documents?.documentEntries?.values()||[])entries.set(e.path,{...entries.get(e.path),...e});return [...entries.values()];}
  entry(p,known){const e=known||this.entries().find(e=>e.path===p);if(!e)fail('需求目录不存在',404);if(this.documents?.documentEntries?.has(p)){this.documents.find(p);return e;}for(let cur=this.root,parts=p.split('/'),i=0;i<parts.length;i++){cur=path.join(cur,parts[i]);if(fs.lstatSync(cur).isSymbolicLink())fail('不支持符号链接目录',403);}return e;}
  async local(p,known){const e=this.entry(p,known),file=path.join(this.root,p,'需求文档.md');
    if(this.documents){const d=await this.documents.document(p),[[state]]=await this.documents.pool.query('SELECT migrated FROM wb_document_control WHERE id=1');if(d||state.migrated){const raw=d?.content||'';return {title:e.feature,body:projectBody(raw),raw,file,revision:d?.revision||0,canonical:true};}}
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())fail('不支持符号链接文档',403);const raw=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';if(Buffer.byteLength(raw)>2*1024*1024)fail('需求正文超过 2 MB');return {title:e.feature,body:projectBody(raw),raw,file};}

  key(p){return 'entry:'+hash(p);}
  async row(p,known){return await this.store.get(this.key(p))||{path:p,ident:(known||this.entry(p)).gitee?.ident||null,state:'pending'};}
  localHash(l){return hash({title:l.title,body:l.body});}
  async list(){const out=[];for(const e of this.entries()){const r=await this.row(e.path,e),l=await this.local(e.path,e);let state=r.state;if(!r.ident&&!r.createIntent&&!['failed','syncing','conflict'].includes(state))state='unlinked';else if(state==='synced'&&r.base?.local!==this.localHash(l))state='pending';out.push({path:e.path,title:e.feature,ident:r.ident,state,label:labels[state],error:r.error||'',lastSuccessAt:r.lastSuccessAt||null,createIntent:!!r.createIntent,remoteVersion:r.base?.remoteVersion||null});}return out;}
  async put(r){await this.store.put(this.key(r.path),r);return r;}
  async snapshot(p,api,r){
    if(r.ident){for(const e of this.entries()){if(e.path!==p&&(await this.row(e.path,e)).ident===r.ident)fail('同一远端编号被多个目录引用，请先在规格索引中明确唯一主需求',409);}}
    const local=await this.local(p),remote=r.ident?await api.get(r.ident):null;
    if(remote)await this.cacheStatus(p,remote);
    const lh=this.localHash(local),rh=remote?remoteHash(remote):null;
    let action='create';
    if(remote){if(!r.base)action=lh===hash(remoteBody(remote))?'none':'conflict';else {const lc=lh!==r.base.local,rc=rh!==r.base.remote;action=lc&&rc?'conflict':lc?'push':rc?'pull':'none';}}
    return {local,remote,lh,rh,action,review:hash({lh,rh,ident:r.ident,config:await this.config()})};
  }
  async preview(p){return this.store.lock(async()=>{
    const r=await this.row(p);try{const s=await this.snapshot(p,await this.api(),r);r.state=s.action==='conflict'?'conflict':s.action==='none'&&r.base?'synced':r.ident?'pending':'unlinked';r.error='';await this.put(r);return {path:p,ident:r.ident,state:r.state,action:s.action,review:s.review,local:{title:s.local.title,body:s.local.body},remote:s.remote?{...remoteBody(s.remote),version:s.remote.updated_at,comments:s.remote.comments}:null,baseline:r.base||null,createIntent:!!r.createIntent};}catch(e){r.state='failed';r.error=this.error(e);await this.put(r);throw e;}
  });}
  error(e){return e.status?e.message:'同步存储失败，请检查服务端配置后重试';}
  async link(p,ident){return this.store.lock(async()=>{
    const r=await this.row(p);if(r.ident&&r.ident!==ident)fail('已关联其他工作项，不能直接换绑',409);
    const remote=await(await this.api()).get(ident);
    for(const e of this.entries()){if(e.path!==p&&(await this.row(e.path,e)).ident===ident)fail('该远端需求已关联其他目录',409);}
    r.ident=ident;r.state='pending';r.error='';delete r.createIntent;await this.put(r);await this.cacheStatus(p,remote);await this.recordIndex(p,remote);return r;
  });}
  async cacheStatus(p,r){if(this.documents?.cacheGiteeStatus){await this.documents.cacheGiteeStatus(p,r,await this.config());return;}const file=path.join(this.root,'portal/data/gitee-status.json');let d={};if(fs.existsSync(file))d=JSON.parse(fs.readFileSync(file,'utf8'));const c=await this.config();d.program={id:Number(c.programId),name:c.programName,enterprisePath:c.enterprisePath,url:`https://e.gitee.com/${c.enterprisePath}/projects/${c.programId}/requirements/table`};d.paths={...d.paths,[p]:r.ident};d.issues={...d.issues,[r.ident]:{...d.issues?.[r.ident],ident:r.ident,title:r.title,state:r.state,label:({open:'待处理',progressing:'进行中',closed:'已完成',rejected:'已拒绝'})[r.state]||r.state,url:this.url(c,r.ident),updatedAt:r.updated_at}};d.syncedAt=now();fs.mkdirSync(path.dirname(file),{recursive:true});atomicWrite(file,JSON.stringify(d,null,2)+'\n');}
  url(c,ident){return `https://gitee.com/enterprises/${c.enterprisePath}/issues/${ident}`;}
  async recordIndex(p,remote){
    const relative=p+'/规格索引.md',file=path.join(this.root,relative);
    const canonical=this.documents?.supportingMigrated,stored=canonical?await this.documents.readDocumentFile(p,relative):null;
    if(!canonical&&fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())fail('规格索引不可为符号链接',403);
    let raw=canonical?(stored?.content||'# 规格索引\n'):(fs.existsSync(file)?fs.readFileSync(file,'utf8'):'# 规格索引\n');
    const block=`<!-- wb-gitee-index:start -->\n- 主 Gitee 需求编号：${remote.ident}\n- 来源：[${remote.ident}](${this.url(await this.config(),remote.ident)})\n- 同步归档：[需求文档](./需求文档.md) · [线上原文](./线上原文/)\n- 最近归档：${now()}\n<!-- wb-gitee-index:end -->`;
    raw=/<!-- wb-gitee-index:start -->[\s\S]*?<!-- wb-gitee-index:end -->/.test(raw)?raw.replace(/<!-- wb-gitee-index:start -->[\s\S]*?<!-- wb-gitee-index:end -->/,block):raw+'\n'+block+'\n';
    if(canonical)await this.documents.saveDocumentFile(p,relative,stored?.revision||0,raw);else atomicWrite(file,raw);
  }
  async archive(p,remote,expectedRaw){
    const local=await this.local(p);if(local.raw!==expectedRaw)fail('本地正文在同步期间变化，请重新查看差异',409);
    const dir=path.join(this.root,p,'线上原文');if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())fail('归档目录不可为符号链接',403);fs.mkdirSync(dir,{recursive:true});
    const name=remote.ident+'-'+remoteHash(remote)+'.json';const dest=path.join(dir,name);
    if(!fs.existsSync(dest))fs.writeFileSync(dest,JSON.stringify(remote,null,2)+'\n',{flag:'wx'});
    // Escape delimiter-looking remote content; it is source material, never local control markup.
    const literal=s=>String(s||'').replace(/<!--\s*wb-/g,'&lt;!-- wb-');
    const comments=remote.comments.map(c=>`### 评论 ${c.id} · ${c.updated_at||c.created_at||''}\n\n${literal(c.content)}`).join('\n\n');
    const versionMarker=`<!-- wb-gitee-version:${remoteHash(remote)} -->`;
    const block=`${START}\n${versionMarker}\n\n## Gitee 线上原文与补充记录 · ${now()}\n\n来源：[${remote.ident}](${this.url(await this.config(),remote.ident)}) · 远端更新：${remote.updated_at}\n\n### 原始标题\n\n${literal(remote.title)}\n\n### 原始描述\n\n${literal(remote.description)}\n\n${comments||'（暂无评论）'}\n\n完整快照：[${name}](./线上原文/${name})\n\n${END}`;
    // Append immutable versions: links to earlier source paragraphs retain their rule IDs.
    const next=local.raw.includes(versionMarker)?local.raw:local.raw+'\n\n'+block+'\n';
    if(local.canonical)await this.documents.saveDocument(p,local.revision,next);
    else atomicWrite(local.file,next,fs.existsSync(local.file)?local.raw:undefined);await this.recordIndex(p,remote);
  }
  async run(p,{direction='auto',review}={}) {return this.store.lock(async()=>{
    if(!['auto','push','pull','create'].includes(direction))fail('同步方向无效');
    const r=await this.row(p),api=await this.api();
    try {
      if(r.createIntent&&!r.ident)fail('上次新建结果未知；请先在 Gitee 核对并关联已有编号，禁止重复新建',409);
      let s=await this.snapshot(p,api,r);
      if(review&&review!==s.review)fail('双方内容已变化，请重新查看差异后选择',409);
      let action=direction==='auto'?s.action:direction;
      if(s.action==='conflict'&&(direction==='auto'||!review)){r.state='conflict';r.error='双方内容不同，请查看差异并选择方向';await this.put(r);return r;}
      if(direction!=='auto'&&!review)fail('请先查看差异并提交当前版本',409);
      if(!r.ident&&action!=='create')fail('请先关联已有需求，或明确选择新建',409);
      if(action==='create'&&r.ident)fail('已有远端编号，不能重复新建',409);
      if(action==='create'&&(!review||direction!=='create')){r.state='unlinked';await this.put(r);return r;}
      if(['push','create'].includes(action)&&!s.local.body)fail('本地需求正文为空，不能推送');
      r.state='syncing';r.runner={host:require('os').hostname(),pid:process.pid};r.error='';r.startedAt=now();await this.put(r);
      if(action==='create'){
        r.createIntent={id:crypto.randomUUID(),at:now(),local:s.lh};await this.put(r);
        r.ident=await api.create(s.local,r.createIntent.id);await this.put(r);
        s.remote=await api.get(r.ident);
      } else if(action==='push'){
        // Re-read immediately before the write. The official API has no documented CAS field.
        const check=await api.get(r.ident);if(remoteHash(check)!==s.rh||this.localHash(await this.local(p))!==s.lh)fail('同步前版本已变化，请重新比较',409);
        await this.archive(p,check,s.local.raw); // Never lose the overwritten remote original/comments.
        await api.update(r.ident,s.local);s.remote=await api.get(r.ident);
      }
      if(!s.remote)fail('远端内容不可读取');
      if(['create','push'].includes(action)&&hash(remoteBody(s.remote))!==s.lh)fail('写入后的远端正文与提交内容不一致，请重新比较',409);
      const latest=await this.local(p);if(this.localHash(latest)!==s.lh)fail('本地正文已变化，请重新比较',409);
      await this.archive(p,s.remote,latest.raw);await this.cacheStatus(p,s.remote);
      r.base={local:s.lh,remote:remoteHash(s.remote),remoteVersion:s.remote.updated_at,content:remoteBody(s.remote)};
      r.lastSuccessAt=now();r.state='synced';r.error='';delete r.createIntent;await this.put(r);return r;
    } catch(e){if(e.definiteNoWrite&&!r.ident)delete r.createIntent;r.state=e.status===409&&!r.createIntent?'conflict':'failed';r.error=this.error(e);await this.put(r);return r;}
  });}
  async startJob(paths,{mode='sync'}={}){if(!['sync','check'].includes(mode))fail('批次模式无效');if(!Array.isArray(paths)||!paths.length||paths.length>200)fail('请选择 1–200 个需求');paths=[...new Set(paths)];paths.forEach(p=>this.entry(p));const id=crypto.randomUUID(),job={id,mode,runner:{host:require('os').hostname(),pid:process.pid},state:'running',total:paths.length,done:0,results:[],createdAt:now()};await this.store.put('job:'+id,job);
    const promise=(async()=>{for(const p of paths){let result;try{result=mode==='check'?await this.preview(p):await this.run(p);}catch(e){result={path:p,state:'failed',error:this.error(e)};}job.results.push({path:p,state:result.state,error:result.error||''});job.done++;await this.store.put('job:'+id,job);}job.state='done';await this.store.put('job:'+id,job);})().catch(async()=>{job.state='failed';job.error='批次执行中断，请查看逐项结果后重试';await this.store.put('job:'+id,job);});
    return {job,promise};
  }
}
module.exports={GiteeSync,projectBody,remoteHash,hash,labels};
