import { icon, iconButton } from "./workbench-icons.js";
import { stateLabel } from './design-states.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const linkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></svg>';

export function createRequirementLinks({content, workspace, panel, onNavigate, onSelection}) {
  let context = null, notes = [], canEdit = false, active = null, generation = 0, lastFocus = null;
  let pageDetails = new Map(), detailsRequest = null, pickerOpen = false, loadError = '';
  const $ = id => panel.querySelector(`#${id}`);
  panel.innerHTML = `<header><h2>关联元素</h2><button id="rulePanelClose" type="button" class="icon-button" aria-label="关闭关联面板"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="rule-panel-body"><div id="ruleSource"></div><div id="ruleLinksStatus" role="status"></div><section><div class="rule-section-heading"><h3>已关联 <span id="ruleLinkCount"></span></h3><button id="ruleAddLink" type="button" aria-expanded="false" aria-controls="rulePageSection">关联元素</button></div><div id="ruleLinkedElements"></div></section><section id="rulePageSection" hidden><h3>选择页面</h3><label class="rule-page-search"><input id="rulePageSearch" type="search" placeholder="查找页面" aria-label="查找要关联的页面"></label><div id="rulePages"></div></section></div>`;
  iconButton(panel.querySelector('#rulePanelClose'), 'close', '关闭关联面板');
  const pageList = () => context?.entry?.design?.pages || [];
  const references = (note, rule) => (note.requirements || []).some(ref => ref.file === rule.file && ref.blockId === rule.blockId);
  const linked = rule => notes.filter(note => note.target.type === 'page-element' && references(note, rule));
  function close(restoreFocus = false) {
    panel.hidden = true; workspace.classList.remove('rule-panel-open');
    content.querySelectorAll('.rule-focused').forEach(el => el.classList.remove('rule-focused'));
    content.querySelectorAll('[data-link-rule]').forEach(el => el.setAttribute('aria-expanded', 'false'));
    active = null;
    if (restoreFocus && lastFocus?.isConnected) lastFocus.focus({preventScroll:true});
  }
  function reset() { generation++; context = null; notes = []; canEdit = false; pageDetails = new Map(); detailsRequest = null; loadError = ''; close(); }
  function renderMarkers() {
    for (const button of content.querySelectorAll('[data-link-rule]')) {
      const rule = context?.rules.find(item => item.blockId === button.dataset.linkRule);
      if (!rule) continue;
      const count = linked(rule).length;
      button.classList.toggle('has-links', count > 0);
      button.classList.add('wb-icon-button');
      button.innerHTML = icon('link') + (count ? `<span>${count}</span>` : '');
      button.dataset.tooltip = count ? `${count} 个关联元素` : '关联元素';
      if (rule.ambiguous) button.dataset.tooltip = '同章节存在相同内容，请先区分原文'; button.removeAttribute('title');
    }
  }
  function renderPages() {
    const query = $('rulePageSearch').value.trim().toLowerCase();
    const pages = pageList().filter(page => page.name.toLowerCase().includes(query));
    $('rulePages').innerHTML = pages.length ? pages.map(page => `<button class="rule-page-choice" type="button" data-link-page="${escape(page.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v18M19 3v18M3 5h18M3 19h18"/></svg><span>${escape(page.name)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>`).join('') : `<p class="rule-empty">${query ? '没有匹配的页面' : '暂无设计页面'}</p>${query ? '' : '<button class="button" type="button" data-open-design>打开设计画布</button>'}`;
  }
  function renderLinked() {
    if (!active) return;
    const focusId = document.activeElement?.dataset.openNote;
    const matches = linked(active);
    $('ruleLinkCount').textContent = matches.length;
    $('ruleLinkedElements').innerHTML = matches.length ? matches.map(note => {
      const page = pageList().find(item => item.id === note.target.pageId);
      const label = page ? `${page.name} · ${stateLabel(pageDetails.get(page.id) || page, note.target.route)}` : '页面已移除 · 关联保留';
      return `<button type="button" class="rule-linked-element" data-open-note="${escape(note.id)}" ${page ? '' : 'disabled'}><span class="rule-target-icon">${linkIcon}</span><span><strong>${escape(note.target.anchor.label || note.target.anchor.tag)}</strong><small>${escape(label)}</small>${note.text ? `<span class="rule-target-description">${escape(note.text)}</span>` : ''}</span></button>`;
    }).join('') : '<p class="rule-empty">暂无关联</p>';
    if (focusId) [...$('ruleLinkedElements').querySelectorAll('[data-open-note]')].find(el => el.dataset.openNote === focusId)?.focus({preventScroll:true});
  }
  // Read state names only when associations are opened; the directory remains lightweight.
  async function loadPageDetails() {
    if (detailsRequest || !context || !notes.some(note => note.target.type === 'page-element')) return;
    const request = generation, path = context.entry.path;
    detailsRequest = (async () => {
      try {
        const response = await fetch(`/api/design?${new URLSearchParams({path})}`, {cache:'no-store'});
        if (!response.ok) return;
        const result = await response.json();
        if (request !== generation) return;
        pageDetails = new Map((result.workspace?.pages || []).map(page => [page.id, page]));
        renderLinked();
      } catch { /* The saved route remains visible if state metadata is unavailable. */ }
    })();
    await detailsRequest;
  }
  function renderPicker() {
    const rule = context?.rules.find(item => item.blockId === active?.blockId && item.file === active.file);
    const allowed = canEdit && rule && !rule.ambiguous && rule.quote === active.quote;
    $('ruleAddLink').hidden = !allowed;
    $('ruleAddLink').setAttribute('aria-expanded', String(!!allowed && pickerOpen));
    iconButton($('ruleAddLink'),pickerOpen ? 'up' : 'plus',pickerOpen ? '收起页面选择' : '关联元素');
    $('rulePageSection').hidden = !allowed || !pickerOpen;
    if (allowed && pickerOpen) renderPages();
  }
  function renderPanel() {
    if (!active || !context) return;
    const rule = context.rules.find(item => item.blockId === active.blockId && item.file === active.file);
    $('ruleSource').innerHTML = `<span class="rule-source-heading">${escape(active.heading || '需求原文')}</span><blockquote>${escape(active.quote || '未找到原段落。请在需求中重新选择要关联的内容。')}</blockquote>`;
    $('ruleLinksStatus').textContent = loadError || (!rule ? '原文已变化，原有关联仍保留。请核对后重新选择需求段落。' : rule.ambiguous ? '同章节有相同内容，暂时无法唯一定位。请先区分原文。' : canEdit ? '' : '只读查看关联');
    renderLinked(); renderPicker();
  }
  function open(rule, {focus = true, scroll = false} = {}) {
    if (!context) return;
    active = rule; pickerOpen = linked(rule).length === 0;
    panel.hidden = false; workspace.classList.add('rule-panel-open');
    content.querySelectorAll('.rule-focused').forEach(el => el.classList.remove('rule-focused'));
    const block = [...content.querySelectorAll('[data-rule-id]')].find(el => el.dataset.ruleId === rule.blockId);
    lastFocus = block?.querySelector('[data-link-rule]') || document.activeElement;
    content.querySelectorAll('[data-link-rule]').forEach(el => el.setAttribute('aria-expanded', String(el === lastFocus)));
    if (block) { block.classList.add('rule-focused'); if (scroll) block.scrollIntoView({block:'center',behavior:'instant'}); }
    $('rulePageSearch').value = ''; renderPanel(); void loadPageDetails();
    onSelection?.(rule);
    if (focus) $('rulePanelClose').focus({preventScroll:true});
    else if (scroll) lastFocus?.focus({preventScroll:true});
  }
  async function mount({entry, file, rules = [], focusRule = ''}) {
    reset(); const request = generation;
    context = {entry, file, rules};
    if (!rules.length && !focusRule) return;
    for (const block of content.querySelectorAll('[data-rule-id]')) {
      const rule = rules.find(item => item.blockId === block.dataset.ruleId);
      if (!rule) continue;
      block.classList.add('requirement-rule');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'rule-link-trigger'; button.dataset.linkRule = rule.blockId; button.textContent = '关联元素';
      button.setAttribute('aria-label', `关联元素：${rule.quote.slice(0,50)}`); button.setAttribute('aria-expanded','false'); button.setAttribute('aria-controls',panel.id);
      (block.tagName === 'TR' ? block.lastElementChild : block).append(button);
    }
    try {
      const response = await fetch(`/api/annotations?${new URLSearchParams({path:entry.path})}`,{cache:'no-store'});
      const result = await response.json();
      if (request !== generation) return;
      if (!response.ok) throw new Error(result.error || '关联读取失败');
      notes = result.workspace.notes; canEdit = result.canEdit === true; renderMarkers();
      if (focusRule) {
        const rule = rules.find(item => item.blockId === focusRule) || notes.flatMap(note => note.requirements || []).find(ref => ref.file === file && ref.blockId === focusRule) || {file,blockId:focusRule,quote:'',heading:''};
        open(rule,{focus:false,scroll:true});
      }
      if (active) { renderPanel(); void loadPageDetails(); }
    } catch (error) {
      if (request !== generation) return;
      canEdit = false; loadError = `${error.message}。重新打开需求后重试。`;
      if (focusRule) open(rules.find(item => item.blockId === focusRule) || {file,blockId:focusRule,quote:'',heading:''},{focus:false});
      if (active) renderPanel();
    }
  }
  content.addEventListener('click', event => {
    const trigger = event.target.closest('[data-link-rule]');
    if (!trigger) return;
    event.preventDefault(); const rule = context?.rules.find(item => item.blockId === trigger.dataset.linkRule);
    if (rule) open(rule);
  });
  $('rulePanelClose').addEventListener('click', () => { close(true); onSelection?.(null); });
  $('rulePageSearch').addEventListener('input', renderPages);
  $('ruleAddLink').addEventListener('click', () => { pickerOpen = !pickerOpen; renderPicker(); if (pickerOpen) $('rulePageSearch').focus(); });
  panel.addEventListener('keydown', event => { if(event.key === 'Escape'){event.preventDefault();close(true);onSelection?.(null);} });
  panel.addEventListener('click', async event => {
    const pageButton = event.target.closest('[data-link-page]'), noteButton = event.target.closest('[data-open-note]');
    if ((!pageButton && !noteButton && !event.target.closest('[data-open-design]')) || !context || !active) return;
    const note = noteButton && notes.find(item => item.id === noteButton.dataset.openNote);
    const params = new URLSearchParams({path:context.entry.path,view:'design'});
    const pageId = pageButton?.dataset.linkPage || note?.target.pageId;
    if (pageId) params.set('prototype',`design:${pageId}`);
    if (note) params.set('note',note.id);
    if(pageButton || note) {params.set('rule',active.blockId);params.set('ruleFile',active.file);}
    await onNavigate(params.toString());
  });
  return {mount,reset,close};
}
