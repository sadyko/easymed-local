// sample.test.js — LIS_REAL_ANALYZERS_V1_SAMPLE: номер пробы — из нужного
// поля провода, и голые цифры — только для открытого недавнего заказа.
//
// Опасность, которую закрывает этот файл (спецификация 2026-10-01, «Опасность
// сегодня»): BS-200 пишет в OBR-3 номер места в штативе («2»), и голое «2»
// легло бы в заказ № 2 чужого пациента. Номер места в штативе, порядковый номер
// прогона, автоматический номер гематологии — маленькие числа, они совпадают
// со старыми заказами первых дней клиники.
//
// Правило голых цифр — РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-10-01 (вопрос 3, изменён против
// рекомендации спецификации): номер без LAB- принимается, только если заказ
// ОТКРЫТ (visit_services.status IN added, queued, collected, in_progress,
// resulted — не выдан, не отменён) И создан не раньше, чем 7 дней назад по
// местному календарному дню клиники. Почему не «только в работе»: лаборатория
// часто не нажимает «Забор пробы», и заказ стоит в queued, когда пробирка уже в
// анализаторе (данные разработки: completed 280, added 23, resulted 12, queued
// 9, collected 4).
//
// LIS_VENDOR_EXACT_V1 — решение владельца 2026-10-06, п. 4: голые цифры —
// только номер с этикетки (6 цифр). Номера в тестах правила «открытый, свежий»
// ниже — такие («000002», «000123», «000015»); номер короче отказывается
// раньше (тесты «п. 4» в конце файла).
//
// Провод прибора в первых тестах назван явно ({ wire }): они писались до
// профилей BS-200, A1000 и BC-780. С LIS_REAL_ANALYZERS_V1_PROFILES провод
// берётся из профиля прибора сам — тесты в конце файла, без { wire }.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ingestMessage, BARE_ID_MAX_AGE_DAYS } from './ingest.js';
import { PLAIN_NUMBER_MIN_DIGITS } from './ingest.js';   // LIS_VENDOR_EXACT_V1 — решение владельца 2026-10-06, п. 4

const seg = (...s) => s.join('\r');

// Время создания заказа — выражением SQLite, чтобы «местный день» считался тем
// же 'localtime', что и в приёме, при любом TZ процесса.
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
/** Первая секунда местного дня «сегодня − n» — в UTC, как пишет приложение. */
const dayStart = (n) => `strftime('%Y-%m-%dT%H:%M:%SZ', date('now','localtime','-${n} days'), 'utc')`;
/** Последняя секунда местного дня «сегодня − n». */
const dayEnd = (n) => `strftime('%Y-%m-%dT%H:%M:%SZ', date('now','localtime','-${n - 1} days'), '-1 second', 'utc')`;

/**
 * Клиника: лабораторная услуга с панелью, прибор 1 кормит панель. Заказы — по
 * списку: { id, status, created (выражение SQLite) }. Строки бланка — по
 * списку [код строки, имя, поле анализатора].
 */
function clinic({ orders = [{ id: 123 }], analytes = [['WBC', 'Лейкоциты', 'WBC']], profile = 'mindray-bc-5300' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-01T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Биохимия',1)").run();
  for (const o of orders) {
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (?, 55, 9, ?, ${o.created || NOW})`)
      .run(o.id, o.status || 'in_progress');
  }
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (1,'Анализатор',?,'mllp',2575)").run(profile);   // profile: LIS_REAL_ANALYZERS_V1_PROFILES
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'Панель',9,1)").run();
  // LIS_REAL_ANALYZERS_V1 (ревью R5, п. 2) — подтверждено человеком для прибора 1 (отметкой).
  analytes.forEach(([code, name, dc], i) => {
    db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
                VALUES (5, ?, ?, '', ?, ?, 1, 1, 0)`).run(code, name, i + 1, dc);   // эпоха 0: ревью R6, п. 1
  });
  return db;
}

const results = (db, id = 123) => db.prepare('SELECT * FROM lab_results WHERE visit_service_id = ? ORDER BY id').all(id);
const last = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
const status = (db, id = 123) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

// Провод default — прежние профили и прибор без профиля.
const HEM = (obr2, obr3, obx = 'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F') => seg(
  'MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORU^R01|42|P|2.3.1',
  `OBR|1|${obr2}|${obr3}|00001^Automated Count^99MRC`,
  obx,
);
// BS-200 — руководство, с. 24–25: OBR-2 — штрихкод, OBR-3 — место в штативе.
const BS200 = (obr2, obr3, obx = 'OBX|1|NM|2|test2|5.000000|g/ml|-||||F|||||||') => seg(
  'MSH|^~\\&|Mindray|BS-200E|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
  'PID|1|854||12|Tommy||19830719145307|F|A||||||||||||||||||||||',
  `OBR|1|${obr2}|${obr3}|Mindray^BS-200E|Y||||||||||serum|||||||||||||||||||||||||||||||||`,
  obx,
);

// ── Поле номера пробы по проводу ────────────────────────────────────────────

test('default: LAB- в OBR-3 — как прежде; LAB- в OBR-2 бьёт голое «15» в OBR-3', () => {
  const db = clinic();
  assert.equal(ingestMessage(db, HEM('', 'LAB-000123'), '10.0.0.9', 1), 'AA');
  assert.equal(last(db).status, 'applied');
  assert.equal(results(db)[0].value, '6.1');

  const db2 = clinic({ orders: [{ id: 123 }, { id: 15 }] });
  ingestMessage(db2, HEM('LAB-000123', '15', 'OBX|1|NM|WBC^^99MRC||7.2|10*9/L|||||F'), '10.0.0.9', 1);
  assert.equal(last(db2).visit_service_id, 123);
  assert.equal(last(db2).sample_id, 'LAB-000123');
  assert.equal(results(db2)[0].value, '7.2');
  assert.equal(results(db2, 15).length, 0, 'заказ № 15 не тронут');
  db.close(); db2.close();
});

test('default: голые цифры OBR-2 не читаются — это может быть номер прогона', () => {
  const db = clinic();
  ingestMessage(db, HEM('000123', ''), '10.0.0.9', 1);
  assert.equal(last(db).status, 'unmatched');
  assert.equal(last(db).visit_service_id, null);
  assert.equal(results(db).length, 0);
  db.close();
});

test('BS-200 (mindray-chem): штрихкод из OBR-2 ложится в свой заказ; значение «5.000000» → «5»', () => {
  const db = clinic({ analytes: [['GLU', 'Глюкоза', '2']] });
  assert.equal(ingestMessage(db, BS200('LAB-000123', '2'), '10.0.0.40', 1, { wire: 'mindray-chem' }), 'AA');
  const m = last(db);
  assert.equal(m.status, 'applied', m.detail);
  assert.equal(m.visit_service_id, 123);
  assert.equal(m.sample_id, 'LAB-000123');
  assert.equal(results(db)[0].value, '5');
  assert.equal(results(db)[0].numeric_value, 5);
  db.close();
});

// ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА — «результат чужого пациента» (спецификация,
// «Опасность сегодня»): заказ № 2 лабораторный, в работе, свежий, с той же
// панелью, а BS-200 пишет «2» в OBR-3 как номер места в штативе.
test('BS-200: OBR-2 пуст, OBR-3 = «2» — unmatched; в бланке заказа № 2 ничего нет', () => {
  const db = clinic({ orders: [{ id: 2 }], analytes: [['GLU', 'Глюкоза', '2']] });
  assert.equal(ingestMessage(db, BS200('', '2'), '10.0.0.40', 1, { wire: 'mindray-chem' }), 'AA', 'сохранено — повторять незачем');
  const m = last(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.visit_service_id, null, 'сообщение не привязано к чужому заказу даже для показа');
  assert.equal(m.sample_id, '', 'OBR-3 у BS-200 не читается никогда');
  assert.equal(results(db, 2).length, 0, 'значения пробы со штатива не легли в заказ № 2');
  assert.equal(status(db, 2), 'in_progress');
  db.close();
});

test('autobio-hl7: номер — OBR-2, код — OBX-4, значение — компонент 2 OBX-5', () => {
  const db = clinic({ analytes: [['B12', 'Витамин B12', '206']] });
  ingestMessage(db, seg(
    'MSH|^~\\&|A1000|Autolumo|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
    'PID|||SYN-PAT-1',   // LIS_VENDOR_EXACT_V1 — кодировщик A1000 пишет PID у пробы пациента (без PID — контроль)
    'OBR|1|LAB-000123|||',
    'OBX|1|NM|1^Vitamin B12|206|5981666^390.946|pg/mL|||||F',
  ), '10.0.0.41', 1, { wire: 'autobio-hl7' });
  assert.equal(last(db).status, 'applied', last(db).detail);
  assert.equal(results(db)[0].value, '390.946', 'RLU (компонент 1) в бланк не идёт');
  db.close();
});

test('переадресатор (MSH-4 = LabPC) читается проводом forwarder сам: номер — OBR-3, код — OBX-3', () => {
  const db = clinic({ analytes: [['B12', 'Витамин B12', '206']] });
  // Провод не назван: его выбирает MSH-4, что бы ни говорил профиль прибора.
  ingestMessage(db, seg(
    'MSH|^~\\&|AutoLumo A1000|LabPC|||20261001101500||ORU^R01|5|P|2.3.1',
    'OBR|1||LAB-000123|00001^Automated Count^99MRC',
    'OBX|1|NM|206^^AUTOBIO|Vitamin B12|390.946||||||F',
  ), '10.0.0.50', 1);
  assert.equal(last(db).status, 'applied', last(db).detail);
  assert.equal(results(db)[0].value, '390.946');
  db.close();
});

test('mindray-hematology (BC-780): OBR-3, запасное OBR-2; LAB- в OBR-2 бьёт голое в OBR-3', () => {
  const run = (obr2, obr3) => {
    const db = clinic({ orders: [{ id: 123 }, { id: 15 }] });
    ingestMessage(db, HEM(obr2, obr3), '10.0.0.42', 1, { wire: 'mindray-hematology' });
    const out = { vs: last(db).visit_service_id, sample: last(db).sample_id, n123: results(db).length, n15: results(db, 15).length };
    db.close();
    return out;
  };
  assert.deepEqual(run('LAB-000123', ''), { vs: 123, sample: 'LAB-000123', n123: 1, n15: 0 }, 'OBR-3 пуст — запасное OBR-2');
  assert.deepEqual(run('LAB-000123', '15'), { vs: 123, sample: 'LAB-000123', n123: 1, n15: 0 }, 'LAB- — в любом поле');
  assert.deepEqual(run('', '000015'), { vs: 15, sample: '000015', n123: 0, n15: 1 }, 'голые цифры OBR-3 — для открытого свежего заказа (номер с этикетки: LIS_VENDOR_EXACT_V1, п. 4)');
});

test('два разных LAB- в OBR-2 и OBR-3 — unmatched с причиной, оба номера в sample_id, бланки не тронуты', () => {
  const db = clinic({ orders: [{ id: 123 }, { id: 124 }] });
  assert.equal(ingestMessage(db, HEM('LAB-000124', 'LAB-000123'), '10.0.0.9', 1), 'AA');
  const m = last(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.sample_id, 'LAB-000124 / LAB-000123');
  assert.equal(m.visit_service_id, null);
  assert.match(m.detail, /в OBR-2 и OBR-3 разные номера LAB-/);
  assert.match(m.detail, /проверьте настройку штрихкода на приборе/);
  assert.equal(results(db).length + results(db, 124).length, 0);
  db.close();
});

// ── Голые цифры: только открытый заказ последних 7 дней ─────────────────────

// LIS_REAL_ANALYZERS_V1 (ревью R7, п. 1) — «ожидает оплату» (added) больше не
// принимается и голым номером: ворота лаборатории те же, что у ручного ввода
// (тест ниже).
test('голые цифры принимаются для открытого заказа: queued, collected, in_progress, resulted', () => {
  assert.equal(BARE_ID_MAX_AGE_DAYS, 7);
  for (const st of ['queued', 'collected', 'in_progress', 'resulted']) {
    const db = clinic({ orders: [{ id: 123, status: st }] });
    ingestMessage(db, HEM('', '000123'), '10.0.0.9', 1);   // LIS_VENDOR_EXACT_V1 — номер с этикетки (6 цифр)
    assert.equal(last(db).visit_service_id, 123, st);
    assert.equal(results(db).length, 1, st + ': лаборатория часто не жмёт «Забор пробы» — queued законен');
    db.close();
  }
});

test('голые цифры к закрытому заказу (выдан, отменён) — unmatched: причина названа словами', () => {
  for (const [st, word] of [['completed', 'выдан'], ['cancelled', 'отменён']]) {
    const db = clinic({ orders: [{ id: 2, status: st }] });
    db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (2, 'Лейкоциты', '5.5')").run();
    assert.equal(ingestMessage(db, HEM('', '000002'), '10.0.0.9', 1), 'AA');
    const m = last(db);
    assert.equal(m.status, 'unmatched', st);
    assert.equal(m.visit_service_id, null, st + ': чужой выданный заказ не показывается рядом с пробой');
    assert.equal(m.sample_id, '000002');
    assert.match(m.detail, /без префикса LAB-/, st);
    assert.match(m.detail, new RegExp('закрыт.*' + word), st);
    assert.match(m.detail, /номер места в штативе/, st);
    assert.equal(results(db, 2)[0].value, '5.5', st + ': бланк не тронут');
    assert.equal(status(db, 2), st);
    db.close();
  }
});

test('голые цифры к открытому, но старому заказу (старше 7 дней по местному дню) — unmatched с причиной', () => {
  const db = clinic({ orders: [{ id: 2, status: 'queued', created: dayStart(30) }] });
  ingestMessage(db, HEM('', '000002'), '10.0.0.9', 1);
  const m = last(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.visit_service_id, null);
  assert.match(m.detail, /без префикса LAB-/);
  assert.match(m.detail, /старше 7 дней/);
  assert.match(m.detail, /\d{2}\.\d{2}\.\d{4}/, 'день заказа назван');
  assert.match(m.detail, /номер места в штативе/);
  assert.equal(results(db, 2).length, 0);
  db.close();
});

test('граница 7 дней — по местному календарному дню: «сегодня − 7» ещё принимается, «сегодня − 8» уже нет', () => {
  const ok = clinic({ orders: [{ id: 2, created: dayStart(7) }] });
  ingestMessage(ok, HEM('', '000002'), '10.0.0.9', 1);
  assert.equal(last(ok).visit_service_id, 2, 'первая секунда дня «сегодня − 7»');
  assert.equal(results(ok, 2).length, 1);
  ok.close();

  const old = clinic({ orders: [{ id: 2, created: dayEnd(8) }] });
  ingestMessage(old, HEM('', '000002'), '10.0.0.9', 1);
  assert.equal(last(old).status, 'unmatched', 'последняя секунда дня «сегодня − 8»');
  assert.equal(results(old, 2).length, 0);
  old.close();
});

