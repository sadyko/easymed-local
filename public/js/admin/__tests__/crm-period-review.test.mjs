// CRM_PERIOD_ALL_COLUMNS_V1 — ПРАВКИ РЕВЬЮ 3.23.0 (решения координатора 2026-11-10).
// Выбранный «Период» сужает каждую колонку доски, и от этого не должны страдать:
//   • поиск — он ВСЕГДА по всем датам, какой бы период ни стоял (Q1); строки
//     «Открытых за другие дни» при поиске нет — вместо неё «Поиск — по всем датам»;
//     выгрузка Excel при поиске — тоже по всем датам;
//   • панель «Телефон» — она называла номер и открывала заявку только по
//     загруженным карточкам: давняя открытая заявка не открывалась («Заявки нет на
//     доске») и в журнале звонков у неё пропадало «Открыть заявку»;
//   • «Список» без карточек за период — «За этот период заявок нет», а не «Заявок
//     пока нет»; строка над доской — только когда давних открытых больше нуля (Q2);
//   • «Отчёт» не считает по доске, загруженной за период, когда база не ответила;
//   • границы периода считаются один раз на загрузку (полночь их не сдвигает);
//   • числа у источников и меток без скрытых колонок — как «Все · N»;
//   • пока доска грузится, у чипов периода видно «Загрузка…».
// Данные — выдуманные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, RPC, CALLS, mk, walk, textOf, byAttr, byClass, tick, TOASTS } from './crm-harness.mjs';
import { DEFAULT_STAGES } from '../crm-settings-logic.js?v=crmcfg1';

const { renderCrm, crmExportRows, CRM_FILTER_ALL } = await import('../views/crm.js');
const { resetCrmPhone, mountPhoneButton } = await import('../views/crm-phone.js');

const ADMIN = { id: 7, full_name: 'Админ', role: 'admin', is_admin: true };
const DAY = 86400000;
const isoAgo = (d) => new Date(Date.now() - d * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
const OLD = { id: 11, full_name: 'Давняя Заявка', phone: '+998 93 555 01 12', status: 'recall', source: 'call', created_at: isoAgo(40), assigned_to: 7 };
const TODAY = { id: 12, full_name: 'Сегодняшняя', phone: '+998 93 555 01 13', status: 'in_process', source: 'call', created_at: isoAgo(0), assigned_to: 7 };
const chip = (root, re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n)));
const periodLine = (root) => byAttr(root, 'data-crm-period-line')[0] || null;
const modalOpen = () => document.body.children.find((n) => String(n.className).includes('modal'));
const NAV = [];

async function shell(leads, { calls = [], config = null, leadTags = [] } = {}) {
  resetCrmPhone();
  RPC.length = 0; NAV.length = 0; TOASTS.length = 0;
  window.easymed.state.user = ADMIN;
  S.config = config; S.leads = leads; S.search = []; S.tasks = []; S.leadTags = leadTags; S.dups = [];
  S.phoneMe = null; S.callLog = []; S.extensions = []; S.dialError = null; S.live = calls;
  document.body.children.length = 0;
  const root = mk('div');
  const btn = mountPhoneButton({ onNavigate: (v, p) => NAV.push([v, p]), shiftTarget: root, livePollMs: 25 });
  await renderCrm(root, { onNavigate() {} });
  await tick(80);
  return { root, btn };
}
async function search(root, q) {
  const inp = walk(root).find((n) => n.tagName === 'INPUT' && String(n.className).includes('crm-search'));
  inp.value = q; inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(560); await tick(60);
}
async function backToAll(root) {
  for (const m of document.body.children.filter((n) => String(n.className).includes('modal'))) m.remove();
  const v = walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'kanban');
  if (v) { v.click(); await tick(60); }
  const all = chip(root, /^Всё время$/);
  if (all) { all.click(); await tick(100); }
  S.dups = []; S.config = null; S.leadTags = []; S.live = [];
  resetCrmPhone();
}
const drawerOf = () => document.body.children.find((n) => n.attrs && 'data-cph-drawer' in n.attrs);

