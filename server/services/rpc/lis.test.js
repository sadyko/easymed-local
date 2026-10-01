import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { lisProfiles, lisMessageAttach, lisMessageDismiss, lisDeviceCodes, lisListeners, lisDeviceDelete } from './lis.js';
import { lisServiceCounts, lisRecent } from './lis.js';   // LIS_REAL_ANALYZERS_V1_SERVICE
import { RPC } from './index.js';                           // LIS_REAL_ANALYZERS_V1_SERVICE — RPC заведён в карте
import { isReadOnlyRpc } from '../control/gate.js';   // LIS_MINDRAY_CODES_V1 (ревью R8)
import { ingestMessage } from '../../lis/ingest.js';   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 2
import { ABANDONED_DETAIL_PREFIX } from '../../lis/inbox.js';   // LIS_REAL_ANALYZERS_V1 — ревью R2, п. 10

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const LAB = { role: 'lab' };

test('лаборатория видит профили, регистратура — нет', () => {
  const db = fresh();
  assert.ok(lisProfiles(db, {}, LAB).length >= 4);
  assert.ok(lisProfiles(db, {}, { role: 'admin' }).length >= 4);
  assert.throws(() => lisProfiles(db, {}, { role: 'reception' }), /прав/);
  assert.throws(() => lisProfiles(db, {}, null), /прав/);
  db.close();
});

test('профиль отдаёт каналы — редактор панелей строит из них выпадающий список', () => {
  const db = fresh();
  const bc = lisProfiles(db, {}, LAB).find((p) => p.key === 'mindray-bc-5300');
  assert.equal(bc.channels.length, 27);
  assert.equal(bc.defaultPort, 2575);
  db.close();
});

test('разбор лотка требует номера и отказывает по несуществующему сообщению', () => {
  const db = fresh();
  assert.throws(() => lisMessageDismiss(db, {}, LAB), /номер/);
  assert.throws(() => lisMessageDismiss(db, { id: 999 }, LAB), /не найдено/);
  assert.throws(() => lisMessageAttach(db, { id: 1 }, LAB), /номер/);
  db.close();
});

test('привязка прогоняет ТОТ ЖЕ приём: неподтверждённое сопоставление так и не применяется', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'lab','x','Л','lab')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'ОАК',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (77,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  // Сопоставление НЕ подтверждено — решение владельца D4 обязано устоять и на
  // ручной привязке, иначе лоток стал бы обходом собственного запрета.
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed)
              VALUES (5,'WBC','Лейкоциты','10^9/л','WBC',0)`).run();

  const raw = [
    'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
    'OBR|1||LAB-999999|00001^Automated Count^99MRC',
    'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  ].join('\r');
  db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status) VALUES (1,'127.0.0.1',?, 'LAB-999999','unmatched')").run(raw);

  const out = lisMessageAttach(db, { id: 1, visit_service_id: 77 }, LAB);
  assert.equal(out.ok, true, 'сообщение принято');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = 77').get().c, 0,
    'неподтверждённое сопоставление не применяется даже при ручной привязке');
  assert.ok(db.prepare('SELECT resolved_at FROM lab_device_messages WHERE id = 1').get().resolved_at,
    'разобранная строка обязана перестать требовать внимания');
  db.close();
});

test('подтверждённое сопоставление применяется при ручной привязке', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'ОАК',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (77,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed)
              VALUES (5,'WBC','Лейкоциты','10^9/л','WBC',1)`).run();

  const raw = [
    'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
    'OBR|1||LAB-999999|00001^Automated Count^99MRC',
    'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  ].join('\r');
  db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status) VALUES (1,'127.0.0.1',?, 'LAB-999999','unmatched')").run(raw);

  lisMessageAttach(db, { id: 1, visit_service_id: 77 }, LAB);
  const rows = db.prepare('SELECT * FROM lab_results WHERE visit_service_id = 77').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parameter, 'Лейкоциты');
  assert.equal(rows[0].source, 'analyzer');
  db.close();
});

// ── LIS_MINDRAY_CODES_V1 — коды, которые прибор действительно присылал ───────
const RAW = (...obx) => ['MSH|^~\\&|BC-5380|Mindray|||20260928120000||ORU^R01|7|P|2.3.1',
  'OBR|1||LAB-000098|00001^Automated Count^99MRC', ...obx].join('\r');

test('коды прибора: различные, без картинок, с приборами той же модели и без чужой', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300'), (2,'Гем 2','mindray-bc-5300'), (3,'Биохимия','mindray-bs-240')").run();
  const ins = db.prepare('INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (?,?,?,?,?)');
  ins.run(1, '10.0.0.5', RAW('OBX|1|IS|08001^Take Mode^99MRC||O||||||F', 'OBX|2|NM|6690-2^WBC^LN||9.81|10*9/L|||||F',
    'OBX|3|ED|15551-4^WBC Histogram. BMP^99MRC||^Image^BMP^Base64^Qk0=||||||F'), 'unmapped', '2026-09-28T10:00:00Z');
  ins.run(2, '10.0.0.6', RAW('OBX|1|NM|6690-2^WBC^LN||7.1|10*9/L|||||F', 'OBX|2|NM|718-7^HGB^LN||142|g/L|||||F'), 'unmapped', '2026-09-28T11:00:00Z');
  ins.run(3, '10.0.0.7', RAW('OBX|1|NM|ALT^^99MRC||31|U/L|||||F'), 'unmapped', '2026-09-28T12:00:00Z');
  ins.run(1, '10.0.0.5', 'мусор, а не HL7', 'rejected', '2026-09-28T12:30:00Z');

  const codes = lisDeviceCodes(db, { device_id: 1 }, LAB);
  assert.deepEqual(codes.map((c) => c.code + '^' + c.name).sort(), ['08001^Take Mode', '6690-2^WBC', '718-7^HGB'],
    'та же модель — те же коды; чужая модель и картинки (ED) — нет; мусор пропущен');
  const wbc = codes.find((c) => c.code === '6690-2');
  assert.equal(wbc.system, 'LN');
  assert.equal(wbc.value_type, 'NM');
  assert.equal(wbc.unit, '10*9/L');
  assert.equal(wbc.last_at, '2026-09-28T11:00:00Z', 'последний раз — по самому свежему сообщению');
  db.close();
});

test('коды прибора — только лаборатории; номер обязателен; прибор обязан существовать', () => {
  const db = fresh();
  assert.throws(() => lisDeviceCodes(db, { device_id: 1 }, { role: 'reception' }), /прав/);
  assert.throws(() => lisDeviceCodes(db, {}, LAB), /номер/);
  assert.throws(() => lisDeviceCodes(db, { device_id: 'abc' }, LAB), /номер/);
  assert.throws(() => lisDeviceCodes(db, { device_id: 999 }, LAB), /не найден/);
  db.close();
});

// LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — коды читаются из первых 64 КБ
// каждого сообщения: коды идут в начале, картинки (ED) — в конце, и сотня
// проб с гистограммами не должна разбираться целиком. Строка, оборванная
// границей, отбрасывается: из половины сегмента вышел бы выдуманный код.
test('коды прибора — из первых 64 КБ сообщения; оборванная строка не даёт выдуманного кода', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  const LIMIT = 64 * 1024;
  const pre = ['MSH|^~\\&|BC-5300|Mindray|||20260929120000||ORU^R01|7|P|2.3.1',
    'OBR|1||LAB-000098|00001^Automated Count^99MRC',
    'OBX|1|NM|6690-2^WBC^LN||9.81|10*9/L|||||F',
    'OBX|2|NM|718-7^HGB^LN||142|g/L|||||F'].join('\r') + '\r';
  const edHead = 'OBX|3|ED|15551-4^WBC Histogram. BMP^99MRC||^Image^BMP^Base64^';
  const edTail = '||||||F';
  const cutAt = 'OBX|4|NM|777-';   // граница 64 КБ — посреди кода «777-3»
  const pad = LIMIT - pre.length - edHead.length - edTail.length - 1 - cutAt.length;
  const raw = pre + edHead + 'Q'.repeat(pad) + edTail + '\r' + 'OBX|4|NM|777-3^PLT^LN||250|10*9/L|||||F'
    + '\r' + 'OBX|5|NM|LATE^^99MRC||1|x|||||F';
  assert.ok(raw.slice(0, LIMIT).endsWith('\r' + cutAt), 'граница там, где задумано');
  db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (1,'10.0.0.5',?,'unmapped','2026-09-29T10:00:00Z')").run(raw);

  assert.deepEqual(lisDeviceCodes(db, { device_id: 1 }, LAB).map((c) => c.code + '^' + c.name).sort(), ['6690-2^WBC', '718-7^HGB'],
    'ранние коды на месте; ни «777-» из оборванной строки, ни кодов после 64 КБ');
  db.close();
});

// ── Ревью 2026-09-28 ────────────────────────────────────────────────────────

test('R8: номер прибора — только целое больше нуля, числом или строкой из цифр; прочее — 400', () => {
  // true, [1] и «0x1» Number() превращал в 1 — чужой прибор отвечал на мусор;
  // 1.5, -1 и 1e308 доходили до базы и возвращались 404 вместо «вызов неверен».
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  for (const bad of [true, [1], '0x1', 1.5, -1, 1e308, {}, 0, '0', '', '1.5', ' ', '1e3', null, NaN, Infinity, '99999999999999999999']) {
    assert.throws(() => lisDeviceCodes(db, { device_id: bad }, LAB),
      (e) => e.status === 400 && e.message === 'Нужен номер прибора', 'device_id=' + String(bad));
  }
  assert.deepEqual(lisDeviceCodes(db, { device_id: 1 }, LAB), []);
  assert.deepEqual(lisDeviceCodes(db, { device_id: '1' }, LAB), []);
  assert.deepEqual(lisDeviceCodes(db, { device_id: ' 1 ' }, LAB), [], 'пробелы вокруг цифр обрезаются');
  db.close();
});

test('R8: коды прибора, список моделей и живая лента — чистое чтение: доступны и при просроченной лицензии', () => {
  // Без lis_profiles ячейка «Поле анализатора» теряла типовой список, без
  // lis_recent пустела лента «Анализаторов» — у клиники, которая может читать.
  for (const name of ['lis_device_codes', 'lis_profiles', 'lis_recent']) assert.equal(isReadOnlyRpc(name), true, name);
  // Перезапуск слушателей, привязка и отклонение сообщения — запись.
  for (const name of ['lis_restart', 'lis_message_attach', 'lis_message_dismiss']) assert.equal(isReadOnlyRpc(name), false, name);
});

test('R9: ручная привязка отвечает статусом новой строки лотка — «принято» ещё не «бланк заполнен»', () => {
  // ACK «AA» значит «принято и сохранено». Раньше экран по нему одному
  // говорил «Сообщение применено», хотя бланк заполнился не весь.
  const db = fresh();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'ОАК',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (77,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (5,'WBC','Лейкоциты','10^9/л',1,'WBC',1), (5,'HGB','Гемоглобин','г/л',2,'HGB',1)`).run();
  const raw = (...obx) => ['MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
    'OBR|1||LAB-999999|00001^Automated Count^99MRC', ...obx].join('\r');
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status) VALUES (1,'127.0.0.1',?, 'LAB-999999','unmatched')");

  // Пришёл только WBC — бланк заполнен не весь.
  const partial = ins.run(raw('OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F')).lastInsertRowid;
  const out = lisMessageAttach(db, { id: partial, visit_service_id: 77 }, LAB);
  assert.equal(out.ok, true, 'приём сообщение принял');
  assert.equal(out.code, 'AA');
  assert.equal(out.status, 'unmapped', 'но бланк заполнен не весь');
  assert.match(out.detail, /не пришли: Гемоглобин \(HGB\)/);
  const newest = db.prepare('SELECT status, detail, resolved_at FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
  assert.equal(newest.status, out.status, 'статус — той строки, которую приём только что записал');
  assert.equal(newest.resolved_at, null, 'новая строка лотка ждёт человека');

  // Пришло всё — применено.
  const full = ins.run(raw('OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F', 'OBX|2|NM|HGB^^99MRC||142|g/L|||||F')).lastInsertRowid;
  const done = lisMessageAttach(db, { id: full, visit_service_id: 77 }, LAB);
  assert.deepEqual({ ok: done.ok, status: done.status }, { ok: true, status: 'applied' });
  db.close();
});

// LIS_ANALYZER_LIST_V1, ревью M4 — приём внутри ручной привязки не отмечает
// прибор «на связи»: нажал человек, а не заговорил анализатор. Иначе прибор,
// выключенный неделю назад, после разбора лотка выглядел бы работающим.
test('ревью M4: ручная привязка не трогает «на связи» прибора', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'ОАК',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (77,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile, last_seen_at) VALUES (1,'Гем','mindray-bc-5300','2026-09-10T08:00:00Z')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed)
              VALUES (5,'WBC','Лейкоциты','10^9/л','WBC',1)`).run();
  const raw = ['MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
    'OBR|1||LAB-999999|00001^Automated Count^99MRC', 'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F'].join('\r');
  const id = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status) VALUES (1,'127.0.0.1',?, 'LAB-999999','unmatched')").run(raw).lastInsertRowid;

  const out = lisMessageAttach(db, { id, visit_service_id: 77 }, LAB);
  assert.deepEqual({ ok: out.ok, status: out.status }, { ok: true, status: 'applied' }, 'привязка сработала');
  assert.equal(db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = 1').get().last_seen_at, '2026-09-10T08:00:00Z',
    'отметка связи — та, что была: сообщение пришло тогда, а не сейчас');
  db.close();
});

test('LIS_ANALYZER_LIST_V1: какие порты слушаются — только лаборатории, чистое чтение', () => {
  const db = fresh();
  assert.throws(() => lisListeners(db, {}, { role: 'reception' }), /прав/);
  const out = lisListeners(db, {}, LAB);
  assert.ok(Array.isArray(out.listening), JSON.stringify(out));
  assert.ok(Array.isArray(out.failed));
  assert.equal(isReadOnlyRpc('lis_listeners'), true, 'экран читает это и при просроченной лицензии');
  db.close();
});

// ── LIS_ANALYZER_LIST_V1, ревью C2 — «Удалить» прибор ───────────────────────
// Обычным /api/db найденный анализатор не удалялся НИКОГДА: у него всегда есть
// сообщения, а lab_device_messages.device_id (как и lab_panels.device_id)
// ссылается на lab_devices без ON DELETE (мигр. 123) — SQLite отказывал.

// После удаления слушатели перезапускаются по-настоящему, как в lis_restart.
// Приём в этих тестах выключен, чтобы не занимать порт 2575.
async function withLisOff(fn) {
  const prev = process.env.LIS_ENABLED;
  process.env.LIS_ENABLED = '0';
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LIS_ENABLED; else process.env.LIS_ENABLED = prev;
  }
}

