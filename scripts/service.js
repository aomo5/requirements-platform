"use strict";
require('../lib/storage-config');
if(process.argv.includes('--lan')){process.env.HOST='0.0.0.0';process.env.WORKBENCH_AUTH='required';}
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const portal=path.join(__dirname,'..'),port=Number(process.env.PORT||8125),runtime=path.join(portal,'.runtime'),pidFile=path.join(runtime,`server-${port}.json`);
async function health(){try{const r=await fetch(`http://127.0.0.1:${port}/api/storage/health`,{signal:AbortSignal.timeout(1000)});return r.ok?await r.json():null;}catch{return null;}}
async function stop(){
  if(!fs.existsSync(pidFile))throw new Error('没有受管服务记录，未结束任何进程');
  const record=JSON.parse(fs.readFileSync(pidFile,'utf8')),active=await health();
  if(!active || active.instanceId!==record.instanceId || active.pid!==record.pid)throw new Error('服务身份无法核验，未结束任何进程');
  process.kill(record.pid,'SIGTERM');
  for(let i=0;i<50;i++){try{process.kill(record.pid,0);}catch{console.log('工作台已停止');return;}await new Promise(r=>setTimeout(r,100));}
  throw new Error('服务仍在收尾，请稍后重试，不强制结束');
}
async function start(){
  if(await health())throw new Error('端口已有工作台，请先停止或使用 restart');
  fs.mkdirSync(runtime,{recursive:true,mode:0o700});const log=fs.openSync(path.join(runtime,`server-${port}.log`),'a',0o600);
  const child=spawn(process.execPath,[path.join(portal,'server.js')],{cwd:portal,env:process.env,detached:true,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);
  for(let i=0;i<50;i++){const active=await health();if(active?.pid===child.pid){console.log(`工作台已启动：http://127.0.0.1:${port} · ${active.storage}`);return;}await new Promise(r=>setTimeout(r,100));}
  throw new Error(`启动未确认，请查看 ${path.join(runtime,`server-${port}.log`)}`);
}
(async()=>{const action=process.argv[2];if(action==='stop'||action==='restart')await stop();if(action==='start'||action==='restart')await start();if(!['start','stop','restart'].includes(action))throw new Error('使用 start / stop / restart');})().catch(e=>{console.error(e.message);process.exitCode=1});
