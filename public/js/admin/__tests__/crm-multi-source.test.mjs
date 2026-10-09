// CRM_MULTI_SOURCE_V1 (2026-09-29) — несколько источников на доске и в окне заявки.
//
// Владелец: «can we setup multiple source selection in the crm» → «Both».
//   • фильтр «Источник» над доской отмечается по несколько; «Все» снимает;
//     заявка видна, если хотя бы один её источник отмечен;
//   • число на чипе — сколько заявок имеют этот источник (заявка с двумя — в
//     обоих), «Все · N» — число заявок;
//   • карточка доски — тег на каждый источник; список и Excel — через запятую;
//   • окно заявки — чипы выбираются по несколько в порядке нажатий, первый —
//     главный, последний не снимается; уходит массив sources и source = первый;
//   • «Отчёт»: заявка — в каждом своём источнике, «Всего» — по заявкам.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, TOASTS, mk, walk, textOf, byAttr, byClass, tick, button } from './crm-harness.mjs';

const { renderCrm, crmExcelRows } = await import('../views/crm.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const SOURCES = [
  { key: 'call', label: 'Звонок', position: 1, is_active: 1 },
  { key: 'instagram', label: 'Instagram', position: 2, is_active: 1 },
  { key: 'telegram', label: 'Telegram', position: 3, is_active: 0 },   // скрыт в настройках
  { key: 'referral', label: 'Рекомендация', position: 4, is_active: 1 },
  { key: 'other', label: 'Другое', position: 5, is_active: 1 },
];
const now = new Date().toISOString();
const LEADS = [
  { id: 1, full_name: 'Каримова Азиза', phone: '+998942846494', status: 'in_process', source: 'instagram', sources: ['instagram', 'referral'], created_at: now },
  // Заявка соседа (звонок, зеркало) — только source.
  { id: 2, full_name: 'Юсупов Бахтиёр', phone: '+998901112233', status: 'in_process', source: 'instagram', sources: null, created_at: now },
  // Строка из RPC поиска несёт sources строкой — правило чтения понимает и её.
  { id: 3, full_name: 'Бахтиёрова Лола', phone: '+998903334455', status: 'came', source: 'call', sources: '["call"]', created_at: now },
  // Скрытый источник, стоящий у заявки.
  { id: 4, full_name: 'Азимов Жасур', phone: '+998904445566', status: 'in_process', source: 'telegram', sources: ['telegram', 'call'], created_at: now },
];

async function board(view = 'kanban', leads = LEADS) {
  window.easymed.state.user = ADMIN;
  S.config = { tags: [], sources: SOURCES };
  S.leads = leads.map((l) => ({ ...l }));
  S.leadTags = [];
  S.dups = [];
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  // Фильтр — состояние модуля: возвращаем «Все», чтобы тесты не зависели от порядка.
  const all = allChip(root);
  if (all) { all.click(); await tick(); }
  button(root, view === 'list' ? /Список/ : /Канбан/).click();
  await tick();
  return root;
}
const srcChips = (root) => byAttr(root, 'data-src-chip');
const chipOf = (root, key) => srcChips(root).find((n) => n.getAttribute('data-src-chip') === key);
function allChip(root) {
  const row = byAttr(root, 'data-crm-src-filter')[0];
  return row ? walk(row).find((n) => n.tagName === 'BUTTON' && /^Все · /.test(textOf(n))) : null;
}
const cards = (root) => byClass(root, 'crm-card');
const cardOf = (root, name) => cards(root).find((c) => textOf(c).includes(name));
async function openCard(root, name) {
  const card = cardOf(root, name);
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  return document.body.children.find((n) => String(n.className).includes('modal'));
}
const picks = (modal) => byAttr(modal, 'data-src-pick');
const pick = (modal, key) => picks(modal).find((n) => n.getAttribute('data-src-pick') === key);
// Отмеченные — в порядке чипов (порядок справочника); главный — со звёздочкой.
const pressed = (modal) => picks(modal).filter((n) => n.getAttribute('aria-pressed') === 'true').map((n) => n.getAttribute('data-src-pick'));
const mainPick = (modal) => picks(modal).filter((n) => n.hasAttribute('data-src-main')).map((n) => n.getAttribute('data-src-pick'));

