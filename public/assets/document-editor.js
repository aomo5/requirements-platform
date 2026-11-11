export function createDocumentEditor({container,readView,editButton,historyButton,onStatus,onRead}){
  const area=document.createElement('textarea');area.className='document-editor-input';area.setAttribute('aria-label','文档内容');area.spellcheck=false;area.hidden=true;container.append(area);
  const notice=document.createElement('div');notice.className='document-editor-notice';notice.hidden=true;notice.innerHTML='<span role="status" aria-live="polite"></span><div><button class="button" data-retry>重试保存</button><button class="button" data-compare>对比最新内容</button><button class="button" data-download>下载草稿</button></div>';container.before(notice);
  const dialog=document.createElement('dialog');dialog.className='document-version-dialog';document.body.append(dialog);
  let data=null,text='',editing=false,timer=null,pending=null,error='',conflict=false,composing=false;
  const key=p=>'workbench.document.draft:'+p;
  const dirty=()=>!!data&&area.value!==text;
  function draft(){if(!data)return;try{if(dirty())localStorage.setItem(key(data.file),JSON.stringify({revision:data.revision,content:area.value}));else localStorage.removeItem(key(data.file));}catch{}}
  function status(){editButton.hidden=!data?.canEdit;historyButton.hidden=!data||!data.revision;editButton.textContent=editing?'完成':'编辑';notice.hidden=!error;notice.querySelector('span').textContent=error;notice.querySelector('[data-retry]').hidden=conflict;notice.querySelector('[data-compare]').hidden=!conflict;onStatus({editing,dirty:dirty(),saving:!!pending,error,revision:data?.revision});}
  async function api(route,body){const [endpoint,extra]=route.split('&');const r=await fetch('/api/document'+endpoint+'?path='+encodeURIComponent(data.entryPath||data.file.replace(/\/需求文档\.md$/,''))+'&file='+encodeURIComponent(data.file)+(extra?'&'+extra:''),body?{method:route==='/restore'?'POST':'PUT',headers:{'Content-Type':'application/json','X-Design-Client':'workbench-v1'},body:JSON.stringify(body)}:{});const p=await r.json();if(!r.ok)throw Object.assign(new Error(p.error||'文档保存失败'),{status:r.status});return p;}
  async function save(){if(!data||!dirty())return true;if(error||composing)return false;if(pending)return pending;
    const snapshot=area.value,expectedRevision=data.revision;
    pending=(async()=>{try{const saved=await api('',{expectedRevision,content:snapshot,editor:true});data={...data,...saved};text=saved.editorContent;if(area.value===snapshot)area.value=text;draft();return true}catch(e){error=e.message;conflict=e.status===409;draft();return false}finally{pending=null;status();if(dirty()&&!error&&!composing)timer=setTimeout(save,600)}})();status();return pending;
  }
  async function flush(){clearTimeout(timer);if(composing&&dirty())return false;while(pending||dirty()){if(pending){if(!await pending)return false}else if(!await save())return false;}return !error;}
  function begin(){if(!data?.canEdit)return;editing=true;area.hidden=false;readView.hidden=true;area.focus({preventScroll:true});area.setSelectionRange(0,0);area.scrollTop=0;status();}
  editButton.addEventListener('click',async()=>{if(!editing){begin();return}if(!await flush())return;editing=false;area.hidden=true;readView.hidden=false;status();await onRead();});
  area.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer)});
  area.addEventListener('compositionend',()=>{composing=false;draft();status();if(!error)timer=setTimeout(save,600)});
  area.addEventListener('input',()=>{draft();status();clearTimeout(timer);if(!composing&&!error)timer=setTimeout(save,600)});
  notice.querySelector('[data-retry]').addEventListener('click',()=>{error='';conflict=false;void save();});
  notice.querySelector('[data-download]').addEventListener('click',()=>{const u=URL.createObjectURL(new Blob([area.value],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=u;a.download=data.file.split('/').pop().replace(/\.md$/,'-未保存草稿.md');a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)});
  notice.querySelector('[data-compare]').addEventListener('click',async()=>{
    try{const latest=await api('');dialog.innerHTML='<div class="dialog-heading"><h2>核对文档更新</h2></div><div class="document-compare"><label>当前草稿<textarea readonly aria-label="当前草稿"></textarea></label><label>最新已保存内容<textarea readonly aria-label="最新已保存内容"></textarea></label></div><p class="document-dialog-error" role="alert"></p><div class="dialog-actions"><button class="button" data-back>返回编辑</button><button class="button button-primary primary" data-use>保存当前草稿</button></div>';dialog.querySelector('[aria-label="当前草稿"]').value=area.value;dialog.querySelector('[aria-label="最新已保存内容"]').value=latest.editorContent;dialog.querySelector('[data-back]').onclick=()=>dialog.close();dialog.querySelector('[data-use]').onclick=async()=>{data={...data,...latest};text=latest.editorContent;error='';conflict=false;dialog.close();await save()};dialog.showModal();}catch(e){error=e.message;status()}
  });
  historyButton.addEventListener('click',async()=>{
    if(!await flush())return;
    try{const result=await api('/versions');dialog.innerHTML='<div class="dialog-heading"><h2>文档历史</h2></div><label for="documentVersionSelect">版本</label><select id="documentVersionSelect"></select><textarea class="document-history-content" readonly aria-label="历史文档内容"></textarea><p class="document-dialog-error" role="alert"></p><div class="dialog-actions"><button class="button" data-close>关闭</button><button class="button button-primary primary" data-restore>恢复此版本</button></div>';const select=dialog.querySelector('select'),restore=dialog.querySelector('[data-restore]');for(const v of result.versions)select.append(new Option('版本 '+v.revision+' · '+new Date(v.updatedAt).toLocaleString(),v.revision));let token=0;const load=async()=>{const id=++token;restore.disabled=true;try{const old=await api('/version&revision='+select.value);if(id!==token)return;dialog.querySelector('textarea').value=old.editorContent;restore.disabled=!data.canEdit||Number(select.value)===data.revision}catch(e){dialog.querySelector('[role=alert]').textContent=e.message}};
      // Query version uses the same path endpoint with an additional parameter.
      select.onchange=load;dialog.querySelector('[data-close]').onclick=()=>dialog.close();restore.hidden=!data.canEdit;restore.onclick=async()=>{restore.disabled=true;try{const saved=await api('/restore',{expectedRevision:data.revision,revision:Number(select.value)});data={...data,...saved};text=saved.editorContent;area.value=text;draft();dialog.close();editing=false;area.hidden=true;readView.hidden=false;status();await onRead()}catch(e){dialog.querySelector('[role=alert]').textContent=e.message;restore.disabled=false}};dialog.showModal();await load();
    }catch(e){error=e.message;status()}
  });
  function mount(payload,{startEditing=false}={}){clearTimeout(timer);data=payload?.storage==='mysql'?payload:null;editing=false;error='';conflict=false;text=data?.editorContent||'';area.value=text;area.hidden=true;readView.hidden=false;
    if(data?.canEdit){try{const stored=JSON.parse(localStorage.getItem(key(data.file))||'null');if(stored&&stored.content!==text){area.value=stored.content;if(stored.revision!==data.revision){error='已恢复本机草稿；文档已有更新，请对比后保存。';conflict=true}startEditing=true}}catch{}}
    status();if(startEditing)begin();if(editing&&dirty()&&!error)timer=setTimeout(save,600);
  }
  return {mount,flush,isDirty:()=>dirty()||!!pending,getStatus:()=>({editing,dirty:dirty(),saving:!!pending,error}),focus:()=>{if(editing)area.focus();else readView.focus({preventScroll:true})}};
}
