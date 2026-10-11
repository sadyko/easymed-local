// SERVICES_PACKAGES_V1 — пакет услуг: одна раскладка на окно пакета, запись
// строки, счёт, оплату врача и API. Примеры — данные одобренного макета
// (data.js S.packages, screen-docs.js «Check-up базовый» 345 000 → 293 000, анализ 45 000 → 38 200).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE_MODES, PACKAGE_PRICE_STEP, PACKAGE_LINE_STEP, PACKAGE_NAME_MAX, PACKAGE_MESSAGES,
  isPackageRow, packageIds, packageTerms, packageItems, packageCalc, packageValueFor, packageLineOf,
  packageLineMoney, packageDayState, packageProblem, packagePublicState, packageHiddenServices,
} from './package-price.js';
import { STRINGS } from '../admin/i18n-strings.js';

// Прайс макета (data.js S.services): id → цена.
const PRICE = { 1: 45000, 2: 25000, 3: 90000, 4: 120000, 5: 85000, 6: 35000, 7: 180000, 8: 60000 };
const items = (ids) => ids.map((id) => ({ service_id: id, price: PRICE[id] }));
const sum = (lines) => Math.round(lines.reduce((s, l) => s + l.price, 0) * 100) / 100;

test('постоянные — как в макете: три способа, цена пакета до 1 000, услуга до 100, название до 120', () => {
  assert.deepEqual(PACKAGE_MODES, ['percent', 'amount', 'price']);
  assert.equal(PACKAGE_PRICE_STEP, 1000);
  assert.equal(PACKAGE_LINE_STEP, 100);
  assert.equal(PACKAGE_NAME_MAX, 120);
});

test('макет «Check-up базовый»: 15 % от 345 000 → 293 000; раскладка 38 200 / 21 200 / 29 700 / 51 000 / 152 900', () => {
  const c = packageCalc({ mode: 'percent', value: 15 }, items([1, 2, 6, 8, 7]));
  assert.deepEqual([c.full, c.price, c.off, c.pct], [345000, 293000, 52000, 15.1]);
  assert.deepEqual(c.lines.map((l) => l.price), [38200, 21200, 29700, 51000, 152900]);
  assert.equal(sum(c.lines), c.price);
  assert.deepEqual(packageLineOf(c, 1), { service_id: 1, full: 45000, price: 38200 }, 'как в документации API: 45 000 → 38 200');
});

test('макет «Диабет-контроль»: сумма скидки 50 000 → 270 000; «Осмотр к школе»: цена 120 000 — как вписана', () => {
  const a = packageCalc({ mode: 'amount', value: 50000 }, items([2, 3, 4, 5]));
  assert.deepEqual([a.full, a.price, a.off, a.pct], [320000, 270000, 50000, 15.6]);
  assert.deepEqual(a.lines.map((l) => l.price), [21100, 75900, 101300, 71700]);
  const p = packageCalc({ mode: 'price', value: 120000 }, items([1, 6, 8]));
  assert.deepEqual([p.full, p.price, p.off, p.pct], [140000, 120000, 20000, 14.3]);
  assert.deepEqual(p.lines.map((l) => l.price), [38600, 30000, 51400]);
  assert.equal(packageCalc({ mode: 'price', value: 119500 }, items([1, 6, 8])).price, 119500, 'вписанную цену не округляем');
  assert.equal(packageCalc({ mode: 'percent', value: 10 }, [{ service_id: 1, price: 45500 }]).price, 41000, 'посчитанную — до 1 000');
});