test('ревью C2: удалить прибор — только лаборатория; номер — целое больше нуля; прибор обязан существовать', async () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  await assert.rejects(lisDeviceDelete(db, { id: 1 }, { role: 'reception' }), (e) => e.status === 403 && /прав/.test(e.message));
  await assert.rejects(lisDeviceDelete(db, { id: 1 }, null), (e) => e.status === 403);
  for (const bad of [undefined, null, 0, -1, 1.5, 'abc', '0x1', '', true, [1], {}, 1e308]) {
    await assert.rejects(lisDeviceDelete(db, { id: bad }, LAB),
      (e) => e.status === 400 && e.message === 'Нужен номер прибора', 'id=' + String(bad));
  }
  await assert.rejects(lisDeviceDelete(db, {}, LAB), (e) => e.status === 400);
  await assert.rejects(lisDeviceDelete(db, { id: 999 }, LAB), (e) => e.status === 404 && e.message === 'Прибор не найден');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 1, 'отказы ничего не удалили');
  assert.equal(isReadOnlyRpc('lis_device_delete'), false, 'удаление — запись: клиника с просроченной лицензией его не делает');
  db.close();
});

test('ревью C2: прибор, привязанный к панелям, не удаляется — отказ называет панели', async () => {
  // Молча отвязать панель значило бы, что её пробы перестают ложиться в
  // бланки, и лаборатория узнала бы об этом от врача.
  const db = fresh();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'ОАК',1), (10,'Биохимия',1), (11,'Коагулограмма',1)").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300'), (2,'Другой','mindray-bs-240')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id, active) VALUES (5,'ОАК',9,1,1), (6,'Биохимия',10,1,0), (7,'Коагулограмма',11,2,1)").run();
  db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (1,'127.0.0.1','MSH|^~\\&|BC-5300','unmatched')").run();

  await assert.rejects(withLisOff(() => lisDeviceDelete(db, { id: 1 }, LAB)), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'device_in_use', 'экран узнаёт этот отказ по коду');
    assert.equal(e.message, 'Прибор привязан к панелям: «Биохимия», «ОАК» — сначала выберите у них другой анализатор.',
      'выключенная панель тоже названа: внешний ключ держит и её');
    assert.equal(e.template, 'Прибор привязан к панелям: {panels} — сначала выберите у них другой анализатор.');
    assert.deepEqual(e.params, { panels: '«Биохимия», «ОАК»' });
    return true;
  });
  assert.ok(db.prepare('SELECT id FROM lab_devices WHERE id = 1').get(), 'прибор на месте');
  assert.equal(db.prepare('SELECT device_id FROM lab_device_messages').get().device_id, 1, 'отказ ничего не меняет: сообщения не отвязаны');
  db.close();
});

// LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — переросшее сообщение лежит в лотке
// обрезанным: только его первые 64 КБ (mllp.js). Доказано: «Привязать» такое
// клало в бланк обрезанное число — PLT «25» вместо 250. Сервер отказывает, а
// строка лотка ждёт повтора пробы с прибора.
const CUT_DETAIL = 'сообщение больше 4 МБ — не принято; в лотке только его начало';   // как пишет index.js
test('обрезанное переросшее сообщение не привязывается: 409, бланк не тронут, строка ждёт человека', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'ОАК',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (77,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed)
              VALUES (5,'PLT','Тромбоциты','10^9/л','PLT',1)`).run();
  const head = ['MSH|^~\\&|BC-5300|Mindray|||20260929120000||ORU^R01|42|P|2.3.1',
    'OBR|1||LAB-000077|00001^Automated Count^99MRC',
    'OBX|1|NM|777-3^PLT^LN||25'].join('\r');   // «250» оборвано потолком на полуслове
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status, detail) VALUES (NULL,'10.0.0.9',?,'LAB-000077','rejected',?)");
  const id = ins.run(head, CUT_DETAIL).lastInsertRowid;

  assert.throws(() => lisMessageAttach(db, { id, visit_service_id: 77 }, LAB), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.message, 'Сообщение пришло не целиком — привязать его нельзя. Попросите анализатор отправить эту пробу ещё раз.');
    return true;
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = 77').get().c, 0, 'обрезанное число в бланк не легло');
  assert.equal(db.prepare('SELECT resolved_at FROM lab_device_messages WHERE id = ?').get(id).resolved_at, null, 'строка лотка ждёт повтора пробы');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c, 1, 'и новой строки лотка отказ не пишет');
  assert.notEqual(db.prepare("SELECT status FROM visit_services WHERE id = 77").get().status, 'resulted');

  // Отказ — только обрезанному: прочий мусор привязка прогоняет как раньше.
  const junk = ins.run('MSH|^~\\&|BC-5300|Mindray|||20260929120000||ADT^A01|43|P|2.3.1', 'ожидался ORU^R01, получен ADT^A01').lastInsertRowid;
  const out = lisMessageAttach(db, { id: junk, visit_service_id: 77 }, LAB);
  assert.deepEqual({ ok: out.ok, status: out.status }, { ok: false, status: 'rejected' });
  db.close();
});

test('ревью C2: найденный анализатор с сообщениями удаляется, сообщения остаются целиком', async () => {
  const db = fresh();
  const found = db.prepare("INSERT INTO lab_devices (name, profile, host, discovered, added) VALUES ('BC-5300','mindray-bc-5300','10.0.0.9',1,0)").run().lastInsertRowid;
  const other = db.prepare("INSERT INTO lab_devices (name, profile) VALUES ('Гем','mindray-bc-5300')").run().lastInsertRowid;
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (?, '10.0.0.9', ?, ?)");
  const m1 = ins.run(found, RAW('OBX|1|NM|6690-2^WBC^LN||9.81|10*9/L|||||F'), 'unmatched').lastInsertRowid;
  const m2 = ins.run(found, 'мусор, а не HL7', 'rejected').lastInsertRowid;
  const m3 = ins.run(other, RAW('OBX|1|NM|718-7^HGB^LN||142|g/L|||||F'), 'unmapped').lastInsertRowid;
  const before = db.prepare('SELECT id, peer, raw, sample_id, status, detail, received_at, resolved_at FROM lab_device_messages ORDER BY id').all();
  // Так было: обычное удаление упирается во внешний ключ.
  assert.throws(() => db.prepare('DELETE FROM lab_devices WHERE id = ?').run(found), /FOREIGN KEY/);

  const out = await withLisOff(() => lisDeviceDelete(db, { id: String(found) }, LAB));
  assert.deepEqual(out, { ok: true, detached: 2 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE id = ?').get(found).c, 0, 'прибор удалён');
  assert.deepEqual(db.prepare('SELECT id, peer, raw, sample_id, status, detail, received_at, resolved_at FROM lab_device_messages ORDER BY id').all(), before,
    'инвариант 2: ни одно сообщение не потеряно и не изменено');
  assert.deepEqual(db.prepare('SELECT id, device_id FROM lab_device_messages ORDER BY id').all(),
    [{ id: m1, device_id: null }, { id: m2, device_id: null }, { id: m3, device_id: other }], 'отвязаны только сообщения удалённого прибора');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1_SERVICE — служебные сообщения прибора ─────────────
// Контроль качества, калибровка и запросы хранятся (инвариант 2), но в бланк,
// лоток, ленту и «Поле анализатора» не идут. Таблица «Анализаторы» показывает
// их число у прибора за сегодня: «контроль: 12 · запросы: 40».

test('lis_service_counts: по прибору за сегодня — контроль, калибровка, запросы; пробы, вчерашнее и сообщения без прибора не в счёт', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'BS-200','mindray-bs-240'), (2,'A1000',''), (3,'Молчит','')").run();
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, kind, resolved_at) VALUES (?, '10.0.0.5', 'MSH|', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))");
  const old = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, kind, received_at) VALUES (?, '10.0.0.5', 'MSH|', 'unmatched', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days'))");
  for (let i = 0; i < 2; i++) ins.run(1, 'unmatched', 'qc');
  ins.run(1, 'unmatched', 'calibration');
  for (let i = 0; i < 3; i++) ins.run(1, 'unmatched', 'query');
  ins.run(1, 'applied', 'result');
  ins.run(2, 'unmatched', 'query');
  ins.run(null, 'unmatched', 'query');
  old.run(1, 'qc');
  old.run(3, 'query');

  assert.deepEqual(lisServiceCounts(db, {}, LAB), [
    { device_id: 1, qc: 2, calibration: 1, query: 3 },
    { device_id: 2, qc: 0, calibration: 0, query: 1 },
  ]);
  db.close();
});

test('lis_service_counts — только лаборатории; чистое чтение; заведён в карте RPC', () => {
  const db = fresh();
  assert.throws(() => lisServiceCounts(db, {}, { role: 'reception' }), /прав/);
  assert.throws(() => lisServiceCounts(db, {}, null), /прав/);
  assert.deepEqual(lisServiceCounts(db, {}, { role: 'admin' }), []);
  assert.equal(isReadOnlyRpc('lis_service_counts'), true, 'счётчик виден и клинике с просроченной лицензией');
  assert.equal(typeof RPC.lis_service_counts, 'function');
  db.close();
});

test('служебные сообщения не идут ни в живую ленту, ни в «Поле анализатора»', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  const ins = db.prepare('INSERT INTO lab_device_messages (device_id, peer, raw, status, kind, resolved_at) VALUES (1, ?, ?, ?, ?, ?)');
  ins.run('10.0.0.5', RAW('OBX|1|NM|6690-2^WBC^LN||9.81|10*9/L|||||F'), 'unmapped', 'result', null);
  ins.run('10.0.0.5', RAW('OBX|1|NM|QCX^Контроль^99MRC||5.1|g/L|||||F'), 'unmatched', 'qc', '2026-10-01T08:00:00Z');
  ins.run('10.0.0.5', RAW('OBX|1|NM|CALX^^99MRC||1|x|||||F'), 'unmatched', 'calibration', '2026-10-01T08:00:00Z');
  ins.run('10.0.0.5', 'MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORM^O01|9|P|2.3.1', 'unmatched', 'query', '2026-10-01T08:00:00Z');

  const recent = lisRecent(db, {}, LAB);
  assert.equal(recent.length, 1, 'утренний контроль не вытесняет пробы пациентов');
  assert.equal(recent[0].status, 'unmapped');
  assert.deepEqual(lisDeviceCodes(db, { device_id: 1 }, LAB).map((c) => c.code), ['6690-2'], 'коды контроля и калибровки не предлагаются');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1_SAMPLE — привязка из лотка номером, без подмены ───
// Раньше привязка переписывала OBR-3 регуляркой. У BS-200 номер в OBR-2, а в
// OBR-3 — место в штативе: подмена OBR-3 привязала бы не то (этикетка LAB- в
// OBR-2 бьёт голые цифры). Теперь приём получает номер явно, сырое — исходное.

function attachClinic(db, { created = "strftime('%Y-%m-%dT%H:%M:%SZ','now')" } = {}) {
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Биохимия',1)").run();
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (77,55,9,'queued',${created})`).run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'BS-200','mindray-bs-240')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'Биохимия',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed)
              VALUES (5,'GLU','Глюкоза','ммоль/л','2',1)`).run();
}
// BS-200, руководство с. 24–25: в OBR-2 — смазанная/чужая этикетка, в OBR-3 — место в штативе.
const BS200_RAW = ['MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
  'OBR|1|LAB-999999|2|Mindray^BS-200E|Y||||||||||serum',
  'OBX|1|NM|2|test2|5.000000|g/ml|-||||F|||||||'].join('\r');

test('привязка BS-200 (номер в OBR-2): ложится в названный заказ, сырое не изменено, sample_id — номер человека', () => {
  const db = fresh();
  attachClinic(db);
  const id = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status, detail) VALUES (1,'10.0.0.40',?,'LAB-999999','unmatched','заказ по номеру пробы не найден')").run(BS200_RAW).lastInsertRowid;

  const out = lisMessageAttach(db, { id, visit_service_id: 77 }, LAB);
  assert.deepEqual({ ok: out.ok, status: out.status }, { ok: true, status: 'applied' }, out.detail);
  assert.match(out.detail, /привязано вручную/);
  const rows = db.prepare('SELECT * FROM lab_results WHERE visit_service_id = 77').all();
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].value), 5, 'значение легло (провод BS-200 срежет нули, когда появится профиль)');
  const fresh_ = db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
  assert.equal(fresh_.raw, BS200_RAW, 'инвариант 2: сырое сообщение новой строки — исходное, без подмены');
  assert.equal(fresh_.sample_id, '77');
  assert.equal(fresh_.visit_service_id, 77);
  assert.ok(db.prepare('SELECT resolved_at FROM lab_device_messages WHERE id = ?').get(id).resolved_at);
  db.close();
});

test('привязка: правило голых цифр не действует — номер назвал человек; старый открытый заказ принимает', () => {
  const db = fresh();
  attachClinic(db, { created: "strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')" });
  const id = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status) VALUES (1,'10.0.0.40',?,'','unmatched')").run(BS200_RAW).lastInsertRowid;
  const out = lisMessageAttach(db, { id, visit_service_id: 77 }, LAB);
  assert.equal(out.status, 'applied', out.detail);
  db.close();
});

test('служебное сообщение (контроль, калибровка, запрос) к заказу не привязывается — 409', () => {
  const db = fresh();
  attachClinic(db);
  const qc = ['MSH|^~\\&|Mindray|BS-200E|||20070720120202||ORU^R01|1|P|2.3.1||||2||ASCII|||',
    'OBR|1|1|test1|Mindray^BS-200E||20070720120143|||||||QUAL1|1111|20080720000000||H|5.000000|2.000000|0.11029|g/ml'].join('\r');
  for (const kind of ['qc', 'calibration', 'query']) {
    const id = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, kind, resolved_at) VALUES (1,'10.0.0.40',?,'unmatched',?,'2026-10-01T08:00:00Z')").run(qc, kind).lastInsertRowid;
    const before = db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c;
    assert.throws(() => lisMessageAttach(db, { id, visit_service_id: 77 }, LAB), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.message, 'Служебное сообщение прибора (контроль качества, калибровка или запрос) к заказу не привязывается');
      return true;
    }, kind);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c, before, kind + ': новой строки нет');
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = 77').get().c, 0);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 77').get().status, 'queued');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1_PROFILES / _MODEL — новые поля профиля экрану ─────
test('lis_profiles отдаёт aliases, wire, oneTestPerMessage, connect, wireSource; прежние — по умолчанию', () => {
  const db = fresh();
  const all = lisProfiles(db, {}, LAB);
  const bs = all.find((p) => p.key === 'mindray-bs-200');
  assert.deepEqual({ aliases: bs.aliases, wire: bs.wire, one: bs.oneTestPerMessage, connect: bs.connect, src: bs.wireSource, ch: bs.channelsSource, n: bs.channels.length },
    { aliases: ['BS-200', 'BS-200E'], wire: 'mindray-chem', one: true, connect: 'listen', src: 'documented', ch: 'device', n: 0 });
  const lumo = all.find((p) => p.key === 'autobio-autolumo-a1000');
  assert.deepEqual([lumo.wire, lumo.oneTestPerMessage, lumo.wireSource, lumo.channelsSource], ['autobio-hl7', true, 'driver', 'device']);
  const bc780 = all.find((p) => p.key === 'mindray-bc-780');
  assert.deepEqual([bc780.wire, bc780.oneTestPerMessage, bc780.connect, bc780.wireSource, bc780.channelsSource, bc780.channels.length],
    ['mindray-hematology', false, 'unknown', 'siblings', 'siblings', 27]);
  const old = all.find((p) => p.key === 'mindray-bc-5300');
  assert.deepEqual({ aliases: old.aliases, wire: old.wire, one: old.oneTestPerMessage, connect: old.connect, src: old.wireSource },
    { aliases: ['BC-5300'], wire: 'default', one: false, connect: 'listen', src: null });
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1_WIRE — «Поле анализатора» читает провод прибора ───
test('lis_device_codes: BS-200 — код «2» (номер теста), подпись «test2»; имени нет', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'BS-200','mindray-bs-200')").run();
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (1,'10.0.0.40',?,'unmapped',?)");
  const bs = (n, name, v) => ['MSH|^~\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
    'OBR|1|LAB-000123|2|Mindray^BS-200E|Y', `OBX|1|NM|${n}|${name}|${v}|g/ml|-||||F|||||||`].join('\r');
  ins.run(bs('2', 'test2', '5.000000'), '2026-10-01T10:00:00Z');
  ins.run(bs('12', 'GLU', '5.400000'), '2026-10-01T10:01:00Z');
  const codes = lisDeviceCodes(db, { device_id: 1 }, LAB);
  assert.deepEqual(codes.map((c) => [c.code, c.name, c.label]).sort(), [['12', '', 'GLU'], ['2', '', 'test2']],
    'сохраняется код: подпись правит оператор, сравнивается только номер');
  db.close();
});

test('lis_device_codes: Autobio по сети — код из OBX-4; сообщение переадресателя — провод forwarder', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'A1000','autobio-autolumo-a1000')").run();
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (1,'10.0.0.41',?,'unmapped',?)");
  ins.run(['MSH|^~\&|A1000|Autolumo|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||', 'OBR|1|LAB-000123|||',
    'OBX|1|NM|1^Vitamin B12|206|5981666^390.946|pg/mL|||||F'].join('\r'), '2026-10-01T10:00:00Z');
  ins.run(['MSH|^~\&|AutoLumo A1000|LabPC|||20261001101500||ORU^R01|5|P|2.3.1', 'OBR|1||LAB-000124|00001^Automated Count^99MRC',
    'OBX|1|NM|207^^AUTOBIO|Ferritin|52.1||||||F'].join('\r'), '2026-10-01T10:05:00Z');
  const codes = lisDeviceCodes(db, { device_id: 1 }, LAB);
  const by = Object.fromEntries(codes.map((c) => [c.code, c]));
  assert.deepEqual(Object.keys(by).sort(), ['206', '207']);
  assert.deepEqual([by['206'].name, by['206'].label], ['', 'Vitamin B12'], 'OBX-3 Autobio — номер заявки, не сравнивается');
  assert.deepEqual([by['207'].name, by['207'].system, by['207'].label], ['', 'AUTOBIO', 'Ferritin'], 'переадресатор: OBX-3, подпись OBX-4');
  db.close();
});

test('lis_device_codes: прежний провод — подпись пустая, коды прежние; не ORU пропускается', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (1,'10.0.0.5',?,'unmapped','2026-10-01T10:00:00Z')");
  ins.run(RAW('OBX|1|NM|6690-2^WBC^LN||9.81|10*9/L|||||F'));
  ins.run('MSH|^~\&|BC-5300|Mindray|||20260910143943||ADT^A01|43|P|2.3.1\rOBX|1|NM|ZZZ^^99MRC||1|x|||||F');
  assert.deepEqual(lisDeviceCodes(db, { device_id: 1 }, LAB).map((c) => [c.code, c.name, c.label]), [['6690-2', 'WBC', '']]);
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1_DIAL — lis_listeners говорит и о звонках прибору ──
test('lis_listeners: dialing — список соединений, которые Easy-Med держит сам (пустой без таких приборов)', () => {
  const db = fresh();
  const out = lisListeners(db, {}, LAB);
  assert.ok(Array.isArray(out.dialing), JSON.stringify(out));
  for (const d of out.dialing) {
    for (const k of ['device_id', 'host', 'port', 'state', 'since', 'last_rx_at', 'code', 'retry_at']) assert.ok(k in d, k);
  }
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R1, пп. 6 и 10: «Привязать» ──────────────

// П. 6 — строки до мигр. 233 по умолчанию kind = 'result', и старый контроль
// качества BS-200 (MSH-16 = 2) прошёл бы через «Привязать» в бланк пациента.
// Отказ — и по содержимому сообщения, а не только по колонке kind.
test('R1 п. 6: служебное по содержимому (QC и запрос с kind = result, строки до мигр. 233) — 409, бланк не тронут', () => {
  const db = fresh();
  attachClinic(db);
  db.prepare("UPDATE lab_devices SET profile = 'mindray-bs-200' WHERE id = 1").run();
  const qc = ['MSH|^~\\&|Mindray|BS-200E|||20070720120202||ORU^R01|1|P|2.3.1||||2||ASCII|||',
    'OBR|1|1|test1|Mindray^BS-200E||20070720120143|||||||QUAL1|1111|20080720000000||H|5.000000|2.000000|0.11029|g/ml',
    'OBX|1|NM|2|test2|5.000000|g/ml|-||||F'].join('\r');
  const qry = ['MSH|^~\\&|Mindray|BS-200E|||20070723170707||QRY^Q02|1|P|2.3.1||||||ASCII|||',
    'QRD|20070723170707|R|D|1|||RD|34567743|OTH|||T|'].join('\r');
  for (const raw of [qc, qry]) {
    const id = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (1,'10.0.0.40',?,'unmatched')").run(raw).lastInsertRowid;
    assert.equal(db.prepare('SELECT kind FROM lab_device_messages WHERE id = ?').get(id).kind, 'result', 'как у строк до мигр. 233');
    assert.throws(() => lisMessageAttach(db, { id, visit_service_id: 77 }, LAB), (e) => e.status === 409
      && e.message === 'Служебное сообщение прибора (контроль качества, калибровка или запрос) к заказу не привязывается');
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = 77').get().c, 0);
  db.close();
});

// П. 10 — Number() принимал true, «0x7b», [123] и «1e0» за номер.
test('R1 п. 10: номер сообщения и заказа — только целое больше нуля; у заказа можно «LAB-»', () => {
  const db = fresh();
  attachClinic(db);
  const raw = ['MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
    'OBR|1|LAB-999999|2|Mindray^BS-200E|Y', 'OBX|1|NM|2|test2|5.000000|g/ml|-||||F'].join('\r');
  const ins = () => db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (1,'10.0.0.40',?,'unmatched')").run(raw).lastInsertRowid;
  const id = ins();
  for (const bad of [true, [77], '0x4d', '7.7e1', 77.5, -77, 0, '', ' ', null, {}, 'LAB-', 'LAB-x', 'LAB2', '77abc']) {
    assert.throws(() => lisMessageAttach(db, { id, visit_service_id: bad }, LAB),
      (e) => e.status === 400 && e.message === 'Нужны номер сообщения и номер заказа', 'visit_service_id=' + JSON.stringify(bad));
  }
  for (const bad of [true, [id], String(id) + '.0', '0x' + id.toString(16)]) {
    assert.throws(() => lisMessageAttach(db, { id: bad, visit_service_id: 77 }, LAB),
      (e) => e.status === 400, 'id=' + JSON.stringify(bad));
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c, 1, 'ни одного прогона');
  assert.equal(lisMessageAttach(db, { id, visit_service_id: 'LAB-000077' }, LAB).status, 'applied', 'номер с этикетки');
  const id2 = ins();
  assert.equal(lisMessageAttach(db, { id: String(id2), visit_service_id: ' 77 ' }, LAB).ok, true);
  db.close();
});

test('R1 п. 10: уже разобранную или принятую строку привязать нельзя — 409 простыми словами', () => {
  const db = fresh();
  attachClinic(db);
  const raw = ['MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
    'OBR|1|LAB-999999|2|Mindray^BS-200E|Y', 'OBX|1|NM|2|test2|5.000000|g/ml|-||||F'].join('\r');
  const resolved = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, resolved_at) VALUES (1,'10.0.0.40',?,'unmatched','2026-10-01T08:00:00Z')").run(raw).lastInsertRowid;
  const applied = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (1,'10.0.0.40',?,'applied')").run(raw).lastInsertRowid;
  for (const id of [resolved, applied]) {
    const before = db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c;
    assert.throws(() => lisMessageAttach(db, { id, visit_service_id: 77 }, LAB),
      (e) => e.status === 409 && e.message === 'Сообщение уже разобрано или принято — привязать его ещё раз нельзя');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c, before, 'нового прогона нет');
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = 77').get().c, 0);
  db.close();
});

// LIS_REAL_ANALYZERS_V1 (экран) — живая лента собирает сообщения одной серии
// (BS-200 шлёт по тесту) в одну строку по прибору и заказу; прибор — номером,
// а не именем: два прибора с одним названием — две серии.
test('lis_recent отдаёт номер прибора — лента склеивает серию по нему, а не по имени', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'BS-200','mindray-bs-200'), (2,'BS-200','mindray-bs-200')").run();
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (?, '10.0.0.40', ?, 'unmatched')");
  ins.run(1, RAW('OBX|1|NM|2|test2|5|g/ml|-||||F'));
  ins.run(2, RAW('OBX|1|NM|2|test2|5|g/ml|-||||F'));
  assert.deepEqual(lisRecent(db, {}, LAB).map((r) => [r.device_id, r.device_name]), [[2, 'BS-200'], [1, 'BS-200']]);
  db.close();
});

// LIS_REAL_ANALYZERS_V1 (экран, ревью) — «сейчас» сервера: окно серии (60 мин),
// «сигнал N с назад» и «повтор через N с» считаются от меток сервера, и экран
// меряет их часами сервера, а не своего компьютера (часы лабораторного ПК
// могут отставать на часы — и просроченная серия пряталась бы в «Идёт приём»).
test('lis_listeners отдаёт «сейчас» сервера', () => {
  const db = fresh();
  const before = Date.now();
  const out = lisListeners(db, {}, LAB);
  const now = Date.parse(out.now);
  assert.ok(Number.isFinite(now), JSON.stringify(out));
  assert.ok(now >= before - 1000 && now <= Date.now() + 1000, out.now);
  assert.match(out.now, /Z$/, 'UTC, как received_at');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R2 ───────────────────────────────────────

// П. 1 — у BS-200 номер теста свой у каждого прибора (ItemID.ini): коды двух
// BS-200 в «Поле анализатора» не сливаются. У гематологии (коды
// производителя) — сливаются, как прежде.
test('R2 п. 1: lis_device_codes у BS-200 — только своего прибора', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'BS-200','mindray-bs-200'), (2,'BS-200 (2)','mindray-bs-200')").run();
  const bs = (n, name) => ['MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
    'OBR|1|LAB-000123|2|Mindray^BS-200E|Y', `OBX|1|NM|${n}|${name}|5|g/ml|-||||F`].join('\r');
  const ins = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status) VALUES (?, '10.0.0.40', ?, 'unmapped')");
  ins.run(1, bs('2', 'GLU'));
  ins.run(2, bs('2', 'CREA'));
  ins.run(2, bs('7', 'UREA'));
  assert.deepEqual(lisDeviceCodes(db, { device_id: 1 }, LAB).map((c) => c.code + ' · ' + c.label), ['2 · GLU']);
  assert.deepEqual(lisDeviceCodes(db, { device_id: 2 }, LAB).map((c) => c.code + ' · ' + c.label).sort(), ['2 · CREA', '7 · UREA']);
  db.close();
});

// П. 2 — «Привязать» строку серии к другому заказу: значение, которое она уже
// положила в бланк первого заказа, оттуда снимается (если это всё ещё значение
// прибора из этой строки и бланк — черновик), а строка выходит из серии
// первого заказа — его бланк снова неполон и всплывает в лотке.
function reattachClinic() {
  const db = fresh();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов'), (4,'Петров')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'scheduled'), (56,4,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Биохимия',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (123,55,9,'in_progress'), (124,56,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'BS-200','mindray-bs-200')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'Биохимия',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (5,'GLU','Глюкоза','',1,'2',1), (5,'UREA','Мочевина','',2,'3',1), (5,'CALC','Расчётный','',3,'102',1)`).run();
  return db;
}
const BS2 = (label, n, name, v) => ['MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
  `OBR|1|${label}|2|Mindray^BS-200E|Y`, `OBX|1|NM|${n}|${name}|${v}|g/ml|-||||F`].join('\r');
