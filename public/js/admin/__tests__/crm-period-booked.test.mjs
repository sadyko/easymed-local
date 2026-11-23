// CRM_PERIOD_BOOKED_V1 (3.25.0) — «ЗАПИСЬ» НЕ ПРЯЧЕТСЯ ЗА «ПЕРИОДОМ».
//
// Доска CRM открывается на «Сегодня» (CRM_PERIOD_DEFAULT_TODAY_V1 — решение
// партнёра), а «Период» сужает каждую колонку по дню ПОСТУПЛЕНИЯ заявки. Фильтр
// «Запись» (день, на который записаны услуги) работал только ВНУТРИ периода: во
// вторник регистратор выбирал «Запись: Завтра», и заявка, поступившая в
// понедельник и записанная на среду, не находилась, а вариант читался «Завтра · 0».
// Теперь выбранная «Запись» показывает ВСЕ заявки, записанные на эти дни, когда бы
// они ни поступили; числа у вариантов — те же карточки; без «Записи» доска — как
// прежде, за «Сегодня».
//
// Этот тест НЕ подменяет период на «Всё время» (остальные тесты доски подменяют:
// crm-harness.mjs) — доска открывается так же, как у клиники. Данные выдуманные;
// дни — от «сейчас» (время суток прогона роли не играет).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, mk, walk, textOf, byAttr, byClass, tick, crmView, useDefaultPeriod } from './crm-harness.mjs';

