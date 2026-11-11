const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../public/assets/flow-contracts.mjs');
const row = overrides => ({id:'field-1',name:'notifyTimes',type:'Integer',required:'required',source:'本轮快照',description:'通知次数',...overrides});
test('contract row validation preserves conditional drafts until they can be saved',async()=>{
 const {validateContractRow,cleanContractRow}=await load();
 assert.match(validateContractRow(row({name:''})),/字段名/);
 assert.match(validateContractRow(row({required:'conditional',condition:' '})),/必需条件/);
 assert.match(validateContractRow(row({source:'a'.repeat(1001)})),/1000/);
 assert.equal(validateContractRow(row({required:'conditional',condition:'仅订单通知'})),'');
 assert.deepEqual(cleanContractRow(row({name:' id ',type:' Long ',source:' ',description:' 原通知 '})),{id:'field-1',name:'id',type:'Long',required:'required',description:'原通知'});
});
test('copy includes inputs, outputs and required condition without breaking markdown tables',async()=>{
 const {formatContractCopy}=await load();
 const copied=formatContractCopy({inputs:[row({description:'a|b\n<script>x</script>'})],outputs:[row({name:'result',type:'Result',required:'conditional',condition:'提交成功',source:'持久化结果'})]},[{label:'本次返回位置',location:'工作线程 → 本轮结果',reference:{entryPath:'模块/需求',flowId:'worker',nodeId:'result'}}]);
 assert.match(copied,/输入参数/);assert.match(copied,/返回参数/);assert.match(copied,/条件必需（提交成功）/);
 assert.ok(copied.includes('a\\|b<br>&lt;script&gt;x&lt;/script&gt;'));
 assert.ok(copied.includes('节点 ID：result'));assert.ok(copied.includes('需求：模块/需求'));
 assert.equal(formatContractCopy(undefined), '');
});
test('return locations derive from each caller; current invocation filters unrelated callers',async()=>{
 const {contractRelations}=await load();
 const module={entryPath:'p',id:'module',kind:'module',name:'公共模块',nodes:[{id:'in',type:'input',label:'输入'},{id:'out',type:'return',label:'跳过'}]};
 const caller=(id,label)=>({entryPath:'p',id,name:label,nodes:[{id:'call',type:'call',label:'调用',call:{entryPath:'p',flowId:'module',nodeId:'in',returns:[{outputNodeId:'out',targetNodeId:'result'}]}},{id:'result',type:'decision',label:'结果？'}],edges:[{source:'call',target:'result'}]});
 const a=caller('a','首次线程'),b=caller('b','回扫线程'),flows=[module,a,b];
 assert.equal(contractRelations(flows,module,module.nodes[1]).length,2);
 const selected=contractRelations(flows,module,module.nodes[1],{entryPath:'p',flowId:'b',nodeId:'call'});
 assert.equal(selected.length,1);assert.equal(selected[0].reference.flowId,'b');assert.equal(selected[0].location,'回扫线程 → 结果？');
 const callRelations=contractRelations(flows,a,a.nodes[0]);
 assert.equal(callRelations[0].label,'调用入口');assert.equal(callRelations[1].reference.nodeId,'result');
});
test('a waiting target is a timer reference, not an immediate return to a query',async()=>{
 const {contractRelations}=await load();
 const target={entryPath:'p',id:'scheduler',name:'通知回扫',nodes:[{id:'timer',type:'event',eventType:'timer',label:'下一轮定时触发'}]};
 const node={id:'wait',type:'output',target:{entryPath:'p',flowId:'scheduler',nodeId:'timer'}};
 const result=contractRelations([target],{entryPath:'p',id:'worker',nodes:[node]},node);
 assert.equal(result[0].label,'后续定时入口');assert.equal(result[0].reference.nodeId,'timer');
 const missing=contractRelations([], {entryPath:'p',id:'worker',nodes:[node]},node);
 assert.equal(missing[0].available,false);assert.match(missing[0].location,/关联不可用/);
});
