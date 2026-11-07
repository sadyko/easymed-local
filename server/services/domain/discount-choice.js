// DISCOUNT_V2 (решения владельца 2026-11-07, п. 4 и 5) — ОДНА СКИДКА НА СЧЁТ, И СЧЁТ
// ЗНАЕТ, КАКАЯ И ПОЧЕМУ.
//
// Окно добавления услуг у стойки (мастер визита, быстрая регистрация, калькулятор)
// показывает все скидки, которые подходят пациенту: скидку группы («Группа VIP —
// 10%»), промокоды клиники, «вручную» — и регистратор выбирает ОДНУ («Без скидки» —
// тоже выбор). Скидки не складываются. Сервер здесь проверяет выбор и считает
// деньги сам — экран лишь называет, что выбрано:
//   • choice не передан (прежние экраны, касса, врач) — правило 3.21: пол группы
//     пациента, присланное — не меньше пола (max);
//   • 'group'  — ровно скидка группы (пол); присланное сверх неё не берётся;
//   • 'manual' — присланная сумма, но не меньше пола группы (как 3.21);
//   • 'none'   — без скидки: и пол группы не ложится;
//   • 'promo'  — промокод discount_id: действует сегодня, для группы пациента, на
//     услуги счёта (discount-rules.js — то же правило, что у экрана); скидка — не
//     больше его стоимости на строках счёта без своей скидки; пол группы не
//     ложится (одна скидка).
// Счёт плательщику скидок пациента не получает (BILLING_AUDIT_FIX_V1 B5).
//
// Счёт запоминает (мигр. 273): discount_source — что выбрано ('group' | 'manual' |
// 'none' | 'promo:<id>'; NULL — как до 3.22), discount_note — причина словами для
// кассы и истории, doctor_discount_share — какая доля скидки счёта (без скидок
// пакета и без скидки после продажи) уменьшает долю врача: переключатель «Скидка
// уменьшает долю врача» выбранной скидки (1 — уменьшает, как всегда было; 0 —
// клиника берёт скидку на себя, врач получает от цены до скидки).
import { discountBlockReason, discountValue, isStoredValueCard } from '../../../public/js/admin/discount-rules.js';
import { withTemplate } from '../server-message.js';   // собранная фраза переводится на экране
import { hasRates } from '../../../public/js/admin/discount-rates.js';   // DISCOUNT_RATES_V1

const round2 = (n) => Math.round(n * 100) / 100;
const pctText = (p) => String(Math.round(Number(p) * 100) / 100).replace('.', ',') + '%';
const moneyText = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export class DiscountChoiceError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const DISCOUNT_CHOICES = Object.freeze(['group', 'manual', 'none', 'promo']);

