// CRM_DUP_CARRY_OPEN_V1 и CRM_DUP_SHEET_V1 (3.22.0, ревью партнёрской работы) —
// окно «У этого номера уже есть карточка».
//
// 1. «Открыть и добавить услуги» (CRM_DUP_ADD_SERVICES_V1) пропускал услугу, если
//    такая уже стояла в карточке, — даже выполненную в прошлом месяце или
//    записанную на другой день, и молчал. Повторный заказ терялся: оператор видел
//    «ЭКГ» в карточке и считал, что заказ там. Теперь совпадением считается
//    только ЖДУЩАЯ строка (не выполнена, без даты и без записи), а о пропущенном
//    окно говорит по имени.
// 2. Вопрос о дубле, заданный поверх окна «Даты приёма», на «Открыть…» закрывал
//    карточку, а окно дат оставлял сиротой: его «Сохранить и записать» снова
//    звало persist() мёртвой карточки, и «Создать всё равно» заводило вторую
//    карточку и записывало дни дважды. Теперь окно дат закрывается вместе с ней.
// 3. Ответ «Создать всё равно», данный по номеру (пациент ещё не выбран), не
//    теряется, когда пациента выбирают потом: его заявки — часть уже показанных.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, CALLS, RPC, TOASTS, mk, walk, textOf, byAttr, tick, button } from './crm-harness.mjs';

const { renderCrm } = await import('../views/crm.js');

async function newRequestModal() {
  CALLS.length = 0; RPC.length = 0; S.inserted = null;
  document.body.children.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  button(root, /Новая заявка/).click();
  await tick();
  const modal = document.body.children.find((n) => String(n.className).includes('modal'));
  assert.ok(modal, 'окно новой заявки не открылось');
  const inputs = walk(modal).filter((n) => n.tagName === 'INPUT');
  inputs.find((n) => /Фамилия Имя/.test(n.getAttribute('placeholder') || '')).value = 'Буронова Феруза';
  inputs.find((n) => n.getAttribute('type') === 'tel').value = '+998 91 566 22 78';
  return modal;
}
async function pickService(modal, name) {
  const inp = walk(modal).find((n) => n.tagName === 'INPUT' && /Поиск услуги/.test(n.getAttribute('placeholder') || ''));
  assert.ok(inp, 'нет поиска услуги');
  inp.value = name;
  inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(600);   // поле поиска — с дебаунсом 500 мс (ui.js SEARCH_DEBOUNCE_V1)
  const item = walk(modal).find((n) => n.tagName === 'DIV' && n._l && n._l.mousedown && textOf(n).startsWith(name));
  assert.ok(item, `услуги «${name}» нет в выпадающем списке`);
  item.dispatchEvent({ type: 'mousedown', target: item, currentTarget: item, preventDefault() {} });
}
const dupDialog = () => document.body.children.find((n) => n.attrs && 'data-crm-dup' in n.attrs);
const inserts = () => CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'insert');
const modals = () => document.body.children.filter((n) => String(n.className).includes('modal') && !(n.attrs && 'data-crm-dup' in n.attrs));
const sheet = () => document.body.children.find((n) => String(n.className).includes('modal') && textOf(n).includes('Даты приёма'));

const UZI = { id: 10, name: 'УЗИ почек', price: 120000, active: 1, type: 'imaging' };
const ECG = { id: 11, name: 'ЭКГ', price: 50000, active: 1, type: 'diag' };
const DUP = { id: 41, full_name: 'Буронова Феруза', phone: '915662278', status: 'in_process', stage_label: 'В обработке', stage_kind: 'open',
  created_at: '2026-08-01T10:00:00Z', assigned_to: null, assigned_name: '', can_open: true };
const LEAD41 = { id: 41, full_name: 'Буронова Феруза', phone: '915662278', status: 'in_process', source: 'call', created_at: '2026-08-01T10:00:00Z' };

