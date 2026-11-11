#!/usr/bin/env node
"use strict";
// CLI talks to the same local HTTP service used by the page. No separate sync implementation.
const fs=require('fs');
const args=process.argv.slice(2),command=args.shift();
const arg=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
const base=process.env.WORKBENCH_URL||'http://127.0.0.1:8125';
async function call(route,body,method='POST'){
  const u=new URL(base);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('CLI 仅连接本机工作台');
  const r=await fetch(base+'/api/gitee'+route,{method:body===undefined?'GET':method,headers:{Origin:base,'X-Design-Client':'workbench-v1','Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const result=await r.json();if(!r.ok)throw new Error(result.error);return result;
}
(async()=>{
  let result;
  if(command==='config'){result=arg('--file')?await call('/config',JSON.parse(fs.readFileSync(arg('--file'),'utf8')),'PUT'):args.includes('--stdin')?await call('/config',JSON.parse(fs.readFileSync(0,'utf8')),'PUT'):await call('/config');}
  else if(command==='test')result=await call('/test',{});
  else if(command==='discover')result=await call('/discover',{});
  else if(command==='pending'||command==='list')result=await call('/items'+(command==='pending'?'?pending=1':''));
  else if(command==='preview')result=await call('/preview',{path:arg('--path')});
  else if(command==='link')result=await call('/link',{path:arg('--path'),ident:arg('--ident')});
  else if(command==='sync')result=await call('/sync',{path:arg('--path'),direction:arg('--direction')||'auto',review:arg('--review')});
  else if(command==='batch'||command==='check'){
    const paths=arg('--file')?JSON.parse(fs.readFileSync(arg('--file'),'utf8')):(await call(command==='check'?'/items':'/items?pending=1')).items.filter(i=>i.ident).map(i=>i.path);
    result=await call('/jobs',{paths,mode:command==='check'?'check':'sync'});
    if(args.includes('--wait')){while(result.state==='running'){await new Promise(r=>setTimeout(r,500));result=await call('/jobs/'+result.id);}}
  }
  else if(command==='job')result=await call('/jobs/'+arg('--id'));
  else {console.log('gitee config [--file 私有JSON文件 | --stdin] | discover | test | list | pending | preview --path 目录 | link --path 目录 --ident 编号 | sync --path 目录 [--direction auto|pull|push|create --review 指纹] | check [--file 路径数组JSON] [--wait] | batch [--file 路径数组JSON] [--wait] | job --id 批次ID');return;}
  console.log(JSON.stringify(result,null,2));
  if(['failed','conflict'].includes(result.state)||result.results?.some(r=>['failed','conflict'].includes(r.state)))process.exitCode=2;
})().catch(e=>{console.error(e.message==='fetch failed'?'无法连接本机工作台':e.message);process.exitCode=1;});
