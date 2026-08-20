// ACCOMMODATION_AS_SERVICE_V1 — строка проживания в списке услуг стационара.
//
// Внесённое проживание — это строка admission_services без service_id и без
// clinic_item_id. Список услуг подписывает такие строки как «(removed)», то
// есть как удалённую из каталога услугу: пользователь видит сумму, за которой
// якобы ничего нет. Название у проживания своё, и оно переводится.
//
// Метка живёт в public/js/shared, потому что notes пишет СЕРВЕР, а читает
// БРАУЗЕР. Две копии строки разошлись бы молча — строка просто перестала бы
// узнаваться, и в счёте снова появился бы «(removed)».

import { test } from 'node:test';
import assert from 'node:assert';
import {
    ACCOMMODATION_NOTE_PREFIX, ACCOMMODATION_LABEL, isAccommodationLine,
} from '../../shared/accommodation-line.js';
import { STRINGS } from '../i18n-strings.js';

test('строка проживания узнаётся по метке', () => {
    assert.ok(isAccommodationLine({ notes: 'ACCOMMODATION · 201 · койка 1 · 5 сут. × 200000' }));
    assert.ok(isAccommodationLine({ notes: ACCOMMODATION_NOTE_PREFIX }));
});

test('обычные строки проживанием не считаются', () => {
    for (const row of [
        { notes: 'Перевязка' }, { notes: '' }, { notes: null }, {},
        null, undefined,
        { notes: 'пациент просил ACCOMMODATION поменять' },   // метка только В НАЧАЛЕ
    ]) {
        assert.strictEqual(isAccommodationLine(row), false, JSON.stringify(row));
    }
});

// Услуга из каталога и расходник узнаются по своим полям и проживанием быть не
// должны, даже если кто-то впишет слово в примечание.
test('услуга с service_id проживанием не считается', () => {
    assert.strictEqual(isAccommodationLine({ service_id: 5, notes: 'ACCOMMODATION' }), false);
    assert.strictEqual(isAccommodationLine({ clinic_item_id: 7, notes: 'ACCOMMODATION' }), false);
});

test('название переведено на три языка', () => {
    const entry = STRINGS[ACCOMMODATION_LABEL];
    assert.ok(entry, 'нет записи в i18n-strings для: ' + ACCOMMODATION_LABEL);
    for (const lang of ['en', 'ru', 'uz']) {
        assert.ok(entry[lang] && entry[lang].trim(), 'нет перевода ' + lang);
    }
    assert.notStrictEqual(entry.ru, entry.en, 'русский и английский не должны совпадать');
    assert.notStrictEqual(entry.uz, entry.en, 'узбекский и английский не должны совпадать');
});

// --- какой список показывает строку ----------------------------------------
import { isServiceLine, isGoodsLine } from '../../shared/accommodation-line.js';

const ACC   = { service_id: null, clinic_item_id: null, notes: 'ACCOMMODATION · 201' };
const SVC   = { service_id: 5, clinic_item_id: null, notes: null };
const GOODS = { service_id: null, clinic_item_id: 7, notes: null };

// Это и был баг: проживание не попадало ни в «Услуги», ни в «Товары».
test('проживание показывается в «Услугах»', () => {
    assert.strictEqual(isServiceLine(ACC), true);
    assert.strictEqual(isGoodsLine(ACC), false);
});

test('обычная услуга и товар делятся как раньше', () => {
    assert.strictEqual(isServiceLine(SVC), true);
    assert.strictEqual(isGoodsLine(SVC), false);
    assert.strictEqual(isGoodsLine(GOODS), true);
    assert.strictEqual(isServiceLine(GOODS), false);
});

// Ни одна строка не должна пропадать с экрана: она всё равно уйдёт в счёт.
test('каждая строка попадает ровно в один список', () => {
    for (const row of [ACC, SVC, GOODS]) {
        assert.strictEqual(Number(isServiceLine(row)) + Number(isGoodsLine(row)), 1, JSON.stringify(row));
    }
});