test('закрытый и старый сразу — названы обе причины', () => {
  const db = clinic({ orders: [{ id: 2, status: 'completed', created: dayStart(40) }] });
  ingestMessage(db, HEM('', '000002'), '10.0.0.9', 1);
  assert.match(last(db).detail, /закрыт.*выдан/);
  assert.match(last(db).detail, /старше 7 дней/);
  db.close();
});

test('с префиксом LAB- правило голых цифр не действует: наша этикетка к старому открытому заказу принимается', () => {
  const db = clinic({ orders: [{ id: 123, status: 'in_progress', created: dayStart(30) }] });
  ingestMessage(db, HEM('', 'LAB-000123'), '10.0.0.9', 1);
  assert.equal(last(db).status, 'applied');
  assert.equal(results(db).length, 1);
  db.close();
});

test('отказ голым цифрам — разобранное сообщение: прибор всё равно «на связи»', () => {
  const db = clinic({ orders: [{ id: 2, status: 'completed' }] });
  ingestMessage(db, HEM('', '000002'), '10.0.0.9', 1);
  assert.ok(db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = 1').get().last_seen_at);
  db.close();
});

// ── Номер, названный человеком (привязка из лотка) ──────────────────────────

test('sampleIdOverride: номер назвал человек — поле OBR не читается, правило голых цифр не действует', () => {
  // Заказ старый, но открытый; в OBR-2 — чужая этикетка, в OBR-3 — место в
  // штативе. Ложится в названный заказ.
  const db = clinic({ orders: [{ id: 77, created: dayStart(30) }, { id: 124 }] });
  const raw = HEM('LAB-000124', '2');
  assert.equal(ingestMessage(db, raw, '10.0.0.9', 1, { touch: false, sampleIdOverride: 77 }), 'AA');
  const m = last(db);
  assert.equal(m.visit_service_id, 77);
  assert.equal(m.sample_id, '77', 'номер, который назвал человек');
  assert.equal(m.raw, raw, 'инвариант 2: сырое сообщение не подменяется');
  assert.match(m.detail, /привязано вручную/);
  assert.equal(results(db, 77).length, 1);
  assert.equal(results(db, 124).length, 0);
  db.close();
});

test('sampleIdOverride к несуществующему заказу — unmatched, как у прибора', () => {
  const db = clinic();
  ingestMessage(db, HEM('', 'LAB-000123'), '10.0.0.9', 1, { touch: false, sampleIdOverride: 999 });
  assert.equal(last(db).status, 'unmatched');
  assert.match(last(db).detail, /не найден/);
  assert.match(last(db).detail, /привязано вручную/);
  assert.equal(results(db).length, 0);
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1_PROFILES — провод из профиля прибора, без { wire } ──
// Приём сам берёт провод у профиля строки прибора (wire.js wireFor); сообщения
// переадресателя (MSH-4 = LabPC) — провод forwarder, что бы ни говорил профиль.

test('профиль BS-200: OBR-3 («2» — место в штативе) не читается — unmatched, заказ № 2 пуст', () => {
  const db = clinic({ orders: [{ id: 2 }], analytes: [['GLU', 'Глюкоза', '2']], profile: 'mindray-bs-200' });
  assert.equal(ingestMessage(db, BS200('', '2'), '10.0.0.40', 1), 'AA');
  assert.equal(last(db).status, 'unmatched');
  assert.equal(last(db).visit_service_id, null);
  assert.equal(last(db).sample_id, '');
  assert.equal(results(db, 2).length, 0, 'значения пробы со штатива не легли в чужой заказ');
  db.close();
});

test('профиль BS-200: штрихкод из OBR-2, код — номер теста, «5.000000» → «5»', () => {
  const db = clinic({ analytes: [['GLU', 'Глюкоза', '2']], profile: 'mindray-bs-200' });
  ingestMessage(db, BS200('LAB-000123', '2'), '10.0.0.40', 1);
  assert.equal(last(db).status, 'applied', last(db).detail);
  assert.equal(results(db)[0].value, '5');
  db.close();
});

test('профиль BS-200: имя теста (OBX-4) не сравнивается — строка бланка «test2» не ловит номер «2»', () => {
  const db = clinic({ analytes: [['GLU', 'Глюкоза', 'test2']], profile: 'mindray-bs-200' });
  ingestMessage(db, BS200('LAB-000123', '2'), '10.0.0.40', 1);
  assert.equal(results(db).length, 0, 'подпись правит оператор как хочет — сравнивается только номер');
  assert.equal(last(db).status, 'unmapped');
  db.close();
});

test('профиль A1000: номер — OBR-2, код — OBX-4, значение — компонент 2 OBX-5', () => {
  const db = clinic({ analytes: [['B12', 'Витамин B12', '206']], profile: 'autobio-autolumo-a1000' });
  ingestMessage(db, seg(
    'MSH|^~\&|A1000|Autolumo|||20261001101500||ORU^R01|1|P|2.3.1||||0||ASCII|||',
    'PID|||SYN-PAT-1',   // LIS_VENDOR_EXACT_V1 — кодировщик A1000 пишет PID у пробы пациента (без PID — контроль)
    'OBR|1|LAB-000123|||',
    'OBX|1|NM|1^Vitamin B12|206|5981666^390.946|pg/mL|||||F',
  ), '10.0.0.41', 1);
  assert.equal(last(db).status, 'applied', last(db).detail);
  assert.equal(results(db)[0].value, '390.946');
  db.close();
});

test('профиль A1000, сообщение переадресателя (MSH-4 = LabPC): провод forwarder — OBR-3 и OBX-3', () => {
  const db = clinic({ analytes: [['B12', 'Витамин B12', '206']], profile: 'autobio-autolumo-a1000' });
  ingestMessage(db, seg(
    'MSH|^~\&|AutoLumo A1000|LabPC|||20261001101500||ORU^R01|5|P|2.3.1',
    'OBR|1||LAB-000123|00001^Automated Count^99MRC',
    'OBX|1|NM|206^^AUTOBIO|Vitamin B12|390.946||||||F',
  ), '10.0.0.50', 1);
  assert.equal(last(db).status, 'applied', last(db).detail);
  assert.equal(results(db)[0].value, '390.946', 'сетевой провод Autobio взял бы компонент 2 «390.946» → пусто');
  db.close();
});

test('профиль BC-780: OBR-3 пуст — запасное OBR-2 (и голые цифры); голые цифры OBR-3 — для открытого свежего заказа', () => {
  const db = clinic({ orders: [{ id: 123 }, { id: 15 }], profile: 'mindray-bc-780' });
  ingestMessage(db, HEM('000123', ''), '10.0.0.42', 1);
  assert.equal(last(db).visit_service_id, 123, 'запасное поле — только у провода гематологии; default голые OBR-2 не читает');
  assert.equal(results(db).length, 1);
  ingestMessage(db, HEM('', '000015'), '10.0.0.42', 1);
  assert.equal(last(db).visit_service_id, 15);
  assert.equal(results(db, 15).length, 1);
  db.close();
});

test('прежний профиль (BC-5300): голые цифры OBR-2 по-прежнему не читаются', () => {
  const db = clinic();
  ingestMessage(db, HEM('000123', ''), '10.0.0.9', 1);
  assert.equal(last(db).status, 'unmatched');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R1 (E1–E5 на 1728cbc) ─────────────────────

// П. 1 — две пробы в одном сообщении: значение пробы 124 ложилось в бланк 123.
test('R1 п. 1: два OBR с разными номерами — unmatched, ни в один бланк ничего не легло', () => {
  const db = clinic({ orders: [{ id: 123 }, { id: 124 }], analytes: [['WBC', 'Лейкоциты', 'WBC'], ['HGB', 'Гемоглобин', 'HGB']] });
  assert.equal(ingestMessage(db, seg(
    'MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORU^R01|1|P|2.3.1',
    'OBR|1||LAB-000123|00001^Automated Count^99MRC',
    'OBX|1|NM|WBC^^99MRC||9.9|10*9/L|||||F',
    'OBR|2||LAB-000124|00001^Automated Count^99MRC',
    'OBX|1|NM|HGB^^99MRC||142|g/L|||||F',
  ), '10.0.0.9', 1), 'AA');
  const m = last(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.visit_service_id, null);
  assert.equal(m.sample_id, 'LAB-000123 / LAB-000124');
  assert.match(m.detail, /в сообщении пробы с разными номерами/);
  assert.equal(results(db).length + results(db, 124).length, 0, 'бланки не тронуты');
  db.close();
});

test('R1 п. 1 и 5: первый OBR без номера — номер из следующего, как у parseMessage до E5', () => {
  const db = clinic();
  ingestMessage(db, seg(
    'MSH|^~\\&|BC-5300|Mindray|||20261001090000||ORU^R01|1|P|2.3.1',
    'OBR|1|||00001^Automated Count^99MRC',
    'OBR|2||LAB-000123|00001^Automated Count^99MRC',
    'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  ), '10.0.0.9', 1);
  assert.equal(last(db).status, 'applied', last(db).detail);
  assert.equal(results(db)[0].value, '6.1');
  db.close();
});

// П. 2 — «2^LAB-000123» читалось как голое «2».
test('R1 п. 2: OBR-3 = «2^LAB-000123» — проба заказа 123, открытый свежий заказ № 2 не тронут', () => {
  const db = clinic({ orders: [{ id: 2 }, { id: 123 }] });
  ingestMessage(db, HEM('', '2^LAB-000123'), '10.0.0.9', 1);
  assert.equal(last(db).visit_service_id, 123);
  assert.equal(last(db).sample_id, 'LAB-000123');
  assert.equal(results(db).length, 1);
  assert.equal(results(db, 2).length, 0);
  db.close();
});

test('R1 п. 2: поле из нескольких компонентов без этикетки — номера нет, ни один заказ не тронут', () => {
  for (const field of ['2^15', '15^', '123^x']) {
    const db = clinic({ orders: [{ id: 2 }, { id: 15 }, { id: 123 }] });
    ingestMessage(db, HEM('', field), '10.0.0.9', 1);
    const m = last(db);
    assert.equal(m.status, 'unmatched', field);
    assert.equal(m.visit_service_id, null, field);
    assert.equal(m.sample_id, field, field + ': в sample_id — поле как пришло');
    assert.match(m.detail, /не этикетка Easy-Med и не номер из одних цифр/, field);
    assert.equal(results(db, 2).length + results(db, 15).length + results(db).length, 0, field);
    db.close();
  }
});

// П. 3 — голый номер, отказанный дальше по приёму, не привязывает чужой заказ:
// иначе лента показывает имя чужого пациента рядом с пробой, а касса не может
// снять его неоплаченную строку (billing.js assertNotPerformed, visit-lines.js).
test('R1 п. 3: голый номер, отказ «не лабораторная / нет панели / панель без прибора / другая модель» — visit_service_id NULL', () => {
  const cases = {
    'не лабораторная': (db) => db.prepare('UPDATE services SET is_lab = 0 WHERE id = 9').run(),
    'нет панели': (db) => db.prepare('UPDATE lab_panels SET service_id = NULL WHERE id = 5').run(),
    'панель без прибора': (db) => db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run(),
  };
  for (const [name, spoil] of Object.entries(cases)) {
    const db = clinic({ orders: [{ id: 2 }] });
    spoil(db);
    ingestMessage(db, HEM('', '000002'), '10.0.0.9', 1);
    assert.equal(last(db).visit_service_id, null, name);
    assert.notEqual(last(db).status, 'applied', name);
    db.close();
  }
  const db = clinic({ orders: [{ id: 2 }] });
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Другой','mindray-bs-240')").run();
  ingestMessage(db, HEM('', '000002'), '10.0.0.9', 2);
  assert.equal(last(db).status, 'unmatched');
  assert.equal(last(db).visit_service_id, null, 'другая модель');
  assert.equal(results(db, 2).length, 0);
  db.close();
});

test('R1 п. 3: с этикеткой LAB- те же отказы, как прежде, привязаны к заказу', () => {
  const db = clinic();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, HEM('', 'LAB-000123'), '10.0.0.9', 1);
  assert.equal(last(db).visit_service_id, 123);
  db.close();
});

// П. 4 — запись колл-центра и календаря создаёт строку заранее (scheduled_at,
// booking-mirror.js): строка, созданная 10 дней назад на СЕГОДНЯШНИЙ визит,
// отказывалась как «старше 7 дней». Возраст — от позднейшего из: создана,
// запись, день визита — всё по местному календарному дню.
test('R1 п. 4: заказ создан 10 дней назад, записан или визит сегодня — голые цифры принимаются', () => {
  const booked = clinic({ orders: [{ id: 2, status: 'queued', created: dayStart(10) }] });
  booked.prepare(`UPDATE visit_services SET scheduled_at = ${NOW} WHERE id = 2`).run();
  ingestMessage(booked, HEM('', '000002'), '10.0.0.9', 1);
  assert.equal(last(booked).visit_service_id, 2, 'запись на сегодня');
  assert.equal(results(booked, 2).length, 1);
  booked.close();

  const visit = clinic({ orders: [{ id: 2, status: 'queued', created: dayStart(10) }] });
  visit.prepare(`UPDATE visits SET visit_date = ${NOW} WHERE id = 55`).run();
  ingestMessage(visit, HEM('', '000002'), '10.0.0.9', 1);
  assert.equal(last(visit).visit_service_id, 2, 'визит сегодня');
  visit.close();
});

test('R1 п. 4: создан, записан и визит — всё старше 7 дней: отказ, назван позднейший день', () => {
  const db = clinic({ orders: [{ id: 2, status: 'queued', created: dayStart(30) }] });
  db.prepare(`UPDATE visit_services SET scheduled_at = ${dayStart(20)} WHERE id = 2`).run();
  db.prepare(`UPDATE visits SET visit_date = ${dayStart(25)} WHERE id = 55`).run();
  ingestMessage(db, HEM('', '000002'), '10.0.0.9', 1);
  const m = last(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.visit_service_id, null);
  const day = db.prepare(`SELECT date(${dayStart(20)}, 'localtime') d`).get().d;
  assert.ok(m.detail.includes(day.slice(8, 10) + '.' + day.slice(5, 7) + '.' + day.slice(0, 4)), 'день записи — позднейший: ' + m.detail);
  assert.match(m.detail, /старше 7 дней/);
  db.close();
});

// П. 8 — «LAB2», «lab 2», «lab_2», «LAB-123» считались нашей этикеткой и
// обходили правило голых цифр.
test('R1 п. 8: не наша этикетка (не «LAB-» и 6+ цифр) — отказ, а не голые цифры и не этикетка', () => {
  for (const loose of ['LAB-123', 'lab_000123', 'LAB000123', 'lab 123']) {
    const db = clinic({ orders: [{ id: 123, status: 'completed', created: dayStart(30) }] });
    ingestMessage(db, HEM('', loose), '10.0.0.9', 1);
    assert.equal(last(db).status, 'unmatched', loose);
    assert.equal(last(db).visit_service_id, null, loose);
    assert.match(last(db).detail, /не этикетка Easy-Med/, loose);
    db.close();
  }
});

// LIS_VENDOR_EXACT_V1 (решение владельца 2026-10-06, п. 4) — лишние нули
// впереди принимает только переадресатор COM (MSH-4 = LabPC; кадр — его
// buildOru, analyzers\forwarder\hl7-oru.js): старая гематология Mindray
// дополняет номер нулями до ширины своего поля (8 знаков, mindray-legacy.js).
// Прибор по сети пишет номер как набрали: «00000123» — не номер с этикетки.
test('R1 п. 8: голые цифры с ведущими нулями (переадресатор шлёт 8 знаков) — правило голых цифр, как прежде', () => {
  const db = clinic();
  ingestMessage(db, seg(
    'MSH|^~\\&|BC-3000 Plus|LabPC|||20261006120000||ORU^R01|512345|P|2.3.1',
    'OBR|1||00000123|00001^Automated Count^99MRC|||20261006120000',
    'OBX|1|NM|WBC^^99MRC||6.1|10*9/L||||F',
  ), '127.0.0.1', 1);
  assert.equal(last(db).visit_service_id, 123, last(db).detail);
  assert.equal(results(db).length, 1);
  db.close();

  const net = clinic();
  ingestMessage(net, HEM('', '00000123'), '10.0.0.9', 1);
  assert.deepEqual([last(net).status, last(net).visit_service_id], ['unmatched', null], 'прибор по сети: «00000123» — не номер с этикетки');
  assert.match(last(net).detail, /не номер с этикетки Easy-Med/);
  assert.equal(results(net).length, 0);
  net.close();
});

// П. 11 — у строки BS-200 нет профиля или он чужой: провод — по тому, как
// сообщение называет себя. OBR-3 BS-200 (место в штативе) не читается.
test('R1 п. 11: BS-200 на строке без профиля или с чужим профилем — OBR-3 не читается', () => {
  for (const profile of ['', 'mindray-bs-240', 'mindray-bc-780']) {
    const db = clinic({ orders: [{ id: 2 }], analytes: [['GLU', 'Глюкоза', '2']], profile });
    ingestMessage(db, BS200('', '2'), '10.0.0.40', 1);
    assert.equal(last(db).status, 'unmatched', profile || '(без профиля)');
    assert.equal(last(db).sample_id, '', profile);
    assert.equal(results(db, 2).length, 0, profile + ': место в штативе «2» не легло в заказ № 2');
    db.close();
  }
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R2 ───────────────────────────────────────

// П. 4 — день в будущем (запись на завтра, визит на следующей неделе) не
// делает старый заказ свежим: «позднейшее из» берётся только из дней не позже
// сегодняшнего.
test('R2 п. 4: запись или визит в будущем не делают старый заказ свежим', () => {
  const fut = clinic({ orders: [{ id: 2, status: 'queued', created: dayStart(10) }] });
  fut.prepare("UPDATE visit_services SET scheduled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','+3 days') WHERE id = 2").run();
  fut.prepare("UPDATE visits SET visit_date = strftime('%Y-%m-%dT%H:%M:%SZ','now','+5 days') WHERE id = 55").run();
  ingestMessage(fut, HEM('', '000002'), '10.0.0.9', 1);
  assert.equal(last(fut).status, 'unmatched');
  assert.equal(last(fut).visit_service_id, null);
  assert.match(last(fut).detail, /старше 7 дней/);
  assert.equal(results(fut, 2).length, 0);
  fut.close();
});

test('R2 п. 4: scheduled_at без пояса читается, как везде (queue.js: date(…, localtime)) — запись на сейчас — свежая', () => {
  const db = clinic({ orders: [{ id: 2, status: 'queued', created: dayStart(10) }] });
  // Время без «Z» и без смещения — как его читает остальной код: UTC.
  db.prepare("UPDATE visit_services SET scheduled_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = 2").run();
  ingestMessage(db, HEM('', '000002'), '10.0.0.9', 1);
  assert.equal(last(db).visit_service_id, 2);
  assert.equal(results(db, 2).length, 1);
  db.close();
});

// П. 12 — профиль строки и само сообщение называют РАЗНЫЕ провода: какое поле
// номер и где значение, решать наугад нельзя — в лоток, с причиной.
test('R2 п. 12: строка BC-780, а сообщение — от BS-200: в лоток «прибор назван как …», ничего не прочитано', () => {
  const db = clinic({ orders: [{ id: 2 }, { id: 123 }], analytes: [['GLU', 'Глюкоза', '2']], profile: 'mindray-bc-780' });
  assert.equal(ingestMessage(db, BS200('LAB-000123', '2'), '10.0.0.40', 1), 'AA');
  const m = last(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.visit_service_id, null);
  assert.equal(m.sample_id, 'LAB-000123', 'номер для человека — по безопасному проводу (OBR-2), OBR-3 не читается');
  assert.match(m.detail, /прибор заведён как «BC-780», а сообщение — от «Mindray BS-200E» \(модель «BS-200»\)/);
  assert.equal(results(db).length + results(db, 2).length, 0);
  db.close();
});

// LIS_VENDOR_EXACT_V1 — с D2 у строки BS-240 свой провод, тот же mindray-chem,
// что у BS-200: провода совпадают — не спор (раньше: прежний профиль без
// провода — провод сообщения).
test('R2 п. 12: строка BS-240 и сообщение BS-200 — один провод mindray-chem, не спор', () => {
  const db = clinic({ analytes: [['GLU', 'Глюкоза', '2']], profile: 'mindray-bs-240' });
  ingestMessage(db, BS200('LAB-000123', '2'), '10.0.0.40', 1);
  assert.equal(last(db).status, 'applied', last(db).detail);
  assert.equal(results(db)[0].value, '5');
  db.close();
});

// П. 14 — голый номер, ПРОШЕДШИЙ правило «открытый заказ последних 7 дней», —
// обычное совпадение: по выданному бланку superseded И с привязкой к заказу
// (D7 — как у этикетки). Пункт 3 R1 снимает привязку только у отказанных.
test('R2 п. 14: голый номер открытого свежего заказа с выданным бланком — superseded, заказ привязан', () => {
  const db = clinic({ orders: [{ id: 123, status: 'resulted' }] });
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, verified_at) VALUES (123,'Лейкоциты','5.5','analyzer','2026-10-01T08:00:00Z')").run();
  ingestMessage(db, HEM('', '000123'), '10.0.0.9', 1);
  assert.equal(last(db).status, 'superseded');
  assert.equal(last(db).visit_service_id, 123);
  assert.equal(results(db)[0].value, '5.5', 'выданный не переписан');
  db.close();
});

// ── LIS_REAL_ANALYZERS_V1 — ревью R7, п. 1 ─────────────────────────────────
test('R7 п. 1: голые цифры к неоплаченному заказу — та же причина, что у этикетки; без привязки, ничего не записано', () => {
  const db = clinic({ orders: [{ id: 123, status: 'added' }] });
  assert.equal(ingestMessage(db, HEM('', '000123'), '10.0.0.9', 1), 'AA');
  const m = last(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.visit_service_id, null, 'голый номер отказа заказ не привязывает');
  assert.equal(m.detail, 'заказ ещё не оплачен — результат прибора можно «Привязать» после оплаты');
  assert.equal(results(db).length, 0);
  assert.equal(status(db, 123), 'added');
  db.close();
});

// ── LIS_VENDOR_EXACT_V1 — D2: BS-240 и CL-900i читаются проводом mindray-chem ──
// Номер пробирки у обоих — OBR-2 (штрихкод), а OBR-3 — внутренний номер
// прибора («Sample ID is for internal use and must not be analyzed by the
// server»), маленькое число 1, 2, 10. Провод default читал OBR-3 — и голое «1»
// ложилось в открытый свежий заказ № 1 чужого пациента.
//
// BS-240 — кадр настоящего BS-240E (2026, iammessier/LIS-Machine_Bridge,
// testdata/hl7/bs240e/glu.hl7; значения синтетические): MSH-3/4 пусты, OBR-2 —
// штрихкод, OBR-3 — «1», OBX-3 — Channel No. «Glu-G», OBX-4 — имя теста
// (подпись), OBX-5 — 6 знаков после точки, OBX-13 — то же значение.
const BS240 = (obr2, obr3, value = '5.123450') => seg(
  'MSH|^~\&|||||20260528122129||ORU^R01|3|P|2.3.1',
  'PID|1|||||||O|||||||||||||||||||||||',
  `OBR|1|${obr2}|${obr3}|^|N|20260528115302|20260528115240|20260528115240||1^1||||20260528115240|Serum`,
  `OBX|1|NM|Glu-G|Glucose (GOD-POD Method)|${value}|mg/dL|-|N|||F||${value}|20260528122129|||0||`,
);
// CL-900i — пример руководства «Chemiluminescence Immunoassay Analyzer Host
// Interface Manual» (2013-08), с. 1-27 (pdf 35); имя пациента заменено:
// OBR-2 — штрихкод, OBR-3 — номер пробы прибора «10», OBX-3 — Routine Channel No.
const CL = (obr2, obr3, obx = 'OBX|1|NM|TSH|TSH|2.350000|uIU/mL|-|N|||F||2.350000|20120405194245||yishen|0|') => seg(
  'MSH|^~\&|||||20120508094822||ORU^R01|1|P|2.3.1||||0||ASCII|||',
  'PID|1|1001|||SYN^PAT||19851001095133|M|||keshi|||||||||||||||beizhu|||||',
  `OBR|1|${obr2}|${obr3}|^|Y|20120405193926|20120405193914|20120405193914|||||linchuangzhenduan|20120405193914|serum|lincyisheng|keshi||||||||3|||||||||||||||||||||||`,
  obx,
);

test('D2: BS-240 — номер пробы из OBR-2 (штрихкод), внутренний номер прибора в OBR-3 — приманка, не читается', () => {
  // Заказ № 1 — открытый свежий заказ ДРУГОГО пациента: ровно то, во что
  // легло бы «1» из OBR-3.
  const db = clinic({ orders: [{ id: 123 }, { id: 1 }], analytes: [['GLU', 'Глюкоза', 'Glu-G']], profile: 'mindray-bs-240' });
  assert.equal(ingestMessage(db, BS240('000123', '1'), '10.0.0.42', 1), 'AA');
  const m = last(db);
  assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 123, '000123'], m.detail);
  assert.equal(results(db)[0].value, '5.12345', 'mindray-chem: хвостовые нули срезаны, число не округлено');
  assert.equal(results(db, 1).length, 0, 'заказ № 1 чужого пациента не тронут');

  // Этикетка Easy-Med в OBR-2 и приманка «2» в OBR-3 — проба заказа 123.
  const db2 = clinic({ orders: [{ id: 123 }, { id: 2 }], analytes: [['GLU', 'Глюкоза', 'Glu-G']], profile: 'mindray-bs-240' });
  ingestMessage(db2, BS240('LAB-000123', '2'), '10.0.0.42', 1);
  assert.deepEqual([last(db2).status, last(db2).visit_service_id], ['applied', 123]);
  assert.equal(results(db2, 2).length, 0);
  db.close(); db2.close();
});

test('D2: BS-240 без штрихкода — номера нет, в лоток; «1» из OBR-3 в заказ № 1 не легло', () => {
  const db = clinic({ orders: [{ id: 123 }, { id: 1 }], analytes: [['GLU', 'Глюкоза', 'Glu-G']], profile: 'mindray-bs-240' });
  ingestMessage(db, BS240('', '1'), '10.0.0.42', 1);
  const m = last(db);
  assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmatched', null, '']);
  assert.equal(results(db, 1).length, 0, 'внутренний номер прибора — не номер пробирки');
  db.close();
});

test('D2: CL-900i — номер пробы из OBR-2; номер пробы прибора «10» в OBR-3 не читается', () => {
  const db = clinic({ orders: [{ id: 123 }, { id: 10 }], analytes: [['TSH', 'ТТГ', 'TSH']], profile: 'mindray-cl-900i' });
  ingestMessage(db, CL('000123', '10'), '10.0.0.43', 1);
  const m = last(db);
  assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 123, '000123'], m.detail);
  assert.equal(results(db)[0].value, '2.35');
  assert.equal(results(db, 10).length, 0, 'заказ № 10 чужого пациента не тронут');

  const db2 = clinic({ orders: [{ id: 123 }, { id: 10 }], analytes: [['TSH', 'ТТГ', 'TSH']], profile: 'mindray-cl-900i' });
  ingestMessage(db2, CL('', '10'), '10.0.0.43', 1);
  assert.deepEqual([last(db2).status, last(db2).visit_service_id], ['unmatched', null]);
  assert.equal(results(db2, 10).length, 0);
  db.close(); db2.close();
});

// ── LIS_VENDOR_EXACT_V1 — D7: контроль гематологии мимо бланков ─────────────
// Пример X-R-контроля BC-5300 (руководство оператора, приложение C, pdf
// 486–489; имя оператора заменено, OBX сокращены): MSH-11 = Q, OBR-4 =
// 00006/00008, в OBR-3 — номер файла контроля «6». Раньше это была «проба» с
// голым номером 6 — и значения контроля ложились в открытый свежий ОАК
// заказа № 6 другого пациента.
const BC5300_QC = seg(
  'MSH|^~\&|BC-5300|Mindray|||20081120171602||ORU^R01|1|Q|2.3.1||||||UNICODE',
  'PID|1||6666666||||20080807235959',
  'OBR|1||6|00006^XR QCR^99MRC|||20080807142518|||||||||||||||||HM||||||||Operator',
  'OBX|4|NM|6690-2^WBC^LN||0.00|10*9/L|||||F',
  'PID|3||6666666',
  'OBR|3||6|00008^XR QCR Mean^99MRC||||||||||||||||||||HM',
  'OBX|83|NM|6690-2^WBC^LN||0.00|10*9/L|||||F',
);

test('D7: контроль BC-5300 (MSH-11 = Q, OBR-4 00006) — служебная строка; заказ № 6 не тронут', async () => {
  const { receiveMessage } = await import('./receive.js');
  const db = clinic({ orders: [{ id: 123 }, { id: 6 }], analytes: [['WBC', 'Лейкоциты', 'WBC']] });
  const out = receiveMessage(db, BC5300_QC, { peer: '10.0.0.9', deviceId: 1 });
  assert.deepEqual([out.code, out.kind], ['AA', 'qc']);
  const m = last(db);
  assert.deepEqual([m.kind, m.status, m.visit_service_id, !!m.resolved_at], ['qc', 'unmatched', null, true]);
  assert.equal(results(db, 6).length, 0, 'контроль не лёг в ОАК заказа № 6');
  db.close();
});

// ── LIS_VENDOR_EXACT_V1 — решение владельца 2026-10-06, п. 4: «только номер с этикетки» ──
// analyzer-research\fix\DECISIONS.md, п. 4. Номер пробы без «LAB-» принимается,
// только если это номер с этикетки Easy-Med, как он напечатан под штрихкодом:
// цифры, не меньше 6 («000123» — заказ 123). Короче — номер самого прибора
// (номера лаборатории на A1000, контроль, номер прогона, автоприращение): в
// «Необработанные», человек привяжет «Привязать». Остальное — прежнее: заказ
// открыт, оплачен, не старше 7 дней.
// Приманки — из приёмки 3.16.0 (acceptance\runs\…, T6/T7): открытый оплаченный
// свежий заказ ДРУГОГО пациента с тем же номером. Ни одна не заполняется.

/** Клиника с приманками: у каждого заказа свой пациент и свой визит (как bench.decoyOrder). */
function decoys({ ids, profile, analytes }) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Анализ',1)").run();
  for (const id of ids) {
    db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)').run(1000 + id, 'Подставной ' + id);
    db.prepare(`INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?, ?, ${NOW}, 'scheduled')`).run(1000 + id, 1000 + id);
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (?, ?, 9, 'queued', ${NOW})`).run(id, 1000 + id);
  }
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (1,'Анализатор',?,'mllp',2575)").run(profile);
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'Панель',9,1)").run();
  analytes.forEach(([code, name, dc], i) => {
    db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
                VALUES (5, ?, ?, '', ?, ?, 1, 1, 0)`).run(code, name, i + 1, dc);
  });
  return db;
}
/** Заказы, которых коснулась проба: значения в бланке или строка лотка, привязанная к заказу. */
const touched = (db, ids) => ids.filter((id) => results(db, id).length > 0
  || db.prepare('SELECT COUNT(*) c FROM lab_device_messages WHERE visit_service_id = ?').get(id).c > 0);
