const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Keep browser ES modules testable on the portal's supported CommonJS runtime.
const source = name => fs.readFileSync(path.join(__dirname, '../public/assets', name), 'utf8');
const url = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const textURL = url(source('flow-text.js'));
const geometryURL = url(source('flow-geometry.js').replaceAll('./flow-text.js', textURL)), formatURL = url(source('flow-mermaid-format.mjs'));
const geometry = import(geometryURL), mermaid = import(url(source('flow-mermaid.js').replaceAll('./flow-geometry.js', geometryURL).replaceAll('./flow-mermaid-format.mjs', formatURL)));
const n = (id, x = 0, y = 0, type = 'step') => ({ id, x, y, type, label: id, pageId: `page-${id}` });
const e = (source, target, label = '') => ({ id: `${source}-${target}-${label}`, source, target, label });
test('branches, merges, cycles and disconnected graphs lay out without overlap in every direction', async () => {
  const { layoutNodes, nodeBox, overlap, center } = await geometry;
  const nodes = [n('a', 0, 0, 'start'), n('b', 0, 0, 'decision'), n('c'), n('d'), n('end', 0, 0, 'end'), n('isolated')];
  const edges = [e('a', 'b'), e('b', 'c'), e('b', 'd'), e('d', 'b'), e('c', 'end'), e('d', 'end')];
  const before = JSON.stringify({ nodes, edges });
  for (const direction of ['TD', 'TB', 'BT', 'LR', 'RL']) {
    const result = layoutNodes(nodes, edges, direction), horizontal = ['LR', 'RL'].includes(direction), axis = horizontal ? 'x' : 'y';
    result.forEach((node, i) => result.slice(i + 1).forEach(other => assert.equal(overlap(nodeBox(node, 20), nodeBox(other, 20)), false)));
    assert.ok((center(result[4])[axis] - center(result[0])[axis]) * (['BT', 'RL'].includes(direction) ? -1 : 1) > 0);
    assert.equal(center(result[0])[horizontal ? 'y' : 'x'], center(result[1])[horizontal ? 'y' : 'x']);
    assert.deepEqual(result.map(({ x, y, ...rest }) => rest), nodes.map(({ x, y, ...rest }) => rest));
    assert.deepEqual(layoutNodes(nodes, edges, direction), result);
  }
  assert.equal(JSON.stringify({ nodes, edges }), before);
});
test('Mermaid roundtrip and partial edits preserve stable identities, positions and page associations', async () => {
  const { parseMermaid, serializeMermaid } = await mermaid;
  const previous = { direction: 'TD', nodes: [n('source-id', -150, 90, 'start'), n('check', 87, 320, 'decision'), n('finish', 40, 600, 'end')], edges: [e('source-id', 'check', '原文'), e('check', 'finish')] };
  const source = serializeMermaid(previous), parsed = parseMermaid(source, previous);
  assert.deepEqual(parsed, previous);
  const changed = parseMermaid(source.replace('原文', '补充') + '\nfinish --> extra[新增步骤]', previous);
  for (const node of previous.nodes) assert.deepEqual(changed.nodes.find(n => n.id === node.id), node);
  assert.equal(changed.edges[0].id, previous.edges[0].id);
  const redirected = parseMermaid(source.replace('flowchart TD', 'flowchart RL'), previous);
  assert.deepEqual(redirected.nodes.map(({ x, y, ...rest }) => rest), previous.nodes.map(({ x, y, ...rest }) => rest));
  assert.deepEqual(redirected.edges, previous.edges);
  const chain = parseMermaid('flowchart TD\na[A] --> b[B] --> c[C]', { direction: 'TD', nodes: [n('a', 2000, 3000)], edges: [] });
  assert.equal(chain.nodes[1].x, 2000); assert.equal(chain.nodes[2].x, 2000);
  assert.ok(chain.nodes[2].y > chain.nodes[1].y && chain.nodes[1].y > 3000);
});
test('smooth curves retain boundary anchors, nearby labels and distinct parallel/self paths without mutating data', async () => {
  const { graphGeometry, anchor, center } = await geometry;
  const nodes = [n('a', 0, 0), n('b', 280, 320, 'decision'), n('side', 320, 150)];
  const edges = [e('a', 'b', '成功'), e('b', 'a', '回路'), e('a', 'b', '并行'), e('side', 'side', '重试')];
  const graph = { nodes, edges, direction: 'TD' }, before = JSON.stringify(graph), routes = graphGeometry(graph);
  for (const edge of edges) {
    const route = routes.get(edge.id); assert.match(route.d, /^M[^C]+ C/); assert.ok(!/[LQ]/.test(route.d));
    assert.ok(Math.abs(route.x - route.midpoint.x) <= route.labelBox.width / 2 + 6);
    assert.ok(Math.abs(route.y - route.midpoint.y) <= route.labelBox.height / 2 + 2);
    if (edge.source !== edge.target) {
      const a = nodes.find(n => n.id === edge.source), b = nodes.find(n => n.id === edge.target);
      assert.deepEqual(route.points[0], anchor(a, center(b))); assert.deepEqual(route.points.at(-1), anchor(b, center(a)));
    }
  }
  assert.notEqual(routes.get(edges[0].id).d, routes.get(edges[2].id).d);
  assert.equal(JSON.stringify(graph), before);
});
test('100 nodes with retry edges retain all data and finite routes', async () => {
  const { layoutNodes, graphGeometry } = await geometry;
  const nodes = Array.from({ length: 100 }, (_, i) => n(`n${i}`));
  const edges = nodes.slice(1).flatMap((node, i) => [e(nodes[i].id, node.id), e(node.id, nodes[Math.max(0, i - 2)].id, 'retry')]);
  const result = layoutNodes(nodes, edges), routes = graphGeometry({ nodes: result, edges, direction: 'TD' });
  assert.equal(result.length, 100); assert.equal(routes.size, 198);
  for (const route of routes.values()) assert.ok(!/NaN|Infinity/.test(route.d));
});
test('multiline labels stay attached to the curve and share their measured bounds', async () => {
  const { graphGeometry, overlap, nodeBox } = await geometry;
  const nodes = [n('step', 280, 50), n('check', 600, 32, 'decision')];
  const edges = [e('step', 'check', '余额不足\n保留原账户余额，等待下一次独立扣费后恢复到账')];
  const route = graphGeometry({ nodes, edges, direction: 'LR' }).get(edges[0].id);
  assert.equal(route.labelText.lines.length, 3);
  assert.equal(route.labelBox.height, route.labelText.height);
  assert.ok(Math.abs(route.x - route.midpoint.x) <= route.labelBox.width / 2 + 6);
  assert.ok(Math.abs(route.y - route.midpoint.y) <= route.labelBox.height / 2 + 2);
  const tightNodes = [n('decision', 0, 0, 'decision'), n('step', -10, 128)];
  const tight = graphGeometry({ nodes: tightNodes, edges: [e('decision', 'step', '有')] }).values().next().value;
  assert.ok(tightNodes.every(node => !overlap(tight.labelBox, nodeBox(node))));
  const offsetNodes = [n('decision', 40, 310, 'decision'), n('step', 40, 440)];
  const offset = graphGeometry({ nodes: offsetNodes, edges: [e('decision', 'step', '有')] }).values().next().value;
  assert.ok(offset.x > offset.midpoint.x); assert.equal(offset.y, offset.midpoint.y);
});
test('swimlane metadata survives storage validation and Mermaid edits', async () => {
  const {validateContent} = require('../lib/flow-store');
  const {parseMermaid,serializeMermaid} = await mermaid;
  const graph = {id:'main',name:'泳道',description:'',parent:null,direction:'TD',lanes:[{id:'orders',label:'订单',x:0,y:0,width:300,height:500}],nodes:[{...n('a'),pageId:'',issues:['P01'],variant:'branch'},{...n('b',0,200),pageId:'',supplement:true}],edges:[{...e('a','b'),id:'edge',trace:'branch'}]};
  const saved=validateContent({applicability:'needed',reason:'',flows:[graph],references:[]},'test').flows[0];
  assert.deepEqual(saved,graph);
  assert.throws(()=>validateContent({applicability:'needed',reason:'',flows:[{...graph,nodes:[{...graph.nodes[0],variant:'unknown'},graph.nodes[1]]}],references:[]},'test'),/节点样式/);
  const parsed=parseMermaid(serializeMermaid(saved),saved);
  assert.deepEqual(parsed.lanes,graph.lanes); assert.deepEqual(parsed.nodes,graph.nodes); assert.deepEqual(parsed.edges,graph.edges);
  assert.throws(()=>validateContent({applicability:'needed',reason:'',flows:[{...graph,lanes:[{...graph.lanes[0],width:-1}]}],references:[]},'test'),/泳道/);
});