/** Новая заявка с набранными услугами → окно дубля → «Открыть и добавить услуги». */
async function carryInto(lines, names) {
  S.services = [UZI, ECG];
  S.reqLines = lines;
  S.dups = [DUP];
  S.leads = [LEAD41];
  const modal = await newRequestModal();
  await tick(30);
  for (const n of names) await pickService(modal, n);
  TOASTS.length = 0;
  button(modal, /Создать заявку/).click();
  await tick(60);
  const dlg = dupDialog();
  assert.ok(dlg, 'дубль не остановил создание');
  const btn = byAttr(dlg, 'data-dup-open')[0];
  assert.match(textOf(btn), /Открыть и добавить услуг/);
  btn.click();
  await tick(150);
  assert.equal(inserts().length, 0, 'вторая карточка всё равно заведена');
  const opened = modals();
  assert.equal(opened.length, 1, 'открыта не одна карточка');
  return opened[0];
}
const ecgRows = (card) => walk(card).filter((n) => n.attrs && 'data-picked-line' in n.attrs && textOf(n).includes('ЭКГ'));
const done = () => { S.services = []; S.reqLines = []; S.leads = []; S.dups = []; document.body.children.length = 0; };

test('CRM_DUP_CARRY_OPEN_V1: ЭКГ в карточке уже ВЫПОЛНЕНА — повторный заказ ложится в карточку', async () => {
  const card = await carryInto([{ id: 1, request_id: 41, service_id: ECG.id, scheduled_date: '2026-10-01', status: 'done', doctor_id: null, visit_id: 7 }], ['ЭКГ']);
  assert.ok(TOASTS.some((t) => /Добавлено услуг в карточку: 1/.test(t)), 'новый заказ ЭКГ потерян молча: ' + JSON.stringify(TOASTS));
  assert.equal(ecgRows(card).length, 2, 'в карточке должны стоять обе ЭКГ — выполненная и новая');
  done();
});

test('CRM_DUP_CARRY_OPEN_V1: ЭКГ в карточке ЗАПИСАНА на другой день — повторный заказ ложится в карточку', async () => {
  const card = await carryInto([{ id: 1, request_id: 41, service_id: ECG.id, scheduled_date: '2026-11-10', status: 'pending', doctor_id: null, visit_id: 7 }], ['ЭКГ']);
  assert.ok(TOASTS.some((t) => /Добавлено услуг в карточку: 1/.test(t)), JSON.stringify(TOASTS));
  assert.equal(ecgRows(card).length, 2);
  done();
});

test('CRM_DUP_CARRY_OPEN_V1: ЭКГ в карточке ещё ЖДЁТ (без даты и записи) — второй не ставим и говорим об этом по имени', async () => {
  const card = await carryInto([{ id: 1, request_id: 41, service_id: ECG.id, scheduled_date: '', status: 'pending', doctor_id: null, visit_id: null }], ['ЭКГ']);
  assert.equal(ecgRows(card).length, 1, 'ждущая ЭКГ продублирована');
  assert.ok(TOASTS.some((t) => /Уже ждут в карточке, второй раз не добавлены: ЭКГ/.test(t)), 'о пропущенной услуге окно промолчало: ' + JSON.stringify(TOASTS));
  done();
});

test('CRM_DUP_CARRY_OPEN_V1: одна добавлена, другая уже ждёт — одно сообщение называет обе части', async () => {
  const card = await carryInto([{ id: 1, request_id: 41, service_id: ECG.id, scheduled_date: '', status: 'pending', doctor_id: null, visit_id: null }], ['УЗИ почек', 'ЭКГ']);
  assert.ok(textOf(card).includes('УЗИ почек'), 'набранная УЗИ не попала в карточку');
  const last = TOASTS[TOASTS.length - 1] || '';
  assert.match(last, /Добавлено услуг в карточку: 1/);
  assert.match(last, /Уже ждут в карточке, второй раз не добавлены: ЭКГ/);
  done();
});

// --- CRM_DUP_SHEET_V1 ---------------------------------------------------------