test('чипы фильтра: заявка считается в каждом своём источнике, «Все» — по заявкам; скрытый источник заявки тоже в ряду', async () => {
  const root = await board();
  assert.equal(textOf(allChip(root)), 'Все · 4');
  const counts = Object.fromEntries(srcChips(root).map((n) => [n.getAttribute('data-src-chip'), textOf(n)]));
  assert.deepEqual(counts, {
    call: 'Звонок · 2', instagram: 'Instagram · 2', referral: 'Рекомендация · 1', telegram: 'Telegram · 1',
  });
  window.easymed.state.user = null;
});

test('фильтр по нескольким: видна заявка, у которой отмечен хотя бы один источник; «Все» снимает отметки', async () => {
  const root = await board();
  chipOf(root, 'referral').click();
  await tick();
  assert.deepEqual(cards(root).map(textOf).map((t) => t.includes('Каримова')), [true], 'по «Рекомендации» — только Каримова');
  chipOf(root, 'call').click();
  await tick();
  const shown = cards(root).map((c) => textOf(c));
  assert.equal(shown.length, 3, 'Рекомендация + Звонок: Каримова, Бахтиёрова, Азимов');
  assert.ok(!shown.some((t) => t.includes('Юсупов')));
  assert.equal(chipOf(root, 'referral').getAttribute('aria-pressed'), 'true');
  assert.equal(chipOf(root, 'call').getAttribute('aria-pressed'), 'true');
  assert.equal(chipOf(root, 'instagram').getAttribute('aria-pressed'), 'false');
  // Повторное нажатие снимает отметку.
  chipOf(root, 'call').click();
  await tick();
  assert.equal(cards(root).length, 1);
  allChip(root).click();
  await tick();
  assert.equal(cards(root).length, 4);
  assert.ok(srcChips(root).every((n) => n.getAttribute('aria-pressed') === 'false'), '«Все» не снял отметки');
  window.easymed.state.user = null;
});

test('карточка доски — тег на каждый источник; список и Excel — через запятую', async () => {
  let root = await board();
  assert.deepEqual(byAttr(cardOf(root, 'Каримова'), 'data-lead-source').map((n) => n.getAttribute('data-lead-source')), ['instagram', 'referral']);
  assert.ok(textOf(cardOf(root, 'Каримова')).includes('Рекомендация'));
  assert.deepEqual(byAttr(cardOf(root, 'Юсупов'), 'data-lead-source').map((n) => n.getAttribute('data-lead-source')), ['instagram']);
  assert.deepEqual(byAttr(cardOf(root, 'Азимов'), 'data-lead-source').map(textOf), ['Telegram', 'Звонок']);

  root = await board('list');
  const cells = byAttr(root, 'data-list-sources').map(textOf);
  // CRM_UNIFY_V1 — доска грузится несколькими запросами (открытые / закрытые по
  // колонкам, views/crm-board-load.js) и сводит их по убыванию номера — тем же
  // порядком, что сервер отдавал и раньше (order id desc). Прежний стенд порядок
  // не применял, и список шёл порядком посева.
  assert.deepEqual(cells, ['Telegram, Звонок', 'Звонок', 'Instagram', 'Instagram, Рекомендация']);

  const aoa = crmExcelRows(LEADS);
  const col = aoa[0].indexOf('Источник');
  assert.ok(col >= 0, 'в выгрузке нет колонки «Источник»');
  assert.deepEqual(aoa.slice(1).map((r) => r[col]), ['Instagram, Рекомендация', 'Instagram', 'Звонок', 'Telegram, Звонок']);
  window.easymed.state.user = null;
});