const SHORT = (n) => 'номер пробы «' + n + '» короче 6 цифр — на приборе вводите номер с этикетки Easy-Med (6 цифр, например 000123)'
  + ' или сканируйте её; эту пробу привяжите кнопкой «Привязать»';

// A1000 — вывод кодировщика программы прибора клиники (AutoLumo1000 1.0.7;
// realtest\a1000\runs\20261006-123254-en-US-ABDE\raw\01-A1 и 05-A3): «по
// тесту», MSH-10 = 5, OBR-2 — Sample ID, OBR-3 — внутренний номер, NTE перед
// OBX. У контроля PID нет, номер — номер контроля («1», «3»).
const A1000 = (sample, value = '4.17', { pid = true, nte = 'SYNLOT1~CEX~AFP~107~~R001~1' } = {}) => seg(
  'MSH|^~\\&|||||20261006123256||ORU^R01|5|P|2.3.1|261006123256638',
  ...(pid ? ['PID|||SYNTHETIC'] : []),
  `OBR|1|${sample}|7764|Autolumo 1000`,
  `NTE|||${nte}`,
  `OBX|10455|CE|107|107|41765^${value}~||||||F|||2026/10/06 12:32:56`,
);
// BC-5300 — пример руководства (OM13, прил. C; acceptance\runs\mindray-bc-5300):
// номер пробы — OBR-3, OBX-3 «LOINC^ИМЯ^LN».
const BC5300 = (sample, wbc = '6.20') => seg(
  'MSH|^~\\&|BC-5300|Mindray|||20261006133432||ORU^R01|1|P|2.3.1||||||UNICODE',
  'PID|1||T0001^^^^MR||Тестов^Анализатор||19900101000000|Мужской',
  'PV1|1|Амбулаторно|Терапия^^12',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261006133432|||||||||||||||||HM||||||||Лаборант`,
  'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
  `OBX|2|NM|6690-2^WBC^LN||${wbc}|10*9/L||N|||F`,
);
// BC-20 — BC-3600 OM, прил. D.7.4 (acceptance\runs\mindray-bc-20): MSH-3/4 пусты.
const BC20 = (sample, wbc = '6.20') => seg(
  'MSH|^~\\&|||||20261006133432||ORU^R01|2|P|2.3.1||||||UNICODE',
  'PID|1||^^^^MR',
  'PV1|1',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261006133432|||||||||||||||||HM||||||||Admin`,
  'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
  `OBX|2|NM|6690-2^WBC^LN||${wbc}|10*9/L||N|||F`,
);

