"use strict";
const {fail}=require('./gitee-api');
class GiteeStore {
  constructor(database){this.db=database;}
  async init(){
    await this.db.pool.query('CREATE TABLE IF NOT EXISTS wb_gitee_sync (record_key VARCHAR(100) CHARACTER SET ascii PRIMARY KEY, payload JSON NOT NULL) ENGINE=InnoDB');
  }
  async recover(){return this.lock(async()=>{
    const [rows]=await this.db.pool.query("SELECT record_key,payload FROM wb_gitee_sync");
    for(const row of rows){const r=row.payload;if(r.state==='syncing'||r.state==='running'){if(r.runner){if(r.runner.host!==require('os').hostname())continue;try{process.kill(r.runner.pid,0);continue}catch(e){if(e.code!=='ESRCH')continue}}r.state='failed';r.error='服务重启中断了同步，请检查结果后重试';await this.put(row.record_key,r);}}
  }).catch(e=>{if(e.status===409)return {skippedBusy:true};throw e;});}
  async latestJob(){const [rows]=await this.db.pool.query("SELECT payload FROM wb_gitee_sync WHERE record_key LIKE 'job:%'");return rows.map(r=>r.payload).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')||b.id.localeCompare(a.id))[0]||null;}
  async get(key){const [[r]]=await this.db.pool.execute('SELECT payload FROM wb_gitee_sync WHERE record_key=?',[key]);return r?.payload||null;}
  async put(key,value){await this.db.transaction(c=>c.execute('INSERT INTO wb_gitee_sync VALUES (?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)',[key,JSON.stringify(value)]));return value;}
  async lock(action){
    const c=await this.db.pool.getConnection(), name=`wb-gitee:${this.db.pool.pool.config.connectionConfig.database}`;
    try {
      const [[r]]=await c.execute('SELECT GET_LOCK(?,0) AS acquired',[name]);
      if(!r.acquired)fail('已有同步或配置操作正在进行，请稍后重试',409);
      return await action();
    } finally {await c.execute('SELECT RELEASE_LOCK(?)',[name]);c.release();}
  }
}
module.exports={GiteeStore};
