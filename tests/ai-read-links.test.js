'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAiReadLinks}=require('../lib/ai-read-links');
test('AI share grants cover discovered resources, expire, and cannot select unrelated requirements',async()=>{
 const context={async read(kind){return kind==='context'?{flows:[{url:'/api/ai/flow?path=A&flow=f&revision=1'}],documents:[{url:'/api/ai/document?file=A%2Fspec.md&fingerprint=x'}],sources:[],materials:[]}:{nodes:[]};}};
 const links=createAiReadLinks(context),issued=await links.issue({id:'u'},new URLSearchParams({path:'A'})),url=new URL(issued.url,'http://example');
 const overview=await links.read(url);assert.ok(overview.flows[0].url.includes('aiToken='));assert.equal(links.permits(new URL(overview.flows[0].url,'http://example')),true);
 const forged=new URL(overview.flows[0].url,'http://example');forged.searchParams.set('path','B');assert.equal(links.permits(forged),false);
 const clock=Date.now;try{Date.now=()=>clock()+3600001;await assert.rejects(links.read(url),{status:401});}finally{Date.now=clock;}
});
