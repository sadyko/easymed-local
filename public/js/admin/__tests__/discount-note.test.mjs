// DISCOUNT_V2 (3.22.0, ревью S1 L-4) — причина скидки счёта (invoices.discount_note) на
// языке экрана: неизменные части сервера — словарём, имена и причина кассира — как ввели.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { documentElement: {}, createElement: () => ({ style: {} }) };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const { setLang } = await import('../i18n.js');
const { discountNoteText } = await import('../discount-note.js');

// Записи сервера — дословно как их собирают domain/discount-choice.js и billing.js.
const GROUP = 'Скидка группы «VIP» — 10%';
const GROUP_FRAC = 'Скидка группы «Пенсионеры» — 12,5%';
const PROMO_PCT = 'Промокод «ЛЕТО» — 15%';
const PROMO_SUM = 'Промокод «ВЕСНА» — 20 000 сум';
const MANUAL = 'Скидка вручную';
const DESK_PCT = 'Касса: постоянный пациент — 5% — 4 500 сум';
const DESK_SUM_OFF = 'Касса: жалоба — сроки — 30 000 сум (доля врача — от цены до скидки)';

test('ru: запись сервера показывается как есть', () => {
  setLang('ru');
  for (const n of [GROUP, GROUP_FRAC, PROMO_PCT, PROMO_SUM, MANUAL, DESK_PCT, DESK_SUM_OFF, GROUP + '; ' + DESK_PCT]) {
    assert.equal(discountNoteText(n), n);
  }
  assert.equal(discountNoteText(null), '');
  assert.equal(discountNoteText(''), '');
});

test('en: неизменные части — по-английски, имена и причина кассира — как ввели', () => {
  setLang('en');
  try {
    assert.equal(discountNoteText(GROUP), 'Group «VIP» discount — 10%');
    assert.equal(discountNoteText(GROUP_FRAC), 'Group «Пенсионеры» discount — 12,5%');
    assert.equal(discountNoteText(PROMO_PCT), 'Promo code «ЛЕТО» — 15%');
    assert.equal(discountNoteText(PROMO_SUM), 'Promo code «ВЕСНА» — 20 000 UZS');
    assert.equal(discountNoteText(MANUAL), 'Manual discount');
    assert.equal(discountNoteText(DESK_PCT), 'Cashier: постоянный пациент — 5% — 4 500 UZS');
    assert.equal(discountNoteText(DESK_SUM_OFF), 'Cashier: жалоба — сроки — 30 000 UZS (doctor’s share — from the price before the discount)');
    assert.equal(discountNoteText(GROUP + '; ' + DESK_PCT), 'Group «VIP» discount — 10%; Cashier: постоянный пациент — 5% — 4 500 UZS');
    assert.equal(discountNoteText('Что-то от другой версии'), 'Что-то от другой версии', 'незнакомая часть — как есть');
  } finally { setLang('ru'); }
});

test('uz: те же части — по-узбекски, без кириллицы в неизменном тексте', () => {
  setLang('uz');
  try {
    const out = [GROUP, PROMO_PCT, PROMO_SUM, MANUAL, DESK_PCT, DESK_SUM_OFF].map(discountNoteText);
    for (const [i, s] of out.entries()) {
      const fixed = s.replace(/«[^»]*»/g, '').replace(/постоянный пациент|жалоба — сроки/g, '');
      assert.ok(!/[А-Яа-яЁё]/.test(fixed), 'кириллица в узбекском тексте: ' + s + ' (часть ' + i + ')');
    }
    assert.match(out[4], /постоянный пациент/, 'причина кассира потерялась');
  } finally { setLang('ru'); }
});

test('касса показывает причину скидки через discountNoteText, а не сырую запись', () => {
  const src = fs.readFileSync(new URL('../views/cashier-desk.js', import.meta.url), 'utf8');
  assert.ok(!/\binv\.discount_note\s*\+|,\s*inv\.discount_note\)/.test(src), 'сырая discount_note в разметке кассы');
  assert.ok((src.match(/discountNoteText\(inv\.discount_note\)/g) || []).length >= 2, 'не везде через discountNoteText');
});

