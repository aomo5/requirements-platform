// Injected into the disposable sandbox only. The overlay never enters source HTML.
export function elementEditorBridge(config) {
  const records = new Map(config.records.map(item => [item.id, item]));
  const send = (type, data = {}) => parent.postMessage({ channel: 'element-edit-v1', token: config.token, type, ...data }, '*');
  const attr = 'data-wb-element';
  let selected = null, hover = null, layer, outline, hoverOutline, editor, editing = null, composing = false, scheduled = false, sizeObserver, measurement = '';
  const lookup = id => {
    if (!records.has(id)) return null;
    const nodes = document.querySelectorAll(`[${attr}="${id}"]`);
    return nodes.length === 1 && nodes[0].tagName.toLowerCase() === records.get(id).tag ? nodes[0] : null;
  };
  const idOf = node => node?.getAttribute(attr);
  const label = node => (node?.getAttribute('aria-label') || node?.getAttribute('alt') || node?.textContent || node?.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 64);
  function kind(node) {
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return '标题';
    if (['button','a','img','svg','main','header','nav','aside','table','tr','td'].includes(tag)) return {button:'按钮',a:'链接',img:'图片',svg:'图标',main:'主内容',header:'页头',nav:'导航',aside:'侧栏',table:'表格',tr:'行',td:'单元格'}[tag];
    if (/(^|[-_ ])(card|panel)([-_ ]|$)/i.test(node.getAttribute('class') || '')) return '卡片';
    if (Array.from(node.childNodes).some(n => n.nodeType === 3 && n.nodeValue.trim())) return '文字';
    return ['section','article'].includes(tag) ? '区块' : '容器';
  }
  function target(node) {
    if (!(node instanceof Element)) return null;
    if (node.closest('svg')) node = node.closest('button,a,[role="button"]') || node.closest('svg');
    // Do not turn a dynamic child into an editable static ancestor silently.
    return lookup(idOf(node));
  }
  function slots(node) {
    return (records.get(idOf(node))?.texts || []).filter(slot => node.childNodes[slot.index]?.nodeType === 3 && node.childNodes[slot.index].nodeValue === slot.text);
  }
  function report() {
    if (!selected?.isConnected) { selected = null; measurement = ''; send('selected', { element: null }); return; }
    const computed = getComputedStyle(selected), parents = [];
    let parentNode = selected;
    while (parentNode && parentNode !== document.body) {
      if (lookup(idOf(parentNode))) parents.unshift({ id: idOf(parentNode), tag: parentNode.tagName.toLowerCase(), kind: kind(parentNode), label: label(parentNode) });
      parentNode = parentNode.parentElement;
    }
    const r = selected.getBoundingClientRect();
    measurement = `${idOf(selected)}:${Math.round(r.width)}:${Math.round(r.height)}`;
    send('selected', { element: { id: idOf(selected), tag: selected.tagName.toLowerCase(), kind: kind(selected), label: label(selected), parents,
      texts: slots(selected), hasOwnText: Array.from(selected.childNodes).some(n => n.nodeType === 3 && n.nodeValue.trim()), computed: Object.fromEntries(config.properties.map(key => [key, computed.getPropertyValue(key)])),
      width: Math.round(r.width), height: Math.round(r.height) } });
  }
  function paintOne(node, box) {
    if (!box) return;
    if (!node?.isConnected) { box.hidden = true; return; }
    const r = node.getBoundingClientRect(); box.hidden = !r.width || !r.height;
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  function positionEditor() {
    if (!editing || !selected?.isConnected) return;
    const r = selected.getBoundingClientRect();
    Object.assign(editor.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${Math.max(40,r.width)}px`, height: `${Math.max(28,r.height)}px` });
    editor.style.height = `${Math.max(28,r.height,Math.min(editor.scrollHeight,Math.max(80,innerHeight-r.top-8)))}px`;
  }
  function paint() {
    scheduled = false; paintOne(selected, outline); paintOne(hover === selected ? null : hover, hoverOutline); positionEditor();
    if (selected?.isConnected) {
      const r = selected.getBoundingClientRect();
      if (measurement !== `${idOf(selected)}:${Math.round(r.width)}:${Math.round(r.height)}`) report();
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(paint); } }
  function select(node) { finishText(true); selected = node; hover = null; sizeObserver?.disconnect(); if (selected) sizeObserver?.observe(selected); report(); schedule(); }
  function finishText(commit) {
    if (!editing) return;
    const value = editor.value, item = editing; editing = null; editor.hidden = true;
    if (commit && value !== item.text) send('text', { id: item.id, index: item.index, expected: item.text, value });
    send('draft-clear');
  }
  function beginText() {
    if (!selected) return;
    const texts = slots(selected);
    if (texts.length !== 1 || selected.children.length) { send('focus-text'); return; }
    const slot = texts[0], css = getComputedStyle(selected), backgrounds = [];
    // Reproduce the visible background under transparent text, including dark
    // buttons and cards; the editing surface must not turn white text invisible.
    for (let node = selected; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') backgrounds.push(style.backgroundImage);
      const color = style.backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') backgrounds.push(`linear-gradient(${color},${color})`);
    }
    editing = { id: idOf(selected), ...slot }; editor.value = slot.text; editor.hidden = false;
    Object.assign(editor.style, { fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, fontStyle: css.fontStyle,
      letterSpacing: css.letterSpacing, lineHeight: css.lineHeight, color: css.color, textAlign: css.textAlign, borderRadius: css.borderRadius,
      backgroundColor: '#fff', backgroundImage: backgrounds.join(',') || 'none' });
    for (const side of ['Top','Right','Bottom','Left']) editor.style[`padding${side}`] = `${parseFloat(css[`padding${side}`]) + parseFloat(css[`border${side}Width`])}px`;
    positionEditor();
    editor.focus(); editor.select();
  }
  // Capture on window before prototype handlers, so design clicks cannot submit,
  // navigate, alter a simulated state, or change business input values.
  for (const name of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','contextmenu','submit','dragstart']) {
    window.addEventListener(name, event => {
      if (event.composedPath().includes(editor)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (name === 'pointerdown' && event.button === 0) {
        const node = target(event.target);
        if (node) select(node); else { select(null); send('unavailable'); }
      }
      if (name === 'click') { const node = target(event.target); if (node && node !== selected) select(node); }
      if (name === 'dblclick') beginText();
    }, true);
  }
  window.addEventListener('wheel', event => {
    if (event.composedPath().includes(editor) && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    send('navigate', { dx: event.deltaX * unit, dy: event.deltaY * unit, zoom: event.ctrlKey || event.metaKey, x: event.clientX, y: event.clientY });
  }, { capture: true, passive: false });
  window.addEventListener('pointermove', event => { if (!editing) { hover = target(event.target); schedule(); } }, true);
  document.addEventListener('pointerleave', () => { hover = null; schedule(); });
  window.addEventListener('keydown', event => {
    if (editing) {
      if (event.isComposing || composing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); finishText(true); send('save'); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finishText(false); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); finishText(true); }
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    const key = event.key.toLowerCase(), mod = event.metaKey || event.ctrlKey;
    if (mod && ['z','y'].includes(key)) send('history', { direction: key === 'y' || event.shiftKey ? 'redo' : 'undo' });
    else if (mod && key === 's') send('save');
    else if (key === 'escape') { if (selected) select(null); else send('exit'); }
    else if (key === 'enter') beginText();
    else if (key === 'tab') send('focus-inspector');
    else if (key === 'arrowup' && selected) select(target(selected.parentElement) || selected);
  }, true);
  window.addEventListener('message', event => {
    const msg = event.data;
    if (event.source !== parent || msg?.channel !== 'element-edit-v1' || msg.token !== config.token) return;
    if (msg.type === 'select') { select(lookup(msg.id)); if (selected && msg.scroll) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    if (msg.type === 'patch') {
      finishText(false);
      const node = lookup(msg.id);
      if (node && msg.patch.kind === 'text') {
        const child = node.childNodes[msg.patch.index];
        if (child?.nodeType === 3 && child.nodeValue === msg.patch.expected) child.nodeValue = msg.patch.value;
      }
      if (node && msg.patch.kind === 'style') { if (msg.patch.value) node.style.setProperty(msg.patch.property, msg.patch.value, 'important'); else node.style.removeProperty(msg.patch.property); }
      const record = records.get(msg.id);
      if (record && msg.texts) record.texts = msg.texts;
      report(); schedule();
    }
    if (msg.type === 'flush') { finishText(true); send('flushed', { request: msg.request }); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const host = document.createElement('div'); host.style.cssText = 'position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
    host.setAttribute('data-element-editor-overlay', '');
    layer = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = '[hidden]{display:none!important} div{position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #0d99ff} .hover{border-width:1px} textarea{position:fixed;box-sizing:border-box;border:0;outline:2px solid #0d99ff;outline-offset:0;resize:none;pointer-events:auto;min-width:0;margin:0;box-shadow:0 2px 8px #0002}'; layer.append(style);
    outline = document.createElement('div'); hoverOutline = document.createElement('div'); hoverOutline.className = 'hover';
    editor = document.createElement('textarea'); editor.hidden = true; editor.setAttribute('aria-label', '编辑选中文字');
    editor.addEventListener('compositionstart', () => composing = true); editor.addEventListener('compositionend', () => composing = false);
    editor.addEventListener('input', () => { if (editing) { positionEditor(); send('draft', { id: editing.id, index: editing.index, expected: editing.text, value: editor.value }); } });
    editor.addEventListener('blur', () => finishText(true));
    layer.append(hoverOutline, outline, editor); document.documentElement.append(host);
    new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
    sizeObserver = new ResizeObserver(schedule);
    selected = lookup(config.selectedId); if (selected) sizeObserver.observe(selected); schedule(); report(); send('ready');
  }, { once: true });
}
