import { createPageId } from './design-model.js';
// Trusted workbench frames share one navigation shell. Prototype frames remain sandboxed.
const CHANNEL = 'requirements-workspace-v1';
const editorKeys = ['flow', 'flowSource', 'node', 'zoom', 'x', 'y', 'fromPath', 'fromFlow', 'fromSource', 'flowReturn', 'action', 'notes', 'note', 'rule', 'ruleFile', 'inspector', 'historyDocument'];
export function workspaceHashFromUrl(value, base = location.href) {
  let url; try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== location.origin) return null;
  if (url.pathname === '/') return url.hash.startsWith('#path=') || url.hash.includes('path=') ? url.hash.slice(1) : null;
  if (!['/design', '/flow'].includes(url.pathname)) return null;
  const params = new URLSearchParams(url.searchParams.get('return') || '');
  params.set('path', url.searchParams.get('path') || params.get('path') || '');
  params.set('view', url.pathname === '/design' ? 'design' : 'flow');
  params.delete('action'); params.delete('notes');
  if (url.searchParams.get('page')) params.set('prototype', `design:${url.searchParams.get('page')}`);
  for (const key of editorKeys) if (url.searchParams.has(key)) params.set(key, url.searchParams.get(key));
  return params.toString();
}
export function installWorkspaceBridge({kind, getState, flush, activate}) {
  const params = new URLSearchParams(location.search), embedded = params.get('shell') === '1' && window !== parent;
  if (!embedded) {
    if (window === parent && params.get('embed') !== '1' && params.get('standalone') !== '1') {
      const hash = workspaceHashFromUrl(location.href);
      if (hash) location.replace(`/#${hash}`);
    }
    return {notify() {}};
  }
  document.documentElement.classList.add('workspace-embedded');
  const token = params.get('shellToken');
  const send = (type, extra = {}) => parent.postMessage({channel:CHANNEL, token, kind, type, ...extra}, location.origin);
  let last = '';
  function notify(force = false) {
    const state = getState(), encoded = JSON.stringify(state);
    if (force || encoded !== last) { last = encoded; send('state', {state}); }
  }
  window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (event.source !== parent || event.origin !== location.origin || msg?.channel !== CHANNEL || msg.token !== token) return;
    if (msg.type === 'visible') { window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('workspace-visible')); notify(true); return; }
    if (msg.type === 'flush' || msg.type === 'activate') {
      let ok = false;
      try { ok = msg.type === 'flush' ? await flush() : activate ? await activate(msg.args || {}) : false; }
      catch { ok = false; }
      send('result', {requestId:msg.requestId, ok:ok === true}); notify(true);
    }
  });
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest('a[href]');
    if (!anchor || anchor.hasAttribute('download') || anchor.target === '_blank') return;
    const hash = workspaceHashFromUrl(anchor.href);
    if (hash === null) return;
    event.preventDefault(); event.stopImmediatePropagation(); send('navigate', {hash});
  }, true);
  send('ready'); notify(true);
  // Notes and modal state may change independently of the canvas model.
  const interval = setInterval(() => notify(), 400);
  window.addEventListener('pagehide', () => clearInterval(interval), {once:true});
  return {notify};
}
export function createWorkspaceHost({container, onState, onNavigate, onError}) {
  const frames = new Map(), requests = new Map();
  let active = '', counter = 0;
  const send = (frame, type, extra = {}) => frame.element.contentWindow?.postMessage({channel:CHANNEL,token:frame.token,type,...extra},location.origin);
  function request(frame, type, args) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++counter}`;
      const timer = setTimeout(() => { requests.delete(id); onError?.('工作区暂未响应，更改仍保留在当前页面。'); resolve(false); }, 15000);
      requests.set(id,{frame,resolve:(ok)=>{clearTimeout(timer); resolve(ok);}});
      send(frame,type,{requestId:id,args});
    });
  }
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.origin !== location.origin || msg?.channel !== CHANNEL) return;
    const frame = [...frames.values()].find((item)=>item.element.contentWindow===event.source && item.token===msg.token);
    if (!frame) return;
    if (msg.type === 'ready') { frame.ready = true; frame.resolveReady(true); }
    if (msg.type === 'state' && msg.state?.path === frame.path) { frame.state = msg.state; onState(frame.kind, msg.state); }
    if (msg.type === 'navigate' && typeof msg.hash === 'string') onNavigate(msg.hash);
    if (msg.type === 'result') { const task=requests.get(msg.requestId); if (task?.frame===frame) {requests.delete(msg.requestId);task.resolve(msg.ok===true);} }
  });
  async function waitReady(frame) {
    if (frame.ready) return true;
    return Promise.race([frame.readyPromise,new Promise(resolve=>setTimeout(()=>resolve(false),15000))]);
  }
  async function flushAll() {
    for (const frame of frames.values()) {
      if (!await waitReady(frame)) { onError?.('工作区仍在加载，请稍后再切换。'); return false; }
      if (!await request(frame,'flush')) { onError?.('更改尚未保存，请在当前工作区处理提示后重试。'); frame.element.classList.remove('hidden'); active=frame.kind; onState(frame.kind,{...frame.state,error:frame.state?.error || '更改尚未保存'}); return false; }
    }
    return true;
  }
  function remove(frame) { frame.element.remove(); frames.delete(frame.kind); }
  async function show(kind, args) {
    active=kind;
    for (const frame of frames.values()) frame.element.classList.toggle('hidden',frame.kind!==kind);
    let frame=frames.get(kind);
    if (frame && frame.path!==args.path) {remove(frame);frame=null;}
    if (frame) {
      frame.element.classList.remove('hidden');
      if (!await waitReady(frame)) return false;
      const targetChanged=kind==='design' ? args.pageId && args.pageId!==frame.state?.pageId : args.flowId && (args.flowId!==frame.state?.flowId || (args.sourcePath||args.path)!==(frame.state?.sourcePath||frame.path));
      const explicitContext = (kind === 'design' && (Object.hasOwn(args,'flowReturn') || frame.flowReturn)) || kind === 'flow' && ['node','zoom','x','y','fromPath','fromFlow','fromSource'].some(key => Object.hasOwn(args,key));
      if (targetChanged || args.action || args.notes || args.note || args.rule || args.inspector || args.historyDocument || explicitContext) {
        if (!await request(frame,'activate',{...args,nodeId:args.node || '',noteId:args.note || ''})) { if (!await request(frame,'flush')) return false; remove(frame); frame=null; }
      }
      if (frame) {frame.flowReturn=args.flowReturn||'';send(frame,'visible');onState(kind,frame.state||{});return true;}
    }
    const element=document.createElement('iframe'); element.className='workspace-editor-frame'; element.title=kind==='design'?'页面设计工作区':'流程设计工作区';
    element.setAttribute('referrerpolicy','same-origin');
    const token=createPageId(), query=new URLSearchParams({path:args.path,shell:'1',shellToken:token});
    if (kind==='design' && args.pageId) query.set('page',args.pageId);
    if (kind==='flow' && args.flowId) query.set('flow',args.flowId);
    if (args.sourcePath && args.sourcePath!==args.path) query.set('flowSource',args.sourcePath);
    for (const key of editorKeys) if (args[key]) query.set(key,String(args[key]));
    frame={kind,path:args.path,element,token,ready:false,state:null,flowReturn:args.flowReturn||''};
    frame.readyPromise=new Promise(resolve=>frame.resolveReady=resolve);
    frames.set(kind,frame);element.src=`/${kind}?${query}`;container.append(element);
    return true;
  }
  function hide() {active='';for(const frame of frames.values()) frame.element.classList.add('hidden');}
  function clearExcept(path) {for(const frame of frames.values()) if(frame.path!==path) remove(frame);}
  function dirty() {return [...frames.values()].some(frame=>frame.state?.dirty||frame.state?.saving);}
  return {show,hide,flushAll,clearExcept,isDirty:dirty,getState:kind=>frames.get(kind)?.state || null,getActive:()=>active};
}