test('cross-flow output metadata survives Mermaid export/import and rejects missing nodes', async () => {
  const { parseMermaid, serializeMermaid } = await mermaid;
  const target = { entryPath: '20-test/example', flowId: 'parent', nodeId: 'start' };
  const previous = { direction: 'TD', nodes: [{ ...n('next', 10, 20, 'output'), target }], edges: [] };
  assert.deepEqual(parseMermaid(serializeMermaid(previous), previous), previous);
  const fresh = parseMermaid(serializeMermaid(previous));
  assert.equal(fresh.nodes[0].type, 'output');
  assert.deepEqual(fresh.nodes[0].target, target);
  assert.throws(() => parseMermaid('flowchart TD\n%% workbench-output {"id":"missing"}'), /不存在/);
});
test('output target is persisted, unsafe paths and self-flow targets rejected', () => {
  const { validateContent } = require('../lib/flow-store');
  const data = { applicability: 'needed', reason: '', references: [], flows: [{ id: 'child', name: '子图', description: '', nodes: [{ ...n('next', 0, 0, 'output'), target: { entryPath: 'test/example', flowId: 'parent', nodeId: 'start' } }], edges: [] }] };
  assert.deepEqual(validateContent(data, 'test/example').flows[0].nodes[0].target, data.flows[0].nodes[0].target);
  data.flows[0].nodes[0].target.flowId = 'child';
  assert.throws(() => validateContent(data, 'test/example'), /其他流程/);
  data.flows[0].nodes[0].target.entryPath = '../secret';
  assert.throws(() => validateContent(data, 'test/example'), /格式/);
});

