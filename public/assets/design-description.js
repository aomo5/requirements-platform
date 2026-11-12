// Page specifications live in the design workspace, alongside their stable page IDs.
export function createDesignDescriptions({state,selected,api,dirty,flush,render,toast}) {
  const $=id=>document.getElementById(id);
  let target='', opening=0;
  const dialog=$('descriptionDialog'),body=$('descriptionBody'),editor=$('descriptionEditor');
  const owner=page=>page?.descriptionPageId?state.workspace.pages.find(p=>p.id===page.descriptionPageId):page;
  function update(){
    const page=selected(),actual=state.workspace.pages.find(p=>p.id===page?.id),source=owner(actual);
    $('designOverviewButton').disabled=!state.entry||state.busy;
    $('pageDescriptionSettings').hidden=!actual||state.selection.length>1;
    $('pageDescriptionSummary').textContent=source?.description?.trim().replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[`*_]/g,'').replace(/^#+\s*/gm,'').slice(0,180)||'尚未填写页面说明';
    $('pageDescriptionSource').hidden=!actual?.descriptionPageId;
    $('pageDescriptionSource').textContent=actual?.descriptionPageId?'共用：'+(source?.name||'') : '';
    $('pageDescriptionButton').textContent=source?.description?'查看说明':state.editable?'填写说明':'查看说明';
    $('pageDesignStatus').value=actual?.status||'designed';
    $('pageDesignStatus').disabled=!state.editable||state.busy;
  }
  async function open(pageId=''){
    if(!await flush())return;
    const page=pageId?state.workspace.pages.find(p=>p.id===pageId):null;
    if(pageId&&!page){toast('页面已移除，请在版本记录查看原说明',true);return;}
    target=pageId;const request=++opening;
    $('descriptionTitle').textContent=page?`${page.name} · 页面说明`:'设计说明';
    editor.hidden=true;body.hidden=false;body.textContent='正在读取…';
    $('descriptionEdit').hidden=!state.editable;$('descriptionSave').hidden=true;
    $('descriptionError').textContent='';dialog.showModal();
    try{const data=await api('/description'+(pageId?'?page='+encodeURIComponent(pageId):''));if(request!==opening)return;
      body.innerHTML=data.html||'<p class="muted">尚未填写说明。</p>';
    }catch(e){body.textContent=e.message;}
  }
  $('designOverviewButton').onclick=()=>open();
  $('pageDescriptionButton').onclick=()=>open(selected()?.id||'');
  $('descriptionEdit').onclick=()=>{
    const page=target?state.workspace.pages.find(p=>p.id===target):null;
    editor.value=(target?owner(page)?.description:state.workspace.overview)||'';
    editor.maxLength=target?80000:160000;editor.hidden=false;body.hidden=true;
    $('descriptionEdit').hidden=true;$('descriptionSave').hidden=false;editor.focus();
  };
  $('descriptionSave').onclick=async()=>{
    const button=$('descriptionSave');button.disabled=true;
    try{
      if(!state.editable||state.conflict)throw new Error('请先处理保存冲突，再保存说明');
      if(target){const page=owner(state.workspace.pages.find(p=>p.id===target));if(!page)throw new Error('页面已移除');page.description=editor.value.trim();}
      else state.workspace.overview=editor.value.trim();
      dirty();render();if(!await flush())throw new Error(state.saveError||'说明尚未保存，请保留当前内容后重试');
      dialog.close();toast('说明已保存');
    }catch(e){$('descriptionError').textContent=e.message;}finally{button.disabled=false;}
  };
  $('pageDesignStatus').onchange=event=>{const page=state.workspace.pages.find(p=>p.id===selected()?.id);if(!page||!state.editable)return;page.status=event.target.value;dirty();render();};
  dialog.addEventListener('close',()=>{opening++;editor.value='';});
  async function history(file){
    const request=++opening;target='';$('descriptionTitle').textContent='页面说明历史';
    $('descriptionEdit').hidden=true;$('descriptionSave').hidden=true;editor.hidden=true;body.hidden=false;body.textContent='正在读取…';$('descriptionError').textContent='';dialog.showModal();
    try{
      const data=await api('/documents?file='+encodeURIComponent(file));if(request!==opening)return;
      $('descriptionTitle').textContent=data.name+' · 版本记录';body.replaceChildren();
      if (!data.versions.length) {
        if (data.html) body.innerHTML = data.html;
        else body.textContent = '暂无版本记录';
        return;
      }
      const select=document.createElement('select');select.setAttribute('aria-label','历史说明版本');
      for(const v of data.versions)select.append(new Option(`版本 ${v.revision} · ${new Date(v.updatedAt).toLocaleString('zh-CN',{hour12:false})}`,v.revision));
      const content=document.createElement('div');content.className='description-history-content';body.append(select,content);
      let sequence=0;
      async function show(){const n=++sequence;content.textContent='正在读取…';try{const v=await api('/documents?'+new URLSearchParams({file,revision:select.value}));if(n===sequence&&request===opening)content.innerHTML=v.html;}catch(e){if(n===sequence)content.textContent=e.message;}}
      select.onchange=show;await show();
    }catch(e){body.textContent=e.message;}
  }
  async function historyList(container){
    const {documents: docs}=await api('/documents');if(!docs.length)return;
    const title=document.createElement('h3');title.textContent='旧页面说明';container.append(title);
    for(const doc of docs){const row=document.createElement('div');row.className='version-row';const label=document.createElement('span');label.textContent=doc.name;const button=document.createElement('button');button.textContent='查看记录';button.onclick=()=>history(doc.file);row.append(label,button);container.append(row);}
  }
  return {update,open,history,historyList};
}
