const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/assets/flow.js'), 'utf8');
// Exercise the editor's actual navigation functions without booting its unrelated editing UI.
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
function harness() {
  const flows = [
    {entryPath:'orders',id:'retry',name:'通知重试',nodes:[{id:'ok',type:'output',label:'通知接口响应成功',target:{entryPath:'orders',flowId:'start',nodeId:'received'}},{id:'timer',type:'event',label:'到期回扫'}]},
    {entryPath:'orders',id:'start',name:'阶段一 · 启动',nodes:[{id:'received',type:'input',label:'接收通知结果'},{id:'result',type:'decision',label:'本次下发后的情况？'}]},
    {entryPath:'orders',id:'ending',name:'结束处理',nodes:[{id:'end',label:'结束'}]},
  ];
  const elements = new Map();
  const state = {path:'orders',source:'orders',flowId:'retry',node:'ok',workspace:{flows},view:{scale:1},selectionToken:0};
  const ctx = {
    state,flows,browseReturn:null,moduleCallStack:[],collapsedFlowBranches:new Set(),allow:true,
    $: id => {if(!elements.has(id)) elements.set(id,{innerHTML:'',clientWidth:800,clientHeight:600});return elements.get(id);},
    escape: text => String(text).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),
    findFlow:(p,id)=>flows.find(f=>f.entryPath===p && f.id===id),
    flow:()=>ctx.findFlow(state.source,state.flowId),
    flowAncestors:(f)=>f?[f]:ctx.flow()?[ctx.flow()]:[],
    moduleCatalog:()=>flows,resolveModuleCall:()=>null,currentModuleContext:()=>null,
    annotations:{beforeContextChange:async()=>ctx.allow},
    key:(p,id)=>JSON.stringify([p,id]),finishDrag(){},saveView(){},setMode(){},restoreView(){},
    api:async()=>({workspace:{flows}}),center:()=>({x:100,y:100}),toast(){},
    renderCanvas(){},render(){ctx.renderContext();},renderInspector(){ctx.renderContext();},
  };
  vm.createContext(ctx);
  vm.runInContext(section('async function choose(', 'async function load(')
    + section('function navigationButton(', 'let browseReturn =')
    + section('function renderContext()', 'function renderInspector()'), ctx);
  return Object.assign(ctx,{html:()=>elements.get('canvasContext')?.innerHTML || ''});
}

test('notification output then selecting a decision shows browsing history, never a decision output',async()=>{
  const h=harness(),before=JSON.stringify(h.flows);
  await h.navigateFlow('orders','start','received',true);
  h.state.node='result';h.renderInspector();
  assert.match(h.html(),/返回上次查看位置/);
  assert.match(h.html(),/通知重试 · 通知接口响应成功/);
  assert.doesNotMatch(h.html(),/返回跨图出口|返回入口／事件|返回等待节点/);
  assert.match(h.html(),/data-navigate-flow="retry"[^>]*data-locate-node="ok"/);
  assert.equal(JSON.stringify(h.flows),before);
  await h.navigateFlow('orders','retry','ok');
  assert.equal(h.state.node,'ok');assert.equal(h.browseReturn,null);
  assert.doesNotMatch(h.html(),/返回上次查看位置/);
});

test('leaving the destination flow or selecting from the tree clears obsolete history',async()=>{
  const h=harness();
  await h.navigateFlow('orders','start','received',true);
  await h.navigateFlow('orders','ending','end');
  assert.equal(h.browseReturn,null);
  await h.navigateFlow('orders','start','received',true);
  await h.choose('orders','start');
  assert.equal(h.browseReturn,null);assert.doesNotMatch(h.html(),/返回上次查看位置/);
});

test('same-flow recovery links return to their origin and hide history at that origin',async()=>{
  const h=harness();
  await h.navigateFlow('orders','retry','timer',true);
  assert.match(h.html(),/返回上次查看位置/);
  h.state.node='ok';h.renderInspector();assert.doesNotMatch(h.html(),/返回上次查看位置/);
  h.state.node='timer';h.renderInspector();assert.match(h.html(),/返回上次查看位置/);
  await h.navigateFlow('orders','retry','ok');
  assert.equal(h.browseReturn,null);
});

test('reference navigation uses the actual source requirement, and deleted origins are not offered',async()=>{
  const h=harness();
  h.flows[0].entryPath='shared';h.state.source='shared';
  await h.navigateFlow('orders','start','received',true);
  assert.equal(h.browseReturn.origin.entryPath,'shared');
  assert.match(h.html(),/data-navigate-source="shared"/);
  h.flows[0].nodes=[];h.renderInspector();
  assert.doesNotMatch(h.html(),/返回上次查看位置/);
});

test('a cancelled navigation leaves current selection and history intact',async()=>{
  const h=harness();
  await h.navigateFlow('orders','start','received',true);
  const before=JSON.stringify(h.browseReturn);h.allow=false;
  await h.navigateFlow('orders','retry','ok',true);
  assert.equal(h.state.flowId,'start');assert.equal(h.state.node,'received');
  assert.equal(JSON.stringify(h.browseReturn),before);
  assert.equal(await h.choose('orders','ending'),false);
  assert.equal(JSON.stringify(h.browseReturn),before);
});

test('module return navigation remains separate from browsing history',async()=>{
  const h=harness();
  h.flows[1].kind='module';h.moduleCallStack.push({flowId:'retry',entryPath:'orders',nodeId:'ok'});
  h.resolveModuleCall=()=>({module:h.flows[1]});
  h.currentModuleContext=()=>h.moduleCallStack.at(-1);
  await h.navigateFlow('orders','start','received');
  assert.equal(h.moduleCallStack.length,1);
  assert.match(h.html(),/返回调用节点/);assert.doesNotMatch(h.html(),/返回上次查看位置/);
  await h.choose('orders','start');assert.equal(h.moduleCallStack.length,0);
});
