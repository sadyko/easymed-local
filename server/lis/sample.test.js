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
// Провод прибора в первых тестах назван явно ({ wire }): они писались до
// профилей BS-200, A1000 и BC-780. С LIS_REAL_ANALYZERS_V1_PROFILES провод
// берётся из профиля прибора сам — тесты в конце файла, без { wire }.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ingestMessage, BARE_ID_MAX_AGE_DAYS } from './ingest.js';

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
    db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id)
                VALUES (5, ?, ?, '', ?, ?, 1, 1)`).run(code, name, i + 1, dc);
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
  ingestMessage(db, HEM('123', ''), '10.0.0.9', 1);
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
  assert.deepEqual(run('', '15'), { vs: 15, sample: '15', n123: 0, n15: 1 }, 'голые цифры OBR-3 — для открытого свежего заказа');
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

test('голые цифры принимаются для открытого заказа: added, queued, collected, in_progress, resulted', () => {
  assert.equal(BARE_ID_MAX_AGE_DAYS, 7);
  for (const st of ['added', 'queued', 'collected', 'in_progress', 'resulted']) {
    const db = clinic({ orders: [{ id: 123, status: st }] });
    ingestMessage(db, HEM('', '123'), '10.0.0.9', 1);
    assert.equal(last(db).visit_service_id, 123, st);
    assert.equal(results(db).length, 1, st + ': лаборатория часто не жмёт «Забор пробы» — queued законен');
    db.close();
  }
});

test('голые цифры к закрытому заказу (выдан, отменён) — unmatched: причина названа словами', () => {
  for (const [st, word] of [['completed', 'выдан'], ['cancelled', 'отменён']]) {
    const db = clinic({ orders: [{ id: 2, status: st }] });
    db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (2, 'Лейкоциты', '5.5')").run();
    assert.equal(ingestMessage(db, HEM('', '2'), '10.0.0.9', 1), 'AA');
    const m = last(db);
    assert.equal(m.status, 'unmatched', st);
    assert.equal(m.visit_service_id, null, st + ': чужой выданный заказ не показывается рядом с пробой');
    assert.equal(m.sample_id, '2');
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
  ingestMessage(db, HEM('', '2'), '10.0.0.9', 1);
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
  ingestMessage(ok, HEM('', '2'), '10.0.0.9', 1);
  assert.equal(last(ok).visit_service_id, 2, 'первая секунда дня «сегодня − 7»');
  assert.equal(results(ok, 2).length, 1);
  ok.close();

  const old = clinic({ orders: [{ id: 2, created: dayEnd(8) }] });
  ingestMessage(old, HEM('', '2'), '10.0.0.9', 1);
  assert.equal(last(old).status, 'unmatched', 'последняя секунда дня «сегодня − 8»');
  assert.equal(results(old, 2).length, 0);
  old.close();
});

test('закрытый и старый сразу — названы обе причины', () => {
  const db = clinic({ orders: [{ id: 2, status: 'completed', created: dayStart(40) }] });
  ingestMessage(db, HEM('', '2'), '10.0.0.9', 1);
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
  ingestMessage(db, HEM('', '2'), '10.0.0.9', 1);
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
  ingestMessage(db, HEM('123', ''), '10.0.0.42', 1);
  assert.equal(last(db).visit_service_id, 123, 'запасное поле — только у провода гематологии; default голые OBR-2 не читает');
  assert.equal(results(db).length, 1);
  ingestMessage(db, HEM('', '15'), '10.0.0.42', 1);
  assert.equal(last(db).visit_service_id, 15);
  assert.equal(results(db, 15).length, 1);
  db.close();
});

test('прежний профиль (BC-5300): голые цифры OBR-2 по-прежнему не читаются', () => {
  const db = clinic();
  ingestMessage(db, HEM('123', ''), '10.0.0.9', 1);
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
    ingestMessage(db, HEM('', '2'), '10.0.0.9', 1);
    assert.equal(last(db).visit_service_id, null, name);
    assert.notEqual(last(db).status, 'applied', name);
    db.close();
  }
  const db = clinic({ orders: [{ id: 2 }] });
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (2,'Другой','mindray-bs-240')").run();
  ingestMessage(db, HEM('', '2'), '10.0.0.9', 2);
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
  ingestMessage(booked, HEM('', '2'), '10.0.0.9', 1);
  assert.equal(last(booked).visit_service_id, 2, 'запись на сегодня');
  assert.equal(results(booked, 2).length, 1);
  booked.close();

  const visit = clinic({ orders: [{ id: 2, status: 'queued', created: dayStart(10) }] });
  visit.prepare(`UPDATE visits SET visit_date = ${NOW} WHERE id = 55`).run();
  ingestMessage(visit, HEM('', '2'), '10.0.0.9', 1);
  assert.equal(last(visit).visit_service_id, 2, 'визит сегодня');
  visit.close();
});

test('R1 п. 4: создан, записан и визит — всё старше 7 дней: отказ, назван позднейший день', () => {
  const db = clinic({ orders: [{ id: 2, status: 'queued', created: dayStart(30) }] });
  db.prepare(`UPDATE visit_services SET scheduled_at = ${dayStart(20)} WHERE id = 2`).run();
  db.prepare(`UPDATE visits SET visit_date = ${dayStart(25)} WHERE id = 55`).run();
  ingestMessage(db, HEM('', '2'), '10.0.0.9', 1);
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

test('R1 п. 8: голые цифры с ведущими нулями (переадресатор шлёт 8 знаков) — правило голых цифр, как прежде', () => {
  const db = clinic();
  ingestMessage(db, HEM('', '00000123'), '10.0.0.9', 1);
  assert.equal(last(db).visit_service_id, 123);
  assert.equal(results(db).length, 1);
  db.close();
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
  ingestMessage(fut, HEM('', '2'), '10.0.0.9', 1);
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
  ingestMessage(db, HEM('', '2'), '10.0.0.9', 1);
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

test('R2 п. 12: строка прежней модели без провода (BS-240) и сообщение BS-200 — не спор: провод сообщения', () => {
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
  ingestMessage(db, HEM('', '123'), '10.0.0.9', 1);
  assert.equal(last(db).status, 'superseded');
  assert.equal(last(db).visit_service_id, 123);
  assert.equal(results(db)[0].value, '5.5', 'выданный не переписан');
  db.close();
});