/** Группа пациента со скидкой: { id, name, pct, reduces } или null (выключена, без процента). */
export function patientGroupDiscount(db, patientId) {
  const id = Number(patientId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.prepare(`SELECT c.id, c.name, c.discount_percent AS pct, c.reduces_doctor_share AS reduces, c.discount_rates AS rates
                            FROM patients p JOIN patient_categories c ON c.id = p.category_id AND c.active = 1
                           WHERE p.id = ?`).get(id);
  if (!row) return null;
  const pct = Number(row.pct);
  // DISCOUNT_RATES_V1 — группа со ставками по услугам скидку даёт и при 0 % «по умолчанию»
  // («Консультации — 100 %, остальное — без скидки»).
  const rated = hasRates(row.rates);
  if ((!Number.isFinite(pct) || pct <= 0) && !rated) return null;
  return { id: row.id, name: row.name || '', pct: Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0, reduces: Number(row.reduces) === 0 ? 0 : 1,
    rates: rated ? row.rates : null };
}

/** Причина скидки группы словами: «Скидка группы «VIP» — 10%». */
export function groupNote(group) {
  return group ? `Скидка группы «${group.name}» — ${pctText(group.pct)}` : null;
}

function promoNote(row) {
  const pct = Number(row.percent) || 0;
  return `Промокод «${row.name}» — ${pct > 0 ? pctText(pct) : moneyText(row.amount) + ' сум'}`;
}

function parseIds(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

/**
 * Проверенный выбор скидки счёта.
 * @param {object} a  { choice, discountId, patientId, payerSet, today, restLines: [{service_id, total}] }
 *   restLines — строки счёта БЕЗ своей скидки (пакета): на них ложится скидка счёта.
 * @returns {{ choice: string|null, floorPct: number, cap: number|null, source: string|null,
 *            note: string|null, reducesFloor: number, reducesChosen: number }}
 *   floorPct — процент пола группы (0 — пол не ложится); cap — потолок скидки сверх
 *   пола (null — без потолка, только база); reducesFloor/reducesChosen — переключатель
 *   «уменьшает долю врача» у пола группы и у выбранной скидки.
 */
export function resolveDiscountChoice(db, a) {
  const choice = a.choice == null || a.choice === '' ? null : String(a.choice);
  if (choice !== null && !DISCOUNT_CHOICES.includes(choice)) throw new DiscountChoiceError('Скидка выбрана неверно.');
  const group = a.payerSet ? null : patientGroupDiscount(db, a.patientId);
  const floorOf = (g) => (g ? g.pct : 0);
  if (choice === null) {
    return { choice, floorPct: floorOf(group), cap: null, source: null, note: groupNote(group),
      reducesFloor: group ? group.reduces : 1, reducesChosen: 1, group };
  }
  if (choice === 'none' || (choice === 'group' && !group)) {
    return { choice: 'none', floorPct: 0, cap: 0, source: 'none', note: null, reducesFloor: 1, reducesChosen: 1, group };
  }
  if (choice === 'group') {
    return { choice, floorPct: group.pct, cap: 0, source: 'group', note: groupNote(group),
      reducesFloor: group.reduces, reducesChosen: group.reduces, group };
  }
  if (choice === 'manual') {
    return { choice, floorPct: floorOf(group), cap: null, source: 'manual', note: 'Скидка вручную',
      reducesFloor: group ? group.reduces : 1, reducesChosen: 1, group };
  }
  // promo
  // DISCOUNT_V2 (ревью S1 L-5) — счёт плательщику скидок пациента не получает (BILLING_AUDIT_FIX_V1 B5):
  // промокод пациента туда не кладётся. Ручная сумма — как в 3.21 (выше), «группа» — без скидки.
  if (a.payerSet) throw new DiscountChoiceError('Промокод пациента на счёт плательщика не ложится — выберите «Без скидки» или скидку суммой.');
  const id = Number(a.discountId);
  if (!Number.isInteger(id) || id <= 0) throw new DiscountChoiceError('Промокод не выбран.');
  const row = db.prepare('SELECT * FROM patient_discounts WHERE id = ?').get(id);
  if (!row || isStoredValueCard(row)) throw new DiscountChoiceError('Промокод не найден.');
  const cat = db.prepare('SELECT category_id FROM patients WHERE id = ?').get(Number(a.patientId));
  const lines = a.restLines || [];
  const why = discountBlockReason({ ...row, service_ids: parseIds(row.service_ids) }, {
    today: a.today, categoryId: cat ? cat.category_id : null, serviceIds: lines.map((l) => Number(l.service_id)),
  });
  if (why) {
    const T = { inactive: 'Промокод «{name}» выключен в настройках.', not_yet: 'Промокод «{name}» ещё не действует.',
      expired: 'Срок промокода «{name}» истёк.', other_group: 'Промокод «{name}» — только для другой группы пациентов.',
      no_matching_service: 'Промокод «{name}» действует на другие услуги.' };
    throw withTemplate(new DiscountChoiceError(''), T[why] || T.inactive, { name: row.name });
  }
  const cap = round2(discountValue({ ...row, service_ids: parseIds(row.service_ids) }, lines));
  return { choice, floorPct: 0, cap, source: 'promo:' + row.id, note: promoNote(row),
    reducesFloor: 1, reducesChosen: Number(row.reduces_doctor_share) === 0 ? 0 : 1, group };
}

/**
 * Скидка остатка счёта (строки без своей скидки) по выбору и что из неё уменьшает
 * долю врача.
 * @param r     resolveDiscountChoice(...)
 * @param sent  присланная скидка (≥ 0)
 * @param base  сумма строк без своей скидки
 * @returns {{ rest: number, floor: number, given: number, share: number, note: string|null }}
 *   given — «ручная» часть, как её дали (invoices.manual_discount, мигр. 219).
 */
export function restDiscountOf(r, sent, base) {
  const floor = round2(base * r.floorPct / 100);
  let rest;
  if (r.choice === 'none') rest = 0;
  // Группа — пол группы; присланное (экран округляет до сума) — не выше пола, округлённого вверх до сума.
  else if (r.choice === 'group') rest = round2(Math.min(Math.max(Number(sent) || 0, floor), Math.ceil(floor - 1e-9)));
  else if (r.choice === 'promo') rest = round2(Math.min(Math.max(Number(sent) || 0, 0), r.cap == null ? base : r.cap));
  else rest = round2(Math.max(Number(sent) || 0, floor));   // прежнее правило и «вручную»
  rest = round2(Math.min(rest, base));
  const floorWins = rest > 0 && floor > 0 && rest <= Math.ceil(floor - 1e-9) + 0.005;   // пол группы, округлённый экраном до сума, — тоже группа
  const share = rest <= 0 ? 1 : (floorWins ? r.reducesFloor : r.reducesChosen);
  // Причина: выбран промокод — он; скидка не больше пола группы — группа; иначе — вручную.
  let note = null;
  if (rest > 0) {
    if (r.choice === 'promo') note = r.note;
    else if (floorWins) note = groupNote(r.group);
    else note = 'Скидка вручную';
  }
  const given = r.choice === 'group' || r.choice === 'none' ? 0 : round2(Math.min(Math.max(Number(sent) || 0, 0), base));
  return { rest, floor, given: r.choice === 'promo' ? rest : given, share, note };
}

/** Ложится ли пол группы пациента на этот счёт при пересчёте строк (NULL / группа / вручную — да). */
export function floorApplies(inv) {
  const s = inv && inv.discount_source;
  return s == null || s === '' || s === 'group' || s === 'manual';
}
