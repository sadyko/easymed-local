// BRANCH_SYNC_V1 — что именно уезжает из главного филиала и как приземляется.
//
// Здесь проверяется НЕ транспорт (это sync-e2e.test.js), а два обещания,
// которые дороже всего стоят, если их нарушить:
//   1. выгрузка физически не умеет вынести клинические данные;
//   2. приём никогда не портит то, что уже есть в принимающем филиале —
//      ни чужими id, ни дублями прайса, ни удалением местных строк.
//
// Важная деталь окружения, на которой держится половина файла: чистая база
// после миграций НЕ пуста. 027_reference_tables засевает шесть типов услуг и
// шесть отделений, 041_lab_handling — услугу «Общий анализ крови (CBC)»
// (LAB-CBC). Значит, у двух независимо установленных филиалов эти строки уже
// СОВПАДАЮТ по смыслу и различаются по id — ровно тот случай, ради которого
// существует усыновление. Тесты ниже намеренно работают на этом фоне, а не на
// стерильной пустой базе, которой в жизни не бывает.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { exportCatalogue, applyCatalogue, TABLES, DOC_SETTINGS_COLUMNS } from './catalogue.js';
import { becomeSecondary } from './identity.js';
// STAFF_SYNC_V1 — вход проверяется НАСТОЯЩИМ путём входа, а не сравнением
// хешей: обещание владельца звучит как «человек войдёт во втором здании», и
// проверять его надо тем же кодом, которым клиника пускает людей каждый день.
import { hashPassword, login, sessionUser } from '../auth.js';

const MARKER = 'ZZMARKERPATIENT';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/** Главный филиал: справочник + пациент со счётом и анализом (маркер утечки). */
function seedMain(db) {
  db.prepare("UPDATE doc_settings SET clinic_name='Клиника Луч', address='ул. Главная, 1', phone='+998901112233', email='main@clinic.uz', accent_color='#123456', license='LIC-77' WHERE id=1").run();

  // Тип с уникальным названием — чтобы отличить «создано» от «усыновлено»:
  // шесть засеянных типов есть в обеих базах и должны именно усыновиться.
  db.prepare("INSERT INTO service_types (name, code) VALUES ('Стоматология','DENT')").run();
  db.prepare("INSERT INTO service_categories (name, code) VALUES ('Терапия','THER')").run();
  db.prepare("INSERT INTO service_categories (name, code, parent_id) VALUES ('Кардиология','CARD',1)").run();

  db.prepare(`INSERT INTO services (name, code, price, type, type_id, category_id, department_id, active)
              VALUES ('Приём кардиолога','S-CARD',250000,'consultation',1,2,2,1)`).run();
  db.prepare(`INSERT INTO services (name, code, price, type, is_lab, active)
              VALUES ('Биохимия крови','S-BIO',180000,'lab',1,1)`).run();
  const bioId = db.prepare("SELECT id FROM services WHERE code='S-BIO'").get().id;
  db.prepare('INSERT INTO lab_panels (name, code, service_id) VALUES (?,?,?)').run('Биохимия', 'P-BIO', bioId);
  const panelId = db.prepare("SELECT id FROM lab_panels WHERE code='P-BIO'").get().id;
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, ref_low, ref_high, sort_order)
              VALUES (?,'GLU','Глюкоза','ммоль/л',3.9,5.9,1)`).run(panelId);
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, ref_low, ref_high, sort_order)
              VALUES (?,'ALT','АЛТ','Ед/л',0,41,2)`).run(panelId);

  // Клиника, которой в выгрузке быть НЕ ДОЛЖНО.
  db.prepare('INSERT INTO patients (full_name, phone, notes) VALUES (?,?,?)')
    .run(MARKER + ' Иванов', '+998900000000', 'диагноз ' + MARKER);
  db.prepare("INSERT INTO visits (patient_id, visit_date, notes) VALUES (1,'2026-08-29',?)").run(MARKER);
  db.prepare('INSERT INTO invoices (invoice_number, patient_id, total_amount) VALUES (?,1,250000)').run(MARKER + '-001');
  db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, unit_price) VALUES (1,?,?,250000)')
    .run(db.prepare("SELECT id FROM services WHERE code='S-CARD'").get().id, MARKER);
  db.prepare('INSERT INTO visit_services (visit_id, service_id, unit_price) VALUES (1,?,180000)').run(bioId);
  db.prepare('INSERT INTO lab_results (visit_service_id, notes) VALUES (1,?)').run(MARKER);
  return db;
}

// Принимающий филиал, у которого автоинкремент услуг заведомо разошёлся с
// главным: если бы приём переносил чужие id, любой тест ниже это увидел бы.
function receiver() {
  const db = fresh();
  db.prepare("UPDATE sqlite_sequence SET seq = 500 WHERE name = 'services'").run();
  return db;
}

const apply = (db, cat) => db.transaction(() => applyCatalogue(db, cat))();

