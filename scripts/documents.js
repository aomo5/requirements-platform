"use strict";
const {ensureWorkspace}=require('../lib/storage-config');
const fs=require('fs'),path=require('path'),{MysqlStorage}=require('../lib/mysql-storage'),{scanRequirements}=require('../lib/scan');
const root=ensureWorkspace();
(async()=>{const command=process.argv[2],option=process.argv.indexOf('--backup'),db=new MysqlStorage(root,()=>scanRequirements(root));try{await db.init();if(!['migrate','migrate-supporting'].includes(command)||option<0)throw new Error('使用 documents.js migrate|migrate-supporting --backup <迁移前已核验备份目录>');const report=await db[command==='migrate'?'migrateDocuments':'migrateSupportingDocuments'](path.resolve(process.argv[option+1]));console.log(JSON.stringify(report,null,2));}finally{await db.close()}})().catch(e=>{console.error(e.status?e.message:e.code||e.message);process.exitCode=1});
