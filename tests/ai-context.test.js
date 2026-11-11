const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAiContext, createAiHandler } = require('../lib/ai-context');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ai-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = ['20-收费管理/订单', '40-支付结算/退款', '40-支付结算/规则'];
  const entries = paths.map(p => ({ path: p, feature: p.split('/')[1], docs: { requirement: `${p}/需求文档.md` },
    document: { storage: 'mysql' }, pageDesigns: [], referenceDocuments: [] }));
  paths.forEach(p => fs.mkdirSync(path.join(root, p), { recursive: true }));
  fs.writeFileSync(path.join(root, paths[0], '核验数据.json'), '{"order":"test"}');
  fs.writeFileSync(path.join(root, paths[0], '.private.json'), '{"secret":true}');
  fs.writeFileSync(path.join(root, paths[0], '元素说明.json'), '{"obsolete":true}');
  const flow = (id, parent = null) => ({ id, name: id, description: '业务说明', parent,
    nodes: [{ id: 'start', type: 'start', label: '开始' }, { id: 'end', type: 'end', label: '结束', pageId: 'page1' }],
    edges: [{ id: 'edge1', source: 'start', target: 'end', label: '成功', trace: 'proposal' }] });
  const flows = {
    [paths[0]]: { revision: 2, flows: [flow('main')], references: [{ entryPath: paths[1], flowId: 'refund' }] },
    [paths[1]]: { revision: 3, flows: [flow('refund', { entryPath: paths[0], flowId: 'main', nodeId: 'end' }),
      flow('child', { entryPath: paths[1], flowId: 'refund' }), flow('unrelated')], references: [{ entryPath: paths[0], flowId: 'main' }] },
  };
  const notes = {
    [paths[0]]: { revision: 5, notes: [{ id: 'n1', text: '退款异常时保留状态', target: { type: 'flow-node', flowId: 'main', nodeId: 'end' },
      requirements: [{ file: entries[2].docs.requirement, blockId: 'rule-one', quote: '旧规则' }] },
    { id: 'n2', text: '连线依据', target: { type: 'flow-edge', flowId: 'main', edgeId: 'edge1' }, requirements: [] }] },
    [paths[1]]: { revision: 1, notes: [] },
  };
  const design = { revision: 7, pages: [{ id: 'page1', name: '订单详情', html: '<h1>订单详情</h1>' }] };
  const flowReads = [];
  const context = createAiContext({ root, getTree: () => ({ modules: [{ features: entries }] }),
    flowStore: { read: async p => { flowReads.push(p); return { workspace: flows[p] }; }, catalog: async () => ({ flows: Object.entries(flows).flatMap(([p, w]) => w.flows.map(f => ({ ...f, entryPath: p }))), issues: [] }) },
    annotationStore: { read: async p => ({ workspace: notes[p] }) },
    designStore: { read: async () => ({ workspace: design }) },
    readDocument: async (e, file) => ({ content: `最新正文 ${file}`, revision: 9, updatedAt: '2026-10-26' }) });
  const readUrl = url => { const u = new URL(url, 'http://workbench'); return context.read(u.pathname.split('/').at(-1), u.searchParams); };
  return { root, paths, entries, context, flows, notes, design, readUrl, flowReads };
}

test('reads recursive cross-requirement children once, preserves notes, linked rules, pages and business data', async t => {
  const f = fixture(t), overview = await f.context.read('context', new URLSearchParams({ path: f.paths[0], flow: 'main' }));
  assert.deepEqual(overview.flows.map(x => x.id).sort(), ['child', 'main', 'refund']);
  assert.equal(overview.coverage.complete, true);
  assert.equal(overview.coverage.discoveredFlowCount, 3);
  assert.equal(overview.documents.length, 3); // Includes the rule's source outside the flow graph.
  assert.equal(overview.materials.length, 1);
  const main = await f.readUrl(overview.flows.find(x => x.id === 'main').url);
  assert.equal(main.notes.length, 2);
  assert.equal(main.notes[0].requirements[0].blockId, 'rule-one');
  assert.equal(main.flow.edges[0].trace, 'proposal');
  assert.equal((await f.readUrl(overview.sources[0].pages[0].url)).page.html, '<h1>订单详情</h1>');
  assert.equal((await f.readUrl(overview.materials[0].url)).content.order, 'test');
  assert.match((await f.readUrl(overview.documents[0].url)).content, /最新正文/);
});

