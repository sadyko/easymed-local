// BRANCH_REISSUE_V1 — enrolling ON TOP of an identity this install already has.
//
// THE SITUATION THIS EXISTS FOR, exactly. A branch PC is reinstalled. Its
// one-time activation code burned at the FIRST activation, so the key the main
// clinic shows no longer activates anything, and on 2026-09-02 the owner did
// the only thing left: he activated the laptop as a brand-new STANDALONE
// clinic. It now has a perfectly valid identity — the wrong one — and it can
// never become a branch again, because enrollWithCode refuses before the
// network the moment it sees an install_token on disk.
//
// `replace: true` lifts that one refusal and NOTHING else. Everything this
// file asserts is about that "nothing else": a refused code still writes
// nothing, an unverifiable licence still writes nothing, and the identity is
// replaced WHOLE (token, unlock secret, subscription) rather than merged —
// half of clinic A's identity next to half of branch B's would be an install
// that check-in can neither renew nor lock.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

import { canonical } from './canonical.js';
import { enrollWithCode, __setPublicKeyForTests } from './enroll.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setPublicKeyForTests(publicKey);

const signLic = (payload) => ({
  payload,
  sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
});

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'em-enroll-replace-'));

/** The identity of an install that was activated as a STANDALONE clinic by mistake. */
const STANDALONE = {
  clinic_id: 'c-000077',
  clinic_name: 'Ноутбук филиала, заведённый как клиника',
  install_token: 'tok-WRONG',
  unlock_secret: 'sec-WRONG',
  subscription: 'active',
};

function licensedAsStandalone() {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(STANDALONE));
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify(signLic({
    clinic_id: 'c-000077', clinic_name: 'Ноутбук', modules: ['crm'],
    valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-08-01T00:00:00Z', nonce: 'n-old',
  })));
  return dir;
}

const branchBody = (over = {}) => ({
  clinic_id: 'c-000005-b2',
  clinic_name: 'Чиланзар',
  install_token: 'tok-BRANCH',
  unlock_secret: 'sec-BRANCH',
  subscription: 'active',
  licence: signLic({
    clinic_id: 'c-000005-b2', clinic_name: 'Чиланзар', modules: ['crm', 'lab'],
    valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-09-02T00:00:00Z', nonce: 'n-branch',
  }),
  ...over,
});

const okFetch = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const errFetch = (status) => async () => ({ ok: false, status, text: async () => '{}' });

const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

test('WITHOUT replace, an already-enrolled install still refuses before the network', async () => {
  // The guard that keeps a single-use code alive is untouched: this is the
  // behaviour every other caller (the activation screen) still gets.
  const dir = licensedAsStandalone();
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('must not reach the vendor'); };

  const r = await enrollWithCode(dir, 'EM-NEW-0002', { fetchImpl });

  assert.deepEqual(r, { ok: false, reason: 'already_enrolled' });
  assert.equal(called, false, 'refusing before the network is what keeps the code unburned');
  assert.equal(read(dir, 'control.json').install_token, 'tok-WRONG');
});

test('WITH replace, the branch code is redeemed and the identity is replaced whole', async () => {
  const dir = licensedAsStandalone();
  let sent = null;
  const fetchImpl = async (url, init) => { sent = { url, init }; return okFetch(branchBody())(); };

  const r = await enrollWithCode(dir, 'em-new-0002', { fetchImpl, replace: true });

  assert.equal(r.ok, true);
  assert.equal(r.clinic_id, 'c-000005-b2');
  assert.equal(r.clinic_name, 'Чиланзар');
  // WHOLE, not merged: nothing of the mistaken clinic survives. A leftover
  // unlock_secret would unlock the wrong clinic; a leftover install_token
  // would keep checking in as it.
  assert.deepEqual(read(dir, 'control.json'), {
    clinic_id: 'c-000005-b2', clinic_name: 'Чиланзар',
    install_token: 'tok-BRANCH', unlock_secret: 'sec-BRANCH', subscription: 'active',
  });
  // Modules and subscription follow the LICENCE, which is why it must be the
  // branch's own and not the one this install came with.
  assert.deepEqual(read(dir, 'licence.dat'), branchBody().licence);
  assert.equal(read(dir, 'licence.dat').payload.modules.includes('lab'), true);
  // The code is still normalised the same way before it is sent.
  assert.equal(JSON.parse(sent.init.body).code, 'EM-NEW-0002');
});