test('окно заявки: выбор по несколько в порядке нажатий, последний не снимается, уходит массив и главный = первый', async () => {
  const root = await board();
  const modal = await openCard(root, 'Каримова');
  assert.ok(modal, 'окно заявки не открылось');
  assert.deepEqual(picks(modal).map((n) => n.getAttribute('data-src-pick')), ['call', 'instagram', 'referral', 'other'],
    'предлагаются видимые источники');
  assert.deepEqual(pressed(modal), ['instagram', 'referral']);
  assert.deepEqual(mainPick(modal), ['instagram'], 'главный не отмечен звёздочкой');

  pick(modal, 'instagram').click();      // снять главный — главным становится «Рекомендация»
  assert.deepEqual(pressed(modal), ['referral']);
  assert.deepEqual(mainPick(modal), ['referral']);
  TOASTS.length = 0;
  pick(modal, 'referral').click();       // последний — не снимается
  assert.deepEqual(pressed(modal), ['referral']);
  assert.ok(TOASTS.some((t) => t.includes('Нужен хотя бы один источник')), 'нет подсказки про последний источник: ' + JSON.stringify(TOASTS));
  pick(modal, 'call').click();           // добавить — в конец
  assert.deepEqual(mainPick(modal), ['referral'], 'добавленный источник стал главным');

  CALLS.length = 0;
  walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить')).click();
  await tick(120);
  const upd = CALLS.find((c) => c.table === 'crm_requests' && c.op === 'update' && 'sources' in (c.values || {}));
  assert.ok(upd, 'правка заявки не ушла');
  assert.deepEqual(upd.values.sources, ['referral', 'call']);
  assert.equal(upd.values.source, 'referral', 'главный источник — первый выбранный');
  window.easymed.state.user = null;
});

test('окно заявки: скрытый источник, стоящий у заявки, виден и снимается; соседская заявка (только source) читается [source]', async () => {
  let root = await board();
  let modal = await openCard(root, 'Азимов');
  assert.ok(pick(modal, 'telegram'), 'скрытый источник заявки нечем снять');
  assert.deepEqual(pressed(modal), ['call', 'telegram']);
  assert.deepEqual(mainPick(modal), ['telegram'], 'главный — первый источник заявки, а не первый чип');
  pick(modal, 'telegram').click();
  assert.deepEqual(pressed(modal), ['call']);
  assert.deepEqual(mainPick(modal), ['call']);
  assert.ok(pick(modal, 'telegram'), 'снятый скрытый источник пропал из выбора — вернуть его нечем');

  root = await board();
  modal = await openCard(root, 'Юсупов');
  assert.deepEqual(pressed(modal), ['instagram']);
  window.easymed.state.user = null;
});

test('новая заявка начинает с источника по умолчанию; вставка несёт sources', async () => {
  const root = await board();
  CALLS.length = 0;
  button(root, /Новая заявка/).click();
  await tick();
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.deepEqual(pressed(modal), ['call'], 'по умолчанию — первый видимый источник');
  pick(modal, 'instagram').click();
  const inputs = walk(modal).filter((n) => n.tagName === 'INPUT');
  inputs.find((n) => /Фамилия Имя/.test(n.getAttribute('placeholder') || '')).value = 'Буронова Феруза';
  inputs.find((n) => n.getAttribute('type') === 'tel').value = '+998 91 566 22 78';
  button(modal, /Создать заявку/).click();
  await tick(80);
  const ins = CALLS.find((c) => c.table === 'crm_requests' && c.op === 'insert');
  assert.ok(ins, 'заявка не создана');
  assert.deepEqual(ins.values.sources, ['call', 'instagram']);
  assert.equal(ins.values.source, 'call');
  window.easymed.state.user = null;
});