test('цена пакета — от 0 до суммы цен: скидка не бывает отрицательной; 0 % — без скидки и без округления', () => {
  assert.equal(packageCalc({ mode: 'price', value: 999999 }, items([1, 2])).price, 70000);
  // SERVICES_PACKAGES_V1 (ревью C4) — сумма скидки больше суммы цен (прайс подешевел, услугу сняли с учёта):
  // пакет без скидки, как у «цены пакета» выше, а не бесплатный. Ровно сумма цен — бесплатный пакет:
  // так его задали (packageProblem это принимает).
  assert.equal(packageCalc({ mode: 'amount', value: 999999 }, items([1, 2])).price, 70000);
  assert.equal(packageCalc({ mode: 'amount', value: 70000 }, items([1, 2])).price, 0);
  assert.equal(packageCalc({ mode: 'percent', value: 150 }, items([1, 2])).price, 0);
  const zero = packageCalc({ mode: 'percent', value: 0 }, [{ service_id: 9, price: 45400 }]);
  assert.deepEqual([zero.price, zero.off, zero.lines[0].price], [45400, 0, 45400], '45 400 не становится 45 000');
  const free = packageCalc({ mode: 'price', value: 0 }, items([1, 2]));
  assert.deepEqual(free.lines.map((l) => l.price), [0, 0]);
  assert.equal(packageCalc({ mode: 'percent', value: 50 }, [{ service_id: 1, price: 800 }]).price, 400, 'дешёвый пакет не становится бесплатным от округления');
  assert.deepEqual(packageCalc({ mode: 'percent', value: 20 }, []).lines, []);
});

test('остаток — на последнюю услугу, не ниже нуля и не выше её цены; у каждой платной — хоть 1 сум скидки', () => {
  // 1 % от 502 000: последняя (2 000) по округлению получила бы 0 скидки или больше своей цены.
  const c = packageCalc({ mode: 'percent', value: 1 }, [{ service_id: 1, price: 500000 }, { service_id: 2, price: 2000 }]);
  assert.equal(sum(c.lines), c.price);
  for (const l of c.lines) assert.ok(l.price >= 0 && l.price < l.full, JSON.stringify(c.lines));
  // Округление вверх у первых строк съело больше цены пакета: последняя — 0, не минус.
  const d = packageCalc({ mode: 'price', value: 100 }, [{ service_id: 1, price: 150 }, { service_id: 2, price: 150 }, { service_id: 3, price: 10 }]);
  assert.equal(sum(d.lines), 100);
  for (const l of d.lines) assert.ok(l.price >= 0 && l.price <= l.full, JSON.stringify(d.lines));
  // Бесплатная услуга в пакете остаётся 0.
  const f = packageCalc({ mode: 'percent', value: 20 }, [{ service_id: 1, price: 100000 }, { service_id: 2, price: 0 }]);
  assert.deepEqual(f.lines.map((l) => l.price), [80000, 0]);
});

test('свойство: на 3 000 случайных пакетах строки дают ровно цену пакета, каждая в [0, своя цена], скидка у каждой платной', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(rnd() * 9);
    const its = Array.from({ length: n }, (_, j) => ({ service_id: j + 1, price: rnd() < 0.1 ? 0 : Math.round(rnd() * 2000) * 500 }));
    const mode = PACKAGE_MODES[Math.floor(rnd() * 3)];
    const full = its.reduce((s, x) => s + x.price, 0);
    const value = mode === 'percent' ? Math.round(rnd() * 1000) / 10 : Math.round(rnd() * full);
    const c = packageCalc({ mode, value }, its);
    assert.equal(sum(c.lines), c.price, JSON.stringify({ mode, value, its }));
    assert.ok(c.price >= 0 && c.price <= c.full);
    const paid = c.lines.filter((l) => l.full > 0).length;
    for (const l of c.lines) {
      assert.ok(l.price >= 0 && l.price <= l.full, JSON.stringify({ mode, value, its, l }));
      if (c.off >= paid && l.full > 0) assert.ok(l.price < l.full, 'строка без скидки в пакете со скидкой: ' + JSON.stringify({ mode, value, its }));
    }
    assert.deepEqual(packageCalc({ mode, value }, its), c, 'одни данные — одна раскладка');
  }
});

