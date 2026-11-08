import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureSigningKey, signingKeyIsProduction } from './services/signing.js';
import { bootstrapVendorAdmin } from './services/vendor-auth.js';
import { createApp } from './app.js';
import { aiReadiness } from './services/ai-reply.js';   // AI_CHAT_V1

// CONTROL_PLANE_V1 — the entry point. Everything here mirrors the clinic app's
// server/index.js on purpose: same env-var pattern for the data directory, same
// first-run password banner, same loud EADDRINUSE message. One team, one shape.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// EASYMED_CP_DATA_DIR, resolved against this service's own root — never the cwd,
// for the same reason as the clinic app: a Windows service starts in system32,
// and a relative path resolved there would quietly create a second, empty
// registry while the real one sat on disk unreferenced.
const raw = String(process.env.EASYMED_CP_DATA_DIR || '').trim();
const DATA_DIR = raw ? path.resolve(ROOT, raw) : path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Refuse to boot without a usable signing key. A control plane that silently
// cannot sign is worse than one that will not start: clinics keep checking in,
// get no fresh licence, and quietly lapse two weeks later with nobody having
// noticed anything wrong today.
try {
  ensureSigningKey();
} catch (e) {
  console.error('');
  console.error('The control plane cannot start: ' + e.message);
  console.error('Set EASYMED_SIGNING_KEY to the path of the vendor private key.');
  console.error('To create one:  node ../scripts/make-licence.mjs keygen');
  process.exit(1);
}

// PUBLIC_LICENCE_V1 — a key that is not the production one is fine on a dev
// machine and a disaster on settings.easymed.uz: no real clinic and not the
// public server would accept anything this process signs. Said loudly, once.
if (!signingKeyIsProduction()) {
  console.warn('');
  console.warn('  WARNING: EASYMED_SIGNING_KEY is NOT the production vendor key compiled into');
  console.warn('  every clinic (server/services/control/licence.js). Real clinics and the public');
  console.warn('  server api.easymed.uz will reject every licence and feed this process signs.');
  console.warn('  Expected only on a development machine.');
  console.warn('');
} else {
  console.log('Signing key: the production vendor key.');
}

// AI_CHAT_V1 — the clinics' AI assistant needs the Anthropic SDK (installed on
// the vendor server separately — see README "AI assistant") and an API key.
// Missing either is a WARNING, never a refusal to start: check-in and licences
// matter more than the AI, and a clinic asking for an AI reply meanwhile just
// gets 503 `upstream` and hands the chat to its operators.
const aiProblems = await aiReadiness();
if (aiProblems.length) {
  console.warn('');
  console.warn('  WARNING: the clinics\' AI assistant will NOT work on this control plane:');
  for (const p of aiProblems) console.warn('    - ' + p);
  console.warn('  Every AI request will answer 503 and the clinic will hand the chat to an operator.');
  console.warn('  Expected only on a development machine.');
  console.warn('');
} else {
  console.log('AI assistant: SDK and ANTHROPIC_API_KEY present.');
}

const db = openDb(path.join(DATA_DIR, 'registry.db'));
migrate(db);
const firstRunPassword = bootstrapVendorAdmin(db);

const PORT = Number(process.env.CP_PORT || 8090);
const server = createApp(db).listen(PORT, process.env.CP_BIND || '0.0.0.0', () => {
  console.log('');
  console.log('Easy-Med control plane is running.');
  console.log(`  Panel:    http://localhost:${PORT}/cp/`);
  console.log(`  Registry: ${path.join(DATA_DIR, 'registry.db')}`);
  if (firstRunPassword) {
    console.log('');
    console.log('FIRST RUN - vendor admin created:');
    console.log('  username: admin');
    console.log(`  password: ${firstRunPassword}`);
    console.log('  Log in and change this password.');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`The control plane could not start: port ${PORT} is already in use.`);
    console.error('It is probably already running - check before starting it again.');
    process.exit(1);
  }
  throw err;
});
