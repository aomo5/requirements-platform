const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/assets/flow-text.js'), 'utf8');
const text = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('wrapping keeps hard breaks, whole words and Unicode graphemes, and marks overflow', async () => {
  const { wrapText, measureText } = await text;
  assert.deepEqual(wrapText('第一行\n\n第三行', [180, 180, 180], 13).lines, ['第一行', '', '第三行']);
  assert.deepEqual(wrapText('Device fee payment', [80, 80, 80], 13).lines, ['Device fee', 'payment']);
  const label = '👨‍👩‍👧‍👦账户余额不足，请补足后继续', result = wrapText(label, [65, 65], 13);
  assert.equal(result.truncated, true); assert.ok(result.lines[0].startsWith('👨‍👩‍👧‍👦'));
  assert.ok(result.lines[1].endsWith('…'));
  for (const line of result.lines) assert.ok(measureText(line, 13) <= 65);
  const punctuation = wrapText('账户余额充足，继续扣费。', [78, 78, 78], 13);
  assert.ok(punctuation.lines.every(line => !/^[，。]/.test(line)));
  assert.equal(wrapText('第一行\n第二行\n第三行', [180, 180], 13).lines[1], '第二行…');
});
test('long text fits the actual shape and leaves space for the page association', async () => {
  const { nodeTextLayout, measureText } = await text;
  for (const [type, w, h] of [['step', 200, 68], ['decision', 180, 104], ['start', 144, 48], ['end', 144, 48]]) for (const pageId of ['', 'bills']) {
    const node = { type, pageId, label: '账户余额不足时，本租户所有汇付到账暂停，设备费用全部扣清后恢复。' .repeat(3) }, before = JSON.stringify(node);
    const result = nodeTextLayout(node, { w, h });
    assert.ok(result.truncated); assert.ok(result.lines.at(-1).endsWith('…'));
    result.lines.forEach((line, i) => {
      assert.ok(measureText(line, 13) <= result.lineWidths[i]);
      assert.ok(result.ys[i] - 6.5 >= 6 && result.ys[i] + 6.5 <= h - 6);
    });
    if (pageId) assert.ok(result.ys.at(-1) + 6.5 < result.pageY - 5.5);
    assert.equal(JSON.stringify(node), before);
  }
});
test('centered captions balance soft wraps without changing explicit line breaks', async () => {
  const { nodeTextLayout } = await text;
  const balanced = nodeTextLayout({ type: 'step', pageId: 'bills', label: '执行扣收，保留来源和账单分配' }, { w: 200, h: 68 });
  assert.equal(balanced.lines.join(''), '执行扣收，保留来源和账单分配');
  assert.ok(balanced.lines.every(line => line.length >= 5));
  const hardBreak = nodeTextLayout({ type: 'step', pageId: '', label: '第一行\n保留原有换行' }, { w: 200, h: 68 });
  assert.deepEqual(hardBreak.lines, ['第一行', '保留原有换行']);
});
test('edge label backgrounds enclose all lines and arrows stay proportionate', async () => {
  const { edgeTextLayout, measureText, arrowSize } = await text;
  const label = edgeTextLayout('余额不足\n保留原账户余额，等待下一次独立扣费后恢复到账');
  assert.equal(label.lines.length, 3); assert.equal(label.height, 56);
  assert.ok(label.lines.every(line => measureText(line, 12) <= label.width - 16));
  for (const scale of [.0001, .1, .25, .5, 1, 2, 2.5]) {
    assert.ok(arrowSize(scale) <= 16); assert.ok(arrowSize(scale) * scale <= 10);
  }
  assert.equal(arrowSize(1), 8);
});