test('выгрузка отдаёт ровно перечисленные колонки — и ни одной лишней', () => {
  // seedStaff — чтобы в выгрузке БЫЛИ сотрудники: без единой строки цикл ниже
  // не проверяет по этой таблице ничего (см. пояснение внутри).
  const db = seedStaff(seedMain(fresh()));
  const cat = exportCatalogue(db);

  assert.deepEqual(Object.keys(cat.doc_settings).sort(), [...DOC_SETTINGS_COLUMNS].sort());
  // Контакты филиала остаются его собственными — их в выгрузке нет вовсе.
  for (const forbidden of ['address', 'phone', 'email', 'id', 'updated_at']) {
    assert.equal(forbidden in cat.doc_settings, false, `doc_settings.${forbidden} не должен уезжать`);
  }
  for (const spec of TABLES) {
    assert.ok(Array.isArray(cat[spec.name]), spec.name + ' должен быть в выгрузке');
    // ПРОВЕРКА НЕ ДОЛЖНА БЫТЬ ХОЛОСТОЙ. У пустой таблицы цикл не выполняется ни
    // разу и «лишних колонок нет» становится правдой ни о чём — так users и
    // проехали мимо неё, пока в посеве не появился ни один сотрудник.
    assert.ok(cat[spec.name].length > 0, spec.name + ': посев обязан дать хоть одну строку, иначе проверка холостая');
    for (const row of cat[spec.name]) {
      // Производное поле (branchLetter) — часть контракта выгрузки наравне с
      // колонками, а вот САМА колонка приписки уезжать не должна: наружу едет
      // буква здания, местный id остаётся дома.
      const derived = spec.branchLetter ? [spec.branchLetter.field] : [];
      assert.deepEqual(Object.keys(row).sort(), ['id', ...spec.columns, ...derived].sort(),
        spec.name + ': набор колонок задан в коде и не должен расходиться');
      if (spec.branchLetter) {
        assert.equal(spec.branchLetter.column in row, false,
          spec.name + ': местный id здания не должен уезжать — у соседа он указывает в никуда');
      }
    }
  }
});

test('в выгрузке нет ни одного следа пациента, визита, счёта или анализа', () => {
  const db = seedMain(fresh());
  const cat = exportCatalogue(db);

  // Тот же приём, что у STATS_V1: маркер сажается в базу-источник и ищется во
  // ВСЁМ передаваемом тексте — не в отдельных полях, которые кто-то мог забыть
  // проверить.
  assert.equal(JSON.stringify(cat).includes(MARKER), false, 'клинические данные не должны попадать в выгрузку');

  // И структурно: таблиц с пациентскими данными в выгрузке нет как ключей.
  for (const t of ['patients', 'visits', 'invoices', 'invoice_items', 'payments', 'lab_results', 'visit_services']) {
    assert.equal(t in cat, false, t + ' не является частью Этапа 1');
  }
});

test('пустой филиал получает справочник целиком, со своими id и верными связями', () => {
  const cat = exportCatalogue(seedMain(fresh()));
  const dst = receiver();

  const summary = apply(dst, cat);
  assert.equal(summary.created.services, 2, 'две новые услуги — засеянная LAB-CBC усыновляется');
  assert.equal(summary.adopted.services, 1);
  assert.equal(summary.adopted.service_types, 6, 'шесть засеянных типов узнаны по названию');
  assert.equal(summary.adopted.departments, 6);
  assert.equal(summary.created.service_types, 1, 'только «Стоматология» действительно новая');
  assert.equal(summary.created.lab_panel_analytes, 2);
  assert.equal(summary.settings, true);

  const card = dst.prepare("SELECT * FROM services WHERE code='S-CARD'").get();
  assert.ok(card.id > 500, 'локальный id выдаёт принимающая база, а не главный филиал');
  assert.equal(card.price, 250000);
  // Ссылки переведены на МЕСТНЫЕ строки, а не скопированы числом.
  const cardCat = dst.prepare("SELECT * FROM service_categories WHERE code='CARD'").get();
  assert.equal(card.category_id, cardCat.id);
  const parent = dst.prepare("SELECT * FROM service_categories WHERE code='THER'").get();
  assert.equal(cardCat.parent_id, parent.id, 'ссылка категории на саму себя проставляется вторым проходом');

  const panel = dst.prepare("SELECT * FROM lab_panels WHERE code='P-BIO'").get();
  const bio = dst.prepare("SELECT * FROM services WHERE code='S-BIO'").get();
  assert.equal(panel.service_id, bio.id);
  const glu = dst.prepare("SELECT * FROM lab_panel_analytes WHERE code='GLU'").get();
  assert.equal(glu.panel_id, panel.id);
  assert.equal(glu.ref_low, 3.9, 'референсные значения едут вместе с показателем');

  // Клиническая часть принимающей базы не появилась из воздуха.
  assert.equal(dst.prepare('SELECT COUNT(*) n FROM patients').get().n, 0);
  assert.equal(dst.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
});

test('повторный приём того же справочника не меняет ничего', () => {
  const cat = exportCatalogue(seedMain(fresh()));
  const dst = receiver();
  apply(dst, cat);
  const countAfterFirst = dst.prepare('SELECT COUNT(*) n FROM services').get().n;

  const preview = applyCatalogue(dst, cat, { dryRun: true });
  assert.equal(preview.changed, 0, 'холостой прогон обязан увидеть, что делать нечего');
  const again = apply(dst, cat);
  assert.equal(again.changed, 0);
  assert.equal(dst.prepare('SELECT COUNT(*) n FROM services').get().n, countAfterFirst, 'прайс не удвоился');
});

test('изменение цены в главном филиале доезжает, id услуги не меняется', () => {
  const src = seedMain(fresh());
  const dst = receiver();
  apply(dst, exportCatalogue(src));
  const before = dst.prepare("SELECT * FROM services WHERE code='S-CARD'").get();

  src.prepare("UPDATE services SET price = 300000 WHERE code='S-CARD'").run();
  const summary = apply(dst, exportCatalogue(src));

  assert.equal(summary.updated.services, 1);
  const after = dst.prepare("SELECT * FROM services WHERE code='S-CARD'").get();
  assert.equal(after.price, 300000);
  assert.equal(after.id, before.id, 'обновляется та же строка — счета филиала продолжают указывать на неё');
});

test('услуга, заведённая в филиале руками, усыновляется, а не дублируется', () => {
  const src = seedMain(fresh());
  const dst = receiver();
  // Филиал жил самостоятельно: та же услуга под тем же кодом, свой id, и на
  // неё уже ссылается выставленный счёт.
  dst.prepare("INSERT INTO services (name, code, price, type) VALUES ('Приём кардиолога','S-CARD',200000,'consultation')").run();
  const localId = dst.prepare("SELECT id FROM services WHERE code='S-CARD'").get().id;
  dst.prepare('INSERT INTO patients (full_name) VALUES (?)').run('Местный пациент');
  dst.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount) VALUES ('L-1',1,200000)").run();
  dst.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, unit_price) VALUES (1,?,'Приём кардиолога',200000)").run(localId);

  apply(dst, exportCatalogue(src));

  assert.equal(dst.prepare("SELECT COUNT(*) n FROM services WHERE code='S-CARD'").get().n, 1, 'дубля прайса быть не должно');
  const svc = dst.prepare("SELECT * FROM services WHERE code='S-CARD'").get();
  assert.equal(svc.id, localId, 'усыновляется МЕСТНАЯ строка, её id не трогают');
  assert.equal(svc.price, 250000, 'цена главного филиала — источник правды');
  assert.equal(dst.prepare('SELECT service_id FROM invoice_items WHERE id = 1').get().service_id, localId,
    'выставленный счёт по-прежнему указывает на ту же услугу');
});