test('«Отчёт»: заявка с двумя источниками — в обоих; «Всего» — по заявкам, не сумма строк', async () => {
  const root = await board();
  document.body.children.length = 0;
  button(root, /Отчёт/).click();
  await tick();
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно отчёта не открылось');
  const rows = Object.fromEntries(byAttr(modal, 'data-src-row').map((tr) => [tr.getAttribute('data-src-row'),
    tr.children.map(textOf)]));
  assert.deepEqual(rows.instagram, ['Instagram', '2', '0', '0%']);
  assert.deepEqual(rows.referral, ['Рекомендация', '1', '0', '0%']);
  assert.deepEqual(rows.call, ['Звонок', '2', '1', '50%']);
  assert.deepEqual(rows.telegram, ['Telegram', '1', '0', '0%']);
  const total = byAttr(modal, 'data-src-total')[0];
  assert.ok(total, 'нет строки «Всего»');
  assert.deepEqual(total.children.map(textOf), ['Всего', '4', '1', '25%'], '«Всего» посчитано суммой строк (6), а не по заявкам (4)');
  window.easymed.state.user = null;
});

// CRM_UNIFY_V1 (задача 8) — «Отчёт» считает заявки по базе своим лёгким запросом
// за свой период, а не то, что загрузила доска (Р14).
test('CRM_UNIFY_V1: «Отчёт» спрашивает базу за свой период; смена периода — новый запрос', async () => {
  const root = await board();
  document.body.children.length = 0;
  CALLS.length = 0;
  button(root, /Отчёт/).click();
  await tick(60);
  const isReport = (c) => c.table === 'crm_requests' && c.op === 'select' && c.columns === 'id, status, source, sources, created_at, assigned_to';
  const q = CALLS.find(isReport);
  assert.ok(q, 'отчёт считает загруженное на доску, а не базу');
  assert.ok((q.filters || []).some((f) => f.col === 'created_at' && f.op === 'gte'), 'период отчёта (30 дней) не ушёл в запрос');
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  CALLS.length = 0;
  walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n) === 'Всё время').click();
  await tick(60);
  const q2 = CALLS.find(isReport);
  assert.ok(q2 && !(q2.filters || []).some((f) => f.col === 'created_at'), '«Всё время» в отчёте обрезано датой');
  // отчёт считает ответ базы: стенд отдаёт те же четыре заявки
  assert.deepEqual(byAttr(modal, 'data-src-total')[0].children.map(textOf), ['Всего', '4', '1', '25%']);
  window.easymed.state.user = null;
});

// Ревью M1 — отмеченный скрытый источник, у которого в новом периоде нет ни
// одной заявки, пропадал из ряда: доска пустая, ни один чип не отмечен, и
// снять отметку нечем. Отмеченный источник рисуется всегда (с нулём).
test('ревью M1: отмеченный источник остаётся в ряду с нулём, когда в периоде его заявок нет, — и снимается', async () => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const leads = [
    { id: 11, full_name: 'Старая Telegram', phone: '+998905556677', status: 'in_process', source: 'telegram', sources: ['telegram'], created_at: old },
    { id: 12, full_name: 'Свежая Instagram', phone: '+998906667788', status: 'in_process', source: 'instagram', sources: null, created_at: now },
  ];
  const root = await board('kanban', leads);
  const period = (re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n)));
  try {
    chipOf(root, 'telegram').click();
    await tick();
    assert.equal(cards(root).length, 1);
    period(/^30 дней$/).click();
    await tick();
    const tg = chipOf(root, 'telegram');
    assert.ok(tg, 'отмеченный «Telegram» пропал из ряда — снять отметку нечем');
    assert.equal(textOf(tg), 'Telegram · 0');
    assert.equal(tg.getAttribute('aria-pressed'), 'true');
    assert.equal(cards(root).length, 0);
    tg.click();
    await tick();
    assert.equal(cards(root).length, 1, 'после снятия отметки доска не вернулась');
    assert.ok(!chipOf(root, 'telegram'), 'неотмеченный источник без заявок в периоде нарисован');
  } finally {
    period(/^Всё время$/).click();
    await tick();
    window.easymed.state.user = null;
  }
});
