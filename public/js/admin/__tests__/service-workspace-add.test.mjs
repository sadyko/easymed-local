// SVC_ATTACH_V1 (2026-09-20) — «Добавить» на карточке «Услуги приёма» в кабинете
// врача добавляет услуги К ТЕКУЩЕМУ ПРИЁМУ, а не заводит новый визит.
//
// Что было. Кнопка открывала мастер записи (calculator: true): мастер заводит
// ОТДЕЛЬНЫЙ визит со своим счётом. Карточка показать его не могла в принципе —
// она рисуется из wsState.payload.services, а пишет туда только addOwnService,
// у которого не было ни одного вызова. Врач нажимал «Добавить», проходил мастер,
// карточка оставалась пустой, а в базе появлялся лишний визит.
//
// Что проверяется здесь — исходником, как соседние пины (fast-registration,
// booking-doors): каталог открывается отдельным окном, и форма вызова видна
// только в тексте вызова. Поведение самого каталога с этими флагами проверяет
// service-picker-attach.test.mjs, а живого DOM-стенда у кабинета врача нет —
// модуль тянет за собой печать, хранилище и карту пациента.
//
//   * РЕЖИМ. attachMode: true + requireSlot: false — тот же каталог со сметой,
//     но без создания визита и без брони времени: приём уже идёт.
//   * АДРЕС СТРОКИ. Выбранное уходит в addOwnService, а он пишет visit_services
//     на ctx.visitId — строка ложится в ТОТ приём, с карточки которого нажали.
//   * ИСПОЛНИТЕЛЬ. Выбранный в смете врач сильнее врача приёма; если в смете
//     врача не выбирали — остаётся врач приёма, а не NULL.
//   * КАРТОЧКА ОТВЕЧАЕТ. addOwnService перерисовывает список — иначе врач снова
//     смотрит на пустую карточку и добавляет услугу второй раз.
//   * ДУБЛИКАТ. Вторая та же услуга не уходит в базу молча: тост и отказ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRINGS } from '../i18n-strings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');

// Комментарии не проверяются: «мастера записи» здесь нет как ВЫЗОВА, а не как
// слова — в комментариях этого файла и его объяснении он поминается по делу.
const code = (s) => s.replace(/\/\/[^\n]*/g, '');

// Вызов каталога с карточки «Услуги приёма» — от servicesCard до конца объекта.
const cardCall = () => {
    const card = SRC.match(/function servicesCard\(ctx\)[\s\S]*?\n\}/);
    assert.ok(card, 'карточка «Услуги приёма» в кабинете врача не найдена');
    const call = card[0].match(/openServicePickerModal\(\{[\s\S]*?\n\s*\}\)/);
    assert.ok(call, 'карточка «Услуги приёма» не открывает каталог услуг');
    return code(call[0]);
};
const addOwn = () => {
    const fn = SRC.match(/async function addOwnService\([\s\S]*?\n\}/);
    assert.ok(fn, 'addOwnService не найден');
    return code(fn[0]);
};

test('«Добавить» на карточке приёма зовёт каталог в режиме привязки, а не мастер записи', () => {
    const call = cardCall();
    assert.match(call, /attachMode:\s*true/,
        'каталог зовут без attachMode — откроется старый каскад из трёх колонок');
    assert.match(call, /requireSlot:\s*false/,
        'каталог требует врача и время: приём уже идёт, бронировать нечего — «Добавить к приёму» останется серым');
    assert.ok(!/calculator:\s*true/.test(call),
        'карточка снова открывает мастер записи: он заведёт ОТДЕЛЬНЫЙ визит со счётом, и карточка его не покажет');
    assert.ok(!/onBooked/.test(call),
        'onBooked читает только мастер — в режиме привязки визита никто не создаёт');
});

test('выбранное в смете уходит в addOwnService вместе с врачом строки', () => {
    const call = cardCall();
    assert.match(call, /onPick:\s*\(p\)\s*=>\s*addOwnService\(\s*ctx\s*,\s*p\.service\s*,\s*p\.doctor\s*\)/,
        'onPick не отдаёт услугу в addOwnService — выбор врача уходит в никуда, а карточка остаётся пустой');
    assert.match(call, /visitDoctorId:\s*ctx\.patient\?\.__service\?\.doctorId/,
        'каталог открывают без врача приёма — подбор исполнителя начинается с чистого листа');
});

test('addOwnService пишет строку в ТЕКУЩИЙ приём (visit_services на ctx.visitId), а не в новый визит', () => {
    const fn = addOwn();
    assert.match(fn, /visit_id:\s*ctx\.visitId/,
        'строка услуги уходит не на приём, с карточки которого её добавили');
    assert.match(fn, /insertRow\('visit_services'/,
        'услуга не становится строкой визита — её не увидит ни счёт, ни карта пациента');
    assert.ok(!/from\('visits'\)\s*\.insert|bookVisit\(/.test(fn),
        'добавление услуги к приёму заводит визит');
});

test('исполнитель строки: выбранный в смете врач → врач консультации → врач приёма', () => {
    assert.match(addOwn(), /doctor_id:\s*doctor\?\.id \|\| svc\.__consultDoctorId \|\| ctx\.patient\?\.__service\?\.doctorId \|\| null/,
        'врач строки берётся не в этом порядке: выбранный в смете исполнитель должен быть сильнее врача приёма, а приём — сильнее пустоты');
});

test('карточка перерисовывается после добавления, а вторая та же услуга получает отказ с тостом', () => {
    const fn = addOwn();
    assert.match(fn, /paintOwnServices\(ctx\)/,
        'карточка не перерисовывается — врач смотрит на пустой список и добавляет услугу второй раз');
    assert.match(fn, /уже добавлена к приёму/,
        'дубликат уходит в базу молча — у приёма появляется вторая такая же строка и вторая цена');
    assert.match(fn, /serviceId:\s*svc\.id/,
        'id услуги не сохраняется в карточке — ни погасить её в каталоге, ни поймать дубликат нечем');
    assert.match(cardCall(), /excludeServiceIds:[^\n]*serviceId/,
        'каталог не гасит уже добавленные услуги');
});

test('подписи каталога переведены на три языка (кнопка и заголовок окна)', () => {
    for (const key of ['Добавить услуги к приёму', 'Добавить к приёму', '«{name}» уже добавлена к приёму.']) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет перевода ' + lang);
    }
});
