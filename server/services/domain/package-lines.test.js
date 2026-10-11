// SERVICES_PACKAGES_V1 — цена пакета фиксируется на строке при записи: та же
// раскладка, что у окна пакета и сметы; строки одного пакета, заведённые по
// одной, дают ровно цену пакета; шаблон сметы — обычные строки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampPackageLines, packageCalcFor, clearStampOnUnpackage, stampWriteBody, STAMP_COLUMNS, stampUpdateRefusal, STAMP_ONLY_WITH_PACKAGE } from './package-lines.js';
import { packageCalc, packageTerms, packageItems } from '../../../public/js/shared/package-price.js';

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const s = db.prepare('INSERT INTO services (id, name, price, active) VALUES (?,?,?,?)');
  s.run(1, 'ОАК', 45000, 1); s.run(2, 'Глюкоза', 25000, 1); s.run(6, 'ОАМ', 35000, 1); s.run(8, 'ЭКГ', 60000, 1); s.run(7, 'УЗИ', 180000, 1);
  s.run(9, 'Снятая', 70000, 0);
  const t = db.prepare(`INSERT INTO service_templates (id, name, service_ids, is_package, discount_mode, discount_value, discount_percent)
                        VALUES (?,?,?,?,?,?,?)`);
  t.run(1, 'Check-up базовый', '[1,2,6,8,7]', 1, 'percent', 15, 15);
  t.run(2, 'Смета терапевта', '[1,2]', 0, 'percent', 0, 0);
  t.run(3, 'Со снятой услугой', '[1,9]', 1, 'price', 40000, 0);
  return db;
}

test('колонки цены пакета — две', () => assert.deepEqual(STAMP_COLUMNS, ['package_full', 'package_price']));

test('строка пакета получает цену без скидки и цену в пакете — как раскладка окна пакета; unit_price и total — от цены без скидки', () => {
  const db = clinic();
  const rows = [
    { visit_id: 1, service_id: 1, package_id: 1, quantity: 1, unit_price: 1, total: 1 },
    { visit_id: 1, service_id: 7, package_id: 1, quantity: 2, unit_price: 1, total: 1 },
  ];
  assert.equal(stampPackageLines(db, rows), 2);
  assert.deepEqual(rows.map((r) => [r.package_full, r.package_price, r.unit_price, r.total]),
    [[45000, 38200, 45000, 45000], [180000, 152900, 180000, 360000]]);
  const { pkg, calc } = packageCalcFor(db, 1);
  assert.equal(pkg.name, 'Check-up базовый');
  const services = db.prepare('SELECT id, price, active FROM services').all();
  assert.deepEqual(calc, packageCalc(packageTerms(pkg), packageItems(pkg, services).items), 'одна функция раскладки с экраном');
});

test('строки одного пакета по одной и вместе — те же цены; все пять — ровно цена пакета', () => {
  const db = clinic();
  const ids = [1, 2, 6, 8, 7];
  const together = ids.map((id) => ({ service_id: id, package_id: 1 }));
  stampPackageLines(db, together);
  const oneByOne = ids.map((id) => { const r = { service_id: id, package_id: 1 }; stampPackageLines(db, r); return r; });
  assert.deepEqual(oneByOne.map((r) => r.package_price), together.map((r) => r.package_price));
  assert.equal(together.reduce((s, r) => s + r.package_price, 0), 293000);
});

test('шаблон сметы, услуга не из пакета, консультация, строка без пакета — без цены пакета; присланное браузером стирается', () => {
  const db = clinic();
  const rows = [
    { service_id: 1, package_id: 2, package_full: 1, package_price: 1, unit_price: 45000 },
    { service_id: 9, package_id: 1 },
    { service_id: null, consultation_type_id: 3, package_id: 1 },
    { service_id: 1, package_full: 999, package_price: 0 },
    { service_id: 1, package_id: 404 },
  ];
  assert.equal(stampPackageLines(db, rows), 0);
  for (const r of rows) assert.deepEqual([r.package_full, r.package_price], [null, null], JSON.stringify(r));
  assert.equal(rows[0].unit_price, 45000, 'цену обычной строки не трогаем');
});

test('отключённая услуга в раскладку не входит: пакет «цена 40 000» — вся цена на действующую', () => {
  const db = clinic();
  const r = { service_id: 1, package_id: 3 };
  stampPackageLines(db, r);
  assert.deepEqual([r.package_full, r.package_price], [45000, 40000]);
});

