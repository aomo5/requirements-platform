'use strict';
// Optional UI fixture: isolated files and in-memory remote; no Gitee requests.
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const {GiteeSync}=require('../lib/gitee-sync'),{createGiteeHandler}=require('../lib/gitee-handler'),{scanRequirements}=require('../lib/scan');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-gitee-ui-')),p='00-测试/同步演练';
fs.mkdirSync(path.join(root,p),{recursive:true});fs.writeFileSync(path.join(root,p,'需求文档.md'),'# 同步演练\n\n<!-- wb-rule:rule-preserved -->\n本地规格：保存物业权限。\n');fs.writeFileSync(path.join(root,p,'规格索引.md'),'# 规格索引\n主 Gitee 需求编号：IABC12\n');
const values=new Map();let locked=false;
const store={get:async k=>structuredClone(values.get(k)||null),put:async(k,v)=>values.set(k,structuredClone(v)),lock:async fn=>{if(locked)throw Object.assign(new Error('已有同步任务'),{status:409});locked=true;try{return await fn();}finally{locked=false;}}};
const remote={ident:'IABC12',title:'同步演练',description:'线上原文：知识库权限设计。',program_id:101,state:'open',updated_at:'2026-10-19T01:00:00Z',comments:[{id:1,author:{name:'评审'},content:'保留原文与元素编号。'}]};
const service=new GiteeSync({root,store,getTree:()=>scanRequirements(root),secretFile:path.join(root,'private/token'),apiFactory:()=>({get:async()=>structuredClone(remote),discover:async()=>[{id:123,name:'隔离企业',path:'fixture'}],test:async()=>({enterprise:'隔离企业',program:'隔离项目',read:true,write:'unverified',message:'隔离连接通过'}),create:async l=>{remote.description=l.body;return remote.ident;},update:async(i,l)=>{remote.description=l.body;remote.title=l.title;remote.updated_at+='x';}})});
const send=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const handler=createGiteeHandler(service,send);
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1:8136');if(u.pathname.startsWith('/api/gitee/'))return handler(req,res,u);
 if(u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html lang="zh-CN"><head><title>Gitee 同步隔离演练</title><link rel="stylesheet" href="/assets/workbench-tokens.css"><link rel="stylesheet" href="/assets/workbench-base.css"><link rel="stylesheet" href="/assets/workbench-icons.css"><link rel="stylesheet" href="/assets/gitee-sync.css"></head><body><h1>Gitee 同步隔离演练</h1><button id="giteeSettingsButton">设置</button><button id="giteeBatchButton">批量同步</button><button id="giteeSyncButton">同步 Gitee</button><span id="giteeSyncState"></span><script type="module">import{createGiteeSyncUI}from'/assets/gitee-sync.js';createGiteeSyncUI({getPath:()=>${JSON.stringify(p)},onChanged:async()=>{}});</script></body></html>`);return;}
 if(/^\/assets\/[a-zA-Z0-9.-]+$/.test(u.pathname)){const f=path.join(__dirname,'../public',u.pathname);if(fs.existsSync(f)){res.writeHead(200,{'Content-Type':f.endsWith('.css')?'text/css':'text/javascript'});fs.createReadStream(f).pipe(res);return;}}
 res.writeHead(404);res.end();
});
server.listen(8136,'127.0.0.1',()=>console.log('隔离同步页面：http://127.0.0.1:8136；远端写入全部使用内存模拟'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{fs.rmSync(root,{recursive:true,force:true});process.exit(0);}));
