// WEBSITE_V1 — миграция 298: таблицы сайта клиники (перенос 083+087 Chilla).
// Врачи и услуги публикуются ПРОФИЛЕМ (users.is_public, services.online_booking),
// поэтому у website_doctors / website_services нет ни published, ни slug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('298 WEBSITE_V1: таблицы сайта есть, строка настроек одна и пустая', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const t of ['website_settings', 'website_doctors', 'website_services', 'website_departments',
    'website_testimonials', 'website_faq', 'website_posts', 'website_requests',
    'website_sessions', 'website_pageviews', 'website_stats_daily']) {
    assert.ok(cols(db, t).length > 0, 'нет таблицы ' + t);
  }
  assert.deepEqual(db.prepare('SELECT id, settings FROM website_settings').all(), [{ id: 1, settings: '{}' }]);
  db.close();
});

test('298 WEBSITE_V1: у врачей и услуг сайта нет своего «published» и слага — показ решает профиль', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const t of ['website_doctors', 'website_services']) {
    assert.ok(!cols(db, t).includes('published'), t + '.published не должно быть');
    assert.ok(!cols(db, t).includes('slug'), t + '.slug не должно быть');
  }
  assert.ok(cols(db, 'website_requests').includes('session_id'), 'session_id из 087 Chilla');
  db.close();
});

test('298 WEBSITE_V1: источник CRM «Сайт» есть в справочнике источников', () => {
  const db = openDb(':memory:');
  migrate(db);
  const row = db.prepare("SELECT key, is_active FROM crm_sources WHERE key = 'website'").get();
  assert.ok(row, 'crm_sources.website');
  db.close();
});