// Ревью S5 L-1 — причина скидки по ставкам (domain/discount-rates.js ratedNote): «— по услугам
// (по умолчанию N%)». Прежде на en/uz она показывалась по-русски.
const RATED_GROUP = 'Скидка группы «Сотрудники» — по услугам (по умолчанию 20%)';
const RATED_PROMO = 'Промокод «ЛЕТО» — по услугам (по умолчанию 12,5%)';

test('ревью S5 L-1: скидка по ставкам — ru как есть; en/uz — переведена, имя как ввели', () => {
  setLang('ru');
  assert.equal(discountNoteText(RATED_GROUP), RATED_GROUP);
  assert.equal(discountNoteText(RATED_PROMO + '; ' + DESK_PCT), RATED_PROMO + '; ' + DESK_PCT);
  setLang('en');
  try {
    assert.equal(discountNoteText(RATED_GROUP), 'Group discount «Сотрудники» — by service (default 20%)');
    assert.equal(discountNoteText(RATED_PROMO), 'Promo code «ЛЕТО» — by service (default 12,5%)');
    assert.equal(discountNoteText(RATED_GROUP + '; ' + DESK_PCT), 'Group discount «Сотрудники» — by service (default 20%); Cashier: постоянный пациент — 5% — 4 500 UZS');
    setLang('uz');
    for (const n of [RATED_GROUP, RATED_PROMO]) {
      const s = discountNoteText(n);
      assert.ok(!/[А-Яа-яЁё]/.test(s.replace(/«[^»]*»/g, '')), 'кириллица в узбекском тексте: ' + s);
      assert.match(s, n === RATED_GROUP ? /20%/ : /12,5%/);
    }
  } finally { setLang('ru'); }
});

// DISCOUNT_CHANGE_PAID_V1 (3.23.0) — след «Изменить скидку» после оплаты (rpc/billing.js
// discountChangeTx): «Касса после оплаты: <причина> — было X% (A сум), стало Y% (B сум)» и
// пометка доли врача (целиком или частично от цены до скидки).
const CHANGE = 'Касса после оплаты: акция — было 20% (40 000 сум), стало 50% (100 000 сум)';
const CHANGE_PART = 'Касса после оплаты: жалоба — было 20% (40 000 сум), стало 33,33% (66 660 сум) (доля врача — частично от цены до скидки)';
const CHANGE_OFF = 'Касса после оплаты: ошибка — было 0% (0 сум), стало 10% (20 000 сум) (доля врача — от цены до скидки)';

test('DISCOUNT_CHANGE_PAID_V1: ru — как есть; en и uz — неизменные части словарём, причина — как ввели', () => {
  setLang('ru');
  assert.equal(discountNoteText(DESK_PCT + '; ' + CHANGE), DESK_PCT + '; ' + CHANGE);
  setLang('en');
  try {
    assert.equal(discountNoteText(CHANGE), 'Cash desk after payment: акция — was 20% (40 000 UZS), now 50% (100 000 UZS)');
    assert.equal(discountNoteText(CHANGE_PART), "Cash desk after payment: жалоба — was 20% (40 000 UZS), now 33,33% (66 660 UZS) (the doctor's share is partly from the price before the discount)");
    assert.match(discountNoteText(CHANGE_OFF), /^Cash desk after payment: ошибка — was 0% \(0 UZS\), now 10% \(20 000 UZS\) \(/);
    assert.doesNotMatch(discountNoteText(CHANGE_OFF).replace('ошибка', ''), /[Ѐ-ӿ]/, 'русское слово в английской записи');
    setLang('uz');
    assert.doesNotMatch(discountNoteText(CHANGE_PART).replace('жалоба', ''), /[Ѐ-ӿ]/, 'русское слово в узбекской записи');
  } finally { setLang('ru'); }
});
