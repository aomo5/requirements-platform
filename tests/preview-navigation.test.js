const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const modulePromise=import('../public/assets/preview-navigation.mjs');
const config={origin:'http://127.0.0.1:8125',entryPath:'20-收费管理/设备收费',pages:[{id:'bill-detail',source:'20-收费管理/设备收费/原型设计/review.html'}]};
const href=config.origin+'/preview/'+encodeURI(config.pages[0].source)+'?ac=B&ro=1#bill-detail';
test('same entry and source resolve with account context; unknown/cross-origin/cross-entry links do not',async()=>{
  const {resolvePreviewTarget}=await modulePromise;
  assert.deepEqual(resolvePreviewTarget(href,config),{id:'bill-detail',query:'ac=B&ro=1'});
  assert.deepEqual(resolvePreviewTarget(href,{...config,pages:[{id:'bill-detail'}],sources:[config.pages[0].source]}),{id:'bill-detail',query:'ac=B&ro=1'});
  assert.equal(resolvePreviewTarget(href,{...config,pages:[{id:'bill-detail'}]}),null);
  for(const invalid of [href.replace('127.0.0.1','evil.example'),href.replace('review.html','different.html'),href.replace('#bill-detail','#unknown'),href.replace('/preview/','/api/'),'javascript:alert(1)'])assert.equal(resolvePreviewTarget(invalid,config),null);
});
test('sandbox bridge passes navigation intent only and safely preserves query text',async()=>{
  const {previewBridgeScript}=await modulePromise;const sent=[],context={URL,window:{},parent:{postMessage:(...args)=>sent.push(args)}};
  const script=previewBridgeScript(config,'ac=B&value=</script>','frame-token');assert(!script.includes('</script>'));
  vm.runInNewContext(script,context);assert.equal(context.window.__workbenchPreviewSearch,'ac=B&value=</script>');
  assert.equal(context.window.workbenchNavigate(href),true);assert.equal(sent.length,1);assert.equal(sent[0][0].token,'frame-token');assert.equal(sent[0][1],config.origin);
  assert.equal(context.window.workbenchNavigate('https://outside.example'),false);assert.equal(sent.length,1);
});
