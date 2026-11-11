'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {digest}=require('./flow-route-graph');
const baselineMethods=new Map();
const optional=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
function contained(root,file) {
  const base=fs.realpathSync(root),resolved=fs.realpathSync(path.resolve(base,file));
  if(!resolved.startsWith(base+path.sep)) throw Error('源码路径超出已配置仓库');
  return resolved;
}

// Keep source literals intact for version comparisons. Mask literals/comments
// only while finding balanced Java delimiters. This is a declared method
// inventory, not a whole-repository Java interpreter.
function methodFacts(source,method,parameter) {
  const masked=source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,s=>s.replace(/[^\n]/g,' '));
  const matcher=new RegExp('\\b'+method+'\\s*\\(\\s*'+parameter+'\\b[^)]*\\)\\s*(?:throws [^{;]+)?\\{','g');
  const match=matcher.exec(masked);
  if(!match || matcher.exec(masked)) throw Error('方法签名缺失或不唯一');
  function closing(start,open,close) {let depth=0;for(let i=start;i<masked.length;i++){if(masked[i]===open)depth++;else if(masked[i]===close && --depth===0)return i;}throw Error('源码片段不完整');}
  const start=masked.indexOf('{',match.index+match[0].lastIndexOf('{')),end=closing(start,'{','}');
  const parts=[],body=masked.slice(start,end+1);
  for(const c of body.matchAll(/\b(if|switch|catch|while|for)\s*\(|\bcase\s+[^:\n]+:/g)) {
    const pos=start+c.index;
    const slice=c[1]?source.slice(pos,closing(masked.indexOf('(',pos),'(',')')+1):source.slice(pos,pos+c[0].length);
    parts.push(slice.replace(/\s+/g,' ').trim());
  }
  const tokens=source.slice(start,end+1).match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[\w$]+|[^\s]/g) || [];
  return {fingerprint:digest(tokens.filter(t=>!t.startsWith('//') && !t.startsWith('/*'))),conditions:parts};
}

function readRules(root,entryPath) {
  const folder=path.join(root,entryPath);
  const issues=[],methods=[],specFile=path.join(folder,'路线核验规则.json');
  let spec={},evidence=null;
  try{if(fs.existsSync(specFile))spec=optional(contained(folder,'路线核验规则.json')) || {};}
  catch{issues.push({kind:'source',message:'路线核验规则无法读取，请检查文件格式'});}
  const baseline=spec.codeVersion || '';
  if(spec.offlineFile)try{evidence=optional(contained(folder,spec.offlineFile));}
  catch{issues.push({kind:'source',message:'已登记的局部测试证据文件无法读取'});}
  for(const m of spec.methods || []) {
    const item={...m},ref={entryPath,flowId:m.flowId,nodeId:m.nodeId};
    try {
      if(!/^[a-zA-Z_$][\w$]*$/.test(m.method) || !/^[a-zA-Z_$][\w$]*$/.test(m.parameter) || !/^[a-f0-9]{7,40}$/.test(baseline)) throw Error('源码映射格式无效');
      if(!process.env.WORKBENCH_SOURCE_ROOT) throw Error('尚未配置源码仓库');
      const repository=path.resolve(process.env.WORKBENCH_SOURCE_ROOT);
      const file=contained(repository,m.file);
      const current=methodFacts(fs.readFileSync(file,'utf8'),m.method,m.parameter);
      const baselineKey=JSON.stringify([repository,baseline,m.file,m.method,m.parameter]);
      if(!baselineMethods.has(baselineKey))baselineMethods.set(baselineKey,methodFacts(execFileSync('git',['-C',repository,'show',baseline+':'+m.file],{encoding:'utf8',maxBuffer:4e6,stdio:['ignore','pipe','ignore']}),m.method,m.parameter));
      const old=baselineMethods.get(baselineKey);
      Object.assign(item,current,{changed:current.fingerprint!==old.fingerprint});
      if(item.changed) {
        const added=current.conditions.filter(c=>!old.conditions.includes(c));
        issues.push(...(added.length?added:['方法实现已变化，须复核绑定的业务结果']).map(c=>({ref,kind:'source',message:'源码待映射 · '+c})));
      }
    } catch(e) {item.unavailable=true;issues.push({ref,kind:'source',message:m.method+' 的源码基线无法核实'});}
    methods.push(item);
  }
  const cases=(spec.cases || []).map(c=>{
    const method=methods.find(m=>m.id===c.method);
    const offline=evidence?.四场景?.find(r=>r.场景===c.offline);
    return {...c,source:method?method.file+' · '+method.method:'业务核验规则',sourceDigest:method?.fingerprint || '',
      ...(offline?{offlineEvidence:{version:evidence.源码提交,verified:offline.已验证,pending:offline.未验证}}:{})};
  });
  return {...spec,cases,issues,methods,baseline};
}

// A passing suite or a terminal order status cannot vouch for a different
// trajectory. An execution carries its route signature and observed assertions.
function evaluateEvidence(route,runs,version,entryPath) {
  const assertions=[];
  for(const run of runs || []) for(const result of run.businessEvidence || []) {
    if(result.routeId!==route.id || result.routeSignature!==route.signature || result.runId!==run.id ||
       run.path!==entryPath || result.executed!==true || run.environment?.scope!=='business' ||
       !run.codeVersion || (version && !(run.codeVersion===version || (/^[a-f\d]{7,40}$/i.test(run.codeVersion) && version.startsWith(run.codeVersion)))) ||
       !run.environment.database || result.database!==run.environment.database || result.cleanupCompleted!==true) continue;
    const c=route.cases?.find(c=>c.id===result.scenario);
    const checks=c?.assertions || [];
    if(!checks.length) continue;
    const expectedEdges=route.steps.filter(s=>s.edge).map(s=>({...s.edge,lanes:s.lanes}));
    const hasTrace=Array.isArray(result.actualEdges) && result.actualEdges.length>0;
    const traced=hasTrace && traceMatches(expectedEdges,result.actualEdges);
    const values=result.observed || {};
    const details=checks.map(a=>({...a,actual:values[a.field],missing:!Object.hasOwn(values,a.field)}));
    const fail=details.some(a=>!a.missing && a.actual!==a.value);
    const status=fail || run.status==='failed' || hasTrace && !traced?'failed':traced && details.every(a=>!a.missing) && run.status==='passed' && run.businessExecuted===true?'passed':'incomplete';
    assertions.push({runId:run.id,scenario:c.id,status,traced,checks:details,database:result.database,codeVersion:run.codeVersion,createdAt:run.createdAt});
  }
  return assertions;
}
function traceMatches(expected,actual) {
  if(!expected.length || expected.length!==actual.length)return false;
  const lane=e=>e.lanes || [],key=e=>JSON.stringify([e.entryPath,e.flowId,e.edgeId,lane(e)]);
  const positions=new Map(),consumed=new Map();
  actual.forEach((e,i)=>{const k=key(e);if(!positions.has(k))positions.set(k,[]);positions.get(k).push(i);});
  const clocks=new Map();
  for(const e of expected) {
    const k=key(e),n=consumed.get(k)||0,idx=positions.get(k)?.[n];if(idx==null)return false;
    consumed.set(k,n+1);
    const l=lane(e);
    for(const {branch,last} of clocks.values()) {
      const shorter=Math.min(branch.length,l.length);
      if(branch.slice(0,shorter).every((v,i)=>v===l[i]) && last>=idx)return false;
    }
    clocks.set(JSON.stringify(l),{branch:l,last:idx});
  }
  return true;
}
module.exports={readRules,methodFacts,evaluateEvidence,traceMatches};