test('две одинаково названные местные строки — усыновлять нечего, создаётся новая', () => {
  const src = seedMain(fresh());
  const dst = receiver();
  // Без кода и в двух экземплярах: угадывание здесь означало бы «перепишем
  // цену наугад одной из двух», чего делать нельзя.
  dst.prepare("INSERT INTO services (name, price, type) VALUES ('Биохимия крови', 10, 'lab')").run();
  dst.prepare("INSERT INTO services (name, price, type) VALUES ('Биохимия крови', 20, 'lab')").run();

  apply(dst, exportCatalogue(src));

  assert.equal(dst.prepare("SELECT COUNT(*) n FROM services WHERE name='Биохимия крови'").get().n, 3);
  assert.deepEqual(
    dst.prepare("SELECT price FROM services WHERE name='Биохимия крови' ORDER BY id").all().map((r) => r.price),
    [10, 20, 180000],
    'обе местные строки остались нетронутыми',
  );
});

test('местная услуга, которой нет у главного филиала, остаётся жить', () => {
  const src = seedMain(fresh());
  const dst = receiver();
  dst.prepare("INSERT INTO services (name, code, price, type) VALUES ('Своя процедура','S-OWN',15000,'procedure')").run();

  apply(dst, exportCatalogue(src));

  const own = dst.prepare("SELECT * FROM services WHERE code='S-OWN'").get();
  assert.ok(own, 'Этап 1 ничего не удаляет — у филиала могут быть свои услуги и счета по ним');
  assert.equal(own.price, 15000);
});

test('снятие услуги с продажи в главном филиале доезжает как active = 0', () => {
  const src = seedMain(fresh());
  const dst = receiver();
  apply(dst, exportCatalogue(src));

  src.prepare("UPDATE services SET active = 0 WHERE code='S-CARD'").run();
  apply(dst, exportCatalogue(src));

  assert.equal(dst.prepare("SELECT active FROM services WHERE code='S-CARD'").get().active, 0);
});

test('сведения о клинике приезжают, а собственные адрес/телефон филиала — нет', () => {
  const src = seedMain(fresh());
  const dst = receiver();
  dst.prepare("UPDATE doc_settings SET clinic_name='Старое имя', address='ул. Филиальная, 7', phone='+998911111111', email='branch@clinic.uz' WHERE id=1").run();

  apply(dst, exportCatalogue(src));

  const s = dst.prepare('SELECT * FROM doc_settings WHERE id=1').get();
  assert.equal(s.clinic_name, 'Клиника Луч');
  assert.equal(s.accent_color, '#123456');
  assert.equal(s.license, 'LIC-77');
  assert.equal(s.address, 'ул. Филиальная, 7', 'адрес филиала не должен подменяться адресом главного');
  assert.equal(s.phone, '+998911111111');
  assert.equal(s.email, 'branch@clinic.uz');
});

// LAB_ONE_CLINIC_V1 — настройка «кого обслуживает лаборатория» (миграция 085).
//
// Она обязана путешествовать. Если бы каждое здание решало у себя, филиал ждал
// бы, что его пробирки возьмёт в работу главный корпус, а главный корпус их бы
// не видел — и никто бы не узнал, потому что молчащая очередь выглядит как
// «сегодня нет заказов». Поэтому проверяется не значение в одной базе, а то,
// что решение главного филиала доезжает до принимающей.
test('лаборатория: настройка «обслуживает всю клинику» приезжает из главного филиала', () => {
  const src = seedMain(fresh());
  const dst = receiver();

  assert.equal(dst.prepare('SELECT lab_scope FROM doc_settings WHERE id=1').get().lab_scope, 'clinic',
    'по умолчанию — вся клиника: так просил владелец');

  // Главный решает, что у него две настоящие лаборатории.
  src.prepare("UPDATE doc_settings SET lab_scope='building' WHERE id=1").run();
  apply(dst, exportCatalogue(src));
  assert.equal(dst.prepare('SELECT lab_scope FROM doc_settings WHERE id=1').get().lab_scope, 'building',
    'филиал обязан согласиться с главным, а не остаться при своём');

  // И обратно — настройка не «однократная», она живёт.
  src.prepare("UPDATE doc_settings SET lab_scope='clinic' WHERE id=1").run();
  apply(dst, exportCatalogue(src));
  assert.equal(dst.prepare('SELECT lab_scope FROM doc_settings WHERE id=1').get().lab_scope, 'clinic');
});

