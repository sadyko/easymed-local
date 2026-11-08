// CRM_DUP_BEFORE_SCHEDULE_V1 (2026-11-07) — вопрос «У этого номера уже есть
// карточка» задаётся ДО окна «Даты приёма», а не из-под него.
//
// Владелец, по снимку: «When I save, main function is appearing on a back side».
// Оператор выбирал пациента, жал «Записать на дату», расставлял врача и дату и
// нажимал «Сохранить и записать». Только тогда persist() спрашивал о дубле — и
// окно вопроса (z-index 100, обычный .modal) открывалось ПОД окном дат
// (z-index 160). Кнопка «Сохранить и записать» серела, ничего не происходило,
// а вопрос, которого ждала программа, был не виден.
//
// Две правки, обе проверяются здесь:
//   1. вопрос о дубле задаётся по нажатию «Записать на дату», до окна дат и до
//      окна заведения карты — тогда ответ уже есть, и persist() не спрашивает
//      второй раз (dupAckKey);
//   2. окно вопроса в любом случае рисуется поверх окна дат — страховка на
//      случай, если спросить придётся из-под него.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './crm-harness.mjs';

const { askDuplicateLead } = await import('../views/crm.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'crm.js'), 'utf8');

function sheetZ() {
  const at = src.indexOf('function openScheduleSheet()');
  assert.ok(at > -1, 'openScheduleSheet есть');
  const m = /zIndex: '(\d+)'/.exec(src.slice(at, at + 300));
  assert.ok(m, 'у окна дат свой z-index');
  return Number(m[1]);
}

test('окно «У этого номера уже есть карточка» рисуется поверх окна «Даты приёма»', async () => {
  document.body.children.length = 0;
  const p = askDuplicateLead([{ id: 1, full_name: 'X', can_open: true, created_at: '2026-11-01' }]);
  const ov = document.body.children.find((n) => n.attrs && 'data-crm-dup' in n.attrs);
  assert.ok(ov, 'окно вопроса не открылось');
  const z = Number(ov.style && ov.style.zIndex);
  assert.ok(z > sheetZ(), `z-index вопроса (${z}) должен быть выше окна дат (${sheetZ()})`);
  walkClose(ov);
  await p;
});

test('«Записать на дату» спрашивает о дубле ДО окна дат и до окна заведения карты', () => {
  const at = src.indexOf("scheduleBtn.addEventListener('click'");
  assert.ok(at > -1, 'обработчик «Записать на дату» на месте');
  const body = src.slice(at, src.indexOf('function openScheduleSheet()', at));
  const ask = body.indexOf('dupCheckBeforeSchedule(');
  assert.ok(ask > -1, 'по нажатию «Записать на дату» о дубле не спрашивают');
  const helper = src.slice(src.indexOf('async function dupCheckBeforeSchedule('), at);
  assert.ok(helper.includes('confirmNoDuplicate('), 'помощник задаёт тот же вопрос, что и persist()');
  const firstSheet = body.indexOf('openScheduleSheet()');
  const firstReg = body.indexOf('patientRegistrationModal(');
  assert.ok(ask < firstSheet, 'вопрос о дубле — раньше окна дат');
  assert.ok(ask < firstReg, 'вопрос о дубле — раньше окна заведения карты');
});

function walkClose(ov) {
  const stack = [ov];
  while (stack.length) {
    const n = stack.pop();
    if (n.tagName === 'BUTTON' && /Отмена/.test((n.children || []).map((c) => c._t || '').join('') + (n._t || ''))) { n.click(); return; }
    for (const c of n.children || []) stack.push(c);
  }
  ov.remove && ov.remove();
}

// CRM_DUP_SAME_PATIENT_V1 (2026-11-08) — выбран пациент: проверка спрашивает о
// заявках ЭТОГО пациента (patient_id), а не обо всех на номере. Сервер это
// проверяет поведением (crm-leads.test.js); здесь — что окно его передаёт.
test('проверка дубля передаёт выбранного пациента, и ответ помнится для пары номер + пациент', () => {
  const at = src.indexOf('async function confirmNoDuplicate(');
  const fn = src.slice(at, src.indexOf('async function persist()', at));
  assert.ok(fn.includes("{ phone, patient_id: linkedPatient.id }"), 'patient_id не уходит в crm_leads_by_phone');
  assert.ok(fn.includes("digits + '|' +"), 'ключ ответа «создать всё равно» не учитывает пациента');
});
