// CRM_LINK_ALL_V1 (мигр. 247, повторное ревью воронки F-10) — только CREATE TABLE
// crm_card_visit_views: визит, который карточка только показывает. Один визит — у
// нескольких карточек; у одной карточки — один раз; привязки записи (187) не тронуты.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('мигр. 247: визит показывают несколько карточек, каждая один раз; привязка записи у визита по-прежнему одна', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(crm_card_visit_views)').all();
  assert.deepEqual(cols.map((c) => [c.name, c.pk]), [['request_id', 1], ['visit_id', 2], ['created_at', 0]]);
  const add = db.prepare('INSERT OR IGNORE INTO crm_card_visit_views (request_id, visit_id) VALUES (?, ?)');
  assert.equal(add.run(1, 10).changes, 1);
  assert.equal(add.run(2, 10).changes, 1, 'вторая карточка не может показать тот же визит');
  assert.equal(add.run(1, 10).changes, 0, 'карточка показывает визит дважды');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_crm_card_visit_views_visit'").get());
  const pk = db.prepare('PRAGMA table_info(crm_booking_links)').all().filter((c) => c.pk).map((c) => c.name);
  assert.deepEqual(pk, ['visit_id']);
});
