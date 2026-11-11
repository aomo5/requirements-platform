import { createPageId } from './design-model.js';
import { prepareElementSource, styleFields } from './element-source.js';
import { elementEditorBridge } from './element-editor-bridge.js';
import { icon, iconButton, controlHint } from './workbench-icons.js';

export function createElementEditor({ getPage, documentHtml, onPatch, onDraft, onNavigate, onExit, onHistory, onSave, toast }) {
  const $ = id => document.getElementById(id);
  let pageId = '', source = null, sourceHtml = '', frame = null, token = '', selection = null, selectedId = '', ready = false;
  const pending = new Map();
  const send = (type, data = {}) => frame?.contentWindow?.postMessage({ channel: 'element-edit-v1', token, type, ...data }, '*');
  const fields = new Map();
  iconButton($('elementLocate'), 'target', '定位选中元素');
  for (const [property, label, example] of styleFields) {
    const wrapper = document.createElement('div'), id = `element-${property}`, caption = document.createElement('label');
    wrapper.className = 'element-field';
    caption.htmlFor = id; caption.textContent = label;
    let input;
    const options = {
      'font-weight': [['100','极细'],['200','纤细'],['300','细体'],['400','常规'],['500','中等'],['600','半粗'],['700','加粗'],['800','特粗'],['900','黑体']],
      'text-align': [['left','左对齐'],['center','居中'],['right','右对齐'],['justify','两端对齐']],
      'border-style': [['none','无'],['solid','实线'],['dashed','虚线'],['dotted','点线']],
    }[property];
    if (options) { input = document.createElement('select'); input.add(new Option('继承','')); for (const [value,name] of options) input.add(new Option(name,value)); }
    else { input = document.createElement('input'); input.type = 'text'; input.placeholder = example; input.autocomplete = 'off'; input.spellcheck = false; }
    input.id = id; input.dataset.property = property; input.setAttribute('aria-label', label);
    const row = document.createElement('div'); row.className = 'element-value';
    let swatch;
    if (property.includes('color')) {
      wrapper.classList.add('element-field-wide'); row.classList.add('element-color-value');
      swatch = document.createElement('span'); swatch.className = 'element-swatch'; swatch.setAttribute('aria-hidden','true');
      row.append(swatch);
    }
    row.append(input);
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'element-reset';
    iconButton(reset, 'undo', `恢复${label}的页面样式`);
    const fieldError = document.createElement('p'); fieldError.id = `${id}-error`; fieldError.className = 'element-field-error'; fieldError.hidden = true; fieldError.setAttribute('role','alert');
    input.setAttribute('aria-describedby', fieldError.id);
    reset.onclick = () => {
      if (selection && apply({ kind: 'style', id: selection.id, property, value: '' })) {
        clearError(input); renderField(property);
      }
    };
    row.append(reset); wrapper.append(caption,row,fieldError);
    const section = property.startsWith('font') || ['line-height','color','text-align'].includes(property) ? 'elementTypography' : property.startsWith('padding') || ['gap','width','height'].includes(property) ? 'elementSpacing' : 'elementAppearance';
    $(section).append(wrapper); fields.set(property,{input,reset,swatch,wrapper,fieldError,label,example});
    input.addEventListener('change', () => commitStyle(input));
    input.addEventListener('blur', () => commitStyle(input));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); commitStyle(input); }
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); clearError(input); renderField(property); input.blur(); }
    });
  }
  $('elementTypography').insertBefore(fields.get('text-align').wrapper,fields.get('color').wrapper);
  function commitStyle(input) {
    if (!selection) return;
    if (input.value === input.dataset.displayValue) { clearError(input); return; }
    let value = input.value.trim();
    if (value && /^\d+(\.\d+)?$/.test(value) && !['font-weight','line-height'].includes(input.dataset.property)) value += 'px';
    if (apply({ kind: 'style', id: selection.id, property: input.dataset.property, value })) { clearError(input); input.value = value; input.dataset.displayValue = value; }
  }
  function ensureSource(page) {
    if (!source || sourceHtml !== page.html) { source = prepareElementSource(page.html); sourceHtml = page.html; }
    return source;
  }
  function clearError(input) {
    input?.removeAttribute('aria-invalid');
    const fieldError = input && document.getElementById(input.getAttribute('aria-describedby'));
    if (fieldError) { fieldError.hidden = true; fieldError.textContent = ''; }
    $('elementError').hidden = true;
  }
  function error(message, input) {
    if (input) {
      input.setAttribute('aria-invalid','true');
      const fieldError = document.getElementById(input.getAttribute('aria-describedby'));
      fieldError.textContent = message; fieldError.hidden = false;
      input.closest('details')?.setAttribute('open','');
    } else { $('elementError').textContent = message; $('elementError').hidden = false; }
  }
  function invalidInput() { return $('elementProperties').querySelector('[aria-invalid="true"]'); }
  function focusInvalid() {
    const input = invalidInput();
    if (!input) return false;
    input.closest('details')?.setAttribute('open',''); input.focus();
    toast('请修正输入，或按 Esc 取消本次修改',true); return true;
  }
  function draft(patch) {
    const page = getPage(); if (!page || page.id !== pageId) return;
    try { const copy = prepareElementSource(ensureSource(page).serialize()); const changed = copy.text(patch.id,patch.index,patch.expected,patch.value); onDraft(pageId, changed ? copy.serialize() : null); } catch {}
  }
  function apply(patch) {
    const page = getPage(); if (!page || page.id !== pageId) return false;
    ensureSource(page);
    try {
      const changed = patch.kind === 'text' ? source.text(patch.id,patch.index,patch.expected,patch.value) : source.style(patch.id,patch.property,patch.value);
      if (!changed) { if(patch.kind === 'text') onDraft(pageId,null); clearError(fields.get(patch.property)?.input); return true; }
      const html = source.serialize();
      if (html.length > 600000) throw new Error('页面内容超过保存上限，请缩短文字');
      sourceHtml = html; onDraft(pageId,null); onPatch(pageId, html);
      send('patch',{id:patch.id,patch,texts:source.describe(patch.id)?.texts});
      clearError(fields.get(patch.property)?.input);
      return true;
    } catch (err) {
      // Rebuild after a rejected edit; do not leave a mutated parsing document.
      source = null; ensureSource(page);
      const field = fields.get(patch.property);
      error(field && err.message.startsWith('请输入有效样式') ? `${field.label}无效，例如 ${field.example}` : err.message, field?.input); return false;
    }
  }
  function displayedValue(property, value) {
    if (property.includes('color')) {
      const rgba = value.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:[, /]+([\d.]+))?\s*\)$/);
      if (rgba && Number(rgba[4]) === 0) return 'transparent';
      if (rgba && (!rgba[4] || Number(rgba[4]) === 1)) return '#' + rgba.slice(1,4).map(n=>Number(n).toString(16).padStart(2,'0')).join('');
    }
    return value;
  }
  function renderField(property, preserveInput = false) {
    const {input,reset,swatch,wrapper} = fields.get(property), original = source?.describe(selection?.id);
    if (!original || !selection) return;
    const local = original.styles[property] || '', computed = selection.computed[property] || '';
    reset.disabled = !local; wrapper.classList.toggle('has-local-style',!!local);
    if (swatch) swatch.style.setProperty('--element-color',computed || 'transparent');
    if (preserveInput) return;
    const value = displayedValue(property, local || computed);
    if (input.tagName === 'SELECT') {
      for (const option of [...input.options]) if (option.dataset.current) option.remove();
      if (value && ![...input.options].some(option=>option.value === value)) {
        const option = new Option(({start:'左对齐',end:'右对齐'}[value]) || value,value); option.dataset.current = 'true'; input.add(option);
      }
      input.options[0].textContent = '沿用页面';
    }
    input.value = value; input.dataset.displayValue = value;
  }
  function renderSelection(next) {
    const changed = selection?.id !== next?.id;
    if (changed && selection && invalidInput()) { send('select',{id:selection.id}); focusInvalid(); return; }
    selection = next; selectedId = next?.id || '';
    $('elementEmpty').hidden = !!next; $('elementProperties').hidden = !next;
    if (!next) { $('elementBreadcrumb').replaceChildren(); $('elementBreadcrumb').dataset.path = ''; return; }
    const original = source?.describe(next.id); if (!original) return;
    $('elementName').textContent = next.texts.length || ['按钮','链接','标题','图片','图标'].includes(next.kind) ? next.label || next.kind : next.kind || next.tag;
    $('elementKind').textContent = next.kind || next.tag;
    $('elementKind').hidden = $('elementName').textContent === $('elementKind').textContent;
    $('elementSize').textContent = `${next.width} × ${next.height}`;
    const crumbs = $('elementBreadcrumb');
    const path = (next.parents || []).map(item=>item.id).join('/');
    if (crumbs.dataset.path !== path) { crumbs.dataset.path = path; crumbs.replaceChildren();
    for (const item of next.parents || []) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = item.kind || item.tag; button.dataset.elementId = item.id;
      controlHint(button, `选择 ${item.kind || item.tag}：${item.label}`);
      button.setAttribute('aria-current',String(item.id === next.id)); button.onclick = () => send('select',{id:item.id,scroll:true});
      if (crumbs.childElementCount) { const separator = document.createElement('span'); separator.className = 'element-crumb-separator'; separator.innerHTML = icon('next'); crumbs.append(separator); }
      crumbs.append(button);
    }
    crumbs.scrollLeft = crumbs.scrollWidth;
    }
    for (const item of next.parents || []) controlHint(crumbs.querySelector(`[data-element-id="${item.id}"]`), `选择 ${item.kind || item.tag}：${item.label}`);
    if (changed || !$('elementTexts').contains(document.activeElement)) {
      $('elementTexts').replaceChildren();
      for (const [position,slot] of next.texts.entries()) {
        const label = document.createElement('label'), input = document.createElement('textarea');
        input.id = `element-text-${position}`; label.htmlFor = input.id; label.textContent = next.texts.length > 1 ? `文字 ${position+1}` : '文字';
        input.value = slot.text; input.rows = Math.min(5,Math.max(2,slot.text.split('\n').length)); input.maxLength = 10000; input.spellcheck = false;
        let expected = slot.text;
        const commit = () => { if (input.value !== expected && apply({kind:'text',id:next.id,index:slot.index,expected,value:input.value})) expected = input.value; };
        input.addEventListener('input',()=>draft({id:next.id,index:slot.index,expected,value:input.value}));
        input.addEventListener('change',commit);
        input.addEventListener('keydown',event=>{ if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();commit();} if(event.key==='Escape'){event.preventDefault();input.value=expected;onDraft(pageId,null);input.blur();} });
        $('elementTexts').append(label,input);
      }
    }
    $('elementTextUnavailable').hidden = !!next.texts.length || !next.hasOwnText;
    for (const [property,{input}] of fields) {
      renderField(property,!changed && (document.activeElement === input || input.getAttribute('aria-invalid') === 'true'));
    }
    if (changed) $('elementError').hidden = true;
  }
  $('finishElementEdit').addEventListener('click', () => void onExit());
  $('elementLocate').addEventListener('click', () => send('select',{id:selectedId,scroll:true}));
  $('elementProperties').addEventListener('submit', event => event.preventDefault());
  window.addEventListener('message', event => {
    const msg = event.data;
    if (!pageId || event.source !== frame?.contentWindow || msg?.channel !== 'element-edit-v1' || msg.token !== token) return;
    if (msg.type === 'selected') renderSelection(msg.element);
    if (msg.type === 'ready') ready = true;
    if (msg.type === 'text') apply({kind:'text',id:msg.id,index:msg.index,expected:msg.expected,value:msg.value});
    if (msg.type === 'draft') draft(msg);
    if (msg.type === 'draft-clear') onDraft(pageId,null);
    if (msg.type === 'navigate' && [msg.dx,msg.dy,msg.x,msg.y].every(Number.isFinite)) onNavigate(msg,frame.getBoundingClientRect());
    if (msg.type === 'history') onHistory(msg.direction === 'redo' ? 'redo' : 'undo');
    if (msg.type === 'save') void onSave();
    if (msg.type === 'exit') void onExit();
    if (msg.type === 'unavailable') toast('此处没有可编辑的静态元素，请选择文字、按钮或容器');
    if (msg.type === 'focus-text' || msg.type === 'focus-inspector') { const input = $('elementTexts').querySelector('textarea') || fields.get('font-size').input; input.focus(); input.select?.(); }
    if (msg.type === 'flushed') { pending.get(msg.request)?.(true); pending.delete(msg.request); }
  });
  return {
    get pageId() { return pageId; },
    open(page) { pageId = page.id; selectedId = ''; source = null; ensureSource(page); renderSelection(null); $('elementEditName').textContent = page.name; },
    close() { pageId = ''; frame = null; source = null; selection = null; selectedId = ''; ready = false; for (const done of pending.values()) done(false); pending.clear(); },
    mount(targetFrame, page) {
      frame = targetFrame; token = createPageId(); ready = false; ensureSource(page);
      const doc = new DOMParser().parseFromString(documentHtml({...page,html:source.serialize()}),'text/html');
      const config = {token,records:source.records(),properties:styleFields.map(([key])=>key),selectedId};
      const script = doc.createElement('script'); script.textContent = `(${elementEditorBridge.toString()})(${JSON.stringify(config).replace(/</g,'\\u003c')});`;
      // Install capture listeners before any prototype scripts run.
      const policy = doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]'); if (policy) policy.after(script); else doc.head.prepend(script);
      frame.srcdoc = `<!doctype html>\n${doc.documentElement.outerHTML}`;
    },
    async flush() {
      const input = document.activeElement;
      if ($('elementProperties').contains(input)) input.dispatchEvent(new Event('change'));
      if (focusInvalid()) return false;
      if (!pageId || !ready) return true;
      const request = createPageId();
      return new Promise(resolve => { const timer = setTimeout(()=>{pending.delete(request);toast('元素编辑尚未响应，请稍后重试',true);resolve(false);},2000);pending.set(request,result=>{clearTimeout(timer);resolve(result);});send('flush',{request}); });
    },
  };
}