test('follows shared cross-requirement module calls recursively and reports broken call targets', async t => {
  const f = fixture(t), [orders, refunds, rules] = f.paths;
  const call = (entryPath, flowId, targetNodeId) => ({ entryPath, flowId, nodeId: 'input',
    returns: [{ outputNodeId: 'output', targetNodeId }] });
  const main = f.flows[orders].flows[0];
  main.nodes.push({ id: 'review', type: 'step', label: '复核后继续' },
    { id: 'close-call', type: 'call', label: '关单退款', call: call(refunds, 'shared-refund', 'end') },
    { id: 'manual-call', type: 'call', label: '人工退款核验', call: call(refunds, 'shared-refund', 'review') });
  f.flows[orders].references = [];
  const shared = { id: 'shared-refund', kind: 'module', name: '公共退款', parent: null,
    nodes: [{ id: 'input', type: 'input' }, { id: 'check-call', type: 'call', call: call(rules, 'fund-check', 'output') },
      { id: 'output', type: 'output' }], edges: [] };
  f.flows[refunds] = { revision: 3, references: [], flows: [shared,
    { id: 'unselected-caller', nodes: [{ id: 'other-call', type: 'call', call: call(refunds, 'shared-refund', 'other-call') }], edges: [] }] };
  f.flows[rules] = { revision: 4, references: [], flows: [{ id: 'fund-check', kind: 'module', name: '资金核验', parent: null,
    nodes: [{ id: 'input', type: 'input' }, { id: 'output', type: 'output' }], edges: [] }] };
  f.notes[rules] = { revision: 1, notes: [] };

  const params = new URLSearchParams({ path: orders });
  const overview = await f.context.read('context', params);
  assert.deepEqual(overview.flows.map(flow => flow.id).sort(), ['fund-check', 'main', 'shared-refund']);
  assert.equal(overview.coverage.complete, true);
  assert.equal(overview.coverage.discoveredFlowCount, 3);
  assert.deepEqual(f.flowReads, [orders, refunds, rules]);
  const module = overview.flows.find(flow => flow.id === 'shared-refund');
  assert.equal(module.kind, 'module');
  assert.equal(module.parent, null);
  assert.deepEqual(module.callers, [
    { entryPath: orders, flowId: 'main', nodeId: 'close-call' },
    { entryPath: orders, flowId: 'main', nodeId: 'manual-call' },
  ]);
  assert.equal(module.calls[0].call.flowId, 'fund-check');
  assert.deepEqual(overview.flows.find(flow => flow.id === 'main').calls.map(item => item.call.returns[0].targetNodeId), ['end', 'review']);
  assert.deepEqual((await f.readUrl(module.url)).flow, shared);

  shared.nodes[1].call.nodeId = 'removed-input';
  shared.nodes[1].call.returns = [{ outputNodeId: 'removed-output', targetNodeId: 'removed-return' }];
  main.nodes.push({ id: 'missing-call', type: 'call', call: call(refunds, 'removed-module', 'end') },
    { id: 'outside-call', type: 'call', call: call('outside/不可读需求', 'private-module', 'end') });
  const incomplete = await f.context.read('context', params);
  assert.equal(incomplete.coverage.complete, false);
  assert.ok(incomplete.issues.some(issue => issue.nodeId === 'missing-call' && issue.target?.flowId === 'removed-module'));
  assert.ok(incomplete.issues.some(issue => issue.nodeId === 'check-call' && issue.target?.nodeId === 'removed-input'));
  assert.ok(incomplete.issues.some(issue => issue.outputNodeId === 'removed-output'));
  assert.ok(incomplete.issues.some(issue => issue.targetNodeId === 'removed-return'));
  assert.ok(incomplete.issues.some(issue => issue.nodeId === 'outside-call'));
  assert.equal(f.flowReads.includes('outside/不可读需求'), false);
});

test('stale flow, note, page and material URLs fail instead of mixing versions', async t => {
  const f = fixture(t), overview = await f.context.read('context', new URLSearchParams({ path: f.paths[0] }));
  const url = overview.flows.find(x => x.id === 'main').url;
  f.flows[f.paths[0]].revision++;
  await assert.rejects(f.readUrl(url), { status: 409 });
  f.flows[f.paths[0]].revision--;
  f.notes[f.paths[0]].revision++;
  await assert.rejects(f.readUrl(url), { status: 409 });
  await assert.rejects(f.readUrl(overview.sources[0].annotationsUrl), { status: 409 });
  f.design.revision++;
  await assert.rejects(f.readUrl(overview.sources[0].pages[0].url), { status: 409 });
  fs.writeFileSync(path.join(f.root, f.paths[0], '核验数据.json'), '{}');
  await assert.rejects(f.readUrl(overview.materials[0].url), { status: 409 });
  const documentUrl = new URL(overview.documents[0].url, 'http://local');
  documentUrl.searchParams.set('fingerprint', 'old-document');
  await assert.rejects(f.readUrl(documentUrl), { status: 409 });
});

