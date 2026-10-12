// PUBLIC_SERVER_V1 — страж схемы: в базе публичного сервера нет колонок для
// данных пациента, ключей и секретов. Каждая колонка каждой таблицы — по
// списку; новая колонка требует правки списка (и мысли, что в ней будет).
// Данные пациента — только inbox.sealed (шифротекст), см. 001_public_server.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';

const EXPECTED = {
  clinics: ['clinic_id', 'slug', 'key_fp', 'box_key', 'licence_issued_at', 'licence_valid_until', 'licence_subscription',
    'first_seen_at', 'last_seen_at', 'keys_at', 'snapshot', 'snapshot_at', 'slots', 'slots_at'],
  slug_aliases: ['slug', 'clinic_id', 'until_at'],
  connections: ['clinic_id', 'id', 'kind', 'active', 'key_hash', 'scopes', 'rate_limit', 'key_expires_at', 'ip_allow', 'origins', 'last_used_at'],
  media: ['clinic_id', 'sha256', 'ext', 'bytes', 'stored_at'],
  requests: ['id', 'clinic_id', 'connection_id', 'kind', 'external_id', 'doctor_id', 'branch_id', 'service_id', 'package_id',
    'consultation', 'start_at', 'duration_min', 'status', 'reason', 'hold_until', 'offered_start', 'offer_until',
    'cancel_requested_at', 'created_at', 'delivered_at', 'answered_at', 'updated_at'],
  inbox: ['cursor', 'clinic_id', 'type', 'request_id', 'connection_id', 'received_at', 'data', 'sealed', 'handed_out_at'],
  events_seen: ['clinic_id', 'seq', 'identity', 'received_at'],
  deliveries: ['id', 'clinic_id', 'connection_id', 'request_id', 'event_id', 'event', 'url', 'body', 'signature', 'attempts',
    'state', 'next_at', 'last_code', 'last_error', 'created_at', 'updated_at'],
  delivery_log: ['id', 'clinic_id', 'delivery_id', 'connection_id', 'request_id', 'event_id', 'event', 'attempt', 'code',
    'error', 'at', 'next_at', 'final'],
  access_log: ['id', 'clinic_id', 'connection_id', 'at', 'method', 'path', 'status', 'ip', 'ms'],
  // PUBLIC_LICENCE_V1 — последний принятый список производителя (номера клиник и отпечатки ключей).
  vendor_feed: ['id', 'issued_at', 'doc', 'received_at'],
  schema_migrations: ['name', 'applied_at'],
};

test('миграции ложатся на пустую базу и повторно ничего не делают', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);
  assert.deepEqual(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name), ['001_public_server.sql', '002_vendor_feed.sql']);
  assert.equal(db.pragma('secure_delete', { simple: true }), 1, 'стёртое затирается');
  db.close();
});

test('каждая таблица — ровно со своими колонками; колонок пациента, ключа и секрета нет', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, Object.keys(EXPECTED).sort());
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.deepEqual(cols, EXPECTED[t], t);
    if (t === 'schema_migrations') continue;
    for (const c of cols) {
      assert.ok(!/patient|name$|phone|comment|secret|password|token|^key$|api_key/i.test(c) || c === 'key_hash' || c === 'key_fp',
        t + '.' + c + ' похоже на поле пациента, ключа или секрета');
    }
  }
  db.close();
});