test('Q1: при «Сегодня» поиск находит давнюю открытую карточку; вместо строки о периоде — «Поиск — по всем датам»; Excel — тоже по всем датам', async () => {
  const { root } = await shell([OLD, TODAY]);
  try {
    chip(root, /^Сегодня$/).click(); await tick(100);
    assert.ok(!byClass(root, 'crm-card').some((c) => textOf(c).includes('Давняя Заявка')), 'стенд не тот');
    assert.ok(periodLine(root), 'строки о периоде нет');
    S.search = [OLD];   // сервер ищет по всем датам
    await search(root, '935550112');
    assert.ok(byClass(root, 'crm-card').some((c) => textOf(c).includes('Давняя Заявка')), 'поиск при выбранном периоде не нашёл давнюю карточку');
    assert.equal(periodLine(root), null, 'при поиске осталась строка «Открытых за другие дни»');
    const note = byAttr(root, 'data-crm-search-all')[0];
    assert.ok(note && textOf(note).includes('Поиск — по всем датам'), 'не сказано, что поиск — по всем датам');
    const exp = await crmExportRows();
    assert.ok(exp.rows.some((r) => r.full_name === 'Давняя Заявка'), 'выгрузка при поиске — только за период');
    // «Список» — то же
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'list').click(); await tick(80);
    assert.ok(textOf(root).includes('Давняя Заявка'), '«Список» при поиске — только за период');
    // поиск стёрли — снова период
    await search(root, '');
    assert.ok(!textOf(root).includes('Давняя Заявка'));
    assert.ok(periodLine(root));
    assert.equal(byAttr(root, 'data-crm-search-all').length, 0);
  } finally { await search(root, ''); await backToAll(root); }
});

test('панель «Телефон», «Звонит»: давняя открытая заявка открывается и при «Сегодня» (доска берёт её с сервера)', async () => {
  const call = { uuid: 'r1', direction: 'in', state: 'ringing', was_answered: false, caller: '998935550112', callee: '101', number: '998935550112',
    since: new Date().toISOString(), updated: Date.now(), patient: null, lead: { id: 11, full_name: 'Давняя Заявка', status: 'recall' } };
  const { root, btn } = await shell([OLD, TODAY], { calls: [call] });
  try {
    chip(root, /^Сегодня$/).click(); await tick(100);
    btn.click(); await tick(80);
    const ring = byAttr(drawerOf(), 'data-cph-ring')[0];
    byAttr(ring, 'data-cph-ring-lead')[0].click();
    await tick(150);
    const modal = modalOpen();
    assert.ok(modal, '«Открыть заявку» не открыло давнюю заявку: ' + JSON.stringify(TOASTS));
    assert.ok(textOf(modal).includes('Давняя Заявка') || walk(modal).some((n) => n.value === 'Давняя Заявка'), 'открыта не та заявка');
    assert.ok(!TOASTS.some((t) => t.includes('Заявки нет на доске')));
  } finally { await backToAll(root); }
});

test('панель «Телефон», журнал и набор: номер давней заявки назван и «Открыть заявку» есть и при «Сегодня»', async () => {
  const { root, btn } = await shell([OLD, TODAY]);
  S.callLog = [{ id: 1, started_at: new Date().toISOString(), call_type: 0, external_number: '998935550112', internal_number: '101', billsec: 42, disposition: 'ANSWER',
    patient_id: null, patient_name: null, patient_mrn: null, operator_name: 'Лола', recording_url: null, has_recording: false }];
  // сервер знает заявку этого номера по всем датам (crm_leads_by_phone)
  S.dups = [{ id: 11, full_name: 'Давняя Заявка', phone: '+998 93 555 01 12', status: 'recall', stage_label: 'Перезвонить', stage_kind: 'open', can_open: true }];
  try {
    chip(root, /^Сегодня$/).click(); await tick(100);
    btn.click(); await tick(120);
    const d = drawerOf();
    byAttr(d, 'data-cph-row').find((r) => r.getAttribute('data-cph-row') === '1').click();
    await tick(80);
    const openBtn = byAttr(drawerOf(), 'data-cph-open-lead')[0];
    assert.ok(openBtn, 'журнал звонков потерял «Открыть заявку» у давней заявки');
    openBtn.click(); await tick(150);
    assert.ok(modalOpen(), '«Открыть заявку» из журнала не открыло заявку: ' + JSON.stringify(TOASTS));
    modalOpen().remove();
    // набор того же номера — назван по имени
    const key = (k) => byAttr(drawerOf(), 'data-k').find((b) => b.getAttribute('data-k') === k).click();
    for (const k of '935550112') key(k);
    await tick(80);
    assert.match(textOf(byAttr(drawerOf(), 'data-cph-who')[0]), /Давняя Заявка/, 'набранный номер давней заявки не назван');
    assert.ok(RPC.filter((r) => r.name === 'crm_leads_by_phone').length >= 1);
  } finally { await backToAll(root); }
});