const formOf = (db, id) => Object.fromEntries(db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = ?').all(id).map((r) => [r.parameter, r.value]));
const newest = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();

test('R2 п. 2: «Привязать» ждущую строку к другому заказу — значение снято из первого бланка; первый заказ снова ждёт', () => {
  const db = reattachClinic();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  assert.equal(glu.visit_service_id, 123);
  assert.deepEqual(formOf(db, 123), { 'Глюкоза': '5.5' });

  const out = lisMessageAttach(db, { id: glu.id, visit_service_id: 124 }, LAB);
  assert.equal(out.ok, true);
  assert.match(out.detail, /снято из бланка заказа № 123: Глюкоза/);
  assert.deepEqual(formOf(db, 123), {}, 'значение ушло из бланка чужого заказа');
  assert.deepEqual(formOf(db, 124), { 'Глюкоза': '5.5' });
  const orig = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(glu.id);
  assert.ok(orig.resolved_at);
  assert.match(orig.detail, /перепривязано к заказу № 124/);
  assert.equal(orig.raw, BS2('LAB-000123', '2', 'GLU', '5.5'), 'сырое не тронуто (инвариант 2)');

  ingestMessage(db, BS2('LAB-000123', '3', 'UREA', '10'), '10.0.0.40', 1);
  ingestMessage(db, BS2('LAB-000123', '102', 'CALC', '15'), '10.0.0.40', 1);
  const last = newest(db);
  assert.equal(last.status, 'unmapped');
  assert.match(last.detail, /не пришли: Глюкоза \(2\)/, 'перепривязанная строка — не член серии заказа 123');
  db.close();
});

test('R2 п. 2: выданное или изменённое после прибора значение не снимается — сказано в журнале', () => {
  // Ревью R3, п. 8 — «выдан» — по заказу: выдана глюкоза — не снимается и
  // мочевина. «Изменено после прибора» — на невыданном заказе (второй случай).
  const db = reattachClinic();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  db.prepare("UPDATE lab_results SET verified_at = '2026-10-01T08:00:00Z' WHERE visit_service_id = 123 AND parameter = 'Глюкоза'").run();
  const a = lisMessageAttach(db, { id: glu.id, visit_service_id: 124 }, LAB);
  assert.match(a.detail, /оставлено в бланке заказа № 123: Глюкоза \(выдан\)/);
  assert.deepEqual(formOf(db, 123), { 'Глюкоза': '5.5' });
  db.close();

  const db2 = reattachClinic();
  ingestMessage(db2, BS2('LAB-000123', '3', 'UREA', '10'), '10.0.0.40', 1);
  const urea = newest(db2);
  db2.prepare("UPDATE lab_results SET value = '11' WHERE visit_service_id = 123 AND parameter = 'Мочевина'").run();
  const b = lisMessageAttach(db2, { id: urea.id, visit_service_id: 124 }, LAB);
  assert.match(b.detail, /оставлено в бланке заказа № 123: Мочевина \(изменено после прибора\)/);
  assert.deepEqual(formOf(db2, 123), { 'Мочевина': '11' });
  db2.close();
});

test('R2 п. 2: то же значение пришло в заказ 123 и другим сообщением — не снимается', () => {
  // Ревью R4, п. B — в бланке значение того сообщения, которое записало его
  // последним (source_message_id): его и «Привязывают» здесь. Привязать
  // первое — снимать нечего, его значение в бланке переписано вторым.
  const db = reattachClinic();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const first = newest(db);
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const second = newest(db);
  const a = lisMessageAttach(db, { id: second.id, visit_service_id: 124 }, LAB);
  assert.match(a.detail, /оставлено в бланке заказа № 123: Глюкоза \(то же значение пришло другим сообщением\)/);
  assert.deepEqual(formOf(db, 123), { 'Глюкоза': '5.5' });
  const b = lisMessageAttach(db, { id: first.id, visit_service_id: 124 }, LAB);
  assert.ok(!/снято/.test(b.detail), b.detail);
  assert.deepEqual(formOf(db, 123), { 'Глюкоза': '5.5' });
  db.close();
});

// П. 10а — оборванный кадр в лотке — начало, а не сообщение целиком:
// «Привязать» его нельзя, как переросшее.
test('R2 п. 10: оборванный кадр не привязывается — 409, как переросшее', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO lab_device_messages (peer, raw, status, detail) VALUES ('10.0.0.5', ?, 'rejected', ?)")
    .run('MSH|^~\\&|BC-5300|Mindray|||1||ORU^R01|1|P|2.3.1\rOBR|1||LAB-000123', ABANDONED_DETAIL_PREFIX + 'x').lastInsertRowid;
  assert.throws(() => lisMessageAttach(db, { id, visit_service_id: 123 }, LAB),
    (e) => e.status === 409 && /пришло не целиком/.test(e.message));
  db.close();
});