test('лаборатория: выгрузка главного филиала СТАРОЙ версии не сбрасывает настройку', () => {
  // Обновления приезжают помашинно: главный неделями может отдавать справочник
  // без этой колонки. Отсутствующий ключ — «оставь как есть», а не NULL.
  const src = seedMain(fresh());
  const dst = receiver();
  dst.prepare("UPDATE doc_settings SET lab_scope='building' WHERE id=1").run();

  const cat = exportCatalogue(src);
  delete cat.doc_settings.lab_scope;
  apply(dst, cat);

  assert.equal(dst.prepare('SELECT lab_scope FROM doc_settings WHERE id=1').get().lab_scope, 'building');
});

test('лаборатория: филиал СТАРОЙ версии не падает на колонке, которой у него ещё нет', () => {
  // Обратная сторона того же: главный уже обновлён и шлёт lab_scope, а филиал
  // ещё нет. Приём справочника идёт ОДНОЙ транзакцией — упади он на «no such
  // column», филиал перестал бы получать и прайс тоже, пока не обновится.
  const src = seedMain(fresh());
  const dst = receiver();
  dst.prepare('ALTER TABLE doc_settings DROP COLUMN lab_scope').run();   // база до 085

  const summary = apply(dst, exportCatalogue(src));

  assert.equal(dst.prepare("SELECT clinic_name FROM doc_settings WHERE id=1").get().clinic_name, 'Клиника Луч',
    'остальные сведения о клинике обязаны доехать');
  assert.ok(summary.changed > 0);
});

test('строку, удалённую в филиале руками, следующая синхронизация заводит заново', () => {
  const src = seedMain(fresh());
  const dst = receiver();
  apply(dst, exportCatalogue(src));

  const id = dst.prepare("SELECT id FROM services WHERE code='S-CARD'").get().id;
  dst.prepare('DELETE FROM services WHERE id = ?').run(id);
  // Соответствие осталось и указывает в пустоту — приём обязан это пережить.
  assert.ok(dst.prepare("SELECT 1 FROM branch_sync_map WHERE table_name='services'").get());

  const summary = apply(dst, exportCatalogue(src));
  assert.equal(summary.created.services, 1);
  assert.ok(dst.prepare("SELECT 1 FROM services WHERE code='S-CARD'").get());
});

test('мусор вместо справочника не роняет приём и ничего не пишет', () => {
  const dst = receiver();
  const before = dst.prepare('SELECT COUNT(*) n FROM services').get().n;
  for (const junk of [null, undefined, 'строка', 42, [], { services: 'не массив' }, { doc_settings: [] }, { services: [null, {}, { id: null }] }]) {
    const s = applyCatalogue(dst, junk);
    assert.equal(s.changed, 0, 'ничего не должно измениться от бессмысленного ответа');
  }
  assert.equal(dst.prepare('SELECT COUNT(*) n FROM services').get().n, before);
  assert.equal(dst.prepare('SELECT COUNT(*) n FROM branch_sync_map').get().n, 0);
});

// ---------------------------------------------------------------------------
// РАЗНЫЕ ВЕРСИИ НА ДВУХ КОНЦАХ — нормальное состояние этого продукта:
// обновления приезжают помашинно, и главный филиал неделями может отдавать
// справочник БЕЗ колонок, которые принимающая база уже получила миграцией
// (первый такой случай — default_doctor_percent из 081). Отсутствующий ключ
// обязан читаться как «старый экспортёр — оставь местное/умолчание», а не как
// NULL: NULL валит INSERT об NOT NULL, а UPDATE затирает местную настройку.
// Ветка doc_settings в applyCatalogue всегда так и делала (`col in payload`);
// эти тесты требуют того же от ветки TABLES.
// ---------------------------------------------------------------------------

// Выгрузка «как её отдал бы главный филиал до 081»: настоящий экспорт, из
// которого КЛЮЧ УДАЛЁН (не занулён — старый код про колонку не знает вовсе).
function preMigration081Catalogue(db) {
  const cat = exportCatalogue(db);
  for (const row of cat.services) delete row.default_doctor_percent;
  return cat;
}

test('выгрузка главного филиала ДО 081 приземляется чисто; новая колонка остаётся по умолчанию', () => {
  const cat = preMigration081Catalogue(seedMain(fresh()));
  const dst = receiver();

  // dryRun решает, снимать ли резервную копию, — он обязан сойтись с
  // настоящим приёмом на том же payload из того же состояния.
  const preview = dst.transaction(() => applyCatalogue(dst, cat, { dryRun: true }))();
  const real = apply(dst, cat);
  assert.equal(preview.changed, real.changed, 'dryRun и настоящий приём должны согласиться');

  const svc = dst.prepare("SELECT default_doctor_percent FROM services WHERE code='S-CARD'").get();
  assert.ok(svc, 'услуга обязана приехать, версия экспортёра — не причина для отказа');
  assert.equal(svc.default_doctor_percent, 0, 'отсутствующая колонка = умолчание, не NULL');
});

