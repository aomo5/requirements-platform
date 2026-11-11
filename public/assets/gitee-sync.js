import {iconButton,statusIndicator} from './workbench-icons.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const diffText=(text,other)=>{const lines=new Set((other||'').split('\n'));return (text||'').split('\n').map(line=>`<span class="${line&&!lines.has(line)?'gitee-diff-change':''}">${esc(line)}\n</span>`).join('');};
const label={unlinked:'未关联',pending:'待同步',syncing:'同步中',synced:'已同步',failed:'失败',conflict:'冲突'};
export function createGiteeSyncUI({getPath,onChanged}){
  const dialog=document.createElement('dialog');dialog.className='gitee-dialog';dialog.setAttribute('aria-labelledby','giteeDialogTitle');document.body.append(dialog);
  let configDraft=null,preview=null,items=[],job=null,timer=null,opener=null,view='',busy=false,returnView='';
  async function api(route,body,method='POST'){
    const r=await fetch('/api/gitee'+route,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json','X-Design-Client':'workbench-v1'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const value=await r.json();if(!r.ok)throw new Error(value.error||'同步请求失败');return value;
  }
  function show(title,content,actions=''){
    dialog.innerHTML=`<header><h2 id="giteeDialogTitle">${esc(title)}</h2><button type="button" data-action="close">关闭</button></header><div class="gitee-body">${content}</div><p class="gitee-notice" role="status" aria-live="polite"></p><footer>${actions}</footer>`;
    iconButton(dialog.querySelector('[data-action="close"]'),'close','关闭');
    if(!dialog.open){opener=document.activeElement;dialog.showModal();}
  }
  function notice(text,error=false){const n=dialog.querySelector('.gitee-notice');n.textContent=text;n.classList.toggle('error',error);}
  function close(){if(busy)return;saveDraft();clearTimeout(timer);dialog.close();opener?.focus();}
  function saveDraft(){if(view==='config'&&dialog.querySelector('form'))configDraft={...configDraft,...Object.fromEntries(new FormData(dialog.querySelector('form')))};}
  function input(name,title,value,type='text'){return `<label>${title}<input name="${name}" type="${type}" value="${esc(value)}" ${type==='password'?'autocomplete="new-password"':''}></label>`;}
  async function settings(){if(view&&view!=='config')returnView=view;view='config';const c=await api('/config');const draft=configDraft||c;configDraft={...draft,revision:c.revision};
    show('设置 · Gitee 同步',`<form class="gitee-config">${input('apiBase','平台 API 地址',draft.apiBase)}<div class="gitee-grid">${input('enterpriseId','企业编号',draft.enterpriseId)}${input('enterprisePath','企业空间',draft.enterprisePath)}${input('programId','项目编号',draft.programId)}${input('programName','项目名称',draft.programName)}${input('issueTypeId','需求类型编号（可选）',draft.issueTypeId)}</div>${input('token',c.credentialConfigured?'企业 API 凭据（留空保留已保存凭据）':'企业 API 凭据',draft.token||'','password')}<p class="text-secondary">凭据仅保存在服务器。测试连接只读取企业与项目；写权限以实际同步结果为准。</p><div id="giteeConnection"></div></form>`,` ${returnView?'<button class="button" data-action="return">返回同步</button>':''}<button data-action="discover" class="button">查询企业编号</button><button data-action="test" class="button">保存并测试连接</button><button data-action="save" class="button primary">保存配置</button>`);
  }
  async function save(){saveDraft();const c=await api('/config',{...configDraft,revision:configDraft.revision},'PUT');configDraft=null;await settings();return c;}
  async function single(p=getPath()){
    if(!p)throw new Error('请先选择需求');view='single';preview=null;
    const r=(await api('/items')).items.find(r=>r.path===p);if(!r)throw new Error('需求不存在');
    show('Gitee 同步',`<h3>${esc(r.title)}</h3><p id="giteeRowState">${esc(label[r.state])}${r.ident?' · '+esc(r.ident):''}${r.lastSuccessAt?' · 最近成功 '+esc(new Date(r.lastSuccessAt).toLocaleString()):''}</p><p class="gitee-error">${esc(r.error)}</p><div class="gitee-link">${input('ident','Gitee 需求编号',r.ident||'')}<button class="button" data-action="link">关联</button></div><div id="giteeComparison"></div>`,`<button class="button" data-action="settings">同步配置</button><button class="button" data-action="batch">批量同步</button><button class="button primary" data-action="preview">${r.state==='failed'?'重试并查看差异':'查看同步差异'}</button>`);
    dialog.dataset.path=p;
  }
  async function compare(){preview=await api('/preview',{path:dialog.dataset.path});
    dialog.querySelector('#giteeRowState').textContent=`${label[preview.state]}${preview.ident?' · '+preview.ident:''}`;
    const c=dialog.querySelector('#giteeComparison');
    c.innerHTML=`<p>${esc({create:'尚未关联，可新建远端需求或关联已有编号。',conflict:'本地与远端存在差异，请选择同步方向。',push:'本地正文已变化。',pull:'远端正文、评论或状态已变化。',none:'内容与最近成功基线一致。'}[preview.action])}</p><div class="gitee-diff"><section><h3>本地规格 · ${esc(preview.local.title)}</h3><pre>${diffText(preview.local.body||'（暂无正文）',preview.remote?.body)}</pre></section><section><h3>远端原文${preview.remote?' · '+esc(preview.remote.title):''}</h3><pre>${diffText(preview.remote?.body||'（未关联）',preview.local.body)}</pre></section></div>${preview.remote?`<details><summary>远端评论（${preview.remote.comments.length}）与版本</summary><p>${esc(preview.remote.version)}</p><pre>${esc(preview.remote.comments.map(c=>`${c.author?.name||''} · ${c.updated_at||c.created_at}\n${c.content}`).join('\n\n')||'暂无评论')}</pre></details>`:''}${preview.createIntent?'<p class="gitee-error">上次新建结果未知。请先核对 Gitee 并关联已有编号，避免重复需求。</p>':''}`;
    dialog.querySelector('footer').innerHTML=`<button class="button" data-action="preview">重新比较</button>${preview.ident?'<button class="button" data-direction="pull">拉取原文归档</button><button class="button" data-direction="push">推送本地规格</button>':`<button class="button primary" data-direction="create" ${preview.createIntent?'disabled':''}>新建远端需求</button>`}${preview.action==='none'?'<button class="button primary" data-direction="auto">同步状态</button>':''}`;
    notice('拉取保留本地规格及元素编号；推送会替换远端标题和描述，远端原文与评论先归档。');
  }
  async function execute(direction){
    notice('同步中…');dialog.querySelector('#giteeRowState').textContent='同步中';
    const result=await api('/sync',{path:dialog.dataset.path,direction,review:preview.review});
    await single(dialog.dataset.path);notice(result.error||label[result.state],['failed','conflict'].includes(result.state));await onChanged();
  }
  async function batch(){view='batch';job=(await api('/jobs/latest')).job;items=(await api('/items')).items;renderBatch();if(job?.state==='running')poll();}
  function renderBatch(){
    show('批量同步',`<div class="gitee-batch-tools"><label><input id="giteePending" type="checkbox" checked>仅待同步</label><button class="button" data-action="select">选择可同步项</button></div><div id="giteeProgress" role="status"></div><div class="gitee-table-wrap"><table class="gitee-table"><thead><tr><th><span class="sr-only">选择</span></th><th>需求</th><th>同步状态</th><th>结果</th></tr></thead><tbody>${items.map(i=>`<tr data-state="${i.state}"><td><input type="checkbox" name="paths" value="${esc(i.path)}" aria-label="选择 ${esc(i.title)}" ${!i.ident?'disabled':''}></td><td><button class="gitee-row-link" data-path="${esc(i.path)}">${esc(i.title)}</button><small>${esc(i.ident||'未关联')}</small></td><td>${esc(label[i.state])}</td><td>${esc(i.error||'')}</td></tr>`).join('')}</tbody></table><p id="giteeEmpty" hidden>暂无待同步项</p></div>`,`<button class="button" data-action="settings">同步配置</button><button class="button" data-action="check-remote">检查远端变化</button><button class="button" data-action="batch">刷新状态</button><button class="button primary" data-action="start-job">同步所选</button>`);
    filter();renderProgress();
  }
  function filter(){const pending=dialog.querySelector('#giteePending')?.checked;dialog.querySelectorAll('tr[data-state]').forEach(r=>r.hidden=!!pending&&r.dataset.state==='synced');const empty=dialog.querySelector('#giteeEmpty');if(empty)empty.hidden=!!dialog.querySelector('tr[data-state]:not([hidden])');}
  function renderProgress(){const n=dialog.querySelector('#giteeProgress');if(!n||!job)return;n.innerHTML=`<p>${job.state==='running'?(job.mode==='check'?'检查中':'同步中'):job.state==='done'?(job.mode==='check'?'检查完成':'批次完成'):'批次中断'} · ${job.done}/${job.total} · 批次 ${esc(job.id)}</p><progress value="${job.done}" max="${job.total}" aria-label="同步进度"></progress>${job.error?`<p>${esc(job.error)}</p>`:''}`;
    for(const result of job.results){const row=[...dialog.querySelectorAll('tr[data-state]')].find(r=>r.querySelector('input').value===result.path);if(row){row.dataset.state=result.state;row.cells[2].textContent=label[result.state];row.cells[3].textContent=result.error||(result.state==='synced'?'完成':label[result.state]);}}
    for(const b of dialog.querySelectorAll('[data-action="start-job"],[data-action="check-remote"]'))b.disabled=job.state==='running';
  }
  async function poll(){clearTimeout(timer);if(!dialog.open||view!=='batch'||!job)return;try{job=await api('/jobs/'+job.id);renderProgress();if(job.state==='running')timer=setTimeout(poll,800);else {if(job.mode==='check'){items=(await api('/items')).items;renderBatch();}await onChanged();}}catch(e){notice(e.message,true);}}
  async function open(action){try{await action();}catch(e){if(!dialog.open)show('Gitee 同步','',`<button class="button" data-action="settings">同步配置</button>`);notice(e.message,true);}}
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  dialog.addEventListener('change',e=>{if(e.target.id==='giteePending')filter();});
  dialog.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b||busy)return;const action=b.dataset.action;
    if(action==='close'){close();return;}
    busy=true;b.disabled=true;
    try{
      if(b.dataset.path)await single(b.dataset.path);
      else if(b.dataset.direction)await execute(b.dataset.direction);
      else if(action==='settings')await settings();
      else if(action==='return'){if(returnView==='batch')await batch();else await single(dialog.dataset.path);}
      else if(action==='save'){await save();notice('配置已保存');}
      else if(action==='test'){await save();notice('正在测试连接…');const r=await api('/test',{});notice(`${r.enterprise} / ${r.program}：${r.message}`);}
      else if(action==='discover'){saveDraft();const r=await api('/discover',{apiBase:configDraft.apiBase,token:configDraft.token});dialog.querySelector('#giteeConnection').textContent=r.enterprises.map(e=>`${e.name}：${e.id}`).join('；');if(r.enterprises.length===1){dialog.querySelector('[name=enterpriseId]').value=r.enterprises[0].id;dialog.querySelector('[name=enterprisePath]').value=r.enterprises[0].path;}}
      else if(action==='link'){await api('/link',{path:dialog.dataset.path,ident:dialog.querySelector('[name="ident"]').value});await single(dialog.dataset.path);await onChanged();}
      else if(action==='preview')await compare();
      else if(action==='batch')await batch();
      else if(action==='select')dialog.querySelectorAll('tr:not([hidden]) input:not(:disabled)').forEach(i=>i.checked=true);
      else if(action==='check-remote'){job=await api('/jobs',{paths:items.filter(i=>i.ident).map(i=>i.path),mode:'check'});renderProgress();poll();}
      else if(action==='start-job'){const paths=[...dialog.querySelectorAll('tr:not([hidden]) input:checked')].map(i=>i.value);job=await api('/jobs',{paths});renderProgress();poll();}
    }catch(e){notice(e.message,true);if(view==='single'&&action==='preview'){dialog.querySelector('#giteeRowState').textContent='失败';b.textContent='重试并查看差异';await onChanged();}}finally{busy=false;if(b.isConnected)b.disabled=['start-job','check-remote'].includes(b.dataset.action)&&job?.state==='running';}
  });
  document.getElementById('giteeSettingsButton').onclick=()=>{view='';returnView='';open(settings);};
  document.getElementById('giteeBatchButton').onclick=()=>open(batch);
  document.getElementById('giteeSyncButton').onclick=()=>open(()=>single());
  iconButton(document.getElementById('giteeSettingsButton'),'settings','设置');
  return {refresh:async()=>{try{const rows=(await api('/items')).items,r=rows.find(r=>r.path===getPath());const n=document.getElementById('giteeSyncState');statusIndicator(n,({unlinked:'unlink',pending:'history',syncing:'refresh',synced:'check',failed:'help',conflict:'help'})[r?.state]||'history',r?'Gitee：'+(label[r.state]||r.state):'',r?.error||(r?.lastSuccessAt?'最近同步：'+r.lastSuccessAt:''));n.classList.toggle('has-error',['failed','conflict'].includes(r?.state));document.getElementById('giteeSyncButton').disabled=!r;}catch{}}};
}