test('переключение способа скидки сохраняет цену пакета (макет)', () => {
  const its = items([1, 2, 6, 8, 7]);
  const c = packageCalc({ mode: 'percent', value: 15 }, its);
  for (const mode of PACKAGE_MODES) {
    assert.equal(packageCalc({ mode, value: packageValueFor(c, mode) }, its).price, c.price, mode);
  }
  assert.deepEqual([packageValueFor(c, 'percent'), packageValueFor(c, 'amount'), packageValueFor(c, 'price')], [15.1, 52000, 293000]);
});

test('условия пакета: строка базы — mode и value; строка до мигр. 244 — процент из discount_percent', () => {
  assert.deepEqual(packageTerms({ discount_mode: 'amount', discount_value: 50000 }), { mode: 'amount', value: 50000 });
  assert.deepEqual(packageTerms({ discount_mode: 'percent', discount_value: 140 }), { mode: 'percent', value: 100 });
  assert.deepEqual(packageTerms({ discount_mode: 'bad', discount_value: -3 }), { mode: 'percent', value: 0 });
  assert.deepEqual(packageTerms({ discount_percent: 20 }), { mode: 'percent', value: 20 });
  assert.deepEqual(packageTerms(null), { mode: 'percent', value: 0 });
  const row = { service_ids: '[1,2]', discount_mode: 'price', discount_value: 60000 };
  assert.equal(packageCalc(row, items([1, 2])).price, 60000, 'строку пакета можно отдать целиком');
});

test('услуги пакета: по его порядку, без повторов; отключённых и удалённых нет — они в missing', () => {
  assert.deepEqual(packageIds({ service_ids: '[3, 1, 3, "x", 0]' }), [3, 1]);
  assert.deepEqual(packageIds({ service_ids: [2, '5'] }), [2, 5]);
  assert.deepEqual(packageIds({ service_ids: 'мусор' }), []);
  const svc = [{ id: 1, price: 45000, active: 1 }, { id: 2, price: 25000, active: 0 }, { id: 3, price: 90000 }, { id: 4, price: 10, __base_price: 120000, active: true }];
  const { items: its, missing } = packageItems({ service_ids: [3, 2, 1, 9, 4] }, svc);
  assert.deepEqual(its.map((x) => [x.service_id, x.price]), [[3, 90000], [1, 45000], [4, 120000]]);
  assert.equal(missing, 2);
});

test('пакет — только с отметкой is_package; шаблон сметы — нет', () => {
  assert.equal(isPackageRow({ is_package: 1 }), true);
  assert.equal(isPackageRow({ is_package: true }), true);
  assert.equal(isPackageRow({ is_package: 0, discount_percent: 20 }), false, 'скидка без отметки — не пакет');
  assert.equal(isPackageRow(null), false);
});

test('деньги строки визита — по ценам, записанным при записи: без скидки, скидка, к оплате', () => {
  assert.deepEqual(packageLineMoney({ package_full: 45000, package_price: 38200, quantity: 1 }), { gross: 45000, discount: 6800, net: 38200 });
  assert.deepEqual(packageLineMoney({ package_full: 45000, package_price: 38200, quantity: 2 }), { gross: 90000, discount: 13600, net: 76400 });
  assert.deepEqual(packageLineMoney({ package_full: 45000, package_price: 45000 }), { gross: 45000, discount: 0, net: 45000 });
  assert.deepEqual(packageLineMoney({ package_full: 45000, package_price: 50000, qty: 1 }), { gross: 45000, discount: 0, net: 45000 }, 'цена в пакете не выше цены услуги');
  assert.equal(packageLineMoney({ package_full: 45000, package_price: null }), null);
  assert.equal(packageLineMoney({ package_id: 3 }), null, 'строка без записанной цены — не из пакета');
});

test('срок пакета: границы включительно, пустая — без ограничения', () => {
  const t = { valid_from: '2026-09-01', valid_until: '2026-09-30' };
  assert.equal(packageDayState(t, '2026-08-31'), 'upcoming');
  assert.equal(packageDayState(t, '2026-09-01'), 'active');
  assert.equal(packageDayState(t, '2026-09-30'), 'active');
  assert.equal(packageDayState(t, '2026-10-01'), 'expired');
  assert.equal(packageDayState({}, '2030-01-01'), 'active');
});

