"use strict";

const { ensureWorkspace } = require("./lib/storage-config");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { renderMarkdown } = require("./lib/markdown");
const { findEntryByPath, scanRequirements, toPosixPath } = require("./lib/scan");
const { createDesignStore, createDesignHandler, canEdit } = require("./lib/design-store");
const { createFlowStore, createFlowHandler } = require("./lib/flow-store");
const { createFlowBatchHandler } = require("./lib/flow-batch");
const { createDesignBatchHandler } = require("./lib/design-batch");
const { createAnnotationStore, createAnnotationHandler } = require("./lib/annotation-store");
const { readableDocument, rewriteDocumentLinks, listedDocument } = require("./lib/document-links");
const { decorateRequirementRules, readRequirementRules } = require("./lib/requirement-rules");
const { createDocumentHandler } = require("./lib/document-handler");
const { createEntryService, createEntryHandler } = require("./lib/entry-create");
const { createDesignExportHandler } = require("./lib/design-export");
const { createDesignDocumentsHandler, designDocumentUrl } = require("./lib/design-documents");
const { createAiContext, createAiHandler } = require("./lib/ai-context");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8125);
const DESIGN_ACCESS = process.env.DESIGN_ACCESS || "local";
const PORTAL_ROOT = __dirname;
const REQUIREMENTS_ROOT = ensureWorkspace();
const PUBLIC_ROOT = fs.realpathSync(path.join(PORTAL_ROOT, "public"));
const PROTOTYPE_SEGMENT = "/原型设计/";
const AUTH_REQUIRED = process.env.WORKBENCH_AUTH === "required";
const { Accounts, createAccountHandler, cookieToken, jsonBody } = require('./lib/accounts');
let accounts, accountHandler, aiReadLinks, testHandler, testModule, flowRouteHandler;
const instanceId = require("crypto").randomUUID();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, contentType, body) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function safeResolve(rootDir, relativePath) {
  const decodedPath = decodeURIComponent(relativePath || "");
  const targetPath = path.resolve(rootDir, decodedPath);
  const withinRoot = file => {
    const relative = path.relative(rootDir, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!withinRoot(targetPath)) return null;
  return fs.existsSync(targetPath) && !withinRoot(fs.realpathSync(targetPath)) ? null : targetPath;
}

function serveFile(response, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(response, 404, "text/plain; charset=utf-8", "Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(response);
}

function getAttachmentFileName(filePath) {
  const baseName = path.basename(filePath);
  const asciiFallback = baseName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `attachment; filename="${asciiFallback || "document.md"}"; filename*=UTF-8''${encodeURIComponent(baseName)}`;
}

function isDownloadableDoc(relativeFile) {
  if (!/\.md$/i.test(relativeFile || "")) {
    return false;
  }

  const normalizedFile = relativeFile.replace(/\\/g, "/");
  const tree = currentTree();
  return tree.modules.some((moduleNode) =>
    moduleNode.features.some((entry) => listedDocument(entry, normalizedFile))
  );
}

function serveDownload(response, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(response, 404, "text/plain; charset=utf-8", "Not Found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": getAttachmentFileName(filePath),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(response);
}

function currentTree() {
  return scanRequirements(REQUIREMENTS_ROOT);
}

async function handleTree(request, response) {
  const tree = database ? await database.decorateTree(currentTree()) : currentTree();
  if (accounts) for (const module of tree.modules) for (const entry of module.features) {
    entry.owner = await accounts.owner(entry.path);
    entry.canEdit = entry.owner?.id === request.accountAccess.user.id;
  }
  sendJson(response, 200, { ...tree, accountsEnabled: !!accounts, canArchive: !!database && canEdit(request, DESIGN_ACCESS), canCreate: canEdit(request, DESIGN_ACCESS), canEditDocuments: !!database && canEdit(request, DESIGN_ACCESS) });
}

async function handleEntry(request, response, requestUrl) {
  const entryPath = requestUrl.searchParams.get("path");
  if (!entryPath) {
    sendJson(response, 400, { error: "Missing path query parameter" });
    return;
  }

  const tree = database ? await database.decorateTree(currentTree()) : currentTree();
  const entry = findEntryByPath(tree, entryPath);
  if (!entry) {
    sendJson(response, 404, { error: "Entry not found" });
    return;
  }

  sendJson(response, 200, { entry: accounts ? {...entry, owner: await accounts.owner(entry.path), canEdit: await accounts.owns(entry.path, request.accountAccess.user)} : entry });
}

async function handleDoc(request, response, requestUrl) {
  const requestedFile = requestUrl.searchParams.get("file");
  if (!requestedFile) {
    sendJson(response, 400, { error: "Missing file query parameter" });
    return;
  }

  const tree = database ? await database.decorateTree(currentTree()) : currentTree();
  const document = readableDocument(REQUIREMENTS_ROOT, tree, requestedFile);
  if (!document) {
    sendJson(response, 404, { error: "Document not found" });
    return;
  }

  const migrated = document.entry.designDocuments?.find(item => item.file === document.file);
  if (migrated) {
    sendJson(response, 200, { redirect: designDocumentUrl(document.entry.path, migrated), designTarget: migrated });
    return;
  }

  const primary = database && document.entry.docs?.requirement === document.file;
  const stored = database && (primary || document.entry.documentFiles?.[document.file]) ? await database.readDocumentFile(document.entry.path,document.file) : null;
  const raw = stored?.content ?? fs.readFileSync(document.fullPath, "utf8");
  const documentDir = path.posix.dirname(document.file);
  const resolveAssetUrl = (assetPath) => {
    const normalizedAssetPath = assetPath.replace(/^\.?\//, "");
    const relativeAssetPath = toPosixPath(path.posix.normalize(path.posix.join(documentDir, normalizedAssetPath)));
    return `/preview/${encodeURI(relativeAssetPath)}`;
  };
  const rendered = rewriteDocumentLinks(renderMarkdown(raw, { resolveAssetUrl }), { root: REQUIREMENTS_ROOT, tree, sourceFile: document.file });
  const requirement = document.entry.docs?.requirement === document.file
    ? decorateRequirementRules(rendered, document.file) : { html: rendered, rules: [] };
  sendJson(response, 200, {
    file: document.file,
    entryPath: document.entry.path,
    title: path.posix.basename(document.file, path.posix.extname(document.file)),
    content: raw,
    ...(stored?.storage === "mysql" ? {storage:"mysql",revision:stored.revision,updatedAt:stored.updatedAt,editorContent:stored.editorContent,canEdit:canEdit(request,DESIGN_ACCESS)} : {}),
    html: requirement.html,
    rules: requirement.rules,
  });
}

async function handleDocDownload(response, requestUrl) {
  const requestedFile = requestUrl.searchParams.get("file");
  if (!requestedFile) {
    sendText(response, 400, "text/plain; charset=utf-8", "Missing file query parameter");
    return;
  }

  const tree=database ? await database.decorateTree(currentTree()) : currentTree();
  const document = readableDocument(REQUIREMENTS_ROOT, tree, requestedFile);
  const migrated = document?.entry.designDocuments?.find(item => item.file === document.file);
  if (migrated) {
    response.writeHead(302, { Location: designDocumentUrl(document.entry.path, migrated), "Cache-Control": "no-store" });
    response.end();
    return;
  }
  if (!document || !tree.modules.some(m=>m.features.some(e=>(Object.values(e.docs||{}).includes(document.file)||(e.pageDesigns||[]).some(d=>d.path===document.file)||(e.referenceDocuments||[]).some(d=>d.path===document.file))))) {
    sendText(response, 403, "text/plain; charset=utf-8", "Forbidden");
    return;
  }

  if(database && (document.entry.docs?.requirement===document.file || document.entry.documentFiles?.[document.file])){
    const stored=await database.readDocumentFile(document.entry.path,document.file);
    if(stored?.storage==='mysql'){response.writeHead(200,{"Content-Type":"text/markdown; charset=utf-8","Content-Disposition":getAttachmentFileName(document.file),"Cache-Control":"no-store"});response.end(stored.content);return;}
  }
  serveDownload(response, document.fullPath);
}

function handlePreview(response, requestPath) {
  const relativePath = requestPath.replace(/^\/preview\/?/, "");
  const normalizedRelativePath = decodeURIComponent(relativePath).replace(/\\/g, "/");
  if (!normalizedRelativePath.includes(PROTOTYPE_SEGMENT)) {
    sendText(response, 403, "text/plain; charset=utf-8", "Forbidden");
    return;
  }

  const fullPath = safeResolve(REQUIREMENTS_ROOT, relativePath);
  if (!fullPath) {
    sendText(response, 403, "text/plain; charset=utf-8", "Forbidden");
    return;
  }

  // A standalone prototype must not inherit the signed-in workbench origin.
  response.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups');
  response.setHeader('Referrer-Policy', 'no-referrer');
  serveFile(response, fullPath);
}

function handlePublic(response, requestPath) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath === "/design" ? "/design.html" : requestPath === "/flow" ? "/flow.html" : requestPath;
  const relativePath = normalizedPath.replace(/^\/assets\//, "assets/").replace(/^\//, "");
  const filePath = safeResolve(PUBLIC_ROOT, relativePath);
  if (!filePath) {
    sendText(response, 403, "text/plain; charset=utf-8", "Forbidden");
    return;
  }

  serveFile(response, filePath);
}

let giteeHandler;
let entryCreateHandler, documentHandler, designExportHandler, designDocumentsHandler, aiHandler;
let database = null, designStore, flowStore, annotationStore, designHandler, designBatchHandler, flowHandler, flowBatchHandler, annotationHandler;
const modeFile = process.env.WORKBENCH_MODE_FILE || path.join(PORTAL_ROOT, ".storage-mode.json");
const storageMode = fs.existsSync(modeFile) ? JSON.parse(fs.readFileSync(modeFile, "utf8")).mode : (process.env.WORKBENCH_STORAGE || "files");
if (!["mysql", "files"].includes(storageMode)) throw new Error("无效的工作台存储模式");
async function initialize() {
  if (storageMode === "mysql") {
    const { MysqlStorage } = require("./lib/mysql-storage");
    database = new MysqlStorage(REQUIREMENTS_ROOT, currentTree);
    await database.init();
    designStore = database.store("design"); flowStore = database.store("flow"); annotationStore = database.store("annotations");
  } else {
    designStore = createDesignStore(REQUIREMENTS_ROOT, p => findEntryByPath(currentTree(), p));
    flowStore = createFlowStore(REQUIREMENTS_ROOT, p => findEntryByPath(currentTree(), p), () => currentTree().modules.flatMap(m=>m.features));
    annotationStore = createAnnotationStore(REQUIREMENTS_ROOT, p => findEntryByPath(currentTree(), p), {
      readDesign: p => designStore.read(p), readFlows: p => flowStore.read(p), readRules: p => readRequirementRules(REQUIREMENTS_ROOT, currentTree(), p),
    });
  }
  if (AUTH_REQUIRED) {
    if (!database) throw new Error('账号权限模式需要 MySQL 存储');
    accounts = new Accounts(database.pool); await accounts.init();
    accountHandler = createAccountHandler(accounts, sendJson);
  }
  const {TestModule,createTestHandler}=require('./lib/test-module');
  const {ApifoxExecutor}=require('./lib/test-executor');
  let tests=null;
  if(database){
    tests=new TestModule(database,new ApifoxExecutor({cli:process.env.APIFOX_CLI_PATH,configFile:process.env.APIFOX_EXECUTOR_CONFIG || path.join(PORTAL_ROOT,'.secrets/apifox-executor.json'),root:path.join(PORTAL_ROOT,'.runtime/apifox')}),{instanceId,version:require('./package.json').version});
    await tests.init();testModule=tests;
  }
  testHandler=createTestHandler(tests,sendJson,DESIGN_ACCESS);
  flowRouteHandler=await require('./lib/flow-route-service').createRouteService({
    db:database,store:flowStore,root:REQUIREMENTS_ROOT,tests,accessMode:DESIGN_ACCESS,sendJson,
  });
  const { createGiteeHandler } = require("./lib/gitee-handler");
  let sync = null;
  if (database && process.env.GITEE_SYNC_ENABLED === "true") {
    const { GiteeStore } = require("./lib/gitee-store");
    const { GiteeSync } = require("./lib/gitee-sync");
    const store = new GiteeStore(database); await store.init(); await store.recover();
    sync = new GiteeSync({root:REQUIREMENTS_ROOT,store,getTree:currentTree,documents:database,secretFile:process.env.GITEE_SECRET_FILE || path.join(PORTAL_ROOT,".secrets/gitee-token")});
  }
  giteeHandler = createGiteeHandler(sync,sendJson,accounts);
  designHandler = createDesignHandler(designStore, sendJson, { accessMode: DESIGN_ACCESS });
  designExportHandler = createDesignExportHandler(designStore, { root: REQUIREMENTS_ROOT, publicRoot: PUBLIC_ROOT, sendJson });
  flowHandler = createFlowHandler(flowStore, sendJson, { accessMode: DESIGN_ACCESS });
  flowBatchHandler = createFlowBatchHandler(database, sendJson, { accessMode: DESIGN_ACCESS });
  designBatchHandler = createDesignBatchHandler(database, sendJson, { accessMode: DESIGN_ACCESS });
  annotationHandler = createAnnotationHandler(annotationStore, sendJson, { accessMode: DESIGN_ACCESS });
  documentHandler = createDocumentHandler(database,sendJson,{accessMode:DESIGN_ACCESS});
  designDocumentsHandler = createDesignDocumentsHandler(database, sendJson, {
    root: REQUIREMENTS_ROOT,
    designStore,
    getTree: () => database ? database.decorateTree(currentTree()) : currentTree(),
  });
  const aiContext = createAiContext({ root: REQUIREMENTS_ROOT,
    getTree: () => database ? database.decorateTree(currentTree()) : currentTree(),
    flowStore, annotationStore, designStore,
    readDocument: (entry, file) => database && (entry.documentFiles?.[file] || entry.docs?.requirement === file)
      ? database.readDocumentFile(entry.path, file) : null,
  });
  aiHandler = createAiHandler(aiContext,sendJson);
  aiReadLinks = require('./lib/ai-read-links').createAiReadLinks(aiContext);
  entryCreateHandler = createEntryHandler(createEntryService(REQUIREMENTS_ROOT, {
    persistDocuments: !database,
    register: async (entry, actor) => {
      if (database) await database.registerEntryDocuments(entry, {afterWrite: c => accounts ? accounts.claim(entry.path, actor, c) : Promise.resolve()});
    },
  }), sendJson, { accessMode: DESIGN_ACCESS });
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${HOST}:${PORT}`);
    const requestPath = requestUrl.pathname;

    if (accounts && (requestPath==='/api/auth/setup-info' || requestPath==='/api/auth/setup')) {
      try {
        if(!canEdit(request,'local'))throw Object.assign(new Error('请在平台所在电脑打开初始化页面'),{status:403});
        if(await accounts.ready())throw Object.assign(new Error('账号已初始化'),{status:409});
        const configFile=process.env.WORKBENCH_SETUP_FILE || path.join(PORTAL_ROOT,'.secrets/account-setup.json');
        if(!fs.existsSync(configFile))throw Object.assign(new Error('尚未配置初始化入口'),{status:409});
        const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
        if(request.method==='GET' && requestPath==='/api/auth/setup-info') {sendJson(response,200,config);return;}
        if(request.method!=='POST' || requestPath!=='/api/auth/setup') {sendJson(response,405,{error:'不支持的方法'});return;}
        const body=await jsonBody(request);
        if(typeof config.token!=='string' || body.token!==config.token)throw Object.assign(new Error('初始化凭证无效'),{status:403});
        const tree=await database.decorateTree(currentTree());
        const user=await accounts.create({username:config.username,displayName:config.displayName,password:body.password},tree.modules.flatMap(m=>m.features.map(e=>e.path)));
        try {fs.unlinkSync(configFile);} catch { /* Initialization is already closed transactionally. */ }
        sendJson(response,200,{user});
      } catch(e){sendJson(response,e.status||500,{error:e.status?e.message:'初始化失败，请重试'});}return;
    }
    if (requestPath==='/setup') {
      if(!accounts || !canEdit(request,'local')){sendJson(response,403,{error:'请在平台所在电脑打开初始化页面'});return;}
      serveFile(response,path.join(PUBLIC_ROOT,'setup.html'));return;
    }
    if (accounts && requestPath==='/api/auth/ai-link'  && request.method==='POST') {
      const user=await accounts.user(cookieToken(request));
      if(!user){sendJson(response,401,{error:'请先登录'});return;}
      try {const body=await jsonBody(request);sendJson(response,200,await aiReadLinks.issue(user,new URLSearchParams(body)));}
      catch(e){sendJson(response,e.status||500,{error:e.status?e.message:'AI 链接生成失败'});}return;
    }
    if (accounts && requestPath.startsWith('/api/ai/') && request.method==='GET' && requestUrl.searchParams.has('aiToken')) {
      try{sendJson(response,200,await aiReadLinks.read(requestUrl));}
      catch(e){sendJson(response,e.status||500,{error:e.status?e.message:'AI 资料读取失败'});}return;
    }
    if (requestPath.startsWith('/api/auth/')) {
      if (accounts) await accountHandler(request,response,requestUrl);
      else sendJson(response,200,{enabled:false,user:null});
      return;
    }
    if (requestPath === '/login') { serveFile(response,path.join(PUBLIC_ROOT,'login.html'));return; }
    if (accounts && !requestPath.startsWith('/assets/') && requestPath !== '/api/storage/health') {
      const user=await accounts.user(cookieToken(request));
      if(!user) {
        if(requestPath.startsWith('/api/'))sendJson(response,401,{error:'请先登录'});
        else {response.writeHead(302,{Location:'/login?returnTo='+encodeURIComponent(request.url||'/')});response.end();}
        return;
      }
      const p=requestUrl.searchParams.get('path');
      const creating=requestPath==='/api/entries' && request.method==='POST';
      if(requestPath==='/api/entry-state/import') {sendJson(response,403,{error:'账号模式不支持批量导入旧归档状态'});return;}
      const canWrite=p ? await accounts.owns(p,user) : creating || requestPath==='/api/tree';
      request.accountAccess={user,canEdit:canWrite};
      // Unknown/global writes fail closed. Gitee validates every target after reading its body.
      if(!['GET','HEAD'].includes(request.method) && !requestPath.startsWith('/api/gitee/') && !canWrite) {
        sendJson(response,403,{error:'只有需求创建者可以修改此需求'});return;
      }
    }
    if (requestPath.startsWith("/api/ai/")) { await aiHandler(request, response, requestUrl); return; }

    if (requestPath.startsWith("/api/gitee/")) { await giteeHandler(request,response,requestUrl); return; }

    if (requestPath === "/api/storage/health" && request.method === "GET") {
      if (database) await database.pool.query("SELECT 1");
      sendJson(response, 200, { storage: storageMode, ready: true, instanceId, pid: process.pid }); return;
    }
    if (requestPath === "/api/requirement-rules") {
      if (request.method !== "GET") sendJson(response, 405, { error: "需求规则仅支持读取" });
      else {
        try {
          const { file, rules } = database ? await database.rules(requestUrl.searchParams.get("path")) : readRequirementRules(REQUIREMENTS_ROOT, currentTree(), requestUrl.searchParams.get("path"));
          sendJson(response, 200, { file, rules, canEdit: canEdit(request, DESIGN_ACCESS) });
        } catch (error) { sendJson(response, error.status || 500, { error: error.status ? error.message : "需求规则读取失败" }); }
      }
      return;
    }

    if (requestPath === "/api/annotations" || requestPath.startsWith("/api/annotations/")) {
      void annotationHandler(request, response, requestUrl);
      return;
    }

    if (requestPath === '/api/flow-routes' || requestPath.startsWith('/api/flow-routes/')) {
      await flowRouteHandler(request,response,requestUrl);return;
    }
    if (requestPath === "/api/flows/bundle" || requestPath === "/api/flows/batch") {
      await flowBatchHandler(request, response, requestUrl);
      return;
    }

    if (requestPath === "/api/flows" || requestPath.startsWith("/api/flows/")) {
      void flowHandler(request, response, requestUrl);
      return;
    }

    if (requestPath === "/api/design/documents" || requestPath === "/api/design/description") {
      await designDocumentsHandler(request, response, requestUrl);
      return;
    }

    if (requestPath === "/api/design/bundle" || requestPath === "/api/design/batch") {
      await designBatchHandler(request, response, requestUrl);
      return;
    }

    if (requestPath === "/api/design/merge" && request.method === "POST") {
      try {
        if (!database) throw Object.assign(new Error('页面合并需要数据库存储'), {status:400});
        const body=await require('./lib/design-store').readBody(request,DESIGN_ACCESS);
        sendJson(response,200,await require('./lib/design-merge').mergePages(database,requestUrl.searchParams.get('path'),body));
      } catch(e) {sendJson(response,e.status||500,{error:e.status?e.message:'页面合并失败，原页面和关联未删除'});} return;
    }

    if (requestPath === "/api/design/export") {
      await designExportHandler(request, response, requestUrl); return;
    }
    if (requestPath === "/api/design/page") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "已保存页面仅支持读取" });
        return;
      }
      try {
        const { workspace } = await designStore.read(requestUrl.searchParams.get("path"));
        const page = workspace.pages.find((item) => item.id === requestUrl.searchParams.get("id"));
        if (!page) sendJson(response, 404, { error: "已保存的设计页面不存在" });
        else sendJson(response, 200, { page, revision: workspace.revision, updatedAt: workspace.updatedAt });
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.status ? error.message : "设计页面读取失败" });
      }
      return;
    }

    if (requestPath === "/api/design" || requestPath.startsWith("/api/design/")) {
      void designHandler(request, response, requestUrl);
      return;
    }

    if (requestPath === '/api/catalog/routes') {
      try { if(!database) throw Object.assign(new Error('路由映射需要数据库存储'),{status:503});
        const p=requestUrl.searchParams.get('path');database.find(p);
        if(request.method==='GET')sendJson(response,200,{routes:(await database.catalogRecord('related-routes'))[p]||[]});
        else if(request.method==='PUT'){const body=await require('./lib/design-store').readBody(request,DESIGN_ACCESS);sendJson(response,200,await database.saveRelatedRoutes(p,body.expectedRoutes,body.routes));}
        else sendJson(response,405,{error:'不支持的目录接口方法'});
      } catch(e){sendJson(response,e.status||500,{error:e.status?e.message:'路由映射操作失败'});}return;
    }
    if (requestPath === "/api/entry-state" || requestPath === "/api/entry-state/import") {
      await require('./lib/entry-state').createEntryStateHandler(database,sendJson,DESIGN_ACCESS)(request,response,requestUrl); return;
    }
    if (requestPath === "/api/tree") {
      await handleTree(request, response);
      return;
    }

    if (requestPath === "/api/entries") {
      await entryCreateHandler(request, response);
      return;
    }

    if (requestPath === "/api/entry") {
      await handleEntry(request, response, requestUrl);
      return;
    }

    if(requestPath==='/api/tests' || requestPath.startsWith('/api/tests/')){await testHandler(request,response,requestUrl);return;}
    if (requestPath === "/api/document" || requestPath.startsWith("/api/document/")) {
      await documentHandler(request,response,requestUrl);return;
    }
    if (requestPath === "/api/doc") {
      await handleDoc(request,response, requestUrl);
      return;
    }

    if (requestPath === "/download/doc") {
      await handleDocDownload(response, requestUrl);
      return;
    }

    if (requestPath.startsWith("/preview/")) {
      handlePreview(response, requestPath);
      return;
    }

    if (requestPath === "/" || requestPath === "/design" || requestPath === "/flow" || requestPath.startsWith("/assets/")) {
      handlePublic(response, requestPath);
      return;
    }

    sendText(response, 404, "text/plain; charset=utf-8", "Not Found");
  } catch (error) {
    sendJson(response, 500, {
      error: "Internal Server Error",
      message: error.message,
    });
  }
});

initialize().then(() => server.listen(PORT, HOST, () => {
  fs.mkdirSync(path.join(PORTAL_ROOT,".runtime"),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(PORTAL_ROOT,".runtime",`server-${PORT}.json`),JSON.stringify({pid:process.pid,instanceId,port:PORT,host:HOST,root:REQUIREMENTS_ROOT}));
  console.log(`Requirements Platform running at http://${HOST}:${PORT}/`);
  if (HOST === "0.0.0.0" || HOST === "::") {
    const addresses = Object.values(os.networkInterfaces()).flatMap((items) => items || [])
      .filter((item) => !item.internal && (item.family === "IPv4" || item.family === 4))
      .map((item) => `http://${item.address}:${PORT}/`);
    console.log(addresses.length ? `LAN access: ${addresses.join(" · ")}` : "LAN access: no active IPv4 network address found");
  }
  console.log(`Requirements root: ${REQUIREMENTS_ROOT}; storage: ${storageMode}`);
  console.log(`Design access: ${AUTH_REQUIRED ? "account owner permissions" : DESIGN_ACCESS === "team" ? "team (all visitors can edit; trusted internal network only)" : "local (remote visitors read-only)"}`);
})).catch(async error => { console.error("工作台启动失败，未回退到文件存储：", error.status ? error.message : error.code || error.message); await database?.close(); process.exitCode = 1; });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  const stopping=testModule?.shutdown();
  server.close(async () => { await stopping; await database?.close(); process.exit(0); });
  server.closeIdleConnections();
});
