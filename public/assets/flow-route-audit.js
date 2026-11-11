import {icon} from './workbench-icons.js';

const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reviewNames={pending:'待核验',ok:'符合预期',issue:'发现问题',unsure:'待确认',stale:'待复核'};
const testNames={pending:'待实测',passed:'实测通过',failed:'实测失败',partial:'部分已测',incomplete:'证据待补'};
const badge=(name,text)=>`<span class="ra-status" data-status="${esc(name)}"><i></i>${esc(text)}</span>`;
const pageSize=10;
const defaults={view:'queue',mode:'all',entry:'',through:'',query:'',rule:'',status:'',review:'',test:''};
const countText=n=>n.length>12?`${n.charAt(0)}.${n.slice(1,3)} × 10^${n.length-1}`:BigInt(n).toLocaleString('zh-CN');
const selectOptions=(items,key,label,all)=>`<option value="">${esc(all)}</option>`+items.map(x=>`<option value="${esc(key(x))}">${esc(label(x))}</option>`).join('');
const linkKind={call:'调用模块',return:'逐级返回',expand:'展开阶段',handoff:'跨图交接',event:'等待事件'};
const stopNames={closed:'业务终点',open:'业务未闭环',wait:'等待接手',loop:'循环待续',local:'本次执行结束',benign:'本次处理完成',planned:'后续待实现',gap:'缺少承接',limited:'待继续分析',stopped:'流程已终止'};
const timeLabel=value=>value?new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';

