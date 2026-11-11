"use strict";
const {canEdit,readBody}=require('./design-store');
function createDocumentHandler(db,sendJson,{accessMode='local'}={}){return async(req,res,url)=>{
 try{
  if(!db)throw Object.assign(new Error('需求在线编辑需要数据库存储'),{status:503});
  const p=url.searchParams.get('path');db.find(p);const file=db.validateDocumentFile(p,url.searchParams.get('file')||p+'/需求文档.md');
  if(req.method==='GET'&&url.pathname==='/api/document'){
   const data=await db.readDocumentFile(p,file);sendJson(res,200,{...(data||{file,content:'',editorContent:'',revision:0,rules:[],storage:'mysql'}),canEdit:canEdit(req,accessMode)});
  }else if(req.method==='PUT'&&url.pathname==='/api/document'){
   const body=await readBody(req,accessMode);sendJson(res,200,await db.saveDocumentFile(p,file,body.expectedRevision,body.content,{editor:body.editor===true}));
  }else if(req.method==='POST'&&url.pathname==='/api/document/check'){
   const body=await readBody(req,accessMode),rollback={};let preview;
   try{await db.transaction(async c=>{
    preview=file===p+'/需求文档.md'
     ? await db.putRequirementDocument(c,p,body.expectedRevision,body.content,{editor:body.editor===true})
     : await db.putSupportingDocument(c,p,file,body.expectedRevision,body.content);
    throw rollback;
   });}catch(e){if(e!==rollback)throw e;}
   sendJson(res,200,{valid:true,dryRun:true,preview});
  }else if(req.method==='GET'&&url.pathname==='/api/document/versions')sendJson(res,200,{versions:await db.fileVersions(p,file)});
  else if(req.method==='GET'&&url.pathname==='/api/document/version'){
   const revision=Number(url.searchParams.get('revision'));
   const data=await db.fileVersion(p,file,revision);sendJson(res,200,data);
  }else if(req.method==='POST'&&url.pathname==='/api/document/restore'){
   const body=await readBody(req,accessMode),old=await db.fileVersion(p,file,body.revision);
   sendJson(res,200,await db.saveDocumentFile(p,file,body.expectedRevision,old.content));
  }else sendJson(res,405,{error:'不支持的文档接口或请求方法'});
 }catch(e){sendJson(res,e.status||500,{error:e.status?e.message:'需求文档操作失败，当前草稿请保留后重试'});}
}}
module.exports={createDocumentHandler};
