// DOCTOR_REFERRAL_DESK_V1 · REFERRAL_LINE_V1 — мастер визита и окно визита (текстом файлов:
// экраны тянут DOM и supabase — тот же приём, что в doctor-refer-wizard.test.js). Поведение
// двери — на сервере (server/routes/doctor-referral-desk.test.js, referral-line-stamp.test.js),
// окна стойки — на настоящем сервере (__tests__/doctor-orders-desk-live.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wiz = fs.readFileSync(path.join(HERE, 'visit-wizard.js'), 'utf8');
const slice = (src, from, len) => {
  const at = src.indexOf(from);
  assert.ok(at >= 0, 'не найдено: ' + from);
  return src.slice(at, at + len);
};

test('строка мастера несёт направившего стойки и рекомендацию врача; строка из рекомендации — без явного источника', () => {
  const body = slice(wiz, 'if (uid != null) row.created_by = uid;', 900);
  assert.match(body, /const lineSrc = lineReferralSource\(\);/);
  assert.match(body, /if \(lineSrc && !c\.fromRec\) row\.referred_by_source_id = lineSrc;/);
  assert.match(body, /row\.referral_note = /);
});

test('после вставки строки из рекомендации мастер зовёт referral_recommendation_attach', () => {
  assert.match(slice(wiz, 'lineByVsId.set(res.data.id, c);', 700), /referral_recommendation_attach/);
});

test('«Направления врача» — только у стойки и раньше строк «из записи»', () => {
  assert.match(wiz, /if \(!referralMode\) await prefillFromDoctorOrders\(\);[^\n]*\n\s*await prefillFromBooking\(\);/);
  assert.match(slice(wiz, 'async function prefillFromBooking() {', 1500), /wiz\.doctorOrderVsIds && wiz\.doctorOrderVsIds\.has\(Number\(r\.vsId\)\)/);
});

test('убранная из сметы строка направления врача не снимается с визита', () => {
  assert.match(slice(wiz, 'function removeCartLine(c) {', 400), /c\.booked && !c\.booked\.doctorOrder/);
});

test('поле «Рекомендация для регистратуры» — только в мастере направления врача', () => {
  const at = wiz.indexOf("tr('Рекомендация для регистратуры')");
  assert.ok(at > 0, 'поля нет');
  assert.match(wiz.slice(Math.max(0, at - 1500), at), /if \(referralMode\) \{/);
});

test('строки направления врача и рекомендации подписаны в смете', () => {
  assert.match(wiz, /'data-doctor-order-line'/);
  assert.match(wiz, /'data-rec-line'/);
  assert.match(wiz, /'data-doctor-orders'/);
});

const modal = fs.readFileSync(path.join(HERE, 'visit-modal.js'), 'utf8');

test('окно визита: рекомендацию закрывает сервер (referral_recommendation_attach) по номеру вставленной строки', () => {
  const body = slice(modal, 'async function attachRecommendation(', 4500);
  // DUP_STOP_V1 — строка уходит с причиной обхода (withRepeatReason), если её назвал администратор.
  assert.match(body, /from\('visit_services'\)\.insert\(withRepeatReason\(\{[\s\S]*?\}, pre\.reason\)\)\.select\(\)\.single\(\)/);
  assert.match(body, /referral_recommendation_attach/);
  assert.match(body, /visit_set_doctor_referrer[\s\S]*referral_recommendation_attach/, 'направивший визита — до закрытия рекомендации (он требует открытую)');
});

// DUP_STOP_V1 — «Add to visit» из рекомендации — та же проверка повтора, что у каталога окна:
// правило сервера (visit_dup_check), а не «та же услуга где-то в окне»: отменённая и
// возвращённая строка не мешают, администратор и главный врач назначают повтор с причиной.
test('окно визита: повтор рекомендации — правило сервера (visit_dup_check), а не список строк окна', () => {
  const open = slice(modal, 'async function openAttachRecommendationModal(', 1500);
  assert.match(open, /await attachExcludeIds\(state\.visit\.id\)/);
  assert.ok(!/state\.services \|\| \[\]\)\.some\(s => s\.service_id === rec\.service_id\)/.test(open), 'окно гасит по любой строке той же услуги');
  const att = slice(modal, 'async function attachRecommendation(', 2500);
  assert.match(att, /const pre = await precheckOrders\(\{ visitId: state\.visit\.id, lines: \[/);
  assert.ok(!/state\.services \|\| \[\]\)\.some\(s => s\.service_id === rec\.service_id\)/.test(att), 'вставка гасит по любой строке той же услуги');
});

// Ревью U10 MEDIUM-2 — отказ привязки: окно визита не закрывает рекомендацию правкой статуса
// (молча, без строки и с направившим того, кто вставил), а предупреждает; рекомендация открыта.
test('окно визита: отказ привязки — предупреждение, рекомендация не закрывается правкой статуса', () => {
  const att = slice(modal, 'async function attachRecommendation(', 4500);
  const tail = att.slice(att.indexOf("supabase.rpc('referral_recommendation_attach'"));
  assert.ok(!/from\('recommended_services'\)[\s\S]*?\.update\(\{ status: 'done'/.test(tail.slice(0, 1500)), 'рекомендация закрывается молча правкой статуса');
  assert.match(tail, /trf\('Услуга добавлена в визит, но рекомендация врача не закрыта: \{msg\}'/);
  assert.match(tail, /'warn'\)/);
});

// Ревью U10 LOW-7 — у рекомендации врач-рекомендатель получает бонус только если выполняет
// другой врач: оба окна стойки отдают подписи условие сервера (bonus_if_other).
test('«Бонус» рекомендации в обоих окнах стойки — с условием сервера bonus_if_other', () => {
  assert.match(wiz, /bonusText\(r\.bonus_to, r\.bonus_if_other\)/);
  const fast = fs.readFileSync(path.join(HERE, 'fast-registration.js'), 'utf8');
  assert.match(fast, /bonusText\(r\.bonus_to, r\.bonus_if_other\)/);
});
