"use strict";
const {ensureWorkspace}=require('../lib/storage-config');
const fs=require('fs'),path=require('path');
const {MysqlStorage}=require('../lib/mysql-storage'),{scanRequirements}=require('../lib/scan');
const transfer=require('../lib/storage-transfer');
const root=ensureWorkspace();
const command=process.argv[2], args=process.argv.slice(3);
function arg(name){const i=args.indexOf(name);return i<0?null:args[i+1];}
(async()=>{
  if(command==='backup'){const output=arg('--output');if(!output)throw new Error('backup --output <全新目录>');const result=transfer.backup(root,path.resolve(output));console.log(JSON.stringify({output,files:result.files.length}));return;}
  const db=new MysqlStorage(root,()=>scanRequirements(root));
  try {
    if(command==='init'){
      await db.init({allowUnmigrated:true});
      const initialized=await db.transaction(async(c,control)=>{
        if(control.migrated)return false;
        const [entries]=await c.query('SELECT id FROM wb_entries LIMIT 1');
        if(entries.length)throw new Error('需求目录或数据库已有数据，请使用备份迁移');
        await c.execute('UPDATE wb_control SET migrated=1,root_path=? WHERE id=1',[db.root]);
        await c.query('UPDATE wb_document_control SET migrated=1 WHERE id=1');
        await c.query('UPDATE wb_supporting_control SET migrated=1 WHERE id=1');
        return true;
      });
      console.log(initialized?'已初始化空工作台数据库':'数据库已初始化');
      return;
    }
    await db.init({allowUnmigrated:command==='migrate',allowMaintenance:['verify','export','rollback'].includes(command)});let result;
    if(command==='migrate'){const backup=arg('--backup');if(!backup)throw new Error('migrate --backup <已核验备份>');result=await transfer.migrate(db,path.resolve(backup));result.verification=await transfer.verify(db);}
    else if(command==='verify')result=await transfer.verify(db);
    else if(command==='export'||command==='rollback'){
      const output=arg('--output');if(!output)throw new Error(`${command} --output <全新目录>`);
      if(command==='rollback'&&!args.includes('--apply'))throw new Error('撤回将冻结数据库、导出最新数据并切回文件；完成服务停机后使用 --apply');
      result=command==='export'?await transfer.exportData(db,path.resolve(output)):await transfer.rollback(db,path.resolve(output),process.env.WORKBENCH_MODE_FILE||path.join(__dirname,'../.storage-mode.json'));
      delete result.baseline;
    } else if(command==='activate'){
      result=await transfer.verify(db);
      const [[state]]=await db.pool.query('SELECT maintenance FROM wb_control WHERE id=1');if(state.maintenance)throw new Error('数据库已冻结，需先核对撤回后数据，禁止直接重新激活旧库');
      fs.writeFileSync(process.env.WORKBENCH_MODE_FILE||path.join(__dirname,'../.storage-mode.json'),JSON.stringify({mode:'mysql',at:new Date().toISOString()},null,2));
      const envFile=process.env.WORKBENCH_ENV_FILE||path.join(__dirname,'../.env');
      if(fs.existsSync(envFile)){let env=fs.readFileSync(envFile,'utf8');env=/^WORKBENCH_STORAGE=/m.test(env)?env.replace(/^WORKBENCH_STORAGE=.*$/m,'WORKBENCH_STORAGE=mysql'):env+'\nWORKBENCH_STORAGE=mysql\n';fs.writeFileSync(envFile,env,{mode:0o600});}
      result.mode='mysql';result.restartRequired=true;
    } else throw new Error('使用 init / backup / migrate / verify / export / rollback / activate');
    console.log(JSON.stringify(result,null,2));
  } finally {await db.close();}
})().catch(error=>{console.error(error.status?error.message:error.code||error.message);process.exitCode=1;});