test('старая выгрузка не затирает местную долю на уже сопоставленной услуге и не дрейфует', () => {
  const main = seedMain(fresh());
  const dst = receiver();
  apply(dst, exportCatalogue(main));   // связаны в новом формате
  dst.prepare("UPDATE services SET default_doctor_percent = 35 WHERE code='S-CARD'").run();

  // Главный филиал ещё не обновился (или откатился): колонки в выгрузке нет,
  // но цена изменилась — цена обязана доехать, местная доля — уцелеть.
  main.prepare("UPDATE services SET price = 260000 WHERE code='S-CARD'").run();
  const cat = preMigration081Catalogue(main);
  apply(dst, cat);

  const svc = dst.prepare("SELECT price, default_doctor_percent FROM services WHERE code='S-CARD'").get();
  assert.equal(svc.price, 260000, 'обычное обновление из старой выгрузки работает');
  assert.equal(svc.default_doctor_percent, 35, 'местная настройка не затёрта отсутствующим ключом');

  // Повторный приём того же старого payload — no-op: иначе каждая синхронизация
  // «находила» бы изменение и снимала резервную копию на пустом прогоне.
  const again = apply(dst, cat);
  assert.equal(again.changed, 0, 'no-op на повторе — против бесконечного дрейфа');
});

// ---------------------------------------------------------------------------
// Ё/Е И NFC ПРИ УСЫНОВЛЕНИИ — правило «то же имя» одно на весь продукт.
// Редактор услуги (resolveCombobox) и усыновление здесь обязаны согласиться,
// иначе то, что редактор считает «той же услугой», синхронизация продублирует
// (или наоборот). Согласие закреплено конструктивно — catalogue.js импортирует
// normName из service-editor-logic.js — и проверено здесь поведенчески.
// ---------------------------------------------------------------------------

test('усыновление сквозь ё/е и NFD: «Прием кардиолога» узнаёт местный «Приём кардиолога»', () => {
  const dst = receiver();
  // Код НЕ задан ни там, ни там — сопоставление идёт по названию.
  dst.prepare("INSERT INTO services (name, price, type) VALUES ('Приём кардиолога', 250000, 'consultation')").run();
  const localId = dst.prepare("SELECT id FROM services WHERE name = 'Приём кардиолога'").get().id;

  const remoteRow = {
    id: 900, name: 'Прием кардиолога', code: null, price: 260000, tax_rate: 0,
    duration_minutes: 30, requires_doctor: 0, active: 1, is_lab: 0, specimen: null,
    result_unit: null, ref_low: null, ref_high: null, ref_text: null,
    type: 'consultation', type_id: null, category_id: null, department_id: null,
    tube_color: null, default_doctor_percent: 0,
  };
  const summary = apply(dst, { services: [remoteRow] });
  assert.equal(summary.adopted.services, 1, 'ё против е — то же имя, это усыновление');
  assert.equal(summary.created.services ?? 0, 0, 'двойник не создан');
  assert.equal(dst.prepare('SELECT price FROM services WHERE id = ?').get(localId).price, 260000);

  // И разложенная форма (NFD) того же имени на следующем прогоне — тоже он.
  const nfd = { ...remoteRow, id: 901, name: 'Приём кардиолога'.normalize('NFD'), price: 270000 };
  const dst2 = receiver();
  dst2.prepare("INSERT INTO services (name, price, type) VALUES ('Приём кардиолога', 250000, 'consultation')").run();
  const s2 = apply(dst2, { services: [nfd] });
  assert.equal(s2.adopted.services, 1, 'NFD против NFC — то же имя');
  assert.equal(s2.created.services ?? 0, 0);
});

// BRANCH_ROSTER_V1 — филиал называется своим именем, а главная — своим.
//
// Снимок владельца 2026-09-02 с машины филиала: в списке филиалов «C» и
// «Main Branch». Имя знает только главная клиника; ключ с именем (0.6.9) чинит
// лишь новые подключения. Список сети в справочнике чинит уже подключённые при
// первой же синхронизации.
test('справочник несёт список сети: буква -> имя и часы, только строки с буквой', () => {
  const db = fresh();
  const WH = JSON.stringify({ mon: { enabled: true, from: '08:00', to: '17:00' } });
  db.prepare("UPDATE branches SET name = 'Heal point', working_hours = ? WHERE letter = 'A'").run(WH);
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Клиника на Чиланзаре', 'C')").run();
  db.prepare("INSERT INTO branches (name) VALUES ('Кабинет без буквы')").run();
  const out = exportCatalogue(db);
  // CROSS_BRANCH_CALENDAR_V1 — ЧАСЫ ЗДАНИЯ ЕДУТ ВМЕСТЕ С ИМЕНЕМ: окно приёма
  // врача сужается часами ЕГО здания, и без них сосед предлагал бы время, на
  // которое само здание записать не даёт.
  assert.deepEqual(out.roster, [
    { letter: 'A', name: 'Heal point', working_hours: WH, is_24_7: 0 },
    { letter: 'C', name: 'Клиника на Чиланзаре', working_hours: '{}', is_24_7: 0 },
  ], 'строка без буквы — не узел сети, соседям ни к чему');
  db.close();
});

test('часы приезжают ЧУЖОМУ зданию и не трогают СВОЁ: распорядок здания правит здание', () => {
  const db = fresh();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  const MY = JSON.stringify({ mon: { enabled: true, from: '07:00', to: '15:00' } });
  db.prepare("UPDATE branches SET working_hours = ? WHERE letter = 'C'").run(MY);

  const MAIN = JSON.stringify({ mon: { enabled: true, from: '08:00', to: '17:00' } });
  applyCatalogue(db, { roster: [
    { letter: 'A', name: 'Heal point', working_hours: MAIN, is_24_7: 0 },
    // Главная клиника считает, что филиал C работает круглосуточно; про СВОЙ
    // распорядок филиал ей не обязан верить — его выставляет местный
    // администратор, и приехавшее значение перекрыло бы его молча.
    { letter: 'C', name: 'Чиланзар', working_hours: '{}', is_24_7: 1 },
  ] });

  assert.equal(db.prepare("SELECT working_hours FROM branches WHERE letter = 'A'").get().working_hours, MAIN,
    'часы соседнего здания обязаны доехать: без них его врачам считается не то окно');
  const mine = db.prepare("SELECT working_hours, is_24_7 FROM branches WHERE letter = 'C'").get();
  assert.equal(mine.working_hours, MY, 'свои часы правит только это здание');
  assert.equal(mine.is_24_7, 0);
  db.close();
});

