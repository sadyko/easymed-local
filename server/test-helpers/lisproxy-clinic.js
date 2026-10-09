// LIS_PROXY_V1 — стенд тестов LIS Proxy (docs/plans/2026-10-09-lis-proxy-endpoint.md).
// Настоящая база (все миграции), настоящее приложение (createApp с явной папкой
// данных — app-test-hygiene), запросы как у программы: те же заголовки, тела —
// байт в байт из lisproxy-fixtures.json (копия analyzer-research\lisproxy\
// harness\fixtures.json, снятой с настоящего lisproxyd.exe 2026-10-09).
// Не тестовый файл — его импортируют; в поставку не идёт (BUNDLE_EXCLUDES).
import fs from 'node:fs';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { writeProxySettings } from '../lis/lisproxy-settings.js';

// listen (control-plane: порты, которые fetch() не открывает) грузится при
// запуске стенда, а не статическим import: сторож поставки
// (scripts/build-bundle.test.js) читает статические import всего server/, кроме
// *.test.js, а control-plane в поставку не идёт. Этот файл в поставку не идёт
// тоже (BUNDLE_EXCLUDES: server/test-helpers).
const listenHelper = () => import('../../control-plane/server/test-helpers/listen.js');

export const FIXTURES = JSON.parse(fs.readFileSync(new URL('./lisproxy-fixtures.json', import.meta.url), 'utf8'));

/** Тело запроса фикстуры по группе и id. */
export function fixture(group, id) {
  const f = (FIXTURES[group] || []).find((x) => x.id === id);
  if (!f || typeof f.body !== 'string') throw new Error('нет фикстуры ' + group + '/' + id);
  return f.body;
}

/** Заголовки каждого запроса программы (§2.1 документа). */
export const PROXY_HEADERS = Object.freeze({
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Mozilla/5.0',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip',
});

export const DEV_KEY = 'DEVKEY';

export function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/**
 * Приложение с LIS Proxy. settings: true — data/lisproxy.json с enabled и key;
 * false — файла нет (приём выключен).
 */
export async function startProxyApp(db, { enabled = true, key = DEV_KEY, settings = true } = {}) {
  const dataDir = licensedDataDir();
  if (settings) writeProxySettings(dataDir, { enabled, key });
  const { listen } = await listenHelper();
  const server = await listen(createApp(db, { dataDir }));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    server, base, dataDir,
    url: base + '/api/lisproxy?key=' + encodeURIComponent(key),
    close: () => new Promise((r) => server.close(r)),
  };
}

/** POST как у прокси. */
export function post(url, body, headers = PROXY_HEADERS) {
  return fetch(url, { method: 'POST', headers, body });
}

export const rows = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id').all();
export const lastRow = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
/** Лоток экрана: неразобранные и не принятые (lab-devices.js reload). */
export const tray = (db) => db.prepare("SELECT * FROM lab_device_messages WHERE resolved_at IS NULL AND status <> 'applied' ORDER BY id").all();
export const blank = (db, vsId) => Object.fromEntries(db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = ? ORDER BY id')
  .all(vsId).map((r) => [r.parameter, r.value]));
export const device = (db, name) => db.prepare("SELECT * FROM lab_devices WHERE via = 'lisproxy' AND proxy_name = ?").get(name);

/**
 * Клиника под номера фикстур. Иванов (03.02.1990, муж.):
 *   № 123 «Биохимия» и № 124 «Мочевина» — одна пробирка, один визит (D3);
 *   № 555 «Общий анализ крови»; № 777 «Витамин B12».
 * Каримова (жен.): № 130 «Биохимия» — не оплачен; № 131 — отменён;
 *   № 900001 «Биохимия» — открытый свежий заказ с номером «как номер пациента».
 * Петров (без даты рождения, пол «другой»): № 132 «Биохимия».
 */
