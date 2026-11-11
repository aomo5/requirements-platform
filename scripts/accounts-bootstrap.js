#!/usr/bin/env node
'use strict';
// Input is read from stdin, never password arguments or committed configuration.
const mysql=require('mysql2/promise');
const {databaseConfig,ensureWorkspace}=require('../lib/storage-config');
const {Accounts}=require('../lib/accounts');
const {scanRequirements}=require('../lib/scan');
(async()=>{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
 const input=JSON.parse(Buffer.concat(chunks).toString());
 const pool=mysql.createPool(databaseConfig());
 try{const accounts=new Accounts(pool);await accounts.init();
  const root=ensureWorkspace();
  const [[control]]=await pool.query('SELECT root_path FROM wb_control WHERE id=1');
  if(control.root_path!==root)throw new Error('数据库与需求目录不匹配，未设置归属');
  const [rows]=await pool.query('SELECT path FROM wb_entries');
  const paths=[...new Set([...rows.map(r=>r.path),...scanRequirements(root).modules.flatMap(m=>m.features.map(e=>e.path))])];
  const user=await accounts.create(input,paths);
  console.log(JSON.stringify({username:user.username,assignedRequirements:paths.length}));
 }finally{await pool.end();}
})().catch(e=>{console.error(e.status?e.message:'初始化失败，请检查配置与输入；未自动重试');process.exitCode=1;});