test('проверка пакета перед записью: название, услуги, способ и величина скидки, даты, показ без узбекского названия', () => {
  const ok = { name: 'Check-up', service_ids: [1, 2], discount_mode: 'percent', discount_value: 15, is_package: 1 };
  assert.equal(packageProblem(ok, { insert: true, full: 70000 }), null);
  assert.deepEqual(packageProblem({ ...ok, name: ' ' }, { insert: true }), { field: 'name', message: PACKAGE_MESSAGES.nameRu });
  assert.deepEqual(packageProblem({ ...ok, name_uz: 'x'.repeat(121) }), { field: 'name_uz', message: PACKAGE_MESSAGES.nameLong });
  assert.deepEqual(packageProblem({ ...ok, service_ids: [] }), { field: 'service_ids', message: PACKAGE_MESSAGES.services });
  assert.deepEqual(packageProblem({ ...ok, service_ids: [1, 1] }), { field: 'service_ids', message: PACKAGE_MESSAGES.serviceId });
  assert.deepEqual(packageProblem({ ...ok, discount_mode: 'gift' }), { field: 'discount_mode', message: PACKAGE_MESSAGES.mode });
  assert.deepEqual(packageProblem({ ...ok, discount_value: -1 }), { field: 'discount_value', message: PACKAGE_MESSAGES.value });
  assert.deepEqual(packageProblem({ ...ok, discount_value: 101 }), { field: 'discount_value', message: PACKAGE_MESSAGES.percent });
  assert.deepEqual(packageProblem({ ...ok, discount_mode: 'amount', discount_value: 80000 }, { full: 70000 }), { field: 'discount_value', message: PACKAGE_MESSAGES.amount });
  assert.deepEqual(packageProblem({ ...ok, discount_mode: 'price', discount_value: 80000 }, { full: 70000 }), { field: 'discount_value', message: PACKAGE_MESSAGES.price });
  assert.equal(packageProblem({ ...ok, discount_mode: 'price', discount_value: 80000 }), null, 'сумма цен неизвестна — не сверяем');
  assert.deepEqual(packageProblem({ valid_from: '2026-09-30', valid_until: '2026-09-01' }), { field: 'valid_until', message: PACKAGE_MESSAGES.dates });
  assert.deepEqual(packageProblem({ valid_until: '30.09.2026' }), { field: 'valid_until', message: PACKAGE_MESSAGES.dateForm });
  assert.deepEqual(packageProblem({ ...ok, show_public: 1, name_uz: '' }), { field: 'name_uz', message: PACKAGE_MESSAGES.publishUz });
  assert.deepEqual(packageProblem({ show_public: 1 }, { merged: { name: 'X', show_public: 1, name_uz: null } }), { field: 'name_uz', message: PACKAGE_MESSAGES.publishUz });
  assert.equal(packageProblem({ name: 'Новое имя' }, { merged: { name: 'Новое имя', show_public: 1, name_uz: '' } }), null, 'переименование не упирается в старый показ');
  assert.deepEqual(packageProblem({ show_public: 2 }), { field: 'show_public', message: PACKAGE_MESSAGES.flag });
  assert.equal(packageProblem({ active: 0 }), null, 'снять с учёта — без проверок');
});

