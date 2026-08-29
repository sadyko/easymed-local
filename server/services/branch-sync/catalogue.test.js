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
  const db = seedMain(fresh());
  const cat = exportCatalogue(db);

  assert.deepEqual(Object.keys(cat.doc_settings).sort(), [...DOC_SETTINGS_COLUMNS].sort());
  // Контакты филиала остаются его собственными — их в выгрузке нет вовсе.
  for (const forbidden of ['address', 'phone', 'email', 'id', 'updated_at']) {
    assert.equal(forbidden in cat.doc_settings, false, `doc_settings.${forbidden} не должен уезжать`);
  }
  for (const spec of TABLES) {
    assert.ok(Array.isArray(cat[spec.name]), spec.name + ' должен быть в выгрузке');
    for (const row of cat[spec.name]) {
      assert.deepEqual(Object.keys(row).sort(), ['id', ...spec.columns].sort(),
        spec.name + ': набор колонок задан в коде и не должен расходиться');
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