test('филиал переименовывает СВОЮ строку и строку главной по списку', () => {
  const db = fresh();
  becomeSecondary(db, { letter: 'C' });   // как при активации старым ключом: имя = буква
  assert.equal(db.prepare("SELECT name FROM branches WHERE letter = 'C'").get().name, 'C');
  assert.equal(db.prepare("SELECT name FROM branches WHERE letter = 'A'").get().name, 'Main Branch');

  const r = applyCatalogue(db, { roster: [
    { letter: 'A', name: 'Heal point' },
    { letter: 'C', name: 'Клиника на Чиланзаре' },
  ] });

  assert.equal(db.prepare("SELECT name FROM branches WHERE letter = 'C'").get().name, 'Клиника на Чиланзаре');
  assert.equal(db.prepare("SELECT name FROM branches WHERE letter = 'A'").get().name, 'Heal point');
  assert.equal(r.roster, 2);
  assert.equal(r.changed >= 2, true, 'переименование — это изменение: копия и применение обязаны сработать');
  db.close();
});

test('холостой прогон видит переименования, но ничего не пишет', () => {
  const db = fresh();
  becomeSecondary(db, { letter: 'C' });
  const r = applyCatalogue(db, { roster: [{ letter: 'C', name: 'Чиланзар' }] }, { dryRun: true });
  assert.equal(r.roster, 1);
  assert.equal(db.prepare("SELECT name FROM branches WHERE letter = 'C'").get().name, 'C', 'dryRun не пишет');
  db.close();
});

test('совпадающее имя — не изменение: повторная синхронизация не делает копий зря', () => {
  const db = fresh();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  const r = applyCatalogue(db, { roster: [{ letter: 'C', name: 'Чиланзар' }] });
  assert.equal(r.roster || 0, 0);
  db.close();
});

// ---------------------------------------------------------------------------
// STAFF_SYNC_V1 — сотрудники и роли (миграция 086).
//
// Владелец: «the filial users (employees are not rendered to other branches)».
// Правило то же, что у прайса: главная клиника управляет, филиал получает.
// Проверяется здесь то, что стоит дороже всего, если сломается:
//   * человек доезжает целиком — с ролью, отделением и паролем, и ВХОДИТ там;
//   * увольнение доезжает: отключён здесь, отключён и там;
//   * местного сотрудника филиала синхронизация не трогает ВООБЩЕ;
//   * филиал не отдаёт своих людей наверх — канал односторонний физически.
// ---------------------------------------------------------------------------

/** Главная клиника с двумя сотрудниками: врач в отделении и главный врач. */
function seedStaff(db) {
  const dep = db.prepare('SELECT id FROM departments ORDER BY id LIMIT 1').get();
  db.prepare(`INSERT INTO users (username, password_hash, full_name, last_name, first_name, role,
              extra_roles, is_doctor, staff_type, specialty, phone, department_id)
              VALUES ('ivanov', ?, 'Иванов Иван', 'Иванов', 'Иван', 'doctor',
              '["lab"]', 1, 'doctor', 'Кардиолог', '+998901112233', ?)`)
    .run(hashPassword('sekret12345'), dep.id);
  db.prepare(`INSERT INTO users (username, password_hash, full_name, role)
              VALUES ('glavvrach', ?, 'Каримова Дилноза', 'admin')`).run(hashPassword('adminpass1'));
  return db;
}

/** Филиал, у которого свои id отделений заведомо разошлись с главной клиникой. */
function staffReceiver() {
  const db = receiver();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  db.prepare("UPDATE sqlite_sequence SET seq = 700 WHERE name = 'departments'").run();
  return db;
}

test('сотрудники приезжают из главной клиники — с ролью, отделением и логином', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();

  const s = apply(branch, exportCatalogue(main));
  assert.equal(s.created.users, 2, 'обоих сотрудников филиал завёл у себя');

  const doc = branch.prepare("SELECT * FROM users WHERE username = 'ivanov'").get();
  assert.equal(doc.role, 'doctor');
  assert.equal(doc.extra_roles, '["lab"]', 'права авторизуются по объединению ролей — вторая половина обязана доехать');
  assert.equal(doc.is_doctor, 1);
  assert.equal(doc.specialty, 'Кардиолог');
  assert.equal(doc.full_name, 'Иванов Иван');
  assert.equal(doc.is_local, 0, 'этой строкой управляет главная клиника');

  // Отделение — по СВОЕЙ строке, а не по чужому id: у филиала счётчик отделений
  // сдвинут, и перенос «как есть» указал бы в никуда.
  const mainDepId = main.prepare("SELECT department_id FROM users WHERE username = 'ivanov'").get().department_id;
  const mainDep = main.prepare('SELECT name FROM departments WHERE id = ?').get(mainDepId);
  const dep = branch.prepare('SELECT name FROM departments WHERE id = ?').get(doc.department_id);
  assert.equal(dep.name, mainDep.name, 'сотрудник обязан оказаться в СВОЁМ отделении с тем же названием');

  main.close(); branch.close();
});

