'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core'),{renderMarkdown}=require('../lib/markdown');
const exe=[process.env.WORKBENCH_BROWSER_EXECUTABLE, process.env.WORKBENCH_CHROMIUM_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome', chromium.executablePath()].find(file=>file && fs.existsSync(file));
const publicDir=path.join(__dirname,'../public');
test('page notes and overview save with design, survive reload, share across states and expose read-only history',{skip:!exe,timeout:30000},async t=>{
 const topic='00-test/unified-design';let workspace={schemaVersion:1,revision:1,pages:[{id:'main',name:'账户',width:1280,height:900,x:0,y:0,html:'<h1>账户</h1>',source:'',route:'',description:'# 账户说明\n\n原规则'},{id:'state',name:'账户只读',width:1280,height:900,x:1500,y:0,html:'<h1>账户只读</h1>',source:'',route:'',descriptionPageId:'main'},{id:'planned',name:'待设计页面',width:390,height:900,x:3000,y:0,html:'',source:'',route:'',status:'planned'}],overview:'总路径'};const writes=[];
 const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://local'),json=v=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v))};
  if(u.pathname==='/api/tree')return json({modules:[{module:'00-test',features:[{path:topic,feature:'合并设计'}]}]});
  if(u.pathname==='/api/design'){
   if(req.method==='PUT'){let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);if(b.expectedRevision!==workspace.revision){res.statusCode=409;return json({error:'版本冲突'})}workspace={...workspace,revision:workspace.revision+1,pages:b.pages,overview:b.overview};writes.push(structuredClone(workspace));}
   return json({workspace,entry:{path:topic,feature:'合并设计',prototypes:[]},canEdit:true,accessMode:'team'});
  }
  if(u.pathname==='/api/design/description'){const p=workspace.pages.find(p=>p.id===u.searchParams.get('page')),o=p?.descriptionPageId?workspace.pages.find(x=>x.id===p.descriptionPageId):p;return json({html:renderMarkdown(p?o.description||'':workspace.overview||'')});}
  if(u.pathname==='/api/design/versions')return json({versions:[{revision:workspace.revision,pageCount:3,updatedAt:'2026-11-12',current:true}]});
  if(u.pathname==='/api/design/documents'){if(u.searchParams.has('revision'))return json({html:'<p>迁移前的规则</p>'});if(u.searchParams.has('file'))return json({name:'原页面说明',versions:[{revision:1,updatedAt:'2026-11-12'}]});return json({documents:[{file:topic+'/页面设计/账户.md',name:'原页面说明',migration:{target:'page'}}]});}
  if(u.pathname.startsWith('/api/'))return json({workspace:{schemaVersion:1,revision:0,notes:[]},rules:[]});
  const f=u.pathname==='/design'?path.join(publicDir,'design.html'):path.resolve(publicDir,'.'+u.pathname);if(!f.startsWith(publicDir+path.sep)||!fs.existsSync(f)){res.statusCode=404;return res.end()}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.mjs':'text/javascript'})[path.extname(f)]||'text/plain');res.end(fs.readFileSync(f));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const browser=await chromium.launch({headless:true,executablePath:exe});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1421,height:900}}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 const url=`http://127.0.0.1:${server.address().port}/design?standalone=1&path=${encodeURIComponent(topic)}&page=state`;
 await page.goto(url);await page.locator('#pageDescriptionButton').click();await page.locator('#descriptionBody').getByText('原规则',{exact:true}).waitFor();await page.locator('#descriptionEdit').click();await page.locator('#descriptionEditor').fill('# 当前账户说明\n\n已整合规则');await page.locator('#descriptionSave').click();await page.locator('#descriptionDialog').waitFor({state:'hidden'});
 assert.equal(workspace.pages[0].description,'# 当前账户说明\n\n已整合规则');assert.equal(workspace.pages[1].description,undefined);assert.equal(workspace.pages[1].descriptionPageId,'main');
 await page.locator('#designOverviewButton').click();await page.locator('#descriptionEdit').click();await page.locator('#descriptionEditor').fill('最新跨页路径');await page.locator('#descriptionSave').click();await page.locator('#descriptionDialog').waitFor({state:'hidden'});assert.equal(workspace.overview,'最新跨页路径');
 await page.reload();await page.locator('#designOverviewButton').click();await page.locator('#descriptionBody').getByText('最新跨页路径',{exact:true}).waitFor();await page.locator('#descriptionDialog .dialog-heading [data-close]').click();
 await page.locator('#pageList .group-name').filter({hasText:'待设计页面'}).click();assert.equal(await page.locator('#previewButton').isDisabled(),true);assert.equal(await page.locator('#pageDesignStatus').inputValue(),'planned');
 await page.locator('#versionsButton').click();await page.getByRole('button',{name:'查看记录',exact:true}).click();await page.locator('#descriptionBody').getByText('迁移前的规则',{exact:true}).waitFor();assert.equal(await page.locator('#descriptionEdit').isVisible(),false);
 assert.deepEqual(errors,[]);assert.equal(writes.length,2);
});
