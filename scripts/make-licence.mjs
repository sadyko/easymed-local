#!/usr/bin/env node
// LICENCE_CORE_V1 — the vendor's licence tool. Runs on the VENDOR's machine, never
// at a clinic. A later plan replaces it with the control-plane panel; it stays
// afterwards as the break-glass path when that panel is unreachable.
//
//   node scripts/make-licence.mjs keygen
//   node scripts/make-licence.mjs enroll  --clinic c-000047 --name "Нурафшон Мед"
//   node scripts/make-licence.mjs issue   --clinic c-000047 --name "Нурафшон Мед" \
//                                         --modules crm,telegram --days 14 --key vendor-private.pem
//   node scripts/make-licence.mjs unlock  --clinic c-000047 --challenge K7M2QP --secret <secret>
//
// The operator here is the business owner, not a programmer — every failure path
// below prints a plain-English line and exits, never a raw stack trace.

import fs from 'node:fs';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { canonical } from '../server/services/control/canonical.js';
import { expectedResponse } from '../server/services/control/unlock.js';

// Pairs "--flag value"; a flag with nothing after it (end of argv, or another
// flag immediately following) becomes boolean `true` rather than silently
// swallowing the next flag's name as its own value — the original i+=2 form
// would misparse `--modules --days 5` as modules="--days".
const args = Object.create(null);
for (let i = 3; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue; // stray positional token — ignore rather than misalign the rest
  const key = tok.slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    args[key] = true;
  } else {
    args[key] = next;
    i++; // consumed as this flag's value
  }
}

// Distinguishes "not given" / "given with no value" from a real value, so a
// bare trailing `--name` doesn't get stringified into the literal text "true".
const opt = (k, fallback = '') => (args[k] === undefined || args[k] === true ? fallback : args[k]);
const need = (k) => {
  const v = args[k];
  if (v === undefined || v === true) {
    console.error(`Missing --${k} <value>`);
    process.exit(1);
  }
  return v;
};

// Must match unlock.js exactly — the clinic verifies with the same alphabet.
// The unlock alphabet and code derivation deliberately live in ONE place —
// server/services/control/unlock.js, imported above. They were duplicated here
// at first, and the two copies agreed, but nothing forced them to: editing the
// alphabet on the clinic side would have silently broken every telephone unlock,
// discoverable only when a locked clinic read out a code that no longer worked.

switch (process.argv[2]) {
  case 'keygen': {
    const outPath = 'vendor-private.pem';
    // Overwriting this destroys the ability to renew or licence every clinic
    // signed with the old key — there is no way back from that, so it takes an
    // explicit --force rather than a quiet clobber.
    if (fs.existsSync(outPath) && !args.force) {
      console.error(`Refusing to overwrite ${outPath} — it may be the ONLY copy of the vendor's signing key.`);
      console.error('Every clinic ever issued a licence under the old key needs that same key to renew.');
      console.error('If you are certain you want to replace it, re-run with --force.');
      process.exit(1);
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(outPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    console.log(`Wrote ${outPath}`);
    console.log('');
    console.log('  This one file is the whole licensing system.');
    console.log('  If it LEAKS, anyone can license themselves and you cannot revoke it.');
    console.log('  If it is LOST, no clinic can ever be licensed again — including renewals');
    console.log('  for clinics already running.');
    console.log('');
    console.log('  Keep it off every clinic machine. Back it up offline, in two places.');
    console.log('');
    console.log('Paste this public key into VENDOR_PUBLIC_KEY_PEM in');
    console.log('server/services/control/licence.js, replacing the placeholder:');
    console.log('');
    console.log(publicKey.export({ type: 'spki', format: 'pem' }).trim());
    break;
  }

  case 'enroll': {
    const identity = {
      clinic_id:     need('clinic'),
      clinic_name:   opt('name'),
      unlock_secret: randomBytes(32).toString('base64'),
      subscription:  'active',
    };
    const out = `control-${identity.clinic_id}.json`;
    fs.writeFileSync(out, JSON.stringify(identity, null, 2));
    console.log(`Wrote ${out} — copy it to the clinic's data/ directory as control.json`);
    console.log('Keep your own copy: unlock_secret is what lets you unlock them by telephone.');
    break;
  }

  case 'issue': {
    const daysArg = opt('days', '14');
    const days = Number(daysArg);
    if (!Number.isFinite(days)) {
      console.error(`--days must be a number, got "${daysArg}"`);
      process.exit(1);
    }
    const validUntilDate = new Date(Date.now() + days * 86400000);
    if (Number.isNaN(validUntilDate.getTime())) {
      console.error(`--days ${days} works out to a date outside what a computer can represent. Use a smaller number.`);
      process.exit(1);
    }
    if (days <= 0) {
      // Genuinely useful for testing the lockout screen — not blocked, just not silent.
      console.log(`Note: --days ${days} issues a licence that is already expired (useful for testing lockout).`);
    }

    const modules = String(opt('modules')).split(',').map((s) => s.trim()).filter(Boolean);
    if (modules.length === 0) {
      console.log('Note: no --modules given — this licence grants the free core only, no add-on modules.');
    }

    const payload = {
      clinic_id:   need('clinic'),
      clinic_name: opt('name'),
      modules,
      valid_until: validUntilDate.toISOString(),
      issued_at:   new Date().toISOString(),
      nonce:       randomBytes(8).toString('hex'),
    };

    const keyPath = opt('key', 'vendor-private.pem');
    let privateKey;
    try {
      privateKey = fs.readFileSync(keyPath, 'utf8');
    } catch {
      console.error(`Could not read the signing key at "${keyPath}". Run "keygen" first, or pass --key <path>.`);
      process.exit(1);
    }

    let sig;
    try {
      sig = sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64');
    } catch {
      console.error(`"${keyPath}" does not look like a valid Ed25519 private key.`);
      process.exit(1);
    }

    const out = `licence-${payload.clinic_id}.dat`;
    fs.writeFileSync(out, JSON.stringify({ payload, sig }));
    console.log(`Wrote ${out} — copy to the clinic's data/ directory as licence.dat`);
    console.log(`Modules: ${modules.join(', ') || '(none)'}   Valid until: ${payload.valid_until}`);
    break;
  }

  case 'unlock': {
    // Same function the clinic runs to check the code. Importing it rather than
    // recomputing it is what makes agreement structural instead of coincidental.
    const code = expectedResponse({
      clinicId:  need('clinic'),
      challenge: need('challenge'),
      secret:    need('secret'),
    });
    console.log('Read this back to the clinic:  ' + code);
    break;
  }

  default:
    console.error('Usage: make-licence.mjs keygen|enroll|issue|unlock [--flags]');
    process.exit(1);
}