// П. 13 — «Отклонить» тем же строгим разбором номера: {id: true} отклонял № 1.
test('R2 п. 13: lis_message_dismiss — номер только целое больше нуля', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_device_messages (peer, raw, status) VALUES ('10.0.0.5', 'MSH|', 'unmatched')").run();
  for (const bad of [true, [1], '0x1', '1e0', 1.5, -1, 0, '', null]) {
    assert.throws(() => lisMessageDismiss(db, { id: bad }, LAB), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.equal(db.prepare('SELECT resolved_at FROM lab_device_messages WHERE id = 1').get().resolved_at, null);
  assert.equal(lisMessageDismiss(db, { id: ' 1 ' }, LAB).ok, true);
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R3 ───────────────────────────────────────

test('R3 п. 2: lis_profiles отдаёт codesPerInstrument — экран сбрасывает подтверждения при смене прибора', () => {
  const db = fresh();
  const all = lisProfiles(db, {}, LAB);
  assert.equal(all.find((p) => p.key === 'mindray-bs-200').codesPerInstrument, true);
  assert.ok(all.filter((p) => p.key !== 'mindray-bs-200').every((p) => p.codesPerInstrument === false));
  db.close();
});

// П. 1 — проба второго BS-200 в лотке; лаборатория удаляет его строку («Удалить»
// ставит device_id = NULL у его сообщений) и жмёт «Привязать»: раньше прибор
// становился неизвестным, и проверка «своя панель» пропускалась — креатинин
// второго прибора ложился в «Глюкозу».
test('R3 п. 1: удалили строку второго BS-200 и «Привязали» его пробу — в бланк не легло, лоток с причиной', async () => {
  const db = reattachClinic();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-200 (2)','mindray-bs-200')").run();
  ingestMessage(db, BS2('LAB-000123', '2', 'CREA', '88'), '10.0.0.41', 2);
  const row = newest(db);
  assert.equal(row.status, 'unmatched');
  await withLisOff(() => lisDeviceDelete(db, { id: 2 }, LAB));
  assert.equal(db.prepare('SELECT device_id FROM lab_device_messages WHERE id = ?').get(row.id).device_id, null);
  const out = lisMessageAttach(db, { id: row.id, visit_service_id: 123 }, LAB);
  assert.equal(out.status, 'unmatched');
  assert.match(out.detail, /прибор этого сообщения неизвестен/);
  assert.deepEqual(formOf(db, 123), {});
  db.close();
});

// П. 7 — снять значение из первого заказа можно, только если второй его
// принял: иначе (выдан, нет такого заказа — опечатка) привязка откатывается
// целиком, и первый бланк не тронут.
test('R3 п. 7: второй заказ выдан или номер с опечаткой — привязка откатывается, первый бланк и строка лотка не тронуты', () => {
  const db = reattachClinic();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, verified_at) VALUES (124, 'Мочевина', '9', 'manual', '2026-10-01T08:00:00Z')").run();
  const count = () => db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c;
  for (const target of [124, 999]) {
    const before = count();
    assert.throws(() => lisMessageAttach(db, { id: glu.id, visit_service_id: target }, LAB), (e) => {
      assert.equal(e.status, 409, String(target));
      assert.equal(e.message, 'Привязка не сделана: этот заказ пробу не принял — значения в прежнем заказе не тронуты, строка осталась в лотке. Проверьте номер заказа.');
      return true;
    });
    assert.equal(count(), before, target + ': новой строки нет');
    assert.deepEqual(formOf(db, 123), { 'Глюкоза': '5.5' }, target + ': первый бланк не тронут');
    const again = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(glu.id);
    assert.deepEqual([again.resolved_at, again.visit_service_id, again.detail], [null, 123, glu.detail], target + ': строка лотка прежняя');
  }
  db.close();
});

// П. 8 — «выдан» — по заказу, как у правила выдачи (D7), а не по строке.
test('R3 п. 8: в первом заказе выдан другой показатель — заказ выдан, значение не снимается', () => {
  const db = reattachClinic();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, verified_at) VALUES (123, 'Мочевина', '9', 'manual', '2026-10-01T08:00:00Z')").run();
  const out = lisMessageAttach(db, { id: glu.id, visit_service_id: 124 }, LAB);
  assert.match(out.detail, /оставлено в бланке заказа № 123: Глюкоза \(выдан\)/);
  assert.equal(formOf(db, 123)['Глюкоза'], '5.5');
  db.close();
});

// П. 9 — после снятия бланк первого заказа пуст: заказ возвращается в работу
// лаборатории, а не стоит «результаты внесены» с пустым бланком; исходная
// строка лотка уходит с первого заказа — иначе касса не могла снять или
// отменить его строку («по услуге уже пришли данные анализатора»), а лента
// показывала имя его пациента.
test('R3 п. 9: бланк первого заказа опустел — заказ снова в том статусе, в каком был до прибора; строка лотка с него снята', () => {
  // Ревью R4, п. C — ровно статус до того, как прибор поставил «результаты
  // внесены» (visit_services.lis_status_before), а не «ждёт забора» по догадке.
  for (const want of ['queued', 'collected', 'in_progress']) {
    const db = reattachClinic();
    db.prepare('UPDATE visit_services SET status = ? WHERE id = 123').run(want);
    ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
    const glu = newest(db);
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 123').get().status, 'resulted');
    lisMessageAttach(db, { id: glu.id, visit_service_id: 124 }, LAB);
    assert.deepEqual(formOf(db, 123), {});
    assert.deepEqual({ ...db.prepare('SELECT status, lis_status_before FROM visit_services WHERE id = 123').get() }, { status: want, lis_status_before: null }, want);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages WHERE visit_service_id = 123').get().c, 0,
      'след прибора на заказе 123 не держит кассу');
    const orig = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(glu.id);
    assert.match(orig.detail, /перепривязано к заказу № 124 \(был заказ № 123\)/, 'история читается');
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 124').get().status, 'resulted');
    db.close();
  }
});

