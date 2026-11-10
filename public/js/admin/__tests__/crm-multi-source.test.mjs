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

const { renderCrm, crmExcelRows, CRM_FILTER_ALL } = await import('../views/crm.js');

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
  if (srcSel(root)) await pickSrc(root, CRM_FILTER_ALL);
  button(root, view === 'list' ? /Список/ : /Канбан/).click();
  await tick();
  return root;
}
// CRM_FILTERS_DROPDOWN_V1 (2026-10-29) — фильтр «Источник» над доской стал
// выпадающим списком (data-src-select) с ОДНИМ значением: «Все · N», затем
// источники выборки со счётчиком. CRM_FILTER_ALL_VALUE_V1 (3.23.0) — у «Все»
// настоящее значение (CRM_FILTER_ALL), а не пустое: пустое список программы
// рисовал серым, как незаполненное поле, и не показывал среди вариантов. Чипов data-src-chip больше нет; окно
// заявки по-прежнему отмечает источники по несколько.
const srcSel = (root) => byAttr(root, 'data-src-select')[0];
const srcOpts = (root) => (srcSel(root) ? walk(srcSel(root)).filter((n) => n.tagName === 'OPTION') : []);
const optOf = (root, key) => srcOpts(root).find((o) => o.value === key);
async function pickSrc(root, key) {
  const s = srcSel(root);
  s.value = key;
  s.dispatchEvent({ type: 'change', target: s, currentTarget: s });
  await tick();
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
const mainPick = (modal) => picks(modal).filter((n) => n.hasAttribute('data-src-main')).map((n) => n.getAttribute('data-src-pick'));

test('список фильтра: заявка считается в каждом своём источнике, «Все» — по заявкам; скрытый источник заявки тоже в списке', async () => {
  const root = await board();
  assert.equal(textOf(optOf(root, CRM_FILTER_ALL)), 'Все · 4');
  assert.equal(optOf(root, ''), undefined, '«Все» снова с пустым значением');
  const counts = Object.fromEntries(srcOpts(root).filter((o) => o.value !== CRM_FILTER_ALL).map((o) => [o.value, textOf(o)]));
  assert.deepEqual(counts, {
    call: 'Звонок · 2', instagram: 'Instagram · 2', referral: 'Рекомендация · 1', telegram: 'Telegram · 1',
  });
  window.easymed.state.user = null;
});

// CRM_FILTERS_DROPDOWN_V1 — выбирается ОДИН источник (чипы отмечались по
// несколько): заявка видна, если выбранный есть среди её источников; «Все»
// снимает выбор.
test('фильтр по одному источнику: видна заявка, у которой он есть среди источников; «Все» снимает выбор', async () => {
  const root = await board();
  await pickSrc(root, 'referral');
  assert.deepEqual(cards(root).map(textOf).map((t) => t.includes('Каримова')), [true], 'по «Рекомендации» — только Каримова');
  await pickSrc(root, 'call');
  const shown = cards(root).map((c) => textOf(c));
  assert.equal(shown.length, 2, 'Звонок: Бахтиёрова и Азимов (у него звонок — второй источник)');
  assert.ok(!shown.some((t) => t.includes('Юсупов')) && !shown.some((t) => t.includes('Каримова')), 'при одном выбранном источнике видны чужие заявки');
  assert.equal(srcSel(root).value, 'call');
  await pickSrc(root, CRM_FILTER_ALL);
  assert.equal(cards(root).length, 4);
  assert.equal(srcSel(root).value, CRM_FILTER_ALL, '«Все» не снял выбор');
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

// CRM_SOURCE_SINGLE_V1 (2026-10-30, владелец: «Remove multiselect from istochnik»)
// — в окне заявки источник ОДИН: клик выбирает пункт (aria-selected) и заменяет
// список. Заявка, у которой источников уже несколько (CRM_MULTI_SOURCE_V1),
// сохраняет их, пока оператор не выберет другой. Фильтр, карточки, Excel и отчёт
// по-прежнему читают все источники заявки (тесты выше и ниже).
const selected = (modal) => picks(modal).filter((n) => n.getAttribute('aria-selected') === 'true').map((n) => n.getAttribute('data-src-pick'));
const saveCard = async (modal) => {
  CALLS.length = 0;
  walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить')).click();
  await tick(120);
  return CALLS.find((c) => c.table === 'crm_requests' && c.op === 'update' && 'sources' in (c.values || {}));
};

test('окно заявки: источники прежней заявки (несколько) не теряются, пока оператор не выберет другой', async () => {
  const root = await board();
  const modal = await openCard(root, 'Каримова');
  assert.ok(modal, 'окно заявки не открылось');
  assert.deepEqual(picks(modal).map((n) => n.getAttribute('data-src-pick')), ['call', 'instagram', 'referral', 'other'],
    'предлагаются видимые источники');
  assert.deepEqual(selected(modal), [], 'у заявки два источника — ни один пункт не отмечен единственным');
  assert.deepEqual(mainPick(modal), [], 'звёздочки «главный» больше нет');
  const upd = await saveCard(modal);
  assert.ok(upd, 'правка заявки не ушла');
  assert.deepEqual(upd.values.sources, ['instagram', 'referral'], 'открыть и сохранить — источники молча потерялись');
  assert.equal(upd.values.source, 'instagram');
  window.easymed.state.user = null;
});

test('окно заявки: выбор заменяет список одним источником; скрытый источник заявки предлагается; только source читается [source]', async () => {
  let root = await board();
  let modal = await openCard(root, 'Азимов');
  assert.ok(pick(modal, 'telegram'), 'скрытый источник заявки не предложен — выбрать его снова нечем');
  pick(modal, 'call').click();
  assert.deepEqual(selected(modal), ['call'], 'выбор не отмечен');
  pick(modal, 'telegram').click();
  assert.deepEqual(selected(modal), ['telegram'], 'второй выбор не заменил первый');
  const upd = await saveCard(modal);
  assert.deepEqual(upd.values.sources, ['telegram']);
  assert.equal(upd.values.source, 'telegram');

  root = await board();
  modal = await openCard(root, 'Юсупов');
  assert.deepEqual(selected(modal), ['instagram']);
  window.easymed.state.user = null;
});

test('новая заявка начинает с источника по умолчанию; выбор — один источник', async () => {
  const root = await board();
  CALLS.length = 0;
  button(root, /Новая заявка/).click();
  await tick();
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.deepEqual(selected(modal), ['call'], 'по умолчанию — первый видимый источник');
  pick(modal, 'instagram').click();
  assert.deepEqual(selected(modal), ['instagram']);
  const inputs = walk(modal).filter((n) => n.tagName === 'INPUT');
  inputs.find((n) => /Фамилия Имя/.test(n.getAttribute('placeholder') || '')).value = 'Буронова Феруза';
  inputs.find((n) => n.getAttribute('type') === 'tel').value = '+998 91 566 22 78';
  button(modal, /Создать заявку/).click();
  await tick(80);
  const ins = CALLS.find((c) => c.table === 'crm_requests' && c.op === 'insert');
  assert.ok(ins, 'заявка не создана');
  assert.deepEqual(ins.values.sources, ['instagram']);
  assert.equal(ins.values.source, 'instagram');
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
// CRM_UNIFY_V1 (итоговое ревью) — случай «в периоде заявок этого источника нет»
// построен на закрытых карточках («Пришёл»). CRM_PERIOD_ALL_COLUMNS_V1 (3.23.0):
// «Период» снова сужает и открытые — на закрытых случай тот же.
test('ревью M1: отмеченный источник остаётся в ряду с нулём, когда в периоде его заявок нет, — и снимается', async () => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const leads = [
    { id: 11, full_name: 'Старая Telegram', phone: '+998905556677', status: 'came', source: 'telegram', sources: ['telegram'], created_at: old },
    { id: 12, full_name: 'Свежая Instagram', phone: '+998906667788', status: 'came', source: 'instagram', sources: null, created_at: now },
  ];
  const root = await board('kanban', leads);
  const period = (re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n)));
  try {
    await pickSrc(root, 'telegram');
    assert.equal(cards(root).length, 1);
    period(/^30 дней$/).click();
    await tick(80);
    const tg = optOf(root, 'telegram');
    assert.ok(tg, 'выбранный «Telegram» пропал из списка — снять выбор нечем');
    assert.equal(textOf(tg), 'Telegram · 0');
    assert.equal(srcSel(root).value, 'telegram');
    assert.equal(cards(root).length, 0);
    await pickSrc(root, CRM_FILTER_ALL);
    assert.equal(cards(root).length, 1, 'после снятия выбора доска не вернулась');
    assert.ok(!optOf(root, 'telegram'), 'невыбранный источник без заявок в периоде предложен');
  } finally {
    period(/^Всё время$/).click();
    await tick(80);
    window.easymed.state.user = null;
  }
});