test('п. 4: порог — 6 цифр, в одном месте (PLAIN_NUMBER_MIN_DIGITS)', () => {
  assert.equal(PLAIN_NUMBER_MIN_DIGITS, 6, 'решение владельца 2026-10-06, п. 4: номер, как он напечатан под штрихкодом — 000123');
  assert.equal(BARE_ID_MAX_AGE_DAYS, 7, 'прочие условия прежние: открыт, оплачен, не старше 7 дней');
});

test('п. 4: A1000 — номера лаборатории 1…99 в OBR-2 — не номер заказа: ни одна приманка не тронута, в лотке — что делать', () => {
  const ids = Array.from({ length: 99 }, (_, i) => i + 1);
  const db = decoys({ ids, profile: 'autobio-autolumo-a1000', analytes: [['AFP', 'АФП', '107']] });
  for (const n of ids) {
    assert.equal(ingestMessage(db, A1000(String(n)), '10.0.0.41', 1), 'AA', 'сохранено — повторять незачем');
    const m = last(db);
    assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmatched', null, String(n)], 'номер ' + n);
    assert.equal(m.detail, SHORT(n));
  }
  assert.deepEqual(touched(db, ids), [], 'чужие бланки не тронуты, и лента не показывает чужого пациента рядом с пробой');
  // Решение владельца: «человек привязывает её кнопкой «Привязать»» — номер называет человек.
  const raw = last(db).raw;
  ingestMessage(db, raw, '10.0.0.41', 1, { touch: false, sampleIdOverride: 42 });
  assert.deepEqual([last(db).status, results(db, 42).map((r) => r.value)], ['applied', ['4.17']]);
  db.close();
});