export function seedOrders(db) {
  const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
  db.exec(`
    INSERT INTO patients (id, full_name, date_of_birth, gender) VALUES
      (3, 'Иванов Иван', '1990-02-03', 'male'), (4, 'Каримова Азиза', '1985-11-20', 'female'), (5, 'Петров Пётр', NULL, 'other');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES
      (55, 3, ${now}, 'scheduled'), (58, 3, ${now}, 'scheduled'), (59, 3, ${now}, 'scheduled'),
      (56, 4, ${now}, 'scheduled'), (57, 5, ${now}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES
      (9, 'Биохимия', 1, 'Сыворотка'), (10, 'Витамин B12', 1, 'Сыворотка'), (11, 'Общий анализ крови', 1, 'Кровь'),
      (12, 'Мочевина', 1, 'Сыворотка'), (13, 'Общий анализ мочи', 1, 'Моча');
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES
      (123, 55, 9, 'queued', ${now}), (124, 55, 12, 'queued', ${now}),
      (555, 58, 11, 'queued', ${now}), (777, 59, 10, 'queued', ${now}),
      (130, 56, 9, 'added', ${now}), (131, 56, 9, 'cancelled', ${now}), (900001, 56, 9, 'queued', ${now}),
      (132, 57, 9, 'queued', ${now});
  `);
}

/** Прибор за LIS Proxy (добавленный — если не сказано иначе). */
export function addProxyDevice(db, { id = null, name, label = '', ip = '127.0.0.1', profile = '', added = 1, enabled = 1 } = {}) {
  return Number(db.prepare(`INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed, via, proxy_name, proxy_label, proxy_ip)
                            VALUES (?, ?, ?, 'mllp', '', NULL, ?, 1, ?, ?, 'lisproxy', ?, ?, ?)`)
    .run(id, name, profile, enabled, added, profile ? 1 : 0, name, label || null, ip).lastInsertRowid);
}

/**
 * Панель услуги на приборе; строки [code, name, deviceCode, confirmed = 1] —
 * подтверждены для этого прибора и его эпохи (так пишет экран, ревью R5/R6).
 */
export function bindPanel(db, { id, serviceId, deviceId, name, lines }) {
  db.prepare('INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (?, ?, ?, ?)').run(id, name, serviceId, deviceId);
  lines.forEach(([code, label, deviceCode, confirmed = 1], i) => db.prepare(`INSERT INTO lab_panel_analytes
      (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
      VALUES (?, ?, ?, '', ?, ?, ?, ?, (SELECT code_epoch FROM lab_devices WHERE id = ?))`)
    .run(id, code, label, i + 1, deviceCode, confirmed ? 1 : 0, confirmed ? deviceId : null, deviceId));
}

/** Три анализатора владельца за LIS Proxy (решение 6) — имена и подписи как в фикстурах. */
export const PROXY_DEVICES = Object.freeze([
  Object.freeze({ id: 1, name: 'bs200', label: 'LAB-PC-1', profile: 'mindray-bs-200' }),
  Object.freeze({ id: 2, name: 'bc780x', label: 'LABPC', profile: 'mindray-bc-780' }),
  Object.freeze({ id: 3, name: 'lumo', label: 'LAB-PC-2', profile: 'autobio-autolumo-a1000' }),
]);

/**
 * Клиника для фикстур и replay_fixtures.py: заказы (seedOrders), три прибора
 * LIS Proxy с адреса ip, панели с подтверждёнными кодами GLU / WBC, HGB / 214.
 */
export function seedLisProxyClinic(db, { devices = PROXY_DEVICES, ip = '127.0.0.1' } = {}) {
  seedOrders(db);
  for (const d of devices) addProxyDevice(db, { ...d, ip });
  bindPanel(db, { id: 5, serviceId: 9, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU']] });
  bindPanel(db, { id: 7, serviceId: 11, deviceId: 2, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC'], ['HGB', 'Гемоглобин', 'HGB']] });
  bindPanel(db, { id: 6, serviceId: 10, deviceId: 3, name: 'Витамин B12', lines: [['B12', 'Витамин B12', '214']] });
}