test('R3 п. 9: в первом бланке остались другие значения — статус не меняется', () => {
  const db = reattachClinic();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  ingestMessage(db, BS2('LAB-000123', '3', 'UREA', '10'), '10.0.0.40', 1);
  lisMessageAttach(db, { id: glu.id, visit_service_id: 124 }, LAB);
  assert.deepEqual(formOf(db, 123), { 'Мочевина': '10' });
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 123').get().status, 'resulted');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R4 ───────────────────────────────────────

const tray409 = (db, id, target) => assert.throws(() => lisMessageAttach(db, { id, visit_service_id: target }, LAB), (e) => {
  assert.equal(e.status, 409, String(target));
  assert.match(e.message, /^Привязка не сделана: этот заказ пробу не принял/);
  return true;
});
const msgRow = (db, id) => db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(id);

// П. B (а) — первый заказ выдан, во втором номере опечатка: снимать нечего
// (выдано), и прежняя проверка «снимаем — значит, новый обязан принять»
// пропускала: строка лотка разбиралась и уходила с заказа, хотя пробу не
// принял никто. Теперь строка, привязанная к заказу, уходит к другому, только
// если тот пробу принял, — что бы ни было снято.
test('R4 п. B (а): первый заказ выдан, номер второго с опечаткой — 409, строка лотка на месте и с заказом', () => {
  const db = reattachClinic();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  db.prepare("UPDATE lab_results SET verified_at = '2026-10-01T08:00:00Z' WHERE visit_service_id = 123").run();
  const n = db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c;
  tray409(db, glu.id, 9999);
  const again = msgRow(db, glu.id);
  assert.deepEqual([again.resolved_at, again.visit_service_id, again.detail], [null, 123, glu.detail]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages').get().c, n, 'новой строки нет');
  assert.deepEqual(formOf(db, 123), { 'Глюкоза': '5.5' });
  db.close();
});

// П. B (б) — снимается по источнику (lab_results.source_message_id), а не по
// пересчёту сырого сообщения нынешним сопоставлением: после перепривязки
// панели и снятых подтверждений пересчёт не находил ничего, и значение
// оставалось в чужом бланке без единого слова.
function twoServices() {
  const db = reattachClinic();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (10,'Биохимия (стационар)',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (125,56,10,'in_progress')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (6,'Биохимия (стационар)',10,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (6,'GLU','Глюкоза','',1,'2',1)`).run();
  return db;
}

test('R4 п. B (б): панель первого заказа перепривязали и сняли подтверждения — «Привязать» всё равно снимает значение этой строки', () => {
  const db = twoServices();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'BS-200 (2)','mindray-bs-200')").run();
  db.prepare('UPDATE lab_panels SET device_id = 2 WHERE id = 5').run();
  db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 0 WHERE panel_id = 5').run();
  const out = lisMessageAttach(db, { id: glu.id, visit_service_id: 125 }, LAB);
  assert.match(out.detail, /снято из бланка заказа № 123: Глюкоза/);
  assert.deepEqual(formOf(db, 123), {});
  assert.deepEqual(formOf(db, 125), { 'Глюкоза': '5.5' });
  assert.equal(msgRow(db, glu.id).visit_service_id, null, 'значений строки в заказе 123 не осталось — строка с него снята');
  db.close();
});

// П. B — строка уходит с прежнего заказа, только когда её значений там не
// осталось. Выданное или изменённое — остаётся, и строка остаётся при нём.
test('R4 п. B: значения строки остались в первом заказе (выдан, изменён) — строка при нём, с отметкой о перепривязке', () => {
  const db = twoServices();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  db.prepare("UPDATE lab_results SET verified_at = '2026-10-01T08:00:00Z' WHERE visit_service_id = 123").run();
  const out = lisMessageAttach(db, { id: glu.id, visit_service_id: 125 }, LAB);
  assert.match(out.detail, /оставлено в бланке заказа № 123: Глюкоза \(выдан\)/);
  const orig = msgRow(db, glu.id);
  assert.equal(orig.visit_service_id, 123, 'выданное значение этой строки в заказе 123 — след остаётся');
  assert.match(orig.detail, /перепривязано к заказу № 125 \(значения остались в заказе № 123\)/);
  assert.ok(orig.resolved_at);
  db.close();

  const db2 = twoServices();
  ingestMessage(db2, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const g2 = newest(db2);
  db2.prepare("UPDATE lab_results SET value = '6.0' WHERE visit_service_id = 123").run();
  const out2 = lisMessageAttach(db2, { id: g2.id, visit_service_id: 125 }, LAB);
  assert.match(out2.detail, /оставлено в бланке заказа № 123: Глюкоза \(изменено после прибора\)/);
  assert.equal(msgRow(db2, g2.id).visit_service_id, 123);
  assert.deepEqual(formOf(db2, 123), { 'Глюкоза': '6.0' });
  db2.close();
});

test('R4 п. B: значение прибора в первом заказе записано до обновления (без отметки строки) — не снимается, строка при заказе, сказано проверить', () => {
  const db = twoServices();
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  db.prepare('UPDATE lab_results SET source_message_id = NULL WHERE visit_service_id = 123').run();
  const out = lisMessageAttach(db, { id: glu.id, visit_service_id: 125 }, LAB);
  assert.match(out.detail, /в бланке заказа № 123 есть значения прибора без отметки сообщения \(записаны до обновления\) — проверьте его вручную/);
  assert.deepEqual(formOf(db, 123), { 'Глюкоза': '5.5' });
  assert.equal(msgRow(db, glu.id).visit_service_id, 123);
  db.close();
});

// П. C — статус до прибора неизвестен — «в работе», не «ждёт забора».
test('R4 п. C: статус до прибора неизвестен — заказ «в работе»; строка только с примечанием — бланк не пуст, статус прежний', () => {
  const db = reattachClinic();
  db.prepare("UPDATE visit_services SET status = 'resulted' WHERE id = 123").run();   // «результаты внесены» поставил человек
  ingestMessage(db, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const glu = newest(db);
  assert.equal(db.prepare('SELECT lis_status_before AS s FROM visit_services WHERE id = 123').get().s, null);
  lisMessageAttach(db, { id: glu.id, visit_service_id: 124 }, LAB);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 123').get().status, 'in_progress');
  db.close();

  const db2 = reattachClinic();
  ingestMessage(db2, BS2('LAB-000123', '2', 'GLU', '5.5'), '10.0.0.40', 1);
  const g2 = newest(db2);
  db2.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, notes, source) VALUES (123, 'Мочевина', '', 'гемолиз', 'manual')").run();
  lisMessageAttach(db2, { id: g2.id, visit_service_id: 124 }, LAB);
  assert.equal(db2.prepare('SELECT status FROM visit_services WHERE id = 123').get().status, 'resulted', 'примечание — содержимое бланка');
  db2.close();
});