test('п. 4: A1000 — контроль (без PID, номер «3», приёмка T7a) — приманка № 3 не тронута', () => {
  const db = decoys({ ids: [1, 3], profile: 'autobio-autolumo-a1000', analytes: [['AFP', 'АФП', '107']] });
  ingestMessage(db, A1000('3', '25.1', { pid: false, nte: 'SYNLOT1~~AFP~107~~R001~2' }), '10.0.0.41', 1);
  ingestMessage(db, A1000('1', '25.1', { pid: false, nte: 'SYNLOT1~~AFP~107~~R001~2' }), '10.0.0.41', 1);
  assert.equal(last(db).visit_service_id, null);
  assert.deepEqual(touched(db, [1, 3]), [], 'значения контроля не легли в бланк пациента');
  db.close();
});

test('п. 4: BS-240 и CL-900i, заведённые «Другой анализатор (общий HL7)», — номер прогона OBR-3 («1», «10») не номер заказа', () => {
  // Общий провод читает OBR-3 (C1-RESULT, риски: «wrong-patient risk until decision #4 ships»).
  const bs = decoys({ ids: [1], profile: '', analytes: [['GLU', 'Глюкоза', 'Glu-G']] });
  ingestMessage(bs, BS240('', '1'), '10.0.0.42', 1);
  assert.deepEqual([last(bs).status, last(bs).visit_service_id, last(bs).sample_id, last(bs).detail], ['unmatched', null, '1', SHORT('1')]);
  assert.deepEqual(touched(bs, [1]), []);
  bs.close();

  const cl = decoys({ ids: [10], profile: '', analytes: [['TSH', 'ТТГ', 'TSH']] });
  ingestMessage(cl, CL('', '10'), '10.0.0.43', 1);
  assert.deepEqual([last(cl).status, last(cl).visit_service_id, last(cl).detail], ['unmatched', null, SHORT('10')]);
  assert.deepEqual(touched(cl, [10]), []);
  cl.close();
});

