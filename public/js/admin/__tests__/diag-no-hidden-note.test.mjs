// DIAG_NO_HIDDEN_NOTE_V1 (3.25.1) — «НАПРАВИТЬ НА УСЛУГИ» / «ПОВТОРНЫЙ ВИЗИТ» /
// «ЗАЯВКА НА ГОСПИТАЛИЗАЦИЮ» НЕ ПИШУТ НЕВИДИМУЮ СТРОКУ В ДОКУМЕНТ ДИАГНОСТИКИ.
//
// Владелец, 2026-11-20: врач УЗИ пользуется одним шаблоном для всех, а «Завершить
// приём» отказал у одного пациента — «В документе есть текст, которого нет в бланке
// «Диагностика»: Рекомендации». Кнопки листа вписывали строку в «Рекомендации»
// при любом типе документа, а бланк диагностики этого раздела не показывает.
// Решение владельца — вариант A: у диагностики строка не пишется; у «Приёма» —
// как раньше.
//
// Проверяется на НАСТОЯЩЕЙ форме кабинета (soapForm) в DOM-стенде cabinet-harness.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El } from './cabinet-harness.mjs';

installFakeDom();
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: null }), headers: { getSetCookie: () => [] } });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS_SRC = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');
const WS = await import('../views/service-workspace.js');

function realCabinet(type, id) {
    const container = new El('div');
    const ctx = { container, patient: { lastName: 'Тестов', firstName: 'Пациент', mrn: 'P-1', __service: { id, name: 'УЗИ почек', doctorName: 'Врач Тестовый', doctorSpec: 'Врач УЗИ-диагностики' } }, visitServiceId: id };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    WS.setDocType(ctx, type);
    ctx.__hydrated = true;   // открытая строка: записи легли в лист
    return ctx;
}
const NOTE = '<div><b>Повторный визит:</b> пт, 27 ноября · 10:00</div>';

test('«Диагностика»: строка не пишется — «Рекомендации» пусты, «Завершить приём» не отказывает', () => {
    const ctx = realCabinet('diag', 101);
    ctx.container.querySelector('[data-field="instrumental_text"]').innerHTML = 'Почки обычных размеров';
    ctx.container.querySelector('[data-field="primary_diagnosis"]').innerHTML = 'Патологии нет';
    assert.equal(WS.noteInRecommendations(ctx, NOTE), false, 'у диагностики строка в документ писаться не должна');
    const f = WS.collectFields(ctx);
    assert.equal(String(f.recommendations_text || '').trim(), '', 'в невидимых «Рекомендациях» диагностики появился текст');
    assert.deepEqual(WS.hiddenTextFor(f, 'diag'), []);
    assert.equal(WS.signRefusal(f, 'diag'), null, 'подпись диагностики отказывает из-за невидимой строки');
    assert.equal(f.instrumental_text, 'Почки обычных размеров', 'текст врача тронут');
});

test('«Приём»: строка пишется, как раньше', () => {
    const ctx = realCabinet('conclusion', 102);
    assert.equal(WS.noteInRecommendations(ctx, NOTE), true);
    assert.match(String(WS.collectFields(ctx).recommendations_text || ''), /Повторный визит:/, 'у «Приёма» строка пропала');
});

test('тип берётся у СВОЕЙ строки: ответ для отложенной строки диагностики не пишет, пока открыт «Приём»', () => {
    const diag = realCabinet('diag', 103);
    const consult = realCabinet('conclusion', 104);   // открыта другая строка, диагностика отложена
    assert.notEqual(diag.__wsState, undefined, 'строка диагностики не отложилась — стенд не проверяет то, что должен');
    assert.equal(WS.noteInRecommendations(diag, NOTE), false, 'взят тип открытой строки, а не своей');
    WS.resumeWorkspace(diag);
    assert.equal(String(WS.collectFields(diag).recommendations_text || '').trim(), '');
    assert.equal(String(WS.collectFields(consult).recommendations_text || '').trim(), '', 'строка ушла в документ другой строки');
});

test('все три кнопки идут через одну проверку (noteInRecommendations), других записей в «Рекомендации» нет', () => {
    const calls = WS_SRC.match(/(?<!function )noteInRecommendations\(ctx,/g) || [];
    assert.equal(calls.length, 3, 'направления, повторный визит, госпитализация — ровно три вызова');
    const writes = WS_SRC.match(/a4InsertHtml\([^)]*'recommendations_text'/g) || [];
    // одна — в noteInRecommendations, одна — в старом insertRecsBlock (вызовов нет)
    assert.equal(writes.length, 2, 'появилась новая запись в «Рекомендации» мимо проверки типа');
    assert.doesNotMatch(WS_SRC.replace(/function insertRecsBlock[\s\S]*?\n}\n/, ''), /insertRecsBlock\(/, 'insertRecsBlock снова вызывается — ему тоже нужна проверка типа');
});
