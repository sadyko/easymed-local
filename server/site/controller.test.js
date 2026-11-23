// WEBSITE_V1 — слушатель сайта: только при модуле лицензии website, при
// settings.enabled === true и SITE_PORT > 0. Включение и выключение — без
// перезапуска сервера (refresh раз в минуту из index.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { siteWanted, createSiteController } from './controller.js';
import { invalidateContentCache } from './content.js';

function fresh(enabled) {
  invalidateContentCache();
  const db = openDb(':memory:'); migrate(db);
  db.prepare('UPDATE website_settings SET settings = ? WHERE id = 1').run(JSON.stringify({ enabled }));
  return db;
}
const yes = () => true, no = () => false;

test('siteWanted: нужен и модуль, и «Сайт включён», и порт', () => {
  assert.equal(siteWanted(fresh(true), { env: {}, hasModule: yes }), 8001);
  assert.equal(siteWanted(fresh(true), { env: { SITE_PORT: '8123' }, hasModule: yes }), 8123);
  assert.equal(siteWanted(fresh(true), { env: {}, hasModule: no }), 0, 'без модуля лицензии');
  assert.equal(siteWanted(fresh(false), { env: {}, hasModule: yes }), 0, 'выключен в настройках');
  assert.equal(siteWanted(fresh(true), { env: { SITE_PORT: '0' }, hasModule: yes }), 0, 'аварийный выключатель');
});

test('контроллер поднимает, закрывает и снова поднимает слушатель без перезапуска', () => {
  const db = fresh(true);
  let licensed = true;
  const opened = [];
  const fake = () => { const s = { closed: false, close() { s.closed = true; }, on() { return s; } }; opened.push(s); return s; };
  const c = createSiteController(db, { env: {}, hasModule: () => licensed, listen: fake });
  assert.equal(c.refresh(), 8001); assert.equal(opened.length, 1);
  assert.equal(c.refresh(), 8001); assert.equal(opened.length, 1, 'повторный refresh не открывает второй');
  licensed = false;
  assert.equal(c.refresh(), 0); assert.equal(opened[0].closed, true, 'лицензия ушла — сайт закрыт');
  licensed = true;
  assert.equal(c.refresh(), 8001); assert.equal(opened.length, 2);
  db.prepare('UPDATE website_settings SET settings = ? WHERE id = 1').run(JSON.stringify({ enabled: false }));
  assert.equal(c.refresh(), 0); assert.equal(opened[1].closed, true, '«Сайт включён» снят — закрыт');
});