useDefaultPeriod();   // до импорта вида — период по умолчанию настоящий
const { renderCrm, crmExportRows, CRM_FILTER_ALL } = await import('../views/crm.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const DAY = 86400000;
const isoAgo = (d) => new Date(Date.now() - d * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
const p2 = (n) => String(n).padStart(2, '0');
const dayOf = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const lead = (id, name, status, created, extra = {}) => ({ id, full_name: name, phone: '+99890' + String(2000000 + id), status, source: 'call',
  created_at: created, assigned_to: 7, ...extra });

// Поступила два дня назад, записана на завтра (день заявки).
const OLD_TOMORROW = lead(1, 'Давняя Завтра', 'scheduled', isoAgo(2), { scheduled_date: dayOf(1) });
// Поступила сегодня, записана на завтра.
const NEW_TOMORROW = lead(2, 'Новая Завтра', 'scheduled', isoAgo(0), { scheduled_date: dayOf(1) });
// Поступила пять дней назад; на завтра записана её СТРОКА услуги (у самой заявки дня нет).
const OLD_LINE = lead(3, 'Давняя Строка', 'in_process', isoAgo(5));
// Поступила сегодня, не записана.
const NEW_FREE = lead(4, 'Новая Без записи', 'in_process', isoAgo(0));
// Поступила три дня назад, записана на послезавтра + 1.
const OLD_LATER = lead(5, 'Давняя Позже', 'scheduled', isoAgo(3), { scheduled_date: dayOf(3) });
// Поступила четыре дня назад, не записана — при «Сегодня» её нет нигде, кроме строки над доской.
const OLD_FREE = lead(6, 'Давняя Без записи', 'in_process', isoAgo(4));

async function board() {
  window.easymed.state.user = ADMIN;
  S.config = null; S.search = []; S.tasks = []; S.leadTags = []; S.dups = [];
  S.leads = [OLD_TOMORROW, NEW_TOMORROW, OLD_LINE, NEW_FREE, OLD_LATER, OLD_FREE];
  S.reqLines = [
    { id: 31, request_id: 3, scheduled_date: dayOf(1), status: 'pending' },
    { id: 32, request_id: 6, scheduled_date: dayOf(1), status: 'cancelled' },   // отменённая строка — не запись
  ];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick(80);
  return root;
}
const sel = (root, attr) => byAttr(root, attr)[0];
const pick = async (root, attr, v) => { const s = sel(root, attr); s.value = v; s.dispatchEvent({ type: 'change', target: s, currentTarget: s }); await tick(80); };
const optionText = (root, attr, value) => textOf(walk(sel(root, attr)).find((n) => n.tagName === 'OPTION' && n.attrs.value === value) || mk('x'));
const ALL_NAMES = [OLD_TOMORROW, NEW_TOMORROW, OLD_LINE, NEW_FREE, OLD_LATER, OLD_FREE].map((r) => r.full_name);
const shown = (root) => {
  const cards = byClass(root, 'crm-card').map((c) => textOf(c));
  return ALL_NAMES.filter((n) => cards.some((t) => t.includes(n))).sort();
};
const names = (rows) => rows.map((r) => r.full_name).sort();

test('CRM_PERIOD_BOOKED_V1: доска по умолчанию — «Сегодня»; «Запись: Завтра» показывает все записанные на завтра, когда бы они ни поступили, и число варианта — то же', async () => {
  const root = await board();
  try {
    // Период по умолчанию — «Сегодня», доска — только сегодняшние.
    assert.equal(sel(root, 'data-period-select').value, 'today', 'доска открылась не на «Сегодня»');
    assert.deepEqual(shown(root), ['Новая Без записи', 'Новая Завтра'], 'без «Записи» доска — не за «Сегодня»');

    // Числа вариантов «Записи» — по всем записанным, а не по поступившим сегодня.
    assert.match(optionText(root, 'data-booked-select', 'tomorrow'), /Завтра · 3$/, 'у «Завтра» не то число');
    assert.match(optionText(root, 'data-booked-select', 'today'), /Сегодня · 0$/);
    assert.match(optionText(root, 'data-booked-select', 'week'), /Ближайшие 7 дней · 4$/, 'у «Ближайших 7 дней» не то число');

    await pick(root, 'data-booked-select', 'tomorrow');
    assert.deepEqual(shown(root), ['Давняя Завтра', 'Давняя Строка', 'Новая Завтра'], '«Запись: Завтра» спрятала заявки, поступившие до сегодня');
    // Период остался «Сегодня» — выбор «Записи» его не сбрасывает.
    assert.equal(sel(root, 'data-period-select').value, 'today');
    // Числа остальных фильтров — по показанным карточкам.
    assert.match(optionText(root, 'data-src-select', CRM_FILTER_ALL), /Все · 3$/, '«Источник: Все» не сходится с доской');
    assert.match(optionText(root, 'data-op-select', 'all'), /Все · 3$/, '«Оператор: Все» не сходится с доской');
    // Над доской сказано, что «Запись» — по всем датам поступления (а не «показаны поступившие сегодня»).
    assert.equal(byAttr(root, 'data-crm-period-line').length, 0, 'строка «показаны заявки, поступившие сегодня» при «Записи»');
    const note = sel(root, 'data-crm-booked-all');
    assert.ok(note && textOf(note).includes('Запись — по всем датам поступления'), 'не сказано, что «Запись» — по всем датам поступления');

    // «Список» и Excel — те же карточки.
    crmView(root, 'list'); await tick(80);
    const list = textOf(root);
    for (const n of ['Давняя Завтра', 'Давняя Строка', 'Новая Завтра']) assert.ok(list.includes(n), '«Список» без ' + n);
    assert.ok(!list.includes('Новая Без записи'));
    crmView(root, 'kanban'); await tick(80);
    const exp = await crmExportRows();
    assert.deepEqual(names(exp.rows), ['Давняя Завтра', 'Давняя Строка', 'Новая Завтра'], 'выгрузка при «Записи» — только за период');

    // «Ближайшие 7 дней» — плюс записанная на +3 дня.
    await pick(root, 'data-booked-select', 'week');
    assert.deepEqual(shown(root), ['Давняя Завтра', 'Давняя Позже', 'Давняя Строка', 'Новая Завтра']);

    // «Запись: Все» — доска снова за «Сегодня». CRM_NO_PERIOD_LINE_V1 (ветка local/ai-on-main,
    // владелец 2026-11-21) — строки о давних открытых над доской больше нет, и подсказка «Записи» ушла.
    await pick(root, 'data-booked-select', CRM_FILTER_ALL);
    assert.deepEqual(shown(root), ['Новая Без записи', 'Новая Завтра'], 'после снятия «Записи» доска не вернулась к «Сегодня»');
    assert.equal(byAttr(root, 'data-crm-period-line').length, 0, 'строка о давних открытых вернулась');
    assert.equal(byAttr(root, 'data-crm-booked-all').length, 0);
  } finally {
    await pick(root, 'data-booked-select', CRM_FILTER_ALL);
    S.reqLines = []; window.easymed.state.user = null;
  }
});
