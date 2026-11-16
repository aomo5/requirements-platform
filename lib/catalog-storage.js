"use strict";
const fs=require('fs'),path=require('path');
const SCHEMA=[`CREATE TABLE IF NOT EXISTS wb_catalog_records (record_key VARCHAR(100) CHARACTER SET ascii PRIMARY KEY, payload JSON NOT NULL) ENGINE=InnoDB`];
const methods={
 async catalogRecord(key,c=this.pool){const [[r]]=await c.execute('SELECT payload FROM wb_catalog_records WHERE record_key=?',[key]);return r?.payload||{};},
 async initCatalog(){
  const sources=[['gitee-status','gitee-status.json'],['related-routes','link-map.json']];
  await this.transaction(async c=>{for(const [key,name]of sources){const [[old]]=await c.execute('SELECT record_key FROM wb_catalog_records WHERE record_key=?',[key]);if(old)continue;const file=path.join(this.root,'portal/data',name);let payload={};if(fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink())throw new Error('目录数据不能为符号链接');payload=JSON.parse(fs.readFileSync(file,'utf8'));}await c.execute('INSERT INTO wb_catalog_records VALUES (?,?)',[key,JSON.stringify(payload)]);}for(const entry of this.getTree().modules.flatMap(m=>m.features))await this.entry(c,entry);});
 },
 async saveRelatedRoutes(p,expectedRoutes,routes){
  this.find(p);if(!Array.isArray(expectedRoutes)||!Array.isArray(routes)||routes.length>100||routes.some(r=>typeof r!=='string'||r.length>1000||!r.startsWith('/')))throw Object.assign(new Error('路由映射无效'),{status:400});
  return this.transaction(async c=>{const map=await this.catalogRecord('related-routes',c);if(!require('util').isDeepStrictEqual(map[p]||[],expectedRoutes))throw Object.assign(new Error('路由映射已变化，请重新读取'),{status:409});map[p]=routes;await c.execute('UPDATE wb_catalog_records SET payload=? WHERE record_key=?',[JSON.stringify(map),'related-routes']);return {routes};});
 },
};
module.exports={SCHEMA,methods};
