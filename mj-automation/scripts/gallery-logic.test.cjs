const test=require('node:test');
const assert=require('node:assert/strict');
const gallery=require('../control/gallery-logic.js');
const rows=[
{id:'a',name:'月夜',prompt:'quiet city',tags:['入选'],favorite:true,archived:false,version:'v7',width:1920,height:1080,createdAt:10,batchId:'first',requestedAspect:'16:9',params:{seed:0,raw:true}},
{id:'b',name:'山林',prompt:'quiet forest',tags:['入选','自然'],favorite:false,archived:false,version:'v7',width:1080,height:1920,createdAt:20,batchId:'first',requestedAspect:'9:16',params:{seed:3}},
{id:'c',name:'历史',prompt:null,tags:[],favorite:true,archived:true,version:null,createdAt:30,batchId:'other'}];
test('composed filters and word search preserve the source collection',()=>{
const before=JSON.stringify(rows);
assert.deepEqual(gallery.filter(rows,{status:'all',tag:'入选',version:'v7',shape:'portrait',search:'quiet forest',batch:'first'}).map(a=>a.id),['b']);
assert.deepEqual(gallery.filter(rows,{status:'favorite',shape:'unknown'}).map(a=>a.id),['c']);
assert.equal(JSON.stringify(rows),before);
});
test('sorting is deterministic and empty results do not alter selection identity',()=>{
assert.deepEqual(gallery.filter(rows,{status:'active',sort:'oldest'}).map(a=>a.id),['a','b']);
assert.deepEqual(gallery.filter(rows,{status:'all',sort:'favorite'}).map(a=>a.id),['c','a','b']);
const compared=new Set(['a','b']);gallery.filter(rows,{tag:'不存在',status:'all'});assert.deepEqual([...compared],['a','b']);
});
test('reuse prefers requested aspect over receipt objects and carries no authorization',()=>{
const result=gallery.reuse({...rows[0],aspect:{applied:'1:1'},paid_confirmed:true,jobId:'old',billed:true});
assert.equal(result.item.aspect,'16:9');assert.deepEqual(result.item.params,{seed:0,raw:true});
assert.deepEqual(result.missing,[]);assert.equal(result.item.paid_confirmed,undefined);assert.equal(result.item.jobId,undefined);
result.item.params.seed=100;assert.equal(rows[0].params.seed,0);
const missing=gallery.reuse({prompt:'old',aspect:{applied:'9:16'}});assert.deepEqual(missing.missing,['画幅','版本','高级参数']);assert.equal(missing.item.aspect,'');
});
test('comparison marks meaningful parameter differences but ignores object key order',()=>{
assert.deepEqual(gallery.differences([rows[0],{...rows[0],params:{raw:true,seed:0}}]),[]);
assert.deepEqual(gallery.differences([rows[0],rows[1]]),['prompt','requestedAspect','params']);
});

test('unknown parameters remain different from recorded empty parameters',()=>{assert.deepEqual(gallery.differences([{prompt:'same',params:null},{prompt:'same',params:{}}]),['params']);});