test('п. 4: BC-5300 и BC-20 — автоприращение («1», «2», «7», «812» — приёмка T6) — не номер заказа', () => {
  const hem = decoys({ ids: [1, 2, 812], profile: 'mindray-bc-5300', analytes: [['WBC', 'Лейкоциты', 'WBC']] });
  for (const n of ['1', '2', '812']) {
    ingestMessage(hem, BC5300(n, '14.20'), '10.0.0.9', 1);
    assert.deepEqual([last(hem).status, last(hem).visit_service_id, last(hem).detail], ['unmatched', null, SHORT(n)], n);
  }
  assert.deepEqual(touched(hem, [1, 2, 812]), []);
  hem.close();

  const bc20 = decoys({ ids: [1, 7], profile: 'mindray-bc-20', analytes: [['WBC', 'Лейкоциты', 'WBC']] });
  for (const n of ['1', '7']) {
    ingestMessage(bc20, BC20(n), '10.0.0.12', 1);
    assert.deepEqual([last(bc20).status, last(bc20).visit_service_id, last(bc20).detail], ['unmatched', null, SHORT(n)], n);
  }
  assert.deepEqual(touched(bc20, [1, 7]), []);
  bc20.close();
});

test('п. 4: BS-200 — свой цифровой штрихкод пробирки «0000000021» (приёмка T6b) — не номер с этикетки: приманка № 21 не тронута', () => {
  const db = decoys({ ids: [21], profile: 'mindray-bs-200', analytes: [['GLU', 'Глюкоза', '2']] });
  ingestMessage(db, BS200('0000000021', '7'), '10.0.0.40', 1);
  const m = last(db);
  assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmatched', null, '0000000021']);
  assert.match(m.detail, /^номер пробы «0000000021» — не номер с этикетки Easy-Med/);
  assert.match(m.detail, /«Привязать»/);
  assert.deepEqual(touched(db, [21]), [], 'лишние нули впереди — не так, как напечатано под штрихкодом');
  db.close();
});

