import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { lisProfiles, lisMessageAttach, lisMessageDismiss, lisDeviceCodes, lisListeners, lisDeviceDelete } from './lis.js';
import { lisServiceCounts, lisRecent } from './lis.js';   // LIS_REAL_ANALYZERS_V1_SERVICE
import { RPC } from './index.js';                           // LIS_REAL_ANALYZERS_V1_SERVICE — RPC заведён в карте
import { isReadOnlyRpc } from '../control/gate.js';   // LIS_MINDRAY_CODES_V1 (ревью R8)

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