test('a refused code (400) with replace leaves the install exactly as it was', async () => {
  // The single most important property of the whole feature. A branch key
  // whose code was already spent must not cost the owner the install he still
  // has: the answer is a reason, not a wiped identity.
  const dir = licensedAsStandalone();
  const before = { control: read(dir, 'control.json'), licence: read(dir, 'licence.dat') };

  const r = await enrollWithCode(dir, 'EM-USED-0001', { fetchImpl: errFetch(400), replace: true });

  assert.deepEqual(r, { ok: false, reason: 'invalid_code' });
  assert.deepEqual(read(dir, 'control.json'), before.control);
  assert.deepEqual(read(dir, 'licence.dat'), before.licence);
});

test('every other refusal with replace is equally untouching', async () => {
  for (const [status, reason] of [[429, 'too_many_attempts'], [500, 'server_error'], [503, 'server_error']]) {
    const dir = licensedAsStandalone();
    const r = await enrollWithCode(dir, 'EM-X', { fetchImpl: errFetch(status), replace: true });
    assert.deepEqual(r, { ok: false, reason }, `status ${status}`);
    assert.equal(read(dir, 'control.json').install_token, 'tok-WRONG');
  }
  const dir = licensedAsStandalone();
  const offline = await enrollWithCode(dir, 'EM-X', {
    fetchImpl: async () => { throw new Error('ENOTFOUND'); }, replace: true,
  });
  assert.deepEqual(offline, { ok: false, reason: 'offline' });
  assert.equal(read(dir, 'control.json').install_token, 'tok-WRONG');
});

test('replace does NOT relax the licence check — an unsigned answer writes nothing', async () => {
  // The gate that makes this safe at all: a control plane answering garbage
  // (or whoever answers in its place) must not be able to take an install's
  // identity away from it.
  const dir = licensedAsStandalone();
  const forged = branchBody({ licence: { payload: { clinic_id: 'c-000005-b2' }, sig: 'bm90LWEtc2ln' } });

  const r = await enrollWithCode(dir, 'EM-NEW-0002', { fetchImpl: okFetch(forged), replace: true });

  assert.deepEqual(r, { ok: false, reason: 'bad_response' });
  assert.equal(read(dir, 'control.json').install_token, 'tok-WRONG');
});

test('replace does NOT relax the clinic_id binding either', async () => {
  // A licence that verifies but names a DIFFERENT clinic than the response
  // claims to be enrolling would let one branch's licence be installed under
  // another branch's identity.
  const dir = licensedAsStandalone();
  const mismatched = branchBody({
    licence: signLic({
      clinic_id: 'c-000005-b9', clinic_name: 'Чужой', modules: [],
      valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-09-02T00:00:00Z', nonce: 'n-other',
    }),
  });

  const r = await enrollWithCode(dir, 'EM-NEW-0002', { fetchImpl: okFetch(mismatched), replace: true });

  assert.deepEqual(r, { ok: false, reason: 'bad_response' });
  assert.equal(read(dir, 'control.json').clinic_id, 'c-000077');
});

test('replace keeps the identity-first write order', async () => {
  // Crash between the two writes and control.json names the new clinic while
  // licence.dat still holds the old one: the install reads as unlicensed WITH
  // an install_token, and the next check-in completes the pair unattended.
  // The other order strands it. Same reasoning as a first enrolment's.
  const dir = licensedAsStandalone();
  const order = [];
  // writeAtomic writes to a hidden '.<name>.tmp…' first, so match by substring
  // rather than by prefix: the temp name is what actually reaches this seam.
  const writeFileSync = (p, data) => { order.push(path.basename(String(p))); fs.writeFileSync(p, data); };

  await enrollWithCode(dir, 'EM-NEW-0002', { fetchImpl: okFetch(branchBody()), replace: true, writeFileSync });

  const first = order.findIndex((n) => n.includes('control.json'));
  const second = order.findIndex((n) => n.includes('licence.dat'));
  assert.ok(first > -1 && second > -1, order.join(','));
  assert.ok(first < second, 'identity first, licence second: ' + order.join(','));
});

test('replace on an install with no identity at all behaves like a plain first enrolment', async () => {
  // Reachable: the branch PC was wiped and never activated. Nothing to
  // replace, and the flag must not change the outcome.
  const dir = freshDir();
  const r = await enrollWithCode(dir, 'EM-NEW-0002', { fetchImpl: okFetch(branchBody()), replace: true });
  assert.equal(r.ok, true);
  assert.equal(read(dir, 'control.json').clinic_id, 'c-000005-b2');
  // The branch-sync group key is born with the identity, exactly as it is on a
  // first activation.
  assert.equal(fs.existsSync(path.join(dir, 'sync-group.json')), true);
});