test('показ пакета: только пакет, действующий, включённый, в сроке, с названиями RU и UZ и только из показанных услуг (В10)', () => {
  const svc = [
    { id: 1, name: 'ОАК', name_uz: 'UQT', online_booking: 1, active: 1 },
    { id: 2, name: 'Перевязка', name_uz: 'Bog‘lash', online_booking: 0, active: 1 },
    { id: 3, name: 'Иссечение', name_uz: '', online_booking: 1, active: 1 },
    { id: 4, name: 'Старая', name_uz: 'Eski', online_booking: 0, active: 0 },
  ];
  const pkg = { is_package: 1, active: 1, show_public: 1, name: 'Check-up', name_uz: 'Check-up', service_ids: [1, 4] };
  const day = '2026-10-10';
  assert.equal(packagePublicState(pkg, svc, day), 'shown', 'отключённая услуга не мешает');
  assert.equal(packagePublicState({ ...pkg, is_package: 0 }, svc, day), 'not_package');
  assert.equal(packagePublicState({ ...pkg, active: 0 }, svc, day), 'retired');
  assert.equal(packagePublicState({ ...pkg, show_public: 0 }, svc, day), 'off');
  assert.equal(packagePublicState({ ...pkg, valid_until: '2026-10-09' }, svc, day), 'expired', 'после «по» пропадает сам');
  assert.equal(packagePublicState({ ...pkg, valid_from: '2026-10-11' }, svc, day), 'upcoming');
  assert.equal(packagePublicState({ ...pkg, name_uz: ' ' }, svc, day), 'no_uz');
  assert.equal(packagePublicState({ ...pkg, service_ids: [4] }, svc, day), 'empty');
  assert.equal(packagePublicState({ ...pkg, service_ids: [1, 2] }, svc, day), 'service_hidden', 'скрытая услуга прячет пакет');
  assert.equal(packagePublicState({ ...pkg, service_ids: [1, 3] }, svc, day), 'service_hidden', 'услуга без узбекского названия — тоже');
  assert.deepEqual(packageHiddenServices({ ...pkg, service_ids: [1, 2, 3, 4] }, svc).map((s) => s.id), [2, 3]);
});

// SERVICES_PACKAGES_V1 (ревью C4) — пакет «скидка суммой» после того, как прайс подешевел или услугу
// сняли с учёта: скидка больше суммы цен действующих услуг. Раскладка — без скидки (не бесплатно), а
// сайт и партнёры пакет не получают, пока клиника не поправит условия.
test('ревью C4: скидка суммой больше суммы цен действующих услуг — «terms_invalid», раскладка без скидки', () => {
  const svc = [
    { id: 1, name: 'ЭКГ', name_uz: 'EKG', online_booking: 1, active: 1, price: 60000 },
    { id: 2, name: 'УЗИ', name_uz: 'UTT', online_booking: 1, active: 1, price: 180000 },
  ];
  const pkg = { is_package: 1, active: 1, show_public: 1, name: 'Сердце', name_uz: 'Yurak', service_ids: [1, 2], discount_mode: 'amount', discount_value: 100000 };
  const day = '2026-10-10';
  assert.equal(packagePublicState(pkg, svc, day), 'shown');
  const retired = [svc[0], { ...svc[1], active: 0 }];
  assert.equal(packagePublicState(pkg, retired, day), 'terms_invalid', 'УЗИ сняли — 100 000 скидки на 60 000');
  assert.equal(packageCalc(pkg, packageItems(pkg, retired).items).price, 60000, 'без скидки, а не 0');
  const cheaper = [svc[0], { ...svc[1], price: 30000 }];
  assert.equal(packagePublicState(pkg, cheaper, day), 'terms_invalid', 'УЗИ подешевело до 30 000');
  assert.equal(packagePublicState({ ...pkg, discount_value: 90000 }, cheaper, day), 'shown', 'ровно сумма цен — бесплатный пакет, так его задали');
  assert.equal(packagePublicState({ ...pkg, discount_mode: 'percent', discount_value: 100 }, cheaper, day), 'shown');
  assert.equal(packagePublicState({ ...pkg, show_public: 0 }, retired, day), 'off', 'выключенный — по-прежнему «off»');
  const e = STRINGS['скидка больше суммы цен услуг'];
  assert.ok(e && e.ru && e.uz && e.en, 'подпись состояния для списка «Пакеты услуг» — в словаре');
});

test('каждое сообщение переведено на ru / uz / en', () => {
  for (const m of Object.values(PACKAGE_MESSAGES)) { const e = STRINGS[m]; assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m); }
});
