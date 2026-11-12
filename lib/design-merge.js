'use strict';
const {validatePages}=require('./design-store');
const {resolveElement}=require('./stable-identities');
const fail=(s,status=400)=>{throw Object.assign(new Error(s),{status})};
const fingerprint=s=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(16).padStart(8,'0')};
function redirectLinks(s,path,old,target){
 const url='/#'+new URLSearchParams({path,view:'preview',prototype:'design:'+target.id});
 for(const prefix of ['design%3A','design:'])s=s.replace(new RegExp(prefix+old.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=[&"\'\\s)<>]|$)','g'),prefix+target.id);
 if(old.route){s=s.split('href="'+old.route+'"').join('href="'+url+'"').split("href='"+old.route+"'").join("href='"+url+"'");
  const key=old.route.slice(1);s=s.replace('function navigate(id){','function navigate(id){if(id==='+JSON.stringify(key)+'){location.href='+JSON.stringify(url)+';return;}');
 }
 return s;
}
async function mergePages(db,path,body){
 const result=await db.transaction(async c=>{
  const {entry,workspace:design}=await db.read('design',path,c);
  if(!Number.isInteger(body.expectedRevision)||body.expectedRevision!==design.revision)fail('画板已有更新，请刷新后重新合并',409);
  const old=design.pages.find(p=>p.id===body.sourceId),target=design.pages.find(p=>p.id===body.targetId);
  if(!old||!target||old.id===target.id)fail('请选择两个不同且仍存在的页面');
  const id=await db.entry(c,entry),now=new Date().toISOString(),counts={notes:0,nodes:0,documents:0,pageLinks:0};
  const notes=(await db.read('annotations',path,c)).workspace,flows=(await db.read('flow',path,c)).workspace;
  for(const note of notes.notes){if(note.target.type!=='page-element'||note.target.pageId!==old.id)continue;
   const a=note.target.anchor,found=resolveElement(target.html,a.elementId?'[data-wb-element="'+a.elementId+'"]':a.selector);
   if(!found||found.tag!==a.tag)fail('目标页尚未保留关联元素，请先补齐原页面内容再合并');
   note.target.pageId=target.id;note.target.route=target.route||'';a.htmlHash=fingerprint(target.html);note.updatedAt=now;counts.notes++;
  }
  for(const f of flows.flows)for(const n of f.nodes)if(n.pageId===old.id){n.pageId=target.id;counts.nodes++;}
  if(target.descriptionPageId===old.id){delete target.descriptionPageId;target.description=old.description||'';}
  const oldOwner=old.descriptionPageId?design.pages.find(p=>p.id===old.descriptionPageId):old;
  const targetOwner=target.descriptionPageId?design.pages.find(p=>p.id===target.descriptionPageId):target;
  if(oldOwner?.description && !targetOwner.description?.includes(oldOwner.description))targetOwner.description=[targetOwner.description,oldOwner.description].filter(Boolean).join('\n\n');
  for(const p of design.pages)if(p.descriptionPageId===old.id)p.descriptionPageId=targetOwner.id;
  delete targetOwner.descriptionPageId;
  const pages=design.pages.filter(p=>p.id!==old.id).map(p=>{const html=redirectLinks(p.html,path,old,target);if(html!==p.html)counts.pageLinks++;return {...p,html,...(p.description?{description:redirectLinks(p.description,path,old,target)}:{})}});
  for(const note of notes.notes)if(note.target.type==='page-element'&&note.target.pageId===target.id)note.target.anchor.htmlHash=fingerprint(pages.find(p=>p.id===target.id).html);
  const next={...design,...(design.overview?{overview:redirectLinks(design.overview,path,old,target)}:{}),pages:validatePages(pages,entry),revision:design.revision+1,updatedAt:now};await db.put(c,id,'design',next);
  if(counts.notes)await db.put(c,id,'annotations',{...notes,revision:notes.revision+1,updatedAt:now});
  if(counts.nodes)await db.put(c,id,'flow',{...flows,revision:flows.revision+1,updatedAt:now});
  const primary=await db.document(path,c);if(primary){const content=redirectLinks(primary.content,path,old,target);if(content!==primary.content){await db.putRequirementDocument(c,path,primary.revision,content);counts.documents++;}}
  await c.execute('UPDATE wb_design_documents SET page_id=? WHERE entry_id=? AND page_id=?',[target.id,id,old.id]);
  const [docs]=await c.execute('SELECT d.file,d.revision,d.content FROM wb_supporting_documents d LEFT JOIN wb_design_documents m ON m.entry_id=d.entry_id AND m.file_hash=d.file_hash WHERE d.entry_id=? AND m.file_hash IS NULL',[id]);
  for(const doc of docs){const content=redirectLinks(doc.content,path,old,target);if(content!==doc.content){await db.putSupportingDocument(c,path,doc.file,doc.revision,content);counts.documents++;}}
  return {workspace:next,migrated:counts};
 });await db.refreshDocumentEntries();return result;
}
module.exports={mergePages,redirectLinks};