test('broken references and detached notes are reported while available data remains readable', async t => {
  const f = fixture(t);
  f.flows[f.paths[0]].references.push({ entryPath: 'missing/需求', flowId: 'missing' });
  f.notes[f.paths[0]].notes.push({ id: 'lost', target: { type: 'flow-node', flowId: 'removed', nodeId: 'x' }, text: '仍须保留', requirements: [] });
  const overview = await f.context.read('context', new URLSearchParams({ path: f.paths[0] }));
  assert.equal(overview.coverage.complete, false);
  assert.equal(overview.coverage.discoveredFlowCount, 4);
  assert.equal(overview.coverage.availableFlowCount, 3);
  assert.equal(overview.issues.length, 2);
  assert.equal((await f.readUrl(overview.sources[0].annotationsUrl)).notes.at(-1).text, '仍须保留');
});

test('AI routes are read-only and reject unknown requirements, hidden files and traversal', async t => {
  const f = fixture(t);
  await assert.rejects(f.context.read('context', new URLSearchParams({ path: '../outside' })), { status: 404 });
  for (const file of ['../../secret.json', `${f.paths[0]}/.private.json`, `${f.paths[0]}/元素说明.json`]) {
    await assert.rejects(f.context.read('material', new URLSearchParams({ path: f.paths[0], file })), { status: 404 });
  }
  let code;
  fs.symlinkSync(path.join(f.root, f.paths[0], '.private.json'), path.join(f.root, f.paths[0], 'link.json'));
  await assert.rejects(f.context.read('material', new URLSearchParams({ path: f.paths[0], file: `${f.paths[0]}/link.json` })), { status: 404 });
  await createAiHandler(f.context, (_, status) => { code = status; })({ method: 'PUT' }, {}, new URL('http://local/api/ai/context'));
  assert.equal(code, 405);
});

test('follows an independent recovery reference without a parent or synchronous call', async t => {
 const f=fixture(t),[orders,refunds]=f.paths;
 f.flows[orders].references=[];
 const recovery={entryPath:refunds,flowId:'timer',nodeId:'tick'};
 f.flows[orders].flows[0].nodes[1].recovery=recovery;
 f.flows[refunds]={revision:1,references:[],flows:[{id:'timer',name:'定时',parent:null,nodes:[{id:'tick',type:'event',eventType:'timer',eventPhase:'trigger'}],edges:[]}]};
 const overview=await f.context.read('context',new URLSearchParams({path:orders}));
 assert.deepEqual(overview.flows.map(x=>x.id).sort(),['main','timer']);
 const detail=await f.readUrl(overview.flows.find(x=>x.id==='main').url);
 assert.deepEqual(detail.flow.nodes[1].recovery,recovery);
 assert.deepEqual(f.flowReads.slice(0,2),[orders,refunds]);
});

test('follows ordinary cross-flow output to a common timer without a recovery field',async t=>{
 const f=fixture(t),[orders,refunds]=f.paths;
 f.flows[orders].references=[];
 f.flows[orders].flows[0].nodes[1]={id:'end',type:'output',target:{entryPath:refunds,flowId:'timer',nodeId:'tick'}};
 f.flows[refunds]={revision:1,references:[],flows:[{id:'timer',name:'通知定时',parent:null,nodes:[{id:'tick',type:'event',eventType:'timer',eventPhase:'trigger'}],edges:[]}]};
 const overview=await f.context.read('context',new URLSearchParams({path:orders}));
 assert.deepEqual(overview.flows.map(x=>x.id).sort(),['main','timer']);
 assert.equal(overview.coverage.complete,true);
});

test('AI flow detail retains structured input/return fields alongside routing and annotations', async t => {
  const f = fixture(t);
  const contract = { inputs: [{ id: 'task-id', name: 'id', type: 'Long', required: 'required', source: '原任务' }],
    outputs: [{ id: 'outcome', name: 'result', type: '目标返回分类', required: 'conditional', condition: '调用正常返回时', description: '不是订单终态' }] };
  f.flows[f.paths[0]].flows[0].nodes[0].contract = contract;
  const overview = await f.context.read('context', new URLSearchParams({ path: f.paths[0] }));
  const detail = await f.readUrl(overview.flows.find(x => x.id === 'main').url);
  assert.deepEqual(detail.flow.nodes[0].contract, contract);
  assert.equal(detail.notes.length, 2);
});
