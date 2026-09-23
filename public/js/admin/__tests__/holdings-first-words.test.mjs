// HOLDINGS_FIRST_V1 — ЭКРАН НЕ ОБЕЩАЕТ ТОГО, ЧЕГО СЕРВЕР БОЛЬШЕ НЕ ДЕЛАЕТ.
//
// До HOLDINGS_FIRST_V1 отмена выдачи действительно возвращала товар НА СКЛАД —
// и подписи это честно говорили. Теперь возврат идёт ПО ИСТОЧНИКАМ
// (rpc/inventory.js voidDispense → restoreSources): что взяли из подотчёта
// медсестры, в подотчёт медсестры и вернётся, а разбитая на два источника
// выдача вернётся двумя частями. Склад при этом может не получить ничего.
//
// Три экрана остались со старыми словами: очередь процедур, кабинет врача и
// задачи медсестры продолжали обещать склад. Цена такой подписи выше, чем
// кажется: медсестра, нажавшая «Убрать», идёт искать товар на складе — его там
// нет, — и заключает, что программа теряет товар. Ровно этот разговор со
// складом HOLDINGS_FIRST_V1 и должен был прекратить.
//
// Проверка по ИСХОДНИКУ, а не по экрану: это подписи, а не поведение, и живут
// они в четырёх разных местах трёх файлов. Общая формулировка взята у той
// двери, которая её уже знала, — амбулаторная вкладка медсестры
// (mar-outpatients.js: «вернётся туда, откуда взято»).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');
const read = (f) => fs.readFileSync(path.join(VIEWS, f), 'utf8');

// Экраны, где отменяют выдачу или снимают отметку о введении дозы.
const VOID_SCREENS = ['procedures.js', 'service-workspace.js', 'mar-nurse.js', 'mar-outpatients.js'];

test('ни один экран отмены не обещает возврат НА СКЛАД', () => {
    const lying = [];
    for (const f of VOID_SCREENS) {
        read(f).split('\n').forEach((line, i) => {
            if (/(вернётся|возвращён|вернуть|вернутся)[^\n]{0,40}на склад/i.test(line)) {
                lying.push(`${f}:${i + 1} ${line.trim().slice(0, 110)}`);
            }
        });
    }
    assert.deepEqual(lying, [],
        'подпись обещает склад, а сервер возвращает товар держателю:\n  ' + lying.join('\n  '));
});

test('и говорят это ОДНИМИ словами — иначе один порядок читается как три разных', () => {
    const silent = VOID_SCREENS.filter((f) => !/откуда (взят|взято)/.test(read(f)));
    assert.deepEqual(silent, [],
        'экран отмены не объясняет, КУДА вернётся товар:\n  ' + silent.join('\n  '));
});