test('человек входит в системе второго здания своим обычным паролем', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  apply(branch, exportCatalogue(main));

  // Ради этого владелец и просил везти пароль: врач приехал принимать во второй
  // корпус и входит там, не заводя себе второй логин.
  const ok = login(branch, 'ivanov', 'sekret12345');
  assert.ok(ok.session, 'приехавший из главной клиники обязан войти в филиале');
  assert.equal(ok.user.username, 'ivanov');
  assert.equal(ok.user.role, 'doctor');
  // Сессия отдаёт ОБЕ роли: ACL авторизует по их объединению (services/roles.js
  // effectiveRoles), и «дополнительная» роль, не доехавшая до филиала, была бы
  // половиной прав, о потере которой никто не узнает до отказа на сохранении.
  assert.deepEqual(sessionUser(branch, ok.session).extra_roles, ['lab']);

  assert.equal(login(branch, 'ivanov', 'ne-tot-parol').error, 'invalid', 'чужой пароль по-прежнему не подходит');
  main.close(); branch.close();
});

test('смена фамилии и роли в главной клинике доезжает до филиала', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  apply(branch, exportCatalogue(main));

  main.prepare("UPDATE users SET full_name = 'Иванова Инна', last_name = 'Иванова', role = 'registrar', is_doctor = 0 WHERE username = 'ivanov'").run();
  const s = apply(branch, exportCatalogue(main));
  assert.equal(s.updated.users, 1);
  assert.equal(s.created.users ?? 0, 0, 'двойник не создан — строка узнана по логину');

  const row = branch.prepare("SELECT full_name, last_name, role, is_doctor FROM users WHERE username = 'ivanov'").get();
  assert.equal(row.full_name, 'Иванова Инна');
  assert.equal(row.role, 'registrar');
  assert.equal(row.is_doctor, 0);
  main.close(); branch.close();
});

test('отключённый в главной клинике отключается и в филиале', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  apply(branch, exportCatalogue(main));
  assert.ok(login(branch, 'ivanov', 'sekret12345').session);

  main.prepare("UPDATE users SET is_active = 0 WHERE username = 'ivanov'").run();
  apply(branch, exportCatalogue(main));

  assert.equal(branch.prepare("SELECT is_active FROM users WHERE username = 'ivanov'").get().is_active, 0);
  assert.equal(login(branch, 'ivanov', 'sekret12345').error, 'invalid',
    'человек, которому закрыли доступ, не должен входить во втором здании');
  main.close(); branch.close();
});

test('пропавший из выгрузки — ОТКЛЮЧАЕТСЯ, а не удаляется: за ним история этого здания', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  apply(branch, exportCatalogue(main));

  // Уволенного главная клиника удаляет из ростера совсем — пометки is_active = 0
  // в выгрузке не будет вообще.
  main.prepare("DELETE FROM users WHERE username = 'ivanov'").run();
  const s = apply(branch, exportCatalogue(main));
  assert.equal(s.deactivated.users, 1);

  const row = branch.prepare("SELECT id, is_active FROM users WHERE username = 'ivanov'").get();
  assert.ok(row, 'строка обязана остаться: на неё ссылаются визиты и счета филиала');
  assert.equal(row.is_active, 0);
  assert.equal(login(branch, 'ivanov', 'sekret12345').error, 'invalid');

  // И это не повторяется каждый час: отключённого второй раз не отключают.
  const again = apply(branch, exportCatalogue(main));
  assert.equal(again.changed, 0, 'повторный прогон обязан быть пустышкой');
  main.close(); branch.close();
});

test('сотрудник, нанятый в филиале, переживает приём, который его не упоминает', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  branch.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('registratura', ?, 'Своя регистратура', 'registrar')")
    .run(hashPassword('mestnyi12345'));

  apply(branch, exportCatalogue(main));

  const own = branch.prepare("SELECT is_active, is_local FROM users WHERE username = 'registratura'").get();
  assert.equal(own.is_active, 1, 'главная клиника его не знает — и не должна его отключать');
  assert.equal(own.is_local, 1, 'он остаётся своим: филиал вправе его править');
  assert.ok(login(branch, 'registratura', 'mestnyi12345').session);
  main.close(); branch.close();
});

test('одинаковый логин с обеих сторон УСЫНОВЛЯЕТСЯ — иначе UNIQUE свалил бы весь приём', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  // Так выглядит любая пара установок: у каждой свой заведённый администратор.
  branch.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('glavvrach', ?, 'Каримова Д.', 'admin')")
    .run(hashPassword('localadmin1'));

  const s = apply(branch, exportCatalogue(main));
  assert.equal(s.adopted.users, 1);
  assert.equal(branch.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'glavvrach'").get().n, 1,
    'двух учётных записей с одним логином не бывает — UNIQUE COLLATE NOCASE');
  assert.equal(branch.prepare("SELECT is_local FROM users WHERE username = 'glavvrach'").get().is_local, 0,
    'усыновлённая строка переходит под управление главной клиники СРАЗУ');
  // Главная клиника управляет и паролем — вход теперь по её паролю.
  assert.ok(login(branch, 'glavvrach', 'adminpass1').session);
  main.close(); branch.close();
});