test('п. 4: номер с этикетки (6 цифр, как под штрихкодом) — принимается у каждого прибора; LAB- — как прежде', () => {
  const cases = [
    ['autobio-autolumo-a1000', [['AFP', 'АФП', '107']], (s) => A1000(s)],
    ['mindray-bc-5300', [['WBC', 'Лейкоциты', 'WBC']], (s) => BC5300(s)],
    ['mindray-bc-20', [['WBC', 'Лейкоциты', 'WBC']], (s) => BC20(s)],
    ['mindray-bs-200', [['GLU', 'Глюкоза', '2']], (s) => BS200(s, '7')],
    ['mindray-bs-240', [['GLU', 'Глюкоза', 'Glu-G']], (s) => BS240(s, '1')],
    ['mindray-cl-900i', [['TSH', 'ТТГ', 'TSH']], (s) => CL(s, '10')],
  ];
  for (const [profile, analytes, msg] of cases) {
    for (const sample of ['000123', 'LAB-000123']) {
      const db = decoys({ ids: [123, 1, 7, 10], profile, analytes });
      ingestMessage(db, msg(sample), '10.0.0.9', 1);
      assert.deepEqual([last(db).status, last(db).visit_service_id], ['applied', 123], profile + ' ' + sample + ': ' + last(db).detail);
      assert.equal(results(db, 123).length, 1, profile + ' ' + sample);
      assert.deepEqual(touched(db, [1, 7, 10]), [], profile + ' ' + sample);
      db.close();
    }
  }
  // Заказ № 1234567 печатается без дополнения — так и принимается; «01234567» — нет.
  const big = decoys({ ids: [1234567], profile: 'mindray-bc-5300', analytes: [['WBC', 'Лейкоциты', 'WBC']] });
  ingestMessage(big, BC5300('1234567'), '10.0.0.9', 1);
  assert.equal(last(big).visit_service_id, 1234567, last(big).detail);
  ingestMessage(big, BC5300('01234567', '7.1'), '10.0.0.9', 1);
  assert.deepEqual([last(big).status, last(big).visit_service_id], ['unmatched', null]);
  big.close();
});

test('п. 4: прочие условия прежние — номер с этикетки к закрытому или старому заказу — отказ с причиной', () => {
  const db = decoys({ ids: [123], profile: 'mindray-bc-5300', analytes: [['WBC', 'Лейкоциты', 'WBC']] });
  db.prepare(`UPDATE visit_services SET created_at = ${dayStart(30)} WHERE id = 123`).run();
  db.prepare(`UPDATE visits SET visit_date = ${dayStart(30)} WHERE id = 1123`).run();
  ingestMessage(db, BC5300('000123'), '10.0.0.9', 1);
  assert.deepEqual([last(db).status, last(db).visit_service_id], ['unmatched', null]);
  assert.match(last(db).detail, /старше 7 дней/);
  assert.equal(results(db, 123).length, 0);
  db.close();
});

test('п. 4: BS-240 — свой 8-значный штрихкод пробирки в OBR-2 и номер прогона «12» в OBR-3 (приёмка T6c) — приманка № 12 не тронута', () => {
  // Профиль BS-240 (провод mindray-chem): OBR-3 не читается, «81234567» — номер
  // как напечатан (без лишних нулей), но такого заказа нет. На строке «Другой
  // анализатор (общий HL7)» читается OBR-3 — «12» короче 6 цифр.
  for (const [profile, detail] of [['mindray-bs-240', 'заказ по номеру пробы не найден'], ['', SHORT('12')]]) {
    const db = decoys({ ids: [12], profile, analytes: [['GLU', 'Глюкоза', 'Glu-G']] });
    ingestMessage(db, BS240('81234567', '12'), '10.0.0.42', 1);
    assert.deepEqual([last(db).status, last(db).visit_service_id, last(db).detail], ['unmatched', null, detail], profile || '(общий HL7)');
    assert.deepEqual(touched(db, [12]), [], profile || '(общий HL7)');
    db.close();
  }
});
