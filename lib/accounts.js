'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const fail = (message,status=400) => {throw Object.assign(new Error(message),{status});};
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const SCHEMA = [
 `CREATE TABLE IF NOT EXISTS wb_users (id CHAR(36) CHARACTER SET ascii PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE, display_name VARCHAR(80) NOT NULL, password_hash VARCHAR(256) CHARACTER SET ascii NOT NULL) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS wb_sessions (token_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY, user_id CHAR(36) CHARACTER SET ascii NOT NULL, expires_at BIGINT NOT NULL, FOREIGN KEY(user_id) REFERENCES wb_users(id)) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS wb_owners (path_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY, path TEXT NOT NULL, user_id CHAR(36) CHARACTER SET ascii NOT NULL, FOREIGN KEY(user_id) REFERENCES wb_users(id)) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS wb_account_control (id INT PRIMARY KEY, initialized BOOLEAN NOT NULL DEFAULT 0) ENGINE=InnoDB`
];
function credentials(input) {
 const username = typeof input.username==='string'?input.username.trim().toLowerCase():'';
 const displayName = typeof input.displayName==='string'?input.displayName.trim():username;
 if(!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) fail('账号须为 3–64 位字母、数字、点、横线或下划线');
 if(!displayName || [...displayName].length>80) fail('姓名须为 1–80 字');
 if(typeof input.password!=='string'||input.password.length<6||input.password.length>128) fail('密码须为 6–128 位');
 return {username,displayName,password:input.password};
}
async function hashPassword(password) {const salt=crypto.randomBytes(16).toString('hex');return salt+':'+(await scrypt(password,salt,64)).toString('hex');}
async function verifyPassword(password,stored) {const [salt,key]=stored.split(':');const result=await scrypt(password,salt,64);return crypto.timingSafeEqual(result,Buffer.from(key,'hex'));}
const publicUser=u=>({id:u.id,username:u.username,displayName:u.display_name});
class Accounts {
 constructor(pool) {this.pool=pool;}
 async init(){for(const sql of SCHEMA)await this.pool.query(sql);await this.pool.query('INSERT IGNORE INTO wb_account_control (id) VALUES (1)');}
 async ready(){const [[row]]=await this.pool.query('SELECT initialized FROM wb_account_control WHERE id=1');return !!row?.initialized;}
 async create(input,bootstrapPaths) {
  const v=credentials(input),user={id:crypto.randomUUID(),username:v.username,display_name:v.displayName,password_hash:await hashPassword(v.password)};
  const c=await this.pool.getConnection();
  try {await c.beginTransaction();const [[state]]=await c.query('SELECT initialized FROM wb_account_control WHERE id=1 FOR UPDATE');
   if(bootstrapPaths ? state.initialized : !state.initialized)fail(bootstrapPaths?'账号已初始化，不能重复认领':'请先由平台维护者初始化账号',409);
   await c.execute('INSERT INTO wb_users (id,username,display_name,password_hash) VALUES (?,?,?,?)',[user.id,user.username,user.display_name,user.password_hash]);
   if(bootstrapPaths) {for(const p of bootstrapPaths)await c.execute('INSERT INTO wb_owners (path_hash,path,user_id) VALUES (?,?,?)',[digest(p),p,user.id]);await c.query('UPDATE wb_account_control SET initialized=1 WHERE id=1');}
   await c.commit();return publicUser(user);
  }catch(e){await c.rollback();if(e.code==='ER_DUP_ENTRY')fail('账号已存在',409);throw e;}finally{c.release();}
 }
 async login(input) {
  if(typeof input.password!=='string'||input.password.length>128)fail('账号或密码不正确',401);
  const [[u]]=await this.pool.execute('SELECT * FROM wb_users WHERE username=?',[String(input.username||'').trim().toLowerCase().slice(0,64)]);
  // Run the same password work even for an unknown account.
  const valid=await verifyPassword(input.password,u?.password_hash||'00000000000000000000000000000000:'+ '00'.repeat(64));
  if(!u||!valid)fail('账号或密码不正确',401);return publicUser(u);
 }
 async session(user){const token=crypto.randomBytes(32).toString('hex');await this.pool.execute('INSERT INTO wb_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',[digest(token),user.id,Date.now()+7*86400000]);await this.pool.execute('DELETE FROM wb_sessions WHERE expires_at<?',[Date.now()]);return token;}
 async user(token){if(!/^[a-f0-9]{64}$/.test(token||''))return null;const [[u]]=await this.pool.execute('SELECT u.* FROM wb_users u JOIN wb_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?',[digest(token),Date.now()]);return u?publicUser(u):null;}
 async logout(token){await this.pool.execute('DELETE FROM wb_sessions WHERE token_hash=?',[digest(token||'')]);}
 async owner(p){const [[u]]=await this.pool.execute('SELECT u.id,u.username,u.display_name FROM wb_owners o JOIN wb_users u ON o.user_id=u.id WHERE o.path_hash=? AND o.path=?',[digest(p),p]);return u?publicUser(u):null;}
 async claim(p,user,c=this.pool){await c.execute('INSERT INTO wb_owners (path_hash,path,user_id) VALUES (?,?,?)',[digest(p),p,user.id]);}
 async owns(p,user){return !!user && (await this.owner(p))?.id===user.id;}
}
function cookieToken(req){return /(?:^|;\s*)wb_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
function cookie(req,token){return `wb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token?604800:0}${req.socket.encrypted?'; Secure':''}`;}
async function jsonBody(req){
 if(req.headers.origin!==`${req.socket.encrypted?'https':'http'}://${req.headers.host}`||req.headers['x-design-client']!=='workbench-v1')fail('不允许跨站请求',403);
 if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail('请使用 JSON 请求',415);
 let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384)fail('请求过大',413);chunks.push(chunk);}
 try {const b=JSON.parse(Buffer.concat(chunks).toString());if(!b||typeof b!=='object'||Array.isArray(b))throw Error();return b;}catch{fail('JSON 格式不正确');}
}
function createAccountHandler(accounts,sendJson){
 const attempts=new Map();
 return async(req,res,url)=>{try{
  const route=url.pathname;
  if(route==='/api/auth/session'&&req.method==='GET'){sendJson(res,200,{enabled:true,initialized:await accounts.ready(),user:await accounts.user(cookieToken(req))});return;}
  if(req.method!=='POST'||!['/api/auth/register','/api/auth/login','/api/auth/logout'].includes(route))fail('账号接口不存在',404);
  const body=await jsonBody(req);
  if(route==='/api/auth/logout'){await accounts.logout(cookieToken(req));res.setHeader('Set-Cookie',cookie(req,''));sendJson(res,200,{ok:true});return;}
  const now=Date.now(),key=req.socket.remoteAddress;
  for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);
  const limit=attempts.get(key)||{count:0,until:now+60000};if(++limit.count>20)fail('尝试过于频繁，请稍后重试',429);attempts.set(key,limit);
  if(!await accounts.ready())fail('请先由平台维护者初始化账号',409);
  const user=route.endsWith('/register')?await accounts.create(body):await accounts.login(body);
  res.setHeader('Set-Cookie',cookie(req,await accounts.session(user)));sendJson(res,200,{user});
 }catch(e){sendJson(res,e.status||500,{error:e.status?e.message:'账号服务暂不可用'});}};
}
module.exports={jsonBody,Accounts,createAccountHandler,cookieToken,credentials,hashPassword,verifyPassword};
