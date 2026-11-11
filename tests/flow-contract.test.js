"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateContent, createFlowStore } = require('../lib/flow-store');
const { createBundle, applyOperations, checkBundle, diffBundle, payloadForApply } = require('../lib/flow-edit-model');
const { MysqlStorage } = require('../lib/mysql-storage');
const topic = '00-测试/节点参数';
const contract = () => ({ inputs: [{ id: 'task-id', name: 'id', type: 'Long', required: 'required', source: '原通知记录', description: '原通知任务 ID' },
  { id: 'status', name: 'status', type: 'Integer', required: 'conditional', condition: '读取成功时', source: '锁内读取' }],
  outputs: [{ id: 'status', name: 'result', type: '目标结果分类', required: 'required', description: '本轮结果，不是订单终态' }] });
const workspace = () => ({ schemaVersion: 1, revision: 1, updatedAt: null, applicability: 'needed', reason: '', references: [],
  flows: [{ id: 'main', name: '通知', description: '', parent: null, nodes: [{ id: 'task', type: 'step', label: '核对通知', x: 0, y: 0, pageId: '' }], edges: [] }] });
const notes = () => ({ schemaVersion: 1, revision: 0, updatedAt: null, notes: [] });
function withContract(value) { const w = workspace(); w.flows[0].nodes[0].contract = value; return w; }

test('contract is optional, bounded and normalized without losing row identity or contextual fields', () => {
  assert.equal(validateContent(workspace(), topic).flows[0].nodes[0].contract, undefined);
  assert.equal(validateContent(withContract({ inputs: [], outputs: [] }), topic).flows[0].nodes[0].contract, undefined);
  assert.deepEqual(validateContent(withContract(contract()), topic).flows[0].nodes[0].contract, contract());
  const spaced = contract(); spaced.inputs[0].name = ' id '; spaced.inputs[0].type = ' Long ';
  assert.deepEqual(validateContent(withContract(spaced), topic).flows[0].nodes[0].contract, contract());
});

test('storage and CLI reject malformed or unknown contract data instead of dropping it', () => {
  const invalid = [null, [], { inputs: null }, { inputs: [], unknown: true }];
  for (const mutate of [
    c => c.inputs.push({ ...c.inputs[0] }),
    c => { c.inputs[0].id = ''; },
    c => { c.inputs[0].name = ' '; },
    c => { c.inputs[0].type = ''; },
    c => { c.inputs[0].required = true; },
    c => { delete c.inputs[1].condition; },
    c => { c.inputs[0].unknown = 'not silently dropped'; },
    c => { c.inputs[0].source = {}; },
    c => { c.inputs[0].description = 'x'.repeat(2001); },
    c => { c.inputs = Array.from({ length: 51 }, (_, i) => ({ ...c.inputs[0], id: `field-${i}` })); },
  ]) { const c = contract(); mutate(c); invalid.push(c); }
  for (const c of invalid) {
    assert.throws(() => validateContent(withContract(c), topic));
    const b = createBundle('http://127.0.0.1:8125', topic, workspace(), notes());
    b.draft.workspace.flows[0].nodes[0].contract = c;
    assert.ok(checkBundle(b).errors.length > 0);
  }
});

test('CLI patch/check/diff/apply payload preserves a contract and supports explicit removal', () => {
  const source = createBundle('http://127.0.0.1:8125', topic, workspace(), notes());
  const edited = applyOperations(source, [{ op: 'node.update', flowId: 'main', id: 'task', set: { contract: contract() } }]);
  assert.deepEqual(checkBundle(edited).errors, []);
  const diff = diffBundle(edited);
  assert.deepEqual(diff.changed, { flows: true, annotations: false });
  assert.equal(diff.changes[0].field, 'contract');
  const payload = payloadForApply(edited);
  assert.deepEqual(payload.workspace.flows[0].nodes[0].contract, contract());
  assert.deepEqual(edited.base, source.base);
  const removed = applyOperations(edited, [{ op: 'node.update', flowId: 'main', id: 'task', unset: ['contract'] }]);
  assert.equal(removed.draft.workspace.flows[0].nodes[0].contract, undefined);
});

test('file store save/read/history and both catalogs retain structured contracts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, topic), { recursive: true });
  const entry = { path: topic, feature: '节点参数' };
  const store = createFlowStore(root, p => p === topic ? entry : null, () => [entry]);
  store.save(topic, 0, withContract(contract()));
  assert.deepEqual(store.read(topic).workspace.flows[0].nodes[0].contract, contract());
  assert.deepEqual(store.catalog().flows[0].nodes[0].contract, contract());
  store.save(topic, 1, workspace());
  store.restore(topic, 2, 1);
  assert.deepEqual(store.read(topic).workspace.flows[0].nodes[0].contract, contract());
  const db = Object.create(MysqlStorage.prototype);
  db.pool = { query: async () => [[{ path: topic, payload: withContract(contract()) }]] };
  assert.deepEqual((await db.store('flow').catalog()).flows[0].nodes[0].contract, contract());
});

const assets = path.join(__dirname, '../public/assets');
const toUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const textUrl = toUrl(fs.readFileSync(path.join(assets, 'flow-text.js'), 'utf8'));
const geometryUrl = toUrl(fs.readFileSync(path.join(assets, 'flow-geometry.js'), 'utf8').replace("'./flow-text.js'", JSON.stringify(textUrl)));
const formatUrl = pathToFileURL(path.join(assets, 'flow-mermaid-format.mjs')).href;
const mermaid = import(toUrl(fs.readFileSync(path.join(assets, 'flow-mermaid.js'), 'utf8').replaceAll('"./flow-mermaid-format.mjs"', JSON.stringify(formatUrl)).replace('"./flow-geometry.js"', JSON.stringify(geometryUrl))));

test('Mermaid fresh import and source edits preserve contracts on every node shape', async () => {
  const { serializeMermaid, parseMermaid } = await mermaid;
  const flow = withContract(contract()).flows[0];
  const text = serializeMermaid(flow);
  assert.match(text, /%% workbench-contract /);
  assert.deepEqual(parseMermaid(text).nodes[0].contract, contract());
  assert.deepEqual(parseMermaid('flowchart TD\ntask[修改名称]', flow).nodes[0].contract, contract());
  const reserved = { ...flow, nodes: [{ ...flow.nodes[0], id: 'end', type: 'end' }] };
  assert.deepEqual(parseMermaid(serializeMermaid(reserved), reserved).nodes[0].contract, contract());
  assert.throws(() => parseMermaid(text + '\n%% workbench-contract ' + JSON.stringify({ id: 'absent', contract: contract() })), /不存在/);
  assert.throws(() => parseMermaid(text + '\n%% workbench-contract ' + JSON.stringify({ id: 'task', contract: contract() })), /重复/);
  const malformed = contract(); malformed.inputs[1].condition = '';
  assert.throws(() => parseMermaid('flowchart TD\ntask[节点]\n%% workbench-contract ' + JSON.stringify({ id: 'task', contract: malformed })), /条件/);
});
