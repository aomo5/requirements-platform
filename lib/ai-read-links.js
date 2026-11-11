'use strict';
const crypto=require('node:crypto');
// Short-lived, read-only grants contain only server-discovered AI resources.
function resource(url){const u=new URL(url,'http://workbench');for(const key of ['aiToken','revision','annotationsRevision','fingerprint'])u.searchParams.delete(key);u.searchParams.sort();return u.pathname+'?'+u.searchParams;}
function createAiReadLinks(context){
 const grants=new Map();
 function collect(data,allowed){for(const f of data.flows||[])allowed.add(resource(f.url));for(const d of data.documents||[])allowed.add(resource(d.url));for(const m of data.materials||[])allowed.add(resource(m.url));for(const s of data.sources||[]){if(s.annotationsUrl)allowed.add(resource(s.annotationsUrl));for(const p of s.pages||[])allowed.add(resource(p.url));}}
 function decorate(data,token){if(!data||typeof data!=='object')return data;for(const [k,v] of Object.entries(data)){if((k==='url'||k==='annotationsUrl')&&typeof v==='string'&&v.startsWith('/api/ai/')){const u=new URL(v,'http://workbench');u.searchParams.set('aiToken',token);data[k]=u.pathname+u.search;}else if(v&&typeof v==='object')decorate(v,token);}return data;}
 return {
  async issue(user,params){const now=Date.now();for(const [k,g]of grants)if(g.expires<=now)grants.delete(k);
   const mine=[...grants].filter(([,g])=>g.userId===user.id);if(mine.length>=20)grants.delete(mine[0][0]);
   const clean=new URLSearchParams();for(const k of ['path','flow','source'])if(params.get(k))clean.set(k,params.get(k));
   const data=await context.read('context',clean),token=crypto.randomBytes(32).toString('hex'),url='/api/ai/context?'+clean,allowed=new Set([resource(url)]);collect(data,allowed);
   grants.set(token,{userId:user.id,expires:now+3600000,allowed});return {url:url+'&aiToken='+token,expiresAt:new Date(now+3600000).toISOString()};
  },
  permits(url){const g=grants.get(url.searchParams.get('aiToken'));return !!g&&g.expires>Date.now()&&g.allowed.has(resource(url));},
  async read(url){const token=url.searchParams.get('aiToken'),g=grants.get(token);if(!this.permits(url))throw Object.assign(new Error('AI 只读链接已失效或超出范围，请重新复制给 AI'),{status:401});const data=await context.read(url.pathname.slice('/api/ai/'.length),url.searchParams);if(url.pathname==='/api/ai/context')collect(data,g.allowed);return decorate(data,token);}
 };
}
module.exports={createAiReadLinks};
