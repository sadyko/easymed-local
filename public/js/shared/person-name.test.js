// PERSON_NAME_SHORT_V1 — фамилия с инициалами и место без точки между числами.
//
// Владелец (2026-09-09): «what if surname and name is too long? can we use
// itinials and surname even if surname is too big?» и «can we not use • between
// numbers». Оба правила про ОДНО: полоса реквизитов обязана оставаться одной
// строкой, и читаться она должна с первого взгляда.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortName, placeLine } from './person-name.js';

test('PERSON_NAME_SHORT_V1: фамилия остаётся целой, имя и отчество становятся инициалами', () => {
    assert.equal(shortName('Иванов Иван Иванович'), 'Иванов И. И.');
    assert.equal(shortName('Абдурахмонова Гулнора Шухратовна'), 'Абдурахмонова Г. Ш.');
    // Длинная и двойная фамилия НЕ сокращается: она и есть то, чем человека
    // называют, а дефис — не пробел.
    assert.equal(shortName('Тухтасинходжаева-Мирзарахимова Дилноза Абдумаликовна'),
        'Тухтасинходжаева-Мирзарахимова Д. А.');
    // Два слова — одна инициала, а не выдуманное отчество.
    assert.equal(shortName('Каримов Темур'), 'Каримов Т.');
    // Одно слово возвращается как есть: это не ошибка ввода, а имя без
    // отчества, и превратить его в «И.» значило бы стереть единственное
    // известное.
    assert.equal(shortName('Мадина'), 'Мадина');
    assert.equal(shortName('   Иванов   Иван  '), 'Иванов И.');
    assert.equal(shortName(''), '');
    assert.equal(shortName(null), '');
    // Четвёртое слово в инициалы не идёт: два — это имя и отчество.
    assert.equal(shortName('Ли Ван Тан Хо'), 'Ли В. Т.');
});

test('PERSON_NAME_SHORT_V1: числа разделяет косая черта, а не точка', () => {
    assert.equal(placeLine('Хирургия', '201', '1'), 'Хирургия, 201/1');
    // Владелец: «can we not use • between numbers» — между числами точки нет.
    assert.ok(!/ds*·s*d/.test(placeLine('Хирургия', '201', '1')));
    // Чего нет, то и не показывается: пустых разделителей не остаётся.
    assert.equal(placeLine('Хирургия', '', ''), 'Хирургия');
    assert.equal(placeLine('', '201', '1'), '201/1');
    assert.equal(placeLine('', '', ''), '');
    assert.equal(placeLine('Хирургия', '201', ''), 'Хирургия, 201');
});