// SERVICES_PACKAGES_V1 (ревью C4) — пакет «скидка суммой 100 000» на ЭКГ 60 000 + УЗИ 180 000; УЗИ сняли
// с учёта: скидка больше суммы цен — строка получает цену без скидки, а не 0 (счёт на 0 и доля врача 0).
test('ревью C4: скидка суммой стала больше суммы цен действующих услуг — строка по цене без скидки, а не бесплатно', () => {
  const db = clinic();
  db.prepare("INSERT INTO service_templates (id, name, service_ids, is_package, discount_mode, discount_value) VALUES (4, 'Сердце', '[8,7]', 1, 'amount', 100000)").run();
  const before = { service_id: 8, package_id: 4 };
  stampPackageLines(db, before);
  assert.ok(before.package_price < 60000, 'пока УЗИ в пакете — скидка есть: ' + before.package_price);
  db.prepare('UPDATE services SET active = 0 WHERE id = 7').run();
  const r = { service_id: 8, package_id: 4 };
  stampPackageLines(db, r);
  assert.deepEqual([r.package_full, r.package_price], [60000, 60000]);
});

// SERVICES_PACKAGES_V1 (ревью шага 6) — цену пакета правкой не трогают отдельно
// от пакета: снять её одну (строка осталась бы с пакетом, но без цены — касса
// выставила бы её по обычной цене) нельзя; снять вместе с пакетом — можно.
test('правка цены пакета без снятия пакета — отказ; вместе с пакетом или без цены пакета — можно', () => {
  assert.equal(stampUpdateRefusal({ package_price: null }), STAMP_ONLY_WITH_PACKAGE);
  assert.equal(stampUpdateRefusal({ package_full: null, package_price: null }), STAMP_ONLY_WITH_PACKAGE);
  assert.equal(stampUpdateRefusal({ package_id: 3, package_price: null }), STAMP_ONLY_WITH_PACKAGE);
  assert.equal(stampUpdateRefusal({ package_id: null, package_full: null, package_price: null }), null);
  assert.equal(stampUpdateRefusal({ package_id: null }), null);
  assert.equal(stampUpdateRefusal({ status: 'queued' }), null);
  assert.equal(stampUpdateRefusal(null), null);
});

test('правка, снимающая пакет, снимает и его цену; другая правка — нет', () => {
  const v = { package_id: null };
  assert.equal(clearStampOnUnpackage(v), true);
  assert.deepEqual(v, { package_id: null, package_full: null, package_price: null });
  assert.equal(clearStampOnUnpackage({ status: 'queued' }), false);
  assert.equal(clearStampOnUnpackage([{ package_id: null }]), false);
});

test('тело двери /api/db: вставка строк пакета получает цену; правка, снимающая пакет, — без цены; другие таблицы и строки без пакета — не тронуты', () => {
  const db = clinic();
  const ins = { table: 'visit_services', op: 'insert', values: [{ service_id: 1, package_id: 1 }, { service_id: 2 }] };
  assert.equal(stampWriteBody(db, ins), true);
  assert.deepEqual(ins.values.map((r) => [r.package_full, r.package_price]), [[45000, 38200], [null, null]]);
  const plain = { table: 'visit_services', op: 'insert', values: { service_id: 2, unit_price: 25000 } };
  assert.equal(stampWriteBody(db, plain), false, 'строк пакета нет — тело то же');
  assert.deepEqual(plain.values, { service_id: 2, unit_price: 25000 });
  const upd = { table: 'visit_services', op: 'update', values: { package_id: null }, filters: [{ col: 'id', op: 'eq', val: 5 }] };
  assert.equal(stampWriteBody(db, upd), true);
  assert.deepEqual(upd.values, { package_id: null, package_full: null, package_price: null });
  assert.equal(stampWriteBody(db, { table: 'visit_services', op: 'update', values: { status: 'queued' } }), false);
  assert.equal(stampWriteBody(db, { table: 'services', op: 'insert', values: { package_id: 1 } }), false);
  assert.equal(stampWriteBody(db, { table: 'whatever', op: 'insert', values: { service_id: 1, package_id: 1 } }, { table: 'visit_services', op: 'insert' }), true,
    'дверь передаёт разобранное compile()');
});

// Страж: строку с пакетом заводит только дверь /api/db (routes/db.js →
// stampWriteBody). Код сервера, вписавший package_id сам, завёл бы строку
// пакета без записанной цены — касса выставила бы её по обычной цене. А снятие
// пакета обязано снимать и его цену.
test('страж: сервер сам package_id не ставит; снимая пакет, снимает и цену', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'test-helpers') walk(p); }
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) files.push(p);
    }
  })(root);
  assert.ok(files.length > 100, 'обход сломан: ' + files.length);
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/INSERT INTO visit_services\s*\(([^)]*)\)/g)) if (/\bpackage_id\b/.test(m[1])) bad.push(path.relative(root, f) + ': INSERT с package_id');
    for (const m of src.matchAll(/UPDATE visit_services SET ([^']*?)WHERE/g)) {
      if (/package_id\s*=\s*NULL/.test(m[1]) && !(/package_full\s*=\s*NULL/.test(m[1]) && /package_price\s*=\s*NULL/.test(m[1]))) bad.push(path.relative(root, f) + ': пакет снят без цены');
    }
  }
  assert.deepEqual(bad, []);
});
