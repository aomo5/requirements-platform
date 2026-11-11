const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {validatePages,createDesignStore}=require('../lib/design-store');
const load = name => import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(__dirname,'../public/assets',name))).toString('base64'));
const nav=load('design-navigation.js'), model=load('design-model.js');
const page=(id,x=0,y=0,width=390,height=844)=>({id,name:`账户充值 · ${id}`,x,y,width,height,html:`<h1 data-wb-element="${id}">${id}</h1>`,source:'',route:''});
test('legacy states group without rewriting identities or content; explicit group persists',async()=>{
 const {pageGroups}=await nav;const pages=[page('a'),page('b')], before=JSON.stringify(pages);
 assert.equal(pageGroups(pages).length,1);assert.equal(JSON.stringify(pages),before);
 pages[1].platform='运营端';pages[1].group='付款结果';
 const saved=validatePages(pages,{path:'00-测试/画布'});assert.equal(saved[1].group,'付款结果');assert.equal(saved[1].id,'b');assert.equal(saved[1].html,pages[1].html);
 assert.throws(()=>validatePages([{...pages[0],group:''}],{path:'00-测试/画布'}),/分组/);
});
test('100 widely-spaced boards actually fit, including coordinate extremes',async()=>{
 const {fitPages}=await model;const pages=Array.from({length:100},(_,i)=>page('p'+i,(i%10)*1440,Math.floor(i/10)*2200,1340,2000));pages.push(page('edge',-100000,-100000));
 const v=fitPages(pages,600,628);
 for(const p of pages){assert.ok(p.x*v.scale+v.x>=0);assert.ok((p.x+p.width)*v.scale+v.x<=600);assert.ok(p.y*v.scale+v.y>=0);assert.ok((p.y+p.height)*v.scale+v.y<=628);}
 assert.ok(v.scale<.1);
});
test('multi-move clamps the common delta and maintains relative positions',async()=>{
 const {movePages}=await nav,pages=[page('a',99990,0),page('b',99980,20)];movePages(pages,500,-10);
 assert.deepEqual(pages.map(p=>[p.x,p.y]),[[100000,-10],[99990,10]]);
});
test('alignment/distribution affect only selection; undo and redo restore all pages',async()=>{
 const {organizePages}=await nav,{createEditHistory}=await model,pages=[page('a',0,0),page('b',800,200),page('c',1600,400),page('untouched',2500,600)];
 const h=createEditHistory(pages);organizePages(pages.slice(0,3),'top');h.record(pages);assert.equal(pages[2].y,0);assert.equal(pages[3].y,600);
 assert.equal(h.undo()[2].y,400);assert.equal(h.redo()[2].y,0);
 organizePages(pages.slice(0,3),'distributeX');assert.equal(pages[1].x,800);
});
test('tree reorder moves selected pages into a group while preserving HTML, IDs and routes',async()=>{
 const {reorderPages}=await nav;const a=page('a'),b=page('b'),c=page('c');const result=reorderPages([a,b,c],['c'],'a',{platform:'Web 后台',group:'账户'});
 assert.deepEqual(result.map(p=>p.id),['c','a','b']);assert.equal(result[0].html,c.html);assert.equal(result[0].group,'账户');assert.equal(result[0].route,'');
});
test('snap respects screen tolerance and returns guide coordinates',async()=>{
 const {snapDelta}=await nav;const result=snapDelta([page('a',0,0)],[page('b',500,0)],108,40,6);
 assert.equal(result.dx,110);assert.ok(result.guides.some(g=>g.axis==='x'&&g.at===500));
});
test('100-page geometry edits retain 30 undo steps without counting shared HTML repeatedly',async()=>{
 const {createEditHistory}=await model;const pages=Array.from({length:100},(_,i)=>({...page('p'+i),html:'x'.repeat(20000)+i}));const h=createEditHistory(pages);
 for(let i=1;i<=31;i++){pages[0].x=i;h.record(pages);}
 let count=0;while(h.undo())count++;assert.equal(count,30);
});
test('snap holds a nearby target through small jitter, releases it, and ignores distant boards',async()=>{
 const {snapDelta}=await nav, moving=[page('a',0,0,100,100)], targets=[page('near',200,0,100,100),page('competing',204,0,100,100),page('far',201,5000,100,100)];
 const first=snapDelta(moving,targets,99,20,6,{maxDistance:240});assert.equal(first.dx,100);
 const held=snapDelta(moving,targets,105,20,6,{maxDistance:240,previous:first.guides});assert.equal(held.dx,100);
 const released=snapDelta(moving,targets,110,20,6,{maxDistance:240,previous:held.guides});assert.equal(released.dx,104);
 const remote=snapDelta(moving,[targets[2]],99,20,6,{maxDistance:240});assert.equal(remote.dx,99);assert.equal(remote.guides.length,0);
 assert.ok(first.guides.every(g=>Number.isFinite(g.from)&&Number.isFinite(g.to)&&g.to<5000));
 assert.deepEqual(snapDelta(moving,targets.toReversed(),99,20,6,{maxDistance:240}),first);
});
test('snap tolerance is in screen pixels and guides match the rounded position',async()=>{
 const {snapDelta,movePages}=await nav;
 for(const scale of [.25,1,4]){
  const moving=[page('a',0,0,101,101)],target=page('b',500,0,100,100);
  const r=snapDelta(moving,[target],399-5/scale,30,6/scale);assert.equal(r.dx,399);
  movePages(moving,r.dx,r.dy);
  for(const g of r.guides){const p=moving[0],values=g.axis==='x'?[p.x,p.x+p.width/2,p.x+p.width]:[p.y,p.y+p.height/2,p.y+p.height];assert.ok(values.includes(g.at));}
  assert.equal(snapDelta([page('a',0,0,101,101)],[target],399-7/scale,30,6/scale).guides.filter(g=>g.axis==='x').length,0);
 }
});
test('zoom preserves the pointer anchor and clamps extremes without drift',async()=>{
 const {zoomAt}=await nav,view={x:-120,y:60,scale:.4},anchor={x:321,y:187};
 for(const requested of [.000001,.25,1,40]){
  const next=zoomAt(view,requested,anchor.x,anchor.y);
  assert.ok(next.scale>=.0001&&next.scale<=4);
  assert.ok(Math.abs((anchor.x-next.x)/next.scale-(anchor.x-view.x)/view.scale)<1e-6);
  assert.ok(Math.abs((anchor.y-next.y)/next.scale-(anchor.y-view.y)/view.scale)<1e-6);
 }
 const back=zoomAt(zoomAt(view,2,anchor.x,anchor.y),view.scale,anchor.x,anchor.y);assert.ok(Math.abs(back.x-view.x)<1e-10);assert.ok(Math.abs(back.y-view.y)<1e-10);
});
test('wheel normalizes units, horizontal shift and bounded zoom gestures',async()=>{
 const {canvasWheel}=await nav;
 assert.deepEqual(canvasWheel({deltaY:2,deltaMode:1,shiftKey:true},600),{dx:32,dy:0,zoom:false,factor:1});
 assert.equal(canvasWheel({deltaY:1,deltaMode:2},600).dy,600);
 const pinch=canvasWheel({deltaY:-3,ctrlKey:true},600);assert.ok(pinch.zoom&&pinch.factor>1&&pinch.factor<1.01);
 assert.equal(canvasWheel({deltaY:100000,ctrlKey:true},600).factor,canvasWheel({deltaY:200,ctrlKey:true},600).factor);
 assert.deepEqual(canvasWheel({deltaX:12,deltaY:5,shiftKey:true},600),canvasWheel({deltaX:12,deltaY:5},600));
});
