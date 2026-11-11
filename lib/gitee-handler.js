"use strict";
const {canEdit}=require('./design-store');
const {fail}=require('./gitee-api');
function createGiteeHandler(service,sendJson,accounts){return async(req,res,url)=>{
  try{
    if(!req.accountAccess && !canEdit(req,'local'))fail('Gitee 配置与同步仅允许本机操作',403);
    if(!service)fail('Gitee 同步当前未启用，请检查 MySQL 存储及服务端同步开关',503);
    const route=url.pathname.slice('/api/gitee'.length);let body={};
    if(req.method!=='GET'){
      if(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-design-client']!=='workbench-v1')fail('不允许跨站同步请求',403);
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail('请使用 JSON 请求',415);
      const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>32768)fail('请求过大',413);chunks.push(chunk);}try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{fail('JSON 格式错误');}
    }
    if(accounts) {
      const paths=route==='/jobs'?body.paths:[body.path];
      if(req.method!=='GET') {
        if(!['/preview','/link','/sync','/jobs','/status-cache'].includes(route))fail('团队模式下平台配置由维护者在服务端管理',403);
        if(!Array.isArray(paths)||!paths.length)fail('请选择需求',400);
        for(const p of paths)if(typeof p!=='string'||!await accounts.owns(p,req.accountAccess.user))fail('只有需求创建者可以同步或修改此需求',403);
      }
    }
    let result;
    if(route==='/config'&&req.method==='GET')result=await service.publicConfig();
    else if(route==='/config'&&req.method==='PUT')result=await service.saveConfig(body);
    else if(route==='/test'&&req.method==='POST')result=await service.test();
    else if(route==='/discover'&&req.method==='POST')result={enterprises:await service.discover(body)};
    else if(route==='/status-cache'&&req.method==='POST'){service.entry(body.path);const remote=body.remote;if(!remote||!/^I[A-Z0-9]{5}$/.test(remote.ident||'')||!['open','progressing','closed','rejected'].includes(remote.state)||typeof remote.title!=='string'||remote.title.length>1000||typeof remote.updated_at!=='string'||!Number.isFinite(Date.parse(remote.updated_at)))fail('远端状态摘要无效');await service.cacheStatus(body.path,remote);result={cached:true};}
    else if(route==='/items'&&req.method==='GET'){let items=await service.list();if(url.searchParams.get('pending')==='1')items=items.filter(x=>x.state!=='synced');result={items};}
    else if(route==='/preview'&&req.method==='POST')result=await service.preview(body.path);
    else if(route==='/link'&&req.method==='POST')result=await service.link(body.path,String(body.ident||'').trim().toUpperCase());
    else if(route==='/sync'&&req.method==='POST')result=await service.run(body.path,body);
    else if(route==='/jobs'&&req.method==='POST'){result=(await service.startJob(body.paths,{mode:body.mode})).job;}
    else if(route==='/jobs/latest'&&req.method==='GET')result={job:await service.store.latestJob()};
    else if(/^\/jobs\/[a-f0-9-]{36}$/.test(route)&&req.method==='GET'){result=await service.store.get('job:'+route.split('/').at(-1));if(!result)fail('批次不存在',404);}
    else fail('同步接口不存在或请求方法错误',404);
    sendJson(res,200,result);
  }catch(e){sendJson(res,e.status||500,{error:e.status?e.message:'同步服务暂不可用，请检查数据库连接'});}
};}
module.exports={createGiteeHandler};