test('ХОЛОСТОЙ ПРОГОН СЧИТАЕТ УСЫНОВЛЕНИЕ — иначе оно тихо не случилось бы вовсе', () => {
  // Ревью Фазы 3, I4. Переход строки под управление главной клиники
  // (users.is_local 1 -> 0) стоял под `!dryRun` и НИ РАЗУ не попадал в summary.
  // Два следствия, и второе хуже первого:
  //   * предсказание недосчитывало самое необратимое из того, что делает приём;
  //   * а когда переход был ЕДИНСТВЕННЫМ изменением (строки совпадают колонка в
  //     колонку — так выглядит повторное связывание после отвязки), холостой
  //     прогон возвращал changed = 0, и rpc/branch-sync.js выходил ДО применения.
  //     То есть человек оставался «своим» в филиале, продолжал править
  //     карточку — и правка исчезала при первом же настоящем изменении сверху.
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  apply(branch, exportCatalogue(main));

  // Отвязали и связали заново: карта соответствий стёрта (так и делает
  // «Отвязать»), строки стали снова местными. Ничего, кроме владения, не
  // изменилось — все колонки совпадают.
  branch.prepare("DELETE FROM branch_sync_map WHERE table_name = 'users'").run();
  branch.prepare('UPDATE users SET is_local = 1').run();

  const cat = exportCatalogue(main);
  const preview = applyCatalogue(branch, cat, { dryRun: true });
  assert.equal(preview.adopted.users, 2, 'холостой прогон видит усыновление обоих');
  assert.equal(preview.changed, 2, 'и считает его изменением: только на этом переход и случится');

  // И при этом НИЧЕГО не написал — вот вторая половина обещания dryRun.
  assert.equal(branch.prepare('SELECT COUNT(*) n FROM users WHERE is_local = 0').get().n, 0);
  assert.equal(branch.prepare("SELECT COUNT(*) n FROM branch_sync_map WHERE table_name = 'users'").get().n, 0);

  const real = apply(branch, cat);
  assert.equal(real.changed, preview.changed, 'предсказание и приём обязаны согласиться');
  assert.equal(branch.prepare('SELECT COUNT(*) n FROM users WHERE is_local = 0').get().n, 2,
    'строки действительно перешли под управление главной клиники');
  main.close(); branch.close();
});

test('устаревшая карта соответствий не должна ронять весь приём справочника', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  apply(branch, exportCatalogue(main));

  // Так выглядит филиал, перепривязанный к пересобранной главной клинике: в
  // карте остались чужие id, которых больше нет, а логины те же. Без повторного
  // захвата строки INSERT упал бы на UNIQUE — вместе с прайсом, навсегда.
  const localId = branch.prepare("SELECT id FROM users WHERE username = 'ivanov'").get().id;
  branch.prepare("UPDATE branch_sync_map SET remote_id = remote_id + 9000 WHERE table_name = 'users' AND local_id = ?").run(localId);

  const s = apply(branch, exportCatalogue(main));
  assert.equal(branch.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'ivanov'").get().n, 1);
  assert.equal(s.adopted.users, 1, 'строка захвачена заново, а не продублирована');
  main.close(); branch.close();
});

test('ФИЛИАЛ НЕ ОТДАЁТ СОТРУДНИКОВ НАВЕРХ: канал односторонний физически', () => {
  const branch = staffReceiver();
  branch.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('registratura', 'x', 'Своя регистратура', 'registrar')").run();

  const out = exportCatalogue(branch);
  assert.deepEqual(out.users, [], 'учётные записи с паролями не уезжают из филиала никуда');
  assert.deepEqual(out.role_permissions, [], 'права ролей настраивает главная клиника');
  // Прайс филиал по-прежнему отдаёт: запрет адресный, а не «выгрузка выключена».
  assert.ok(out.services.length > 0);

  // А главная клиника — отдаёт.
  const main = seedStaff(fresh());
  assert.equal(exportCatalogue(main).users.length, 2);
  main.close(); branch.close();
});

test('пустой список сотрудников НИКОГО не отключает', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  apply(branch, exportCatalogue(main));

  // Две ситуации, неотличимые для приёмника: главная клиника старой версии
  // (ключа нет вовсе) и установка-филиал (список пуст). Ни то ни другое не
  // значит «в клинике не осталось людей», а последствие было бы необратимым:
  // здание, где никто не может войти.
  const cat = exportCatalogue(main);
  const noKey = { ...cat }; delete noKey.users;
  assert.equal(apply(branch, noKey).deactivated, undefined);
  assert.equal(apply(branch, { ...cat, users: [] }).deactivated, undefined);
  assert.equal(branch.prepare('SELECT COUNT(*) AS n FROM users WHERE is_active = 1').get().n, 2);
  main.close(); branch.close();
});

test('права ролей приезжают из главной клиники и не удваиваются', () => {
  const main = seedMain(fresh());
  const branch = staffReceiver();
  main.prepare("UPDATE role_permissions SET permissions = '{\"sections\":[\"procedures\"]}' WHERE role = 'nurse'").run();

  const s = apply(branch, exportCatalogue(main));
  assert.equal(s.created.role_permissions ?? 0, 0, 'роли засеяны одинаково — их усыновляют, а не заводят заново');
  assert.equal(s.updated.role_permissions, 1);
  assert.equal(branch.prepare("SELECT permissions FROM role_permissions WHERE role = 'nurse'").get().permissions,
    '{"sections":["procedures"]}');
  assert.equal(branch.prepare("SELECT COUNT(*) AS n FROM role_permissions WHERE role = 'nurse'").get().n, 1);
  main.close(); branch.close();
});

test('холостой прогон видит ровно то же, что настоящий приём сотрудников', () => {
  const main = seedStaff(seedMain(fresh()));
  const branch = staffReceiver();
  const cat = exportCatalogue(main);
  const preview = applyCatalogue(branch, cat, { dryRun: true });
  assert.equal(branch.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'dryRun не пишет');
  const real = apply(branch, cat);
  assert.equal(preview.changed, real.changed, 'предсказание и приём обязаны согласиться');
  main.close(); branch.close();
});
