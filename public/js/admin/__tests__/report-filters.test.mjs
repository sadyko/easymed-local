// REPORTS_TAX_PAY_V1 — фильтры окна отчёта: какие выбраны (строка над таблицей)
// и как называется файл Excel (в имени — выбранные фильтры).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  F_PAY, F_PAY_INFLOW, F_CASHIER, F_DOCTOR, F_GROUP, F_PATIENT_GROUP, PAY_FILTER_CHOICES,
  activeFilters, filterFileSuffix, isStaticOption,
} from '../views/report-filters.js';

const tx = { tr: (s) => s };
const rep = {
  kind: 'total_revenue',
  options: [F_PAY, F_CASHIER, F_DOCTOR, F_GROUP, F_PATIENT_GROUP,
    { arg: 'paid', label: 'Счета', choices: [['all', 'Все счета'], ['paid', 'Только оплаченные']] }],
};

test('способы оплаты фильтра — словарь кассы плюс «Не оплачено», первым — «все»', () => {
  assert.deepEqual(PAY_FILTER_CHOICES.map((c) => c[0]), ['', 'cash', 'card', 'transfer', 'acquiring', 'wallet', 'gift_card', 'unpaid']);
  assert.equal(PAY_FILTER_CHOICES[2][1], 'Карта');
  assert.equal(isStaticOption(F_PAY), true);
  assert.equal(isStaticOption(F_GROUP), true);
  assert.equal(isStaticOption(F_DOCTOR), false);
  assert.equal(isStaticOption(F_CASHIER), false);
  assert.equal(isStaticOption(F_PATIENT_GROUP), false);
});

test('выбранные фильтры — подписью и значением словами; «все» не считается', () => {
  const opts = { pay_method: 'card', cashier_id: '', doctor_id: '7', group: '', patient_group: '3', paid: 'all' };
  const loaded = { doctor_id: [['7', 'Иванов И.']], patient_group: [['3', 'VIP']] };
  assert.deepEqual(activeFilters(rep, 'total_revenue', opts, loaded, tx),
    [{ label: 'Способ оплаты', value: 'Карта' }, { label: 'Врач', value: 'Иванов И.' }, { label: 'Группа пациентов', value: 'VIP' }]);
  // Кнопка-переключатель: не первый вариант — выбран.
  assert.deepEqual(activeFilters(rep, 'total_revenue', { paid: 'paid' }, {}, tx), [{ label: 'Счета', value: 'Только оплаченные' }]);
  // Значение, которого ещё нет в загруженном списке, — показывается как есть.
  assert.deepEqual(activeFilters(rep, 'total_revenue', { doctor_id: '9' }, {}, tx), [{ label: 'Врач', value: '9' }]);
  assert.deepEqual(activeFilters(rep, 'total_revenue', {}, {}, tx), []);
});

test('имя файла говорит, какие фильтры применены; запретные для имени файла знаки убраны', () => {
  assert.equal(filterFileSuffix([], tx), '');
  assert.equal(filterFileSuffix([{ label: 'Способ оплаты', value: 'Карта' }], tx), '_Способ оплаты Карта');
  assert.equal(filterFileSuffix([{ label: 'Врач', value: 'Иванов И. / "Терапия"' }, { label: 'Кассир', value: 'A:B*C?' }], tx),
    '_Врач Иванов И. Терапия_Кассир A B C');
  // Длинное имя обрезается — файл с именем в 300 знаков Windows не сохранит.
  const long = filterFileSuffix([{ label: 'Врач', value: 'Я'.repeat(400) }], tx);
  assert.ok(long.length <= 120, String(long.length));
  // Перевод — языком экрана.
  assert.equal(filterFileSuffix([{ label: 'Способ оплаты', value: 'Карта' }], { tr: (s) => ({ 'Способ оплаты': 'Payment method', 'Карта': 'Card' }[s] || s) }),
    '_Payment method Card');
});

// REPORTS_TAX_PAY_V1 (ревью S2 L2) — «Отчёт кассира» считает только приход денег: «Кошелёк» и
// «Подарочная карта» в его фильтре не предлагаются (всегда давали пустой отчёт); у выручки — есть.
test('ревью S2 L2: фильтр «Отчёта кассира» — без «Кошелька» и «Подарочной карты»', () => {
  assert.deepEqual(F_PAY_INFLOW.choices.map((c) => c[0]), ['', 'cash', 'card', 'transfer', 'acquiring', 'unpaid']);
  assert.equal(F_PAY_INFLOW.arg, 'pay_method');
  assert.equal(isStaticOption(F_PAY_INFLOW), true);
  assert.ok(F_PAY.choices.some((c) => c[0] === 'wallet'), 'у выручки «Кошелёк» пропал');
});
