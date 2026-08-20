import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthBridge } from './db-auth.js';

function fetchStub(routes) {
  return async (url, opts) => {
    const key = (opts?.method || 'GET') + ' ' + url;
    const r = routes[key];
    if (!r) return { ok:false, status:404, json: async () => ({ error:{ message:'no route '+key } }) };
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  };
}

test('signInWithPassword posts username+password to /api/auth/login', async () => {
  let sent = null;
  const fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) };
    return { ok:true, status:200, json: async () => ({ user:{ id:1, username:'anna', role:'admin' } }) }; };
  const auth = makeAuthBridge({ fetch, base:'/api/auth' });
  const { data, error } = await auth.signInWithPassword({ email:'anna', password:'secret' });
  assert.equal(error, null);
  assert.equal(sent.url, '/api/auth/login');
  assert.equal(sent.body.username, 'anna');
  assert.equal(sent.body.password, 'secret');
  assert.ok(data.user && data.session);        // supabase-shaped: {user, session}
  assert.equal(data.user.username, 'anna');
});

test('getUser / getSession read /api/auth/me; unauthenticated => null, no throw', async () => {
  const authed = makeAuthBridge({ fetch: fetchStub({ 'GET /api/auth/me': { body:{ user:{ id:2, username:'boss', role:'admin' } } } }), base:'/api/auth' });
  assert.equal((await authed.getUser()).data.user.username, 'boss');
  assert.ok((await authed.getSession()).data.session);

  const anon = makeAuthBridge({ fetch: fetchStub({ 'GET /api/auth/me': { ok:false, status:401, body:{ error:{ message:'Login required.' } } } }), base:'/api/auth' });
  assert.equal((await anon.getUser()).data.user, null);
  assert.equal((await anon.getSession()).data.session, null);
});

test('signOut posts to /api/auth/logout and never throws', async () => {
  const auth = makeAuthBridge({ fetch: fetchStub({ 'POST /api/auth/logout': { body:{ ok:true } } }), base:'/api/auth' });
  const { error } = await auth.signOut();
  assert.equal(error, null);
});
