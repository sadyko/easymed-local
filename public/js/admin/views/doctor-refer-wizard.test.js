import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DOCTOR_REFER_WIZARD_V1 (2026-09-16) — владелец: «направление на услуги — это
// какая-то старая версия, можно тот же мастер, что в регистратуре?».
//
// ЧТО БЫЛО. Кнопка «Направить на услуги» в кабинете врача открывала свой,
// отдельный выбор услуг (service-picker-modal.js), а регистратура записывает
// пациента мастером visit-wizard.js. Два окна для одного дела расходились:
// цена по кратности визита, скидки пациента, шаблоны сметы и выбор времени у
// врача были только в одном из них.
//
// ЧТО ДЕРЖИТ ЭТОТ ТЕСТ (текстом файлов — экраны тянут DOM и supabase, тот же
// приём, что в visit-bill-origin.test.js):
//   1. кабинет зовёт openVisitWizard, а не старый выбор услуг;
//   2. мастер отчитывается о записанном (onSaved получает rows) — по этому
//      списку кабинет печатает «Маршрутный лист»;
//   3. маршрутный лист печатается НЕ типом 'lab': бланк результатов клиника
//      оформляет своим макетом, который рисуется раньше нашего текста, и лист
//      выходил демо-бланком анализов с чужой фамилией;
//   4. право выставить счёт мастер спрашивает у ролей — зеркало
//      CREATE_INVOICE_ROLES на сервере. REFERRAL_BILL_V1 (2026-09-29) —
//      решение владельца: врач и главный врач теперь выставляют счёт по
//      направлению (зеркало DOCTOR_INVOICE_ROLES), но плательщика и ручную
//      скидку в него не ставят — прежняя проверка «у врача права нет»
//      переписана под это правило.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.readFileSync(path.join(HERE, 'service-workspace.js'), 'utf8');
const wiz = fs.readFileSync(path.join(HERE, 'visit-wizard.js'), 'utf8');
const billing = fs.readFileSync(
  path.join(HERE, '..', '..', '..', '..', 'server', 'services', 'rpc', 'billing.js'), 'utf8');

test('кабинет врача открывает мастер регистратуры, а не старый выбор услуг', () => {
  const at = ws.indexOf('function openReferralWizard');
  assert.ok(at > 0, 'openReferralWizard есть в кабинете');
  const body = ws.slice(at, at + 900);
  assert.match(body, /visit-wizard\.js/, 'зовётся именно мастер визита');
  assert.match(body, /openVisitWizard/, 'через openVisitWizard');
  assert.match(body, /printRouteSheet/, 'и печатает маршрутный лист по ответу мастера');

  // кнопка в панели действий бланка ведёт туда же
  const bar = ws.indexOf("tr('Направить на услуги')");
  assert.ok(bar > 0, 'кнопка «Направить на услуги» на месте');
  const line = ws.slice(bar, ws.indexOf('\n', bar + 60));
  assert.match(line, /openReferralWizard/, 'кнопка открывает мастер');
  assert.ok(!/openServicePickerModal/.test(line), 'и не старый выбор услуг');
});

test('мастер визита возвращает записанные строки — иначе печатать лист не по чему', () => {
  assert.match(wiz, /booked\.push\(\{/, 'мастер собирает записанное');
  assert.match(wiz, /visit_service_id:\s*res\.data\.id/, 'с id строки услуги');
  const at = wiz.indexOf("if (typeof onSaved === 'function')");
  assert.ok(at > 0, 'onSaved вызывается');
  const call = wiz.slice(at, at + 320);
  assert.match(call, /rows:\s*booked/, 'и получает список строк');
});

test('маршрутный лист печатается своим текстом, а не бланком анализов', () => {
  const at = ws.indexOf('async function printRouteSheet');
  assert.ok(at > 0);
  const body = ws.slice(at, ws.indexOf('async function sendReferral'));
  assert.match(body, /type:\s*'case_doc'/, "тип печати — 'case_doc'");
  assert.ok(!/type:\s*'lab'/.test(body), "тип 'lab' перехватывается макетом клиники");
  assert.match(body, /label:\s*tr\('Пациент'\)/, 'в шапке есть пациент (объектом, иначе поле молча теряется)');
});

test('право выставить счёт в мастере — зеркало сервера', () => {
  const norm = (s) => s.split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  const mirror = wiz.match(/const INVOICE_ROLES = \[([^\]]+)\]/);
  assert.ok(mirror, 'в мастере объявлен список ролей');
  const server = billing.match(/const CREATE_INVOICE_ROLES = \[([^\]]+)\]/);
  assert.ok(server, 'на сервере объявлен CREATE_INVOICE_ROLES');
  assert.deepEqual(norm(mirror[1]), norm(server[1]), 'экран и сервер называют одни и те же денежные роли');
  assert.ok(!norm(server[1]).includes('doctor'), 'денежные роли (скидка, плательщик) — без врача');
  // REFERRAL_BILL_V1 — врач и главный врач выставляют счёт по направлению сами.
  const docMirror = wiz.match(/const DOCTOR_INVOICE_ROLES = \[([^\]]+)\]/);
  const docServer = billing.match(/const DOCTOR_INVOICE_ROLES = \[([^\]]+)\]/);
  assert.ok(docMirror && docServer, 'список врачебных ролей счёта объявлен и в мастере, и на сервере');
  assert.deepEqual(norm(docMirror[1]), norm(docServer[1]), 'экран и сервер называют одни и те же врачебные роли');
  assert.deepEqual(norm(docServer[1]), ['doctor', 'head_doctor'], 'решение владельца: врач и главный врач');
  assert.match(wiz, /const canInvoice = moneyRole \|\| hasActorRole\(DOCTOR_INVOICE_ROLES\)/, 'врачу галочка «сразу выставить счёт» есть');
  assert.match(wiz, /raiseInvoice:\s*canInvoice/, 'галочка «сразу выставить счёт» зависит от роли');
  // Плательщика врач не выбирает: выбор — от денежной роли, а не от права на счёт.
  assert.match(wiz, /const canPickPayer = moneyRole \|\| hasActorRole\(PATIENT_PAYER_ROLES\)/, '«Кто платит» у врача снова появился бы');
});
