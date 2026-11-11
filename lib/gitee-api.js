"use strict";
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
class GiteeApi {
  constructor(config, token, request = fetch) { this.config=config; this.token=token; this.request=request; }
  async call(method, suffix, body, query={}) {
    if(!this.token) throw Object.assign(new Error('尚未配置企业 API 凭据，请打开设置'),{status:400,definiteNoWrite:true});
    const u=new URL(this.config.apiBase+suffix);
    for(const [k,v] of Object.entries(query)) u.searchParams.set(k,String(v));
    let r;
    try { r=await this.request(u,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}); }
    catch { fail('Gitee 请求未完成；请检查网络，写入结果可能未知',502); }
    if(!r.ok) {try { fail(({401:'Gitee 凭据无效或已过期（401）',403:'Gitee 拒绝访问：请核对企业 API 权限和项目权限（403）',404:'Gitee 企业、项目或工作项不存在，或当前凭据不可见（404）',429:'Gitee 请求过于频繁，请稍后重试（429）'})[r.status] || `Gitee API 请求失败（HTTP ${r.status}）`,502); } catch(e){e.definiteNoWrite=r.status>=400&&r.status<500&&r.status!==408;throw e;} }
    try { return await r.json(); } catch { fail('Gitee 返回了非 JSON 数据，未确认成功',502); }
  }
  async pages(suffix, query={}) {
    const items=[];
    for(let page=1;page<=100;page++) {
      const d=await this.call('GET',suffix,null,{...query,page,per_page:100});
      if(!Array.isArray(d.data)) fail('Gitee 列表格式与企业 API 不符',502);
      items.push(...d.data);
      if((Number.isInteger(d.total_count)&&items.length>=d.total_count)||d.data.length===0) return items;
    }
    fail('Gitee 分页超出上限，未取得完整内容',502);
  }
  async discover() { return this.pages('/list'); }
  async test() {
    const enterprises=await this.discover();
    const e=enterprises.find(e=>String(e.id)===String(this.config.enterpriseId));
    if(!e) fail('当前凭据无法访问指定企业；请核对企业编号');
    const programs=await this.pages(`/${e.id}/programs`);
    const p=programs.find(p=>String(p.id)===String(this.config.programId));
    if(!p) fail('当前凭据无法访问指定项目；请核对项目编号');
    await this.call('GET',`/${e.id}/issues`,null,{program_id:p.id,page:1,per_page:1});
    return {read:true,write:'unverified',enterprise:e.name,enterpriseId:e.id,enterprisePath:e.path,program:p.name,programId:p.id,message:'企业项目读取正常；写权限将在实际同步时由 Gitee 校验'};
  }
  async get(ident) {
    if(!/^I[A-Z0-9]{5,12}$/.test(ident||'')) fail('请输入有效的 Gitee 需求编号');
    const issue=await this.call('GET',`/${this.config.enterpriseId}/issues/${ident}`,null,{qt:'ident'});
    if(issue.ident!==ident||typeof issue.description!=='string'||typeof issue.title!=='string'||!issue.updated_at) fail('Gitee 详情字段不完整，未确认同步',502);
    if(String(issue.program_id)!==String(this.config.programId)) fail('该工作项不属于已配置项目，拒绝同步',409);
    const comments=await this.pages(`/${this.config.enterpriseId}/issues/${ident}/notes`,{qt:'ident',direction:'asc'});
    return {...issue,comments};
  }
  async create(local, operationId) {
    const c=this.config;
    const result=await this.call('POST',`/${c.enterpriseId}/issues`,{title:local.title,description:local.body+`\n\n<!-- wb-sync:${operationId} -->`,program_id:Number(c.programId),category:'requirement',...(c.issueTypeId?{issue_type_id:Number(c.issueTypeId)}:{})});
    if(!/^I[A-Z0-9]{5,12}$/.test(result.ident||'')) fail('Gitee 新建响应缺少编号；请在远端核对后关联，禁止重复新建',502);
    return result.ident;
  }
  async update(ident, local) { await this.call('PUT',`/${this.config.enterpriseId}/issues/${ident}`,{qt:'ident',title:local.title,description:local.body}); }
}
module.exports={GiteeApi,fail};