test('entry, event and end semantics survive a fresh Mermaid import and storage', async () => {
  const { parseMermaid, serializeMermaid } = await mermaid;
  const { validateContent } = require('../lib/flow-store');
  const source = { entryPath:'test/example',flowId:'parent',nodeId:'gate' };
  const flow = { id:'child',name:'子图',description:'',direction:'TD',nodes:[{...n('entry',0,0,'input'),source},{...n('response',250,0,'event'),eventType:'response',eventPhase:'intermediate',source},{...n('exit',500,0,'end'),endScope:'execution'}],edges:[] };
  const roundtrip = parseMermaid(serializeMermaid(flow));
  const validated = validateContent({applicability:'needed',reason:'',references:[],flows:[{...flow,...roundtrip}]},'test/example').flows[0];
  assert.deepEqual(validated.nodes.map(({type,source,eventType,eventPhase,endScope})=>({type,source,eventType,eventPhase,endScope})),flow.nodes.map(({type,source,eventType,eventPhase,endScope})=>({type,source,eventType,eventPhase,endScope})));
  flow.nodes[2].endScope = 'all-orders';
  assert.throws(()=>validateContent({applicability:'needed',reason:'',references:[],flows:[flow]},'test/example'),/结束范围/);
});
test('same-flow event source is valid, but input self-flow and event self-node are rejected', () => {
  const {validateContent} = require('../lib/flow-store');
  const event = {...n('received',0,0,'event'),eventType:'message',eventPhase:'trigger',source:{entryPath:'test/example',flowId:'child',nodeId:'sent'}};
  const data={applicability:'needed',reason:'',references:[],flows:[{id:'child',name:'子图',description:'',nodes:[n('sent'),event],edges:[]}]};
  assert.equal(validateContent(data,'test/example').flows[0].nodes[1].source.nodeId,'sent');
  event.type='input';assert.throws(()=>validateContent(data,'test/example'),/入口来源/);
  event.type='event';event.source.nodeId='received';assert.throws(()=>validateContent(data,'test/example'),/入口来源/);
});

test('semantic node boundary anchors and routed edges remain finite', async () => {
  const {graphGeometry,anchor} = await geometry;
  const nodes = ['start','input','event','output','end'].map((type,i)=>n('n'+i,i*250,i*150,type));
  const edges=nodes.slice(1).map((node,i)=>e(nodes[i].id,node.id,'继续'));
  for(const node of nodes) {const point=anchor(node,{x:1000,y:1000});assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y));}
  for(const value of graphGeometry({nodes,edges}).values()) {assert.ok(!/NaN|Infinity/.test(value.d));for(const point of value.points) assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y));}
});
test('all gateway modes roundtrip through Mermaid and storage without becoming decisions', async () => {
  const {parseMermaid,serializeMermaid}=await mermaid;
  const {validateContent}=require('../lib/flow-store');
  for (const gatewayMode of ['split','join','merge','unspecified']) {
    const flow={id:'f',name:'分流',description:'',direction:'TD',nodes:[{...n('gate',0,0,'gateway'),gatewayMode}],edges:[]};
    const parsed=parseMermaid(serializeMermaid(flow));
    const saved=validateContent({applicability:'needed',reason:'',references:[],flows:[{...flow,...parsed}]},'test/example');
    assert.equal(saved.flows[0].nodes[0].type,'gateway');assert.equal(saved.flows[0].nodes[0].gatewayMode,gatewayMode);
  }
  const data={applicability:'needed',reason:'',references:[],flows:[{id:'f',name:'分流',description:'',nodes:[{...n('g',0,0,'gateway'),gatewayMode:'first-wins'}],edges:[]}]};
  assert.throws(()=>validateContent(data,'test/example'),/模式无效/);
});
test('gateway routes stay finite in split and join layouts',async()=>{
  const {graphGeometry}=await geometry;
  const nodes=[n('in'),n('g',250,100,'gateway'),n('a',500,0),n('b',500,200)];
  for (const edges of [[e('in','g'),e('g','a'),e('g','b')],[e('a','g'),e('b','g'),e('g','in')]])
    for (const g of graphGeometry({nodes,edges}).values()) assert.ok(!/NaN|Infinity/.test(g.d));
});