test('«Список» за период без карточек — «За этот период заявок нет»; строка над доской — только когда давних открытых больше нуля (Q2)', async () => {
  const { root } = await shell([OLD]);
  try {
    walk(root).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-crm-view'] === 'list').click(); await tick(80);
    chip(root, /^Сегодня$/).click(); await tick(100);
    const t = textOf(root);
    assert.ok(t.includes('За этот период заявок нет'), 'пустой период назван не так: ' + t.slice(0, 300));
    assert.ok(!t.includes('Заявок пока нет'), '«Заявок пока нет», хотя за другие дни заявка есть');
    assert.match(textOf(periodLine(root)), /Открытых за другие дни: 1 — /);
  } finally { await backToAll(root); }
  // давних открытых нет — строки нет
  const again = await shell([TODAY, { ...OLD, id: 21, status: 'came' }]);
  try {
    chip(again.root, /^Сегодня$/).click(); await tick(100);
    assert.equal(periodLine(again.root), null, 'строка «Открытых за другие дни: 0»');
  } finally { await backToAll(again.root); }
});

test('«Отчёт»: база не ответила при выбранном периоде — ошибка словами, а не числа по доске за период', async () => {
  const { root } = await shell([OLD, TODAY]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const b = o && o.body ? JSON.parse(o.body) : null;
    if (b && b.table === 'crm_requests' && b.columns === 'id, status, source, sources, created_at, assigned_to') {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'сбой' } }) };
    }
    return realFetch(url, o);
  };
  try {
    chip(root, /^Сегодня$/).click(); await tick(100);
    walk(root).find((n) => n.tagName === 'BUTTON' && /Отчёт/.test(textOf(n))).click(); await tick(80);
    let modal = modalOpen();
    assert.ok(byAttr(modal, 'data-report-error').length, 'нет ошибки: отчёт посчитан по доске за период');
    assert.equal(byAttr(modal, 'data-report-fallback').length, 0);
    assert.ok(!textOf(modal).includes('Конверсия'), 'числа отчёта по доске, загруженной за период');
    modal.remove();
    // «Всё время» — доска держит всё: прежний запасной счёт с пометкой
    chip(root, /^Всё время$/).click(); await tick(100);
    walk(root).find((n) => n.tagName === 'BUTTON' && /Отчёт/.test(textOf(n))).click(); await tick(80);
    modal = modalOpen();
    assert.ok(byAttr(modal, 'data-report-fallback').length, 'при «Всё время» пропал запасной счёт по доске');
    assert.equal(byAttr(modal, 'data-report-error').length, 0);
  } finally { globalThis.fetch = realFetch; await backToAll(root); }
});

test('границы периода — одни на загрузку: полночь не прячет сегодняшние карточки до перезагрузки доски', async () => {
  const { root } = await shell([OLD, TODAY]);
  const RealDate = globalThis.Date;
  try {
    chip(root, /^Сегодня$/).click(); await tick(100);
    assert.ok(byClass(root, 'crm-card').some((c) => textOf(c).includes('Сегодняшняя')));
    // часы перешли за полночь (00:05 завтра); доска не перезагружалась
    const t = new RealDate(); t.setDate(t.getDate() + 1); t.setHours(0, 5, 0, 0);
    const shift = t.getTime() - RealDate.now();
    globalThis.Date = class extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + shift); }
      static now() { return RealDate.now() + shift; }
    };
    // перерисовка без загрузки — смена источника
    const s = byAttr(root, 'data-src-select')[0];
    s.value = 'call'; s.dispatchEvent({ type: 'change', target: s, currentTarget: s }); await tick(40);
    assert.ok(byClass(root, 'crm-card').some((c) => textOf(c).includes('Сегодняшняя')), 'перерисовка после полуночи спрятала загруженные карточки');
  } finally {
    globalThis.Date = RealDate;
    const s = byAttr(root, 'data-src-select')[0];
    if (s) { s.value = CRM_FILTER_ALL; s.dispatchEvent({ type: 'change', target: s, currentTarget: s }); await tick(40); }
    await backToAll(root);
  }
});

