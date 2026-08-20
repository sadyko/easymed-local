import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDbClient } from './db-client.js';

function fakeFetch(captured) {
  return async (url, opts) => { captured.url = url; captured.body = JSON.parse(opts.body);
    return { ok:true, status:200, json: async () => ({ data:[{id:1}], count:1 }) }; };
}

test('builds a select descriptor from the chain', async () => {
  const cap = {}; const db = makeDbClient({ fetch: fakeFetch(cap), base:'/api/db' });
  const { data, error } = await db.from('patients').select('id,full_name').eq('branch_id',2).order('created_at',{ascending:false}).limit(10);
  assert.equal(error, null);
  assert.deepEqual(data, [{id:1}]);
  assert.equal(cap.body.table, 'patients');
  assert.equal(cap.body.op, 'select');
  assert.equal(cap.body.columns, 'id,full_name');
  assert.deepEqual(cap.body.filters, [{col:'branch_id',op:'eq',val:2}]);
  assert.deepEqual(cap.body.order, [{col:'created_at',asc:false}]);
  assert.equal(cap.body.limit, 10);
});

test('single() and maybeSingle() set the mode and unwrap data', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:{id:9}})};}, base:'/api/db' });
  const { data } = await db.from('patients').select('*').eq('id',9).single();
  assert.equal(cap.body.single, 'single');
  assert.deepEqual(data, {id:9});
});

test('insert/update/delete build the right op and returning flag', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:[{id:1}]})};}, base:'/api/db' });
  await db.from('patients').insert({ full_name:'A' }).select();
  assert.equal(cap.body.op, 'insert'); assert.equal(cap.body.returning, true);
  await db.from('patients').update({ phone:'5' }).eq('id',1);
  assert.equal(cap.body.op, 'update'); assert.deepEqual(cap.body.values, { phone:'5' });
  await db.from('patients').delete().eq('id',1);
  assert.equal(cap.body.op, 'delete');
});

test('http error becomes { data:null, error }', async () => {
  const db = makeDbClient({ fetch: async ()=>({ ok:false, status:403, json: async ()=>({error:{code:'forbidden',message:'no'}}) }), base:'/api/db' });
  const { data, error } = await db.from('patients').select('*');
  assert.equal(data, null); assert.equal(error.message, 'no');
});

test('in / gte / ilike / contains / neq chain into filters', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:[]})};}, base:'/api/db' });
  await db.from('patients').select('*').in('id',[1,2]).gte('created_at','2026').ilike('full_name','%a%').neq('active',0);
  assert.deepEqual(cap.body.filters, [
    {col:'id',op:'in',val:[1,2]}, {col:'created_at',op:'gte',val:'2026'},
    {col:'full_name',op:'ilike',val:'%a%'}, {col:'active',op:'neq',val:0} ]);
});

test('select with { count } emits count in the descriptor', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:[],count:0})};}, base:'/api/db' });
  await db.from('patients').select('*', { count:'exact' });
  assert.equal(cap.body.count, 'exact');
});

test('.or() parses a PostgREST spec into an OR filter group', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:[]})};}, base:'/api/db' });
  await db.from('patient_relationships').select('*').or('patient_id_a.eq.5,patient_id_b.eq.5');
  assert.deepEqual(cap.body.filters, [{ or: [
    { col:'patient_id_a', op:'eq', val:5 }, { col:'patient_id_b', op:'eq', val:5 } ] }]);
});

test('.or() handles in / is-null / ilike terms (commas inside in(...) stay together)', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:[]})};}, base:'/api/db' });
  await db.from('products').select('*').or('company_id.is.null,id.in.(1,2,3),name.ilike.%x%');
  assert.deepEqual(cap.body.filters, [{ or: [
    { col:'company_id', op:'is', val:null },
    { col:'id', op:'in', val:[1,2,3] },
    { col:'name', op:'ilike', val:'%x%' } ] }]);
});

test('upsert captures values + onConflict target', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:null})};}, base:'/api/db' });
  await db.from('patient_relationships').upsert({ patient_id_a:1, patient_id_b:2, relation_type:'spouse' }, { onConflict:'company_id,patient_id_a,patient_id_b' });
  assert.equal(cap.body.op, 'upsert');
  assert.deepEqual(cap.body.values, { patient_id_a:1, patient_id_b:2, relation_type:'spouse' });
  assert.equal(cap.body.onConflict, 'company_id,patient_id_a,patient_id_b');
});

test('upsert captures an array of rows + ignoreDuplicates', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:null})};}, base:'/api/db' });
  await db.from('patient_relationships').upsert([{ patient_id_a:1, patient_id_b:2, relation_type:'sibling' }], { onConflict:'company_id,patient_id_a,patient_id_b', ignoreDuplicates:true });
  assert.equal(cap.body.op, 'upsert');
  assert.ok(Array.isArray(cap.body.values));
  assert.equal(cap.body.ignoreDuplicates, true);
});

test('not() encodes op as not.<op>', async () => {
  const cap = {}; const db = makeDbClient({ fetch: async (u,o)=>{cap.body=JSON.parse(o.body); return {ok:true,status:200,json:async()=>({data:[]})};}, base:'/api/db' });
  await db.from('visit_services').select('id').not('doctor_id', 'is', null).not('status', 'in', '(cancelled)');
  assert.deepEqual(cap.body.filters, [
    { col: 'doctor_id', op: 'not.is', val: null },
    { col: 'status', op: 'not.in', val: '(cancelled)' },
  ]);
});
