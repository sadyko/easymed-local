import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { lisProfiles, lisMessageAttach, lisMessageDismiss, lisDeviceCodes, lisListeners, lisDeviceDelete } from './lis.js';
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