export function createRouteAudit({dialog,trigger,returnButton,getContext,guard,locate,onHighlight,onVisibility}) {
  dialog.innerHTML=`<header class="ra-heading"><div><h2 id="routeAuditHeading">路线核验</h2><span data-el="context"></span></div><button type="button" class="icon-button" data-act="close" aria-label="关闭路线核验" title="关闭路线核验">${icon('close')}</button></header>
    <div class="ra-nav"><div role="tablist" aria-label="路线核验视图">${[['routes','路线清单'],['coverage','条件与缺口'],['history','我的记录']].map(([id,t])=>`<button role="tab" data-tab="${id}" aria-selected="${id==='routes'}">${t}</button>`).join('')}</div><span data-el="version"></span></div>
    <div data-el="notice" class="ra-notice" role="status" hidden></div>
    <div data-el="routes" class="ra-page">
      <div class="ra-work"><aside class="ra-master"><div class="ra-pickers"><select data-opt="view" aria-label="路线范围"><option value="queue">逐条核验清单</option><option value="all">全部图上组合</option></select><button data-act="filter" class="ra-filter" aria-expanded="false">筛选</button></div>
       <div class="ra-filters" data-el="filters" hidden><label>入口<select data-opt="entry"></select></label><label>经过流程<select data-opt="through"></select></label><label>实现范围<select data-opt="mode"><option value="all">含拟改方案</option><option value="current">仅现有实现</option></select></label><label>路线含有<select data-opt="status"><option value="">所有结果</option><option value="open">业务未闭环</option><option value="wait">等待接手</option><option value="gap">缺少承接</option><option value="loop">循环待续</option><option value="closed">业务终点</option></select></label><label data-personal>我的核验<select data-opt="review"><option value="">所有结论</option><option value="pending">待核验</option><option value="issue">发现问题</option><option value="unsure">待确认</option><option value="stale">版本变化待复核</option><option value="ok">符合预期</option></select></label><label data-personal>业务实测<select data-opt="test"><option value="">所有实测状态</option><option value="pending">待实测</option><option value="failed">实测失败</option><option value="partial">部分已测</option><option value="incomplete">证据待补</option><option value="passed">实测通过</option></select></label><label class="ra-wide">节点或条件<input data-opt="query" type="search" maxlength="100" placeholder="查找经过此条件的路线"></label><button data-act="reset">清除筛选</button></div>
       <div class="ra-count"><span data-el="count" aria-live="polite"></span><span data-el="progress"></span><button data-act="clear-rule" hidden></button></div><div class="ra-rows" data-el="rows" aria-label="路线列表"></div>
       <footer class="ra-pager"><button data-act="prev-page" aria-label="上一页">上一页</button><label><input data-el="jump" type="text" inputmode="numeric" aria-label="跳至第几条路线" value="1"></label><button data-act="goto">跳至</button><button data-act="next-page" aria-label="下一页">下一页</button></footer></aside>
       <section class="ra-detail" data-el="detail" aria-label="路线详情"></section></div>
    </div><section class="ra-secondary" data-el="coverage" hidden></section><section class="ra-secondary" data-el="history" hidden></section>`;
  const el=Object.fromEntries([...dialog.querySelectorAll('[data-el]')].map(n=>[n.dataset.el,n]));
  const act=id=>dialog.querySelector('[data-act="'+id+'"]');
  const controls=[...dialog.querySelectorAll('[data-opt]')];
  let path='', options={...defaults},offset=0n,rank=0n,meta=null,data=null,current=null,caseId='',choice='',tab='routes',pending=false;
  let listReq=null,detailReq=null,searchTimer=null,highlight=null,expectedSignature='',sessionKey='',resume=null,openToken=0;
  let historyRequest=0,driverChoices=null,driverCase='',changes=null;
  const cache=new Map(),drafts=new Map();
  const cacheKey=r=>JSON.stringify([options,r.toString(),meta?.revision]);
  const draftKey=()=>JSON.stringify([path,current?.id,current?.signature,caseId]);
  const draftStorage=key=>'flow-route-draft:'+key;
  const session=()=>{try{sessionStorage.setItem(sessionKey,JSON.stringify({options,offset:String(offset),rank:String(rank),tab,resume}));}catch{}};
  const message=(s='')=>{el.notice.textContent=s;el.notice.hidden=!s;};
  const localDraft=()=>{const k=draftKey();if(drafts.has(k))return drafts.get(k);try{return JSON.parse(sessionStorage.getItem(draftStorage(k)));}catch{return null;}};
  function setDraft(item) {const k=draftKey();if(item)drafts.set(k,item);else drafts.delete(k);try{if(item)sessionStorage.setItem(draftStorage(k),JSON.stringify(item));else sessionStorage.removeItem(draftStorage(k));}catch{}}
  async function request(url,config={}) {const r=await fetch(url,{cache:'no-store',...config});const d=await r.json();if(!r.ok)throw Error(d.error || '请求失败');return d;}
  function url(extra={}) {return '/api/flow-routes?'+new URLSearchParams({path,...options,...extra});}
  function setMobile(value) {dialog.classList.toggle('ra-show-detail',value);}
  function remember() {
    if(!current || !dialog.open)return;
    resume={id:current.id,caseId,top:el.detail.scrollTop,listTop:el.rows.scrollTop,mobile:dialog.classList.contains('ra-show-detail'),
      panels:[...el.detail.querySelectorAll('details')].flatMap((d,i)=>d.open?[i]:[])};
    session();
  }
  function setTab(id) {
    tab=id;for(const name of ['routes','coverage','history'])el[name].hidden=name!==id;
    dialog.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===id)));
    if(id==='history')showHistory();if(id==='coverage')showCoverage();session();
  }
  function showMeta() {
    if(!meta)return;
    el.context.textContent=meta.path.split('/').at(-1)+' · '+meta.flows.length+' 张图';
    el.version.textContent='流程 v'+meta.revision;
    const field=id=>controls.find(n=>n.dataset.opt===id);
    field('entry').innerHTML=selectOptions(meta.roots,r=>r.key,r=>r.name+' · '+r.flow,'全部业务入口');
    field('through').innerHTML=selectOptions(meta.flows,f=>f.id,f=>f.name,'整个需求');
    controls.forEach(n=>{n.value=options[n.dataset.opt] || '';});
    const rule=meta.cases.find(c=>c.id===options.rule);
    act('clear-rule').hidden=!rule;if(rule)act('clear-rule').textContent=rule.when+' ×';
    dialog.querySelectorAll('[data-personal]').forEach(n=>{n.hidden=options.view!=='queue';});
    const filtered=!!(options.review||options.test||options.entry||options.through||options.query||options.status||options.rule||options.mode==='current');
    act('filter').classList.toggle('ra-active',filtered);
  }
  function showList() {
    if(!data)return;
    const count=BigInt(data.count);
    el.count.textContent=options.view==='all'?countText(data.count)+' 条图上组合':countText(data.count)+' 条完整路线';
    el.count.title=options.view==='all'?data.count+' 种有界图上组合，文字条件的可达性仍须核验':'为每个可达入口、判断出线、交接与结果选择完整路线，相同路线合并。全部组合可切换查看。';
    el.progress.textContent=data.progress?'整条已核 '+data.progress.reviewed+'/'+data.progress.total:'';
    el.jump.value=count?String(rank+1n):'0';
    act('prev-page').disabled=offset===0n;act('next-page').disabled=offset+BigInt(pageSize)>=count;
    el.rows.innerHTML=data.rows.map(r=>`<button class="ra-row" data-rank="${r.rank}" aria-pressed="${r.rank===String(rank)}">
      <span class="ra-row-top"><span class="ra-index">${String(BigInt(r.rank)+1n).padStart(2,'0')}</span><span>${esc(r.entry)}</span></span>
      <strong>${esc(r.title)}</strong><span class="ra-route-condition">${esc(r.focus || r.via.at(-1) || r.reason)}</span>
      <span class="ra-row-foot">${badge(r.hasProposal && r.status==='closed'?'planned':r.status,r.statusName)}<span>${esc(reviewNames[r.review.status])} · ${esc(testNames[r.test])}</span></span></button>`).join('')||'<p class="ra-empty">这个范围内没有匹配的路线。</p>';
  }
  async function list({metadata=true,keep=false}={}) {
    listReq?.abort();detailReq?.abort();detailReq=null;const ctl=new AbortController();listReq=ctl;
    el.rows.setAttribute('aria-busy','true');el.detail.setAttribute('aria-busy','true');message();current=null;
    if(!data)el.count.textContent='正在整理需求流程…';
    try {
      const d=await request(url({offset:String(offset),limit:String(pageSize),focus:String(keep?rank:offset),meta:metadata?'1':'0'}),{signal:ctl.signal});
      if(ctl!==listReq)return;
      if(!d.meta && d.revision!==meta?.revision){cache.clear();return list({keep});}
      if(d.meta){if(meta && meta.revision!==d.meta.revision){cache.clear();changes=null;}meta=d.meta;}
      data=d;
      if(offset && offset>=BigInt(d.count)) {offset=0n;rank=0n;return list({metadata:false});}
      if(!keep || !d.rows.some(r=>r.rank===String(rank)))rank=offset;
      if(d.focus && d.rows.find(r=>r.rank===String(rank))?.id===d.focus.id)cache.set(cacheKey(rank),d.focus);
      showMeta();showList();
      if(tab==='history')showHistory();if(tab==='coverage')showCoverage();
      if(d.rows.length)await select(rank,false);
      else el.detail.innerHTML='<p class="ra-empty">选择其他入口或清除筛选。</p>';
    } catch(e){if(!ctl.signal.aborted){message(e.message);el.rows.innerHTML='<button data-act="retry">重新载入</button>';el.detail.innerHTML='';}}
    finally{if(ctl===listReq){el.rows.removeAttribute('aria-busy');el.detail.removeAttribute('aria-busy');}}
  }
  async function select(next,focusDetail=true) {
    if(pending)return;
    rank=BigInt(next);caseId='';driverCase='';current=null;
    if(focusDetail)setMobile(true);
    session();el.jump.value=String(rank+1n);
    for(const b of el.rows.querySelectorAll('[data-rank]'))b.setAttribute('aria-pressed',String(b.dataset.rank===String(rank)));
    detailReq?.abort();const ctl=new AbortController();detailReq=ctl;
    el.detail.setAttribute('aria-busy','true');message();
    try {
      const key=cacheKey(rank);let row=cache.get(key);
      if(!row){const d=await request(url({detail:'1',offset:String(rank)}),{signal:ctl.signal});if(ctl!==detailReq)return;
        if(d.revision!==meta.revision){cache.clear();return list({keep:true});}
        row=d.row;if(cache.size>25)cache.clear();cache.set(key,row);}
      if(ctl!==detailReq)return;
      current=row;
      if(expectedSignature && expectedSignature!==row.signature)message('这条路线的条件已变化，需要复核。');
      expectedSignature='';showDetail();
      if(resume?.id===row.id) {
        const saved=resume;setMobile(focusDetail || saved.mobile);
        if(saved.caseId && row.caseIds.includes(saved.caseId)){caseId=saved.caseId;el.detail.querySelector('[data-case]').value=caseId;showCase();}
        el.detail.querySelectorAll('details').forEach((d,i)=>{d.open=saved.panels.includes(i);});
        el.detail.scrollTop=saved.top;el.rows.scrollTop=saved.listTop;
      }
    }catch(e){if(!ctl.signal.aborted){message(e.message);el.detail.innerHTML='<button data-act="retry">重新载入</button>';}}
    finally{if(ctl===detailReq)el.detail.removeAttribute('aria-busy');}
  }
  function trajectory(steps) {
    const groups=[];let group,previous;
    steps.forEach((s,i)=>{
      if(s.kind==='transition'){previous={...s,index:i};return;}
      if(s.kind!=='node')return;
      const lane=s.lanes.join('.'),key=JSON.stringify([s.ref.entryPath,s.ref.flowId,lane]);
      if(group?.key!==key){group={key,name:s.flow,lane,relation:linkKind[previous?.relation]||'',steps:[]};groups.push(group);}
      group.steps.push({s,i,via:previous?.label || '',edgeIndex:previous?.edge?previous.index:null});previous=null;
    });
    return groups.map((g,j)=>`<details class="ra-group"${j===0?' open':''}><summary><b>${esc(g.name)}</b><small>${esc([g.relation,g.lane?'并行 '+g.lane:''].filter(Boolean).join(' · '))} · ${g.steps.length} 步</small></summary>
      <ol>${g.steps.map(({s,i,via,edgeIndex})=>`<li>${via?(edgeIndex!==null?`<button class="ra-edge-link" data-edge-step="${edgeIndex}">${esc(via)} ↗</button>`:`<small>${esc(via)}</small>`):''}<button data-step="${i}">${esc(s.label)}<span aria-hidden="true">↗</span></button>${s.warning?`<small>${esc(s.warning)}</small>`:''}</li>`).join('')}</ol></details>`).join('');
  }
  function showDetail() {
    const r=current;if(!r)return;
    const decisive=[...new Set(r.via)].slice(-2);
    const hops=r.steps.flatMap((s,index)=>s.kind==='node'?[{s,index}]:[]).filter(({s},i,n)=>!i || s.ref.flowId!==n[i-1].s.ref.flowId || s.ref.entryPath!==n[i-1].s.ref.entryPath);
    el.detail.innerHTML=`<button class="ra-mobile-back" data-act="back">‹ 路线清单</button><div class="ra-read-head"><div class="ra-kicker"><span>路线 ${String(rank+1n)}</span><span>${r.flowCount} 张图${r.hasProposal?' · 含拟改':''}</span></div><h3>${esc(r.title)}</h3><div class="ra-outcome">${badge(r.hasProposal && r.status==='closed'?'planned':r.status,r.statusName)}<span>${esc(r.reason===r.title?r.focus || '':r.reason)}</span></div></div>
      <div class="ra-read-body"><div class="ra-summary"><span>起点</span><b>${esc(r.entry)}</b>${decisive.map(s=>`<span>条件</span><b>${esc(s)}</b>`).join('')}<span>落点</span><b>${esc(r.title)}</b></div>
      ${hops.length>1?`<nav class="ra-hops" aria-label="按经过顺序定位流程">${hops.map(({s,index})=>`<button data-step="${index}" title="${esc(s.flow+' · '+s.label)}">${esc(s.flow)}</button>`).join('<span aria-hidden="true">›</span>')}</nav>`:''}
      <details class="ra-trace"><summary>完整走向 <span>${r.steps.filter(s=>s.kind==='node').length} 个步骤</span></summary>${trajectory(r.steps)}</details>
      ${r.outcomes?.length>1?`<details class="ra-ends"><summary>各分支落点 <span>${r.outcomes.length} 项</span></summary>${r.outcomes.map((o,i)=>`<button data-outcome="${i}">${badge(o.status,stopNames[o.status] || o.status)}<span>${esc(o.label)}</span> ↗</button>`).join('')}</details>`:''}
      <div class="ra-tools"><button data-act="map">在图上查看</button><button data-act="copy">复制给 AI</button></div>
      <section class="ra-case-section"><div class="ra-section-title"><h4>核验对象</h4>${badge(r.test,testNames[r.test])}</div><select data-case aria-label="选择整条路线或具体场景"><option value="">整条路线</option>${r.cases.map(c=>`<option value="${esc(c.id)}">${esc(c.when)} · ${esc(reviewNames[r.caseStates.find(s=>s.id===c.id)?.review.status || 'pending'])}</option>`).join('')}</select><div data-case-info></div></section>
      <div class="ra-verdict"></div></div>`;
    el.detail.scrollTop=0;showCase();
  }
  function showCase() {
    const r=current,c=r.cases.find(c=>c.id===caseId),state=r.caseStates.find(s=>s.id===caseId);
    const saved=state?.review || r.review, draft=localDraft();choice=draft?.status || saved.status;
    const info=el.detail.querySelector('[data-case-info]');
    const related=r.evidence.filter(e=>!caseId || e.scenario===caseId);
    const jobs=r.runs.filter(e=>!caseId || e.scenario===caseId);
    info.innerHTML=c?`<div class="ra-expected"><small>预期结果</small><p>${esc(c.expected)}</p><small>${esc(c.source.split('/').at(-1))}</small></div>`:r.cases.length?`<p class="ra-caption">本路线包含 ${r.cases.length} 个可分别核验的场景。</p>`:'<p class="ra-caption">本路线尚无独立场景断言。</p>';
    if(c?.offlineEvidence)info.innerHTML+=`<details class="ra-evidence"><summary>已有局部测试证据</summary><p>${esc(c.offlineEvidence.verified)}</p><p>待验 · ${esc(c.offlineEvidence.pending)}</p><small>${esc(c.offlineEvidence.version.slice(0,8))}</small></details>`;
    if(related.length)info.innerHTML+=related.map(e=>`<div class="ra-expected">${badge(e.status,testNames[e.status])}<p>${esc(e.database)} · ${esc(e.codeVersion)} · ${esc(e.runId)}</p>${e.checks.map(a=>`<p>${esc(a.field)} · 预期 ${esc(a.value)} · 实际 ${esc(a.missing?'缺证':a.actual)}</p>`).join('')}</div>`).join('');
    if(jobs.length)info.innerHTML+=jobs.map(j=>`<p class="ra-caption">执行 ${esc(j.id)} · ${esc(j.status)} ${esc(j.reason || '')}</p>`).join('')+'<button data-act="refresh-run">刷新执行结果</button>';
    if(c){
      info.innerHTML+=`<div class="ra-driver"><span>${esc(c.driver?.name || (c.driver?'已关联测试':'业务实测待关联'))}</span>${c.driver && data.canEdit?'<button data-act="run">运行此场景</button>':''}${data.canEdit?`<button data-act="pick-driver">${c.driver?'更换测试':'关联自动化测试'}</button>`:''}</div>`;
      if(driverCase===c.id && driverChoices) {
        const items=driverChoices.items;
        info.innerHTML+=items.length?`<div class="ra-driver"><select data-driver aria-label="已授权的自动化测试">${items.map((i,n)=>`<option value="${n}">${esc(i.name)}${i.ready?'':' · 环境待就绪'}</option>`).join('')}</select><button data-act="bind-driver">保存关联</button></div>`:'<p class="ra-caption">当前需求还没有获准在业务测试库执行的资源。可在工作台「测试」页关联用例，再在这里选择。</p>';
      }
    }
    const last=saved.status==='stale'?`上个版本 · ${reviewNames[saved.priorStatus] || ''} · ${saved.note || ''}`:saved.updatedAt?'已保存 · '+timeLabel(saved.updatedAt):'';
    el.detail.querySelector('.ra-verdict').innerHTML=`<div class="ra-section-title"><h4>我的核验</h4><span data-draft-label>${esc(draft?'草稿':last)}</span></div>
      <div class="ra-choices">${['ok','issue','unsure'].map(s=>`<button data-choice="${s}" aria-pressed="${choice===s}">${reviewNames[s]}</button>`).join('')}</div>
      <textarea data-note aria-label="核验备注" maxlength="2000" rows="2" placeholder="记下问题或判断依据（选填）">${esc(draft?.note ?? (saved.status==='stale'?'':saved.note || ''))}</textarea>
      <div class="ra-actions"><button data-act="skip">下一条</button><button class="primary" data-act="save">${nextCase(r,caseId)?'保存并核验下一场景':rank+1n<BigInt(data.count)?'保存并核验下一条':'保存核验'}</button></div>`;
    act('save').disabled=!data.canEdit || !['ok','issue','unsure'].includes(choice);act('skip').disabled=rank+1n>=BigInt(data.count);
  }
  function nextCase(r,id){return id && r.caseStates.find(s=>s.id!==id && ['pending','stale'].includes(s.review.status))?.id;}
  function saveDraft(){if(!current)return;setDraft({status:choice,note:el.detail.querySelector('[data-note]')?.value || ''});el.detail.querySelector('[data-draft-label]').textContent='草稿';}
  function showCoverage() {
    if(!meta)return;
    el.coverage.innerHTML=`<div class="ra-sec-head"><h3>条件与缺口</h3><span>源码基线 ${esc(meta.baseline.slice(0,8) || '待绑定')} · ${meta.methods.length} 个已登记方法</span></div>
      ${meta.issues.length?`<div class="ra-issues">${meta.issues.map((i,n)=>`<${i.ref?'button data-gap="'+n+'"':'p'}>${badge('gap',i.kind==='source'?'源码待核':'需核验')} ${esc(i.message)}${i.ref?' ↗':''}</${i.ref?'button':'p'}>`).join('')}</div>`:''}
      <h4>业务条件 · ${meta.cases.length}</h4><div class="ra-source-list">${meta.cases.map(c=>`<button data-rule="${esc(c.id)}"><span><strong>${esc(c.when)}</strong><small>${esc(c.expected)}</small></span><span>查看路线 ›</span></button>`).join('') || '<p class="ra-empty">这个需求尚未登记可对照源码的条件。</p>'}</div>
      <details class="ra-index-detail"><summary>当前入口未经过的图节点 · ${meta.uncovered.length}</summary><p class="ra-caption">含被详细图展开替代的概览、拟改分支和待核实入口。</p>${meta.uncovered.map((u,i)=>`<button data-uncovered="${i}">${esc(u.label)} ↗</button>`).join('')}</details>
      <details class="ra-index-detail"><summary>当前入口未经过的连线 · ${meta.unusedEdges?.length || 0}</summary>${(meta.unusedEdges || []).map((u,i)=>`<button data-unused="${i}">${esc(u.label)} · ${esc(u.reason)} ↗</button>`).join('')}</details>
      <details class="ra-index-detail" data-diff><summary>与上一流程版本比较</summary><div data-diff-items></div></details>
      <details class="ra-index-detail"><summary>路线统计范围</summary><p>逐条清单为每个可达入口、分支、交接和结果保留一条完整路线。全部组合保留这些选择的不同组合。并行处理列在同一路线里。循环展示首轮、一次重入和仍待继续的情况。只有已登记的源码约束会排除互斥组合。</p></details>
      ${meta.limited?'<p class="ra-notice">部分片段已达分析界限，仍待展开。</p>':''}`;
  }
  function showHistory() {
    if(!data)return;
    el.history.innerHTML=`<div class="ra-sec-head"><h3>我的记录</h3><span>${data.history.length} 项</span></div><div class="ra-source-list">${data.history.map((r,i)=>`<button data-record="${i}"><span><strong>${esc(r.title)}</strong><small>v${r.flowRevision} · ${esc(r.caseName || r.caseId || '整条路线')} · ${esc(r.note || timeLabel(r.updatedAt))}</small></span>${badge(r.status,reviewNames[r.status])}</button>`).join('')||'<p class="ra-empty">保存第一条核验后，可在这里接着看。</p>'}</div><div data-archived></div>`;
  }
  async function openRecord(record) {
    const ticket=++historyRequest;
    try{
      const d=await request(url({record:record.id,signature:record.signature,caseId:record.caseId || ''}));
      if(ticket!==historyRequest || tab!=='history')return;
      if(d.rank===null){
        el.history.querySelector('[data-archived]').innerHTML=`<section class="ra-expected"><h4>历史路线 · v${record.flowRevision}</h4><p>${esc([record.entry,...(record.via || []),record.title].join(' → '))}</p><p>${esc(reviewNames[record.status])} · ${esc(record.note)}</p><small>当前版本无法重现这条走向，已保留当时的记录。</small></section>`;return;
      }
      options={...defaults,...d.options};rank=BigInt(d.rank);offset=rank/BigInt(pageSize)*BigInt(pageSize);expectedSignature=record.signature;resume=null;
      setTab('routes');setMobile(true);await list({keep:true});
      if(record.id===current?.id && current.caseIds.includes(record.caseId)){caseId=record.caseId;el.detail.querySelector('[data-case]').value=caseId;showCase();}
    }catch(e){message(e.message);}
  }
  el.coverage.addEventListener('toggle',async e=>{
    if(!e.target.matches('[data-diff][open]'))return;
    const target=e.target.querySelector('[data-diff-items]');target.textContent='读取版本…';
    try{
      const result=changes || await request('/api/flow-routes/changes?'+new URLSearchParams({path}));if(!target.isConnected)return;changes=result;
      target.innerHTML=!result.from?'暂无更早的流程版本。':`<p>v${result.from} → v${result.to} · ${result.changes.length} 处流程语义变化</p>`+result.changes.map((c,i)=>
        `<${c.change==='移除'?'p':'button data-change="'+i+'"'}>${esc([c.change+c.kind,c.flow,c.before && c.after && c.before!==c.after?c.before+' → '+c.after:c.label].join(' · '))}${c.change==='移除'?'':' ↗'}</${c.change==='移除'?'p':'button'}>`).join('');
    }catch(e){target.textContent=e.message;}
  },true);
  async function jump(to,focus=true) {
    if(!data || to<0n || to>=BigInt(data.count))return;
    rank=to;const page=(to/BigInt(pageSize))*BigInt(pageSize);
    if(focus)setMobile(true);
    if(offset!==page){offset=page;await list({metadata:false,keep:true});el.rows.scrollTop=0;}
    else await select(to,focus);
    el.rows.querySelector('[aria-pressed="true"]')?.scrollIntoView({block:'nearest'});
  }
  async function submit(run=false) {
    if(!current || pending)return;
    const r=current,saved=(caseId?r.caseStates.find(c=>c.id===caseId)?.review:r.review),note=el.detail.querySelector('[data-note]').value;
    const body={id:r.id,signature:r.signature,revision:meta.revision,rank:String(rank),caseId,options,status:choice,note,expected:saved?.revision || 0};
    pending=true;dialog.setAttribute('data-saving','');act('save').disabled=true;message();
    try {
      const result=await request('/api/flow-routes/'+(run?'run':'review')+'?'+new URLSearchParams({path}),{method:'POST',headers:{'Content-Type':'application/json','X-Design-Client':'workbench-v1'},body:JSON.stringify(body)});
      if(!run)setDraft(null);cache.clear();pending=false;dialog.removeAttribute('data-saving');
      if(run){await select(rank,false);message('已提交受控测试 · '+result.id);return;}
      data.history=[result.record,...data.history.filter(x=>!(x.id===r.id && x.signature===r.signature && x.caseId===caseId))];
      if(!caseId){const row=data.rows.find(i=>i.id===r.id);if(row)row.review=result.record;}
      const following=nextCase(r,caseId);resume=null;
      if(!caseId && data.progress && !['ok','issue','unsure'].includes(saved?.status))data.progress.reviewed++;
      showList();if(!caseId && options.review){await list({keep:true});}
      else if(following){await select(rank,false);caseId=following;el.detail.querySelector('[data-case]').value=caseId;showCase();}
      else if(rank+1n<BigInt(data.count))await jump(rank+1n);else await select(rank,false);
      message('已保存 · '+reviewNames[result.record.status]);
    }catch(e){message(e.message);act('save').disabled=false;}
    finally{pending=false;dialog.removeAttribute('data-saving');}
  }
  async function onMap(ref,withRoute=true) {
    if(!ref?.flowId)return;const r=withRoute && current;
    if(!await guard())return;
    remember();highlight={path,steps:r?r.steps:[]};
    dialog.close();returnButton.hidden=false;await locate(ref);onHighlight();
  }
  function openFilters() {const hidden=el.filters.hidden;el.filters.hidden=!hidden;act('filter').setAttribute('aria-expanded',String(hidden));}
  function freshFilters() {offset=0n;rank=0n;cache.clear();setMobile(false);session();void list();}
  dialog.addEventListener('change',e=>{
    const target=e.target;
    if(target.matches('[data-opt]:not([type=search])')){options[target.dataset.opt]=target.value;if(options.view==='all'){options.review='';options.test='';}freshFilters();}
    if(target.hasAttribute('data-case')){caseId=target.value;showCase();}
  });
  dialog.addEventListener('input',e=>{
    if(e.target.hasAttribute('data-note'))saveDraft();
    if(e.target.dataset.opt==='query'){clearTimeout(searchTimer);const value=e.target.value;searchTimer=setTimeout(()=>{options.query=value;freshFilters();},220);}
  });
  el.jump.addEventListener('keydown',e=>{if(e.key==='Enter')act('goto').click();});
  dialog.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b || pending)return;
    if(b.dataset.tab){setTab(b.dataset.tab);return;}
    if(b.dataset.rank!==undefined){if(!el.rows.hasAttribute('aria-busy'))await select(BigInt(b.dataset.rank));return;}
    if(b.dataset.step!==undefined){await onMap(current?.steps[Number(b.dataset.step)]?.ref);return;}
    if(b.dataset.outcome!==undefined){await onMap(current?.outcomes[Number(b.dataset.outcome)]?.ref);return;}
    if(b.dataset.edgeStep!==undefined){await onMap(current?.steps[Number(b.dataset.edgeStep)]?.edge);return;}
    if(b.dataset.gap!==undefined){await onMap(meta.issues[Number(b.dataset.gap)].ref,false);return;}
    if(b.dataset.uncovered!==undefined){await onMap(meta.uncovered[Number(b.dataset.uncovered)].ref,false);return;}
    if(b.dataset.unused!==undefined){await onMap(meta.unusedEdges[Number(b.dataset.unused)].ref,false);return;}
    if(b.dataset.change!==undefined){await onMap({...changes.changes[Number(b.dataset.change)].ref,entryPath:path},false);return;}
    if(b.dataset.rule){options.rule=b.dataset.rule;setTab('routes');freshFilters();return;}
    if(b.dataset.record!==undefined){await openRecord(data.history[Number(b.dataset.record)]);return;}
    if(b.dataset.choice){choice=b.dataset.choice;dialog.querySelectorAll('[data-choice]').forEach(n=>n.setAttribute('aria-pressed',String(n===b)));act('save').disabled=!data.canEdit;saveDraft();return;}
    switch(b.dataset.act){
      case 'close':remember();dialog.close();break;
      case 'back':setMobile(false);el.rows.querySelector('[aria-pressed="true"]')?.focus();break;
      case 'retry':cache.clear();await list({keep:true});break;
      case 'filter':openFilters();break;
      case 'reset':options={...defaults,view:options.view};freshFilters();break;
      case 'clear-rule':options.rule='';freshFilters();break;
      case 'prev-page':await jump(offset-BigInt(pageSize),false);break;
      case 'next-page':await jump(offset+BigInt(pageSize),false);break;
      case 'goto':if(/^\d{1,400}$/.test(el.jump.value.trim()) && BigInt(el.jump.value)>0n && BigInt(el.jump.value)<=BigInt(data.count))await jump(BigInt(el.jump.value)-1n);else message('请输入当前范围内的路线序号。');break;
      case 'skip':await jump(rank+1n);break;
      case 'save':await submit();break;
      case 'run':await submit(true);break;
      case 'pick-driver': {
        const id=caseId;try{driverChoices=await request('/api/flow-routes/drivers?'+new URLSearchParams({path}));
          if(id===caseId && current){driverCase=id;showCase();}}catch(e){message(e.message);}break;
      }
      case 'bind-driver': {
        const r=current,id=caseId,item=driverChoices?.items[Number(el.detail.querySelector('[data-driver]').value)];
        if(!r || !id || !item)break;
        try{b.disabled=true;const expected=driverChoices.bindings.find(x=>x.id===id)?.revision || 0;
          await request('/api/flow-routes/binding?'+new URLSearchParams({path}),{method:'POST',headers:{'Content-Type':'application/json','X-Design-Client':'workbench-v1'},body:JSON.stringify({id:r.id,signature:r.signature,revision:meta.revision,rank:String(rank),options,caseId:id,linkId:item.linkId,environmentId:item.environmentId,expected})});
          if(current===r && id===caseId){remember();cache.clear();await select(rank,false);message('已关联自动化测试。');}
        }catch(e){message(e.message);b.disabled=false;}break;
      }
      case 'refresh-run':cache.clear();await select(rank,false);break;
      case 'map':await onMap(current?.steps.find(s=>s.kind==='node')?.ref);break;
      case 'copy':if(current){try{await navigator.clipboard.writeText(JSON.stringify({requirement:path,revision:meta.revision,codeVersion:meta.baseline,route:current},null,2));message('已复制这条路线、场景与证据。');}catch{message('复制未完成，请检查浏览器剪贴板权限。');}}break;
    }
  });
  dialog.addEventListener('cancel',e=>{if(pending)e.preventDefault();else remember();});
  window.addEventListener('pagehide',remember);
  el.rows.addEventListener('keydown',async e=>{
    if(!['ArrowDown','ArrowUp'].includes(e.key) || !e.target.matches('.ra-row'))return;
    e.preventDefault();await jump(rank+(e.key==='ArrowDown'?1n:-1n),false);
    el.rows.querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
  });
  dialog.addEventListener('close',()=>{remember();clearTimeout(searchTimer);listReq?.abort();detailReq?.abort();session();onVisibility?.();});
  async function open() {
    if(dialog.open)return;
    const token=++openToken;
    if(!await guard() || token!==openToken)return;
    const ctx=getContext();if(!ctx.path)return;
    if(path!==ctx.path) {
      path=ctx.path;meta=data=current=null;highlight=null;cache.clear();sessionKey='flow-route-view:'+path;
      let saved;try{saved=JSON.parse(sessionStorage.getItem(sessionKey));}catch{}
      options={...defaults,...saved?.options};offset=/^\d+$/.test(saved?.offset)?BigInt(saved.offset):0n;rank=/^\d+$/.test(saved?.rank)?BigInt(saved.rank):0n;
      resume=saved?.resume || null;changes=null;driverChoices=null;setMobile(!!resume?.mobile);
      tab=['history','coverage'].includes(saved?.tab)?saved.tab:'routes';el.rows.innerHTML='';el.detail.innerHTML='';
    }
    returnButton.hidden=true;highlight=null;cache.clear();onHighlight();dialog.showModal();onVisibility?.();setTab(tab);
    el.context.textContent=path.split('/').at(-1);await list({keep:true});
  }
  trigger.addEventListener('click',open);returnButton.addEventListener('click',open);
  function paint(container,source,flowId) {
    const relevant=highlight?.path===getContext().path?highlight.steps.filter(s=>(s.edge || s.ref)?.entryPath===source && (s.edge || s.ref)?.flowId===flowId):[];
    const nodes=new Set(relevant.filter(s=>s.kind==='node').map(s=>s.ref.nodeId)),edges=new Set(relevant.map(s=>s.edge?.edgeId).filter(Boolean));
    for(const n of container.querySelectorAll('[data-node],[data-edge]'))n.classList.toggle('ra-on-route',nodes.has(n.dataset.node)||edges.has(n.dataset.edge));
    if(highlight?.path!==getContext().path)returnButton.hidden=true;
  }
  return {open,paint};
}
