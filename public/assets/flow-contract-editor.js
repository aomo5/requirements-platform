import { CONTRACT_LIMITS, requirementLabels, validateContractRow, cleanContractRow, contractRelations } from './flow-contracts.mjs';
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createContractEditor(host) {
  const panel = document.getElementById('nodeContractFields');
  const dialog = document.createElement('dialog'); dialog.id = 'contractParameterDialog'; dialog.setAttribute('aria-labelledby','contractParameterTitle');
  dialog.innerHTML = `<form id="contractParameterForm"><div class="dialog-heading"><h2 id="contractParameterTitle">参数</h2><button type="button" data-contract-close class="icon-button" aria-label="关闭参数编辑" title="关闭参数编辑">×</button></div><div class="contract-editor-grid"><label>字段名<input id="contractName" name="name" maxlength="120" required autocomplete="off"></label><label>类型<input id="contractType" name="type" maxlength="120" required autocomplete="off" list="contractTypeOptions"></label></div><datalist id="contractTypeOptions"><option value="String"><option value="Long"><option value="Integer"><option value="Boolean"><option value="LocalDateTime"><option value="Object"><option value="Array"></datalist><label>必需性<select id="contractRequired" name="required"><option value="required">必需</option><option value="optional">可选</option><option value="conditional">条件必需</option></select></label><label id="contractConditionField">条件<textarea id="contractCondition" name="condition" rows="2" maxlength="1000"></textarea></label><label>来源／取值<textarea id="contractSource" name="source" rows="2" maxlength="1000"></textarea></label><label>含义<textarea id="contractDescription" name="description" rows="3" maxlength="2000"></textarea></label><p id="contractParameterError" class="form-error" role="alert"></p><div class="dialog-actions"><span id="contractParameterState" role="status">更改自动保存</span><button id="contractDiscardDraft" type="button">取消新建</button><button type="submit" class="primary">完成</button></div></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), error = dialog.querySelector('#contractParameterError');
  let editing = null, composing = false;
  const detail = document.createElement('dialog'); detail.id = 'contractParameterDetail'; detail.setAttribute('aria-labelledby','contractParameterDetailTitle');
  detail.innerHTML = `<div class="dialog-heading"><h2 id="contractParameterDetailTitle">参数详情</h2><button type="button" class="icon-button" data-detail-close aria-label="关闭参数详情" title="关闭参数详情">×</button></div><dl id="contractParameterDetailContent"></dl><div class="dialog-actions"><button type="button" id="contractParameterDetailEdit">编辑</button><button type="button" class="primary" data-detail-close>完成</button></div>`;
  document.body.append(detail);
  let detailContext = null;
  for(const button of detail.querySelectorAll('[data-detail-close]'))button.addEventListener('click',()=>detail.close());
  detail.querySelector('#contractParameterDetailEdit').addEventListener('click',()=>{
    const target=detailContext,ctx=host.context();if(!target||ctx.path!==target.path||ctx.flow.id!==target.flowId||ctx.node?.id!==target.nodeId)return;
    detail.close();host.beginEditing();open(target.direction,target.rowId);
  });
  function showDetail(direction,rowId){
    const ctx=host.context(),row=ctx.node?.contract?.[direction]?.find(item=>item.id===rowId);if(!row)return;
    detailContext={path:ctx.path,flowId:ctx.flow.id,nodeId:ctx.node.id,direction,rowId};
    detail.querySelector('#contractParameterDetailTitle').textContent=row.name;
    detail.querySelector('#contractParameterDetailContent').innerHTML=[['类型',row.type],['必需性',requirementLabels[row.required]],['条件',row.condition],['来源／取值',row.source],['含义',row.description]].filter(([,value])=>value).map(([name,value])=>`<dt>${html(name)}</dt><dd>${html(value)}</dd>`).join('');
    detail.querySelector('#contractParameterDetailEdit').hidden=!ctx.canEdit;
    detail.showModal();
  }
  detail.addEventListener('close', () => {
    const target = detailContext, ctx = host.context();
    detailContext = null;
    if (!target || dialog.open || target.path !== ctx.path || target.flowId !== ctx.flow?.id || target.nodeId !== ctx.node?.id) return;
    panel.querySelector(`[data-direction="${target.direction}"][data-contract-row="${CSS.escape(target.rowId)}"] .contract-field-trigger`)?.focus({preventScroll:true});
  });
  const draftKey = ctx => `contractEditor:${ctx.flowId}:${ctx.nodeId}:${ctx.direction}:${ctx.rowId}`;
  const owner = () => editing && host.getNode(editing.flowId, editing.nodeId, editing.path);
  const persistedRow = () => owner()?.contract?.[editing.direction]?.find(row => row.id === editing.rowId);
  const values = () => ({id:editing.rowId, ...Object.fromEntries(['name','type','required','condition','source','description'].map(key => [key,form.elements.namedItem(key).value]))});
  function stash(row, message) {
    host.setDraft(draftKey(editing), {control:'contractEditor',kind:'node',flowId:editing.flowId,itemId:editing.nodeId,direction:editing.direction,rowId:editing.rowId,value:JSON.stringify(row),error:message,composing});
  }
  function update() {
    if (!editing || !owner() || !host.canEdit(editing.path)) return false;
    const row = values(), message = validateContractRow(row);
    const next = cleanIfValid(row, message);
    if (message || composing) {
      stash(row,message || '请完成正在输入的文字。'); error.textContent = message;
      dialog.querySelector('#contractParameterState').textContent = '未完成输入已保留';
    } else {
      host.removeDraft(draftKey(editing));
      const rows = owner().contract?.[editing.direction] || [];
      if (!rows.some(item => item.id === row.id) && rows.length >= CONTRACT_LIMITS.rows) {
        const limit = '每组最多 50 个参数。'; stash(row,limit); error.textContent = limit; return false;
      }
      const current = persistedRow();
      if (!current || JSON.stringify(cleanContractRow(current)) !== JSON.stringify(next)) host.commit(editing, next);
      error.textContent = ''; dialog.querySelector('#contractParameterState').textContent = '更改自动保存';
    }
    dialog.querySelector('#contractConditionField').hidden = row.required !== 'conditional';
    form.elements.namedItem('condition').required = row.required === 'conditional';
    dialog.querySelector('#contractDiscardDraft').textContent = persistedRow() ? '撤销未完成输入' : '取消新建';
    dialog.querySelector('#contractDiscardDraft').hidden = !!persistedRow() && !host.getDraft(draftKey(editing));
    return !message && !composing;
  }
  function cleanIfValid(row,message) { return message ? null : cleanContractRow(row); }
  function open(direction, rowId = '', pending = null) {
    const ctx = host.context(); if (!ctx.node || !ctx.editable) return;
    const row = ctx.node.contract?.[direction]?.find(item => item.id === rowId);
    if (!row && !pending && (ctx.node.contract?.[direction]?.length || 0) >= CONTRACT_LIMITS.rows) { host.notify('每组最多 50 个参数。'); return; }
    editing = {path:ctx.path,flowId:ctx.flow.id,nodeId:ctx.node.id,direction,rowId:rowId || host.newId()};
    const savedDraft = pending || host.getDraft(draftKey(editing));
    let value = row || {id:editing.rowId,name:'',type:'',required:'required'};
    if (savedDraft) { try { value = JSON.parse(savedDraft.value); } catch { host.notify('参数草稿无法读取，原数据已保留。'); return; } }
    for (const name of ['name','type','required','condition','source','description']) form.elements.namedItem(name).value = value[name] || (name === 'required' ? 'required' : '');
    dialog.querySelector('#contractParameterTitle').textContent = `${row ? '编辑' : '新增'}${direction === 'inputs' ? '输入' : '返回'}参数`;
    dialog.querySelector('#contractConditionField').hidden = value.required !== 'conditional';
    form.elements.namedItem('condition').required = value.required === 'conditional';
    error.textContent = savedDraft?.error || '';
    dialog.querySelector('#contractParameterState').textContent = savedDraft ? '未完成输入已保留' : '更改自动保存';
    dialog.querySelector('#contractDiscardDraft').hidden = !!row && !savedDraft;
    dialog.querySelector('#contractDiscardDraft').textContent = row ? '撤销未完成输入' : '取消新建';
    if (!row && !savedDraft) stash(value,'请填写字段名和类型。');
    if (!dialog.open) dialog.showModal(); form.elements.namedItem('name').focus();
  }
  form.addEventListener('input',update); form.addEventListener('change',update);
  form.addEventListener('compositionstart',()=>{composing=true;update();}); form.addEventListener('compositionend',()=>{composing=false;update();});
  form.addEventListener('submit',event=>{event.preventDefault();if(update())dialog.close();});
  dialog.querySelector('[data-contract-close]').addEventListener('click',()=>dialog.close());
  dialog.querySelector('#contractDiscardDraft').addEventListener('click',()=>{if(editing)host.removeDraft(draftKey(editing));dialog.close();render();});
  dialog.addEventListener('close',()=>{editing=null;composing=false;render();});
  panel.addEventListener('click',event=>{
    const button = event.target.closest('button');
    const field = event.target.closest('tr[data-contract-row]');
    if (field && (!button || button.classList.contains('contract-field-trigger'))) {
      field.querySelector('.contract-field-trigger').focus({preventScroll:true});
      showDetail(field.dataset.direction, field.dataset.contractRow);
      return;
    }
    if (!button) return;
    if(button.dataset.contractAdd)open(button.dataset.contractAdd);
    if(button.dataset.contractEdit)open(button.dataset.direction,button.dataset.contractEdit);
    if(button.dataset.contractResume){const draft=host.getDraft(button.dataset.contractResume);if(draft){host.beginEditing();open(draft.direction,draft.rowId,draft);}}
    if(button.dataset.contractRemove){const ctx=host.context();if(ctx.editable)host.remove(ctx.flow.id,ctx.node.id,button.dataset.direction,button.dataset.contractRemove);}
    if(button.dataset.contractNavigate){try{host.navigate(JSON.parse(button.dataset.contractNavigate));}catch{host.notify('关联不可用。');}}
  });
  function fieldRow(row, direction, editable) {
    const id = html(row.id), name = html(row.name);
    const actions = editable ? `<div class="contract-row-actions"><button type="button" data-contract-edit="${id}" data-direction="${direction}" aria-label="编辑${name}">编辑</button><button type="button" data-contract-remove="${id}" data-direction="${direction}" aria-label="删除${name}">删除</button></div>` : '';
    return `<tr data-contract-row="${id}" data-direction="${direction}"><td><button class="contract-field-trigger" type="button" aria-haspopup="dialog" aria-controls="contractParameterDetail">${name}</button>${actions}</td><td>${html(row.type)}</td><td>${html(requirementLabels[row.required] || row.required)}</td></tr>`;
  }
  function render() {
    const ctx = host.context(); panel.hidden = !ctx.node;
    const sameOwner=target=>target && ctx.path===target.path && ctx.flow?.id===target.flowId && ctx.node?.id===target.nodeId;
    if(editing && (!sameOwner(editing) || !ctx.editable)) { editing=null;composing=false;if(dialog.open)dialog.close(); }
    if(detailContext && !sameOwner(detailContext)){detailContext=null;if(detail.open)detail.close();}
    if (!ctx.node) return;
    const drafts = host.drafts().filter(d => d.control === 'contractEditor' && d.flowId === ctx.flow.id && d.itemId === ctx.node.id);
    panel.innerHTML = ['inputs','outputs'].map(direction=>{
      const label=direction==='inputs'?'输入参数':'返回参数', rows=ctx.node.contract?.[direction] || [];
      return `<section id="contract-panel-${direction}" class="contract-section" aria-labelledby="contract-heading-${direction}"><div class="contract-heading"><h3 id="contract-heading-${direction}">${label}</h3>${ctx.editable?`<button type="button" data-contract-add="${direction}" ${rows.length>=CONTRACT_LIMITS.rows?'disabled':''}>新增参数</button>`:''}</div>${rows.length?`<table class="contract-table" aria-label="${label}"><thead><tr><th scope="col">字段</th><th scope="col">类型</th><th scope="col">必需性</th></tr></thead><tbody>${rows.map(row=>fieldRow(row,direction,ctx.editable)).join('')}</tbody></table>`:`<p class="contract-empty">暂无${label}</p>`}${drafts.filter(d=>d.direction===direction).map(d=>`<button class="contract-resume" type="button" data-contract-resume="${html(`contractEditor:${d.flowId}:${d.itemId}:${d.direction}:${d.rowId}`)}" ${!ctx.canEdit?'disabled':''}>继续填写未完成参数</button>`).join('')}</section>`;
    }).join('');
    const relations=contractRelations(ctx.flows,ctx.flow,ctx.node,ctx.callContext);
    if(relations.length)panel.innerHTML+=`<section class="contract-section contract-relations"><h3>来源与承接</h3><dl>${relations.map(item=>`<dt>${html(item.label)}</dt><dd>${item.available?`<button type="button" data-contract-navigate="${html(JSON.stringify(item.reference))}">${html(item.location)} ↗</button>`:html(item.location)}</dd>`).join('')}</dl></section>`;
    if(editing)for(const input of form.querySelectorAll('input,textarea,select,button[type="submit"]'))input.disabled=!host.canEdit(editing.path);
  }
  return {render,openDraft(draft){host.beginEditing();open(draft.direction,draft.rowId,draft);}};
}