test('числа у источников и меток — без скрытых колонок, как «Все · N»; выбор «X · n» показывает n карточек', async () => {
  const config = {
    stages: DEFAULT_STAGES.map((st) => (st.key === 'approved' ? { ...st, is_active: 0 } : st)),
    sources: [{ key: 'call', label: 'Звонок', position: 1, is_active: 1 }, { key: 'instagram', label: 'Instagram', position: 2, is_active: 1 }],
    tags: [{ key: 'vip', label: 'VIP', color: 'purple', position: 1, is_active: true }],
  };
  const lead = (id, status, source) => ({ id, full_name: 'Лид ' + id, phone: '+99890' + String(1000000 + id), status, source, created_at: isoAgo(1) });
  const leads = [lead(1, 'recall', 'instagram'), lead(2, 'in_process', 'instagram'), lead(3, 'approved', 'instagram'), lead(4, 'came', 'call'), lead(5, 'approved', 'call')];
  const tags = [{ request_id: 1, tag_key: 'vip' }, { request_id: 3, tag_key: 'vip' }, { request_id: 5, tag_key: 'vip' }];
  const { root } = await shell(leads, { config, leadTags: tags });
  const opt = (attr, v) => walk(byAttr(root, attr)[0]).find((n) => n.tagName === 'OPTION' && n.attrs.value === v);
  const pick = async (attr, v) => { const s = byAttr(root, attr)[0]; s.value = v; s.dispatchEvent({ type: 'change', target: s, currentTarget: s }); await tick(40); };
  try {
    assert.equal(textOf(opt('data-src-select', CRM_FILTER_ALL)), 'Все · 3');
    assert.equal(textOf(opt('data-src-select', 'instagram')), 'Instagram · 2', 'скрытая колонка посчитана у источника');
    assert.equal(textOf(opt('data-src-select', 'call')), 'Звонок · 1');
    assert.match(textOf(opt('data-tag-select', 'vip')), /VIP · 1$/, 'скрытая колонка посчитана у метки');
    await pick('data-src-select', 'instagram');
    assert.equal(byClass(root, 'crm-card').length, 2, '«Instagram · 2» показал не две карточки');
    await pick('data-src-select', CRM_FILTER_ALL);
    await pick('data-tag-select', 'vip');
    assert.equal(byClass(root, 'crm-card').length, 1, '«VIP · 1» показал не одну карточку');
  } finally { await pick('data-tag-select', CRM_FILTER_ALL); await backToAll(root); }
});

test('пока доска перезагружается, у чипов периода видно «Загрузка…» (и чипы заняты); после — нет', async () => {
  const { root } = await shell([TODAY]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const b = o && o.body ? JSON.parse(o.body) : null;
    if (b && b.table === 'crm_requests' && b.op === 'select') await new Promise((r) => setTimeout(r, 200));
    return realFetch(url, o);
  };
  try {
    chip(root, /^Сегодня$/).click();
    const busy = byAttr(root, 'data-crm-period-busy');
    assert.equal(busy.length, 1, 'нет «Загрузка…» у чипов');
    assert.equal(textOf(busy[0]), 'Загрузка…');
    assert.ok(byAttr(root, 'data-crm-period').every((b) => b.hasAttribute('disabled') && b.getAttribute('aria-busy') === 'true'));
    await tick(500);
    assert.equal(byAttr(root, 'data-crm-period-busy').length, 0, '«Загрузка…» осталась после загрузки');
  } finally { globalThis.fetch = realFetch; await backToAll(root); }
});
