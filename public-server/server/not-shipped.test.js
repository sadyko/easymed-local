// PUBLIC_SERVER_V1 — публичный сервер — служба Easy-Med, а не часть программы
// клиники: выпуск программы (scripts/build-bundle.mjs, разрешающий список) его
// не берёт, и клиники его не получают.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectEntries, ALLOWLIST } from '../../scripts/build-bundle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('выпуск программы клиники не берёт public-server/', () => {
  assert.ok(!ALLOWLIST.includes('public-server'));
  assert.ok(!selectEntries(REPO).includes('public-server'));
});