async function editModal(lead) {
  CALLS.length = 0; RPC.length = 0;
  document.body.children.length = 0;
  S.leads = [lead];
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  const card = walk(root).find((n) => String(n.className).split(/\s+/).includes('crm-card'));
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(150);
  return document.body.children.find((n) => String(n.className).includes('modal'));
}

test('CRM_DUP_SHEET_V1: вопрос о дубле поверх «Даты приёма» → «Открыть» закрывает и окно дат, второго сохранения нет', async () => {
  S.services = [UZI];
  S.reqLines = [{ id: 1, request_id: 5, service_id: UZI.id, scheduled_date: '2026-11-20', status: 'pending', doctor_id: null, visit_id: null }];
  const lead5 = { id: 5, full_name: 'Юсупов Бекзод', phone: '+998 90 485 88 55', status: 'in_process', source: 'call', created_at: '2026-09-20T10:00:00Z',
    patient_id: 3, patients: { id: 3, full_name: 'Юсупов Бекзод', mrn: 'M-3' } };
  const modal = await editModal(lead5);
  assert.ok(modal, 'карточка не открылась');
  // Номер сменили на номер другой карточки; первая проверка ответа не дала —
  // окно дат открывается без вопроса, и спрашивать приходится уже из-под него.
  walk(modal).find((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'tel').value = '+998 91 566 22 78';
  S.dups = null;
  button(modal, /Записать на дату/).click();
  await tick(60);
  assert.ok(sheet(), 'окно «Даты приёма» не открылось');
  S.dups = [DUP];
  S.leads = [lead5, LEAD41];
  button(sheet(), /Сохранить и записать/).click();
  await tick(60);
  const dlg = dupDialog();
  assert.ok(dlg, 'сохранение из окна дат не спросило о дубле');
  byAttr(dlg, 'data-dup-open')[0].click();
  await tick(150);
  assert.equal(sheet(), undefined, 'окно «Даты приёма» осталось сиротой поверх открытой карточки');
  assert.ok(!document.body.children.includes(modal), 'прежняя карточка не закрылась');
  const opened = modals();
  assert.equal(opened.length, 1, 'открыто не ровно одно окно: ' + opened.length);
  assert.equal(CALLS.filter((c) => c.table === 'crm_requests' && (c.op === 'insert' || c.op === 'update')).length, 0, 'что-то сохранилось');
  done();
});

test('CRM_DUP_SHEET_V1: «Создать всё равно» по номеру помнится и после выбора пациента — второй раз не спрашивают', async () => {
  S.dups = [DUP];
  S.failInsertOnce = true;   // первая вставка не прошла — окно новой заявки осталось открытым
  const modal = await newRequestModal();
  button(modal, /Создать заявку/).click();
  await tick(60);
  button(dupDialog(), /Создать всё равно/).click();
  await tick(60);
  assert.equal(S.inserted, null);
  // Теперь оператор находит пациента в базе через поле ФИО.
  S.patients = [{ id: 3, full_name: 'Буронова Феруза', mrn: 'M-3', phone: '915662278' }];
  const nameInp = walk(modal).find((n) => n.tagName === 'INPUT' && /Фамилия Имя/.test(n.getAttribute('placeholder') || ''));
  nameInp.value = 'Буронова';
  nameInp.dispatchEvent({ type: 'input', target: nameInp, currentTarget: nameInp });
  await tick(350);
  const hit = walk(modal).find((n) => n.tagName === 'DIV' && n._l && n._l.mousedown && textOf(n).startsWith('Буронова Феруза'));
  assert.ok(hit, 'пациент не нашёлся в поле ФИО');
  hit.dispatchEvent({ type: 'mousedown', target: hit, currentTarget: hit, preventDefault() {} });
  await tick(30);
  button(modal, /Создать заявку/).click();
  await tick(60);
  assert.equal(dupDialog(), undefined, 'после выбора пациента вопрос «Создать всё равно» задан второй раз');
  assert.equal(RPC.filter((r) => r.name === 'crm_leads_by_phone').length, 1);
  assert.ok(S.inserted, 'заявка не создана');
  assert.equal(S.inserted.patient_id, 3);
  S.patients = undefined;
  done();
});

test('CRM_DUP_SHEET_V1: ответ, данный за ОДНОГО пациента, на другого не переносится', async () => {
  S.dups = [DUP];
  S.failInsertOnce = true;
  S.patients = [{ id: 3, full_name: 'Буронова Феруза', mrn: 'M-3', phone: '915662278' }];
  const modal = await newRequestModal();
  const nameInp = walk(modal).find((n) => n.tagName === 'INPUT' && /Фамилия Имя/.test(n.getAttribute('placeholder') || ''));
  nameInp.value = 'Буронова';
  nameInp.dispatchEvent({ type: 'input', target: nameInp, currentTarget: nameInp });
  await tick(350);
  walk(modal).find((n) => n.tagName === 'DIV' && n._l && n._l.mousedown && textOf(n).startsWith('Буронова Феруза'))
    .dispatchEvent({ type: 'mousedown', preventDefault() {} });
  await tick(30);
  button(modal, /Создать заявку/).click();
  await tick(60);
  button(dupDialog(), /Создать всё равно/).click();
  await tick(60);
  assert.equal(S.inserted, null);
  // Отвязали и выбрали другого человека с тем же номером — это другой вопрос.
  const unlink = walk(modal).find((n) => n.tagName === 'BUTTON' && /Отвязать/.test(n.attrs.title || ''));
  assert.ok(unlink, 'нет кнопки «Отвязать»');
  unlink.click();
  S.patients = [{ id: 4, full_name: 'Буронов Акмал', mrn: 'M-4', phone: '915662278' }];
  nameInp.value = 'Буронов';
  nameInp.dispatchEvent({ type: 'input', target: nameInp, currentTarget: nameInp });
  await tick(350);
  walk(modal).find((n) => n.tagName === 'DIV' && n._l && n._l.mousedown && textOf(n).startsWith('Буронов Акмал'))
    .dispatchEvent({ type: 'mousedown', preventDefault() {} });
  await tick(30);
  button(modal, /Создать заявку/).click();
  await tick(60);
  assert.ok(dupDialog(), 'ответ за одного пациента перенесён на другого');
  button(dupDialog(), /^Отмена$/).click();
  await tick(30);
  S.patients = undefined;
  done();
});

// CRM_DUP_CARRY_DOCTOR_V1 (3.22.0, ревью) — консультация по виду приёма, перенесённая
// «Открыть и добавить услуги», теряла врача, но сохраняла цену, выбранную под этого
// врача. Теперь врач едет вместе со строкой, а цена пересчитывается в открытой
// карточке правилом кассы (consultPriceOf) — для этого врача.
// В 3.22.0 новая заявка консультаций не набирает (виды приёма грузятся только у
// открытой карточки), поэтому проверка — по исходнику: путь заперт на будущее.
test('CRM_DUP_CARRY_DOCTOR_V1: перенесённая консультация едет со своим врачом и ценой по правилу кассы', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../views/crm.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function confirmNoDuplicate(');
  const fn = src.slice(at, src.indexOf('async function persist()', at));
  assert.match(fn, /const carry = [\s\S]*?doctor_id: [^,]*p\.doctor_id/, 'врач консультации не попадает в перенос');
  const mergeAt = src.indexOf('const carried = (prefill && Array.isArray(prefill.addServices))');
  assert.ok(mergeAt > -1, 'приём переноса не найден');
  const merge = src.slice(mergeAt, src.indexOf('linesLoaded = true;', mergeAt));
  assert.match(merge, /doctor_id: c\.doctor_id/, 'перенесённая консультация приходит без врача');
  assert.match(merge, /consultPriceOf\(c\)/, 'цена перенесённой консультации не пересчитана правилом кассы');
});
