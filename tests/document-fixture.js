'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepareMarkdown}=require('../lib/stable-identities'),{scanRequirements}=require('../lib/scan'),{MysqlStorage}=require('../lib/mysql-storage'),{TABLES}=require('../lib/storage-transfer'),{databaseConfig}=require('../lib/storage-config');
function prefixPool(pool,prefix){const wrap=c=>({query:(sql,args)=>c.query(sql.replaceAll('wb_',prefix),args),execute:(sql,args)=>c.execute(sql.replaceAll('wb_',prefix),args),beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release()});return {...wrap(pool),pool:pool.pool,getConnection:async()=>wrap(await pool.getConnection()),end:()=>pool.end()};}
async function fixture({routes={}}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-doc-db-')),p='20-测试/正文迁移',dir=path.join(root,p);fs.mkdirSync(dir,{recursive:true});
 const content=prepareMarkdown('# 账户需求\n\n充值只进入对应账户。\n\n欠费时暂停租户到账。\n',p+'/需求文档.md').content;
 fs.writeFileSync(path.join(dir,'需求文档.md'),content);fs.writeFileSync(path.join(dir,'规格索引.md'),'# 索引\n');
 fs.mkdirSync(path.join(root,'portal/data'),{recursive:true});fs.writeFileSync(path.join(root,'portal/data/link-map.json'),JSON.stringify(routes));
 const config={...databaseConfig(),database:'requirements_workbench_test'},db=new MysqlStorage(root,()=>scanRequirements(root),config),prefix='wb_docqa_'+Date.now().toString(36)+'_'+require('node:crypto').randomBytes(4).toString('hex')+'_';
 const pool=db.pool;db.pool=prefixPool(pool,prefix);await db.init({allowUnmigrated:true});await db.pool.execute('UPDATE wb_control SET migrated=1,root_path=? WHERE id=1',[db.root]);
 return {root,p,dir,content,db,prefix,async close(){for(const table of [...TABLES].reverse())await db.pool.query('DROP TABLE IF EXISTS '+table);await db.close();fs.rmSync(root,{recursive:true,force:true});}};
}

module.exports={fixture,prefixPool};
