// PRINT_SKIP_EMPTY_V1 (2026-10-29) — ПУСТОЕ НЕ ПЕЧАТАЕТСЯ.
//
// Владелец: «ОПИСАНИЕ —» на листе диагностики — ошибка; пустые поля в
// документах врача не печатаются. Один рендерер (doc-variants.js) рисует экран
// бланка, печать, архив документов (заново из сохранённых данных) и PDF в
// Telegram (buildSheetHtml), поэтому правило проверяется здесь, на его выходе:
//   • вне редактора раздел врача — заголовок вместе с текстом — печатается,
//     только если в нём есть текст или таблица (richHasContent); пустые <p><br></p>,
//     &nbsp;, &#160;, &#xa0; и невидимый пробел U+200B — пусто, прочерка «—» нет;
//   • в редакторе (__editor) пустой раздел виден — в него пишут;
//   • пустые необязательные поля шапки и карточек (дата рождения, пол, телефон,
//     специальность, услуга, область) не печатаются; ФИО и номер карты — всегда.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDesignedVariant } from '../views/doc-variants.js';

const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const VARIANTS = ['classic', 'compact'];
// Текст листа без стилей и разметки, пробелы схлопнуты.
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// Прочерк «—» отдельным словом (пустое поле), а не тире внутри текста «N28.9 — Болезнь».
const DASH_ALONE = /(^|\s)—(\s|$)/;
const word = (w) => new RegExp('(^|\\s)' + w + '(\\s|$)');

// Бланк исследования этого пациента: заключение есть, описание — по случаю.
const diag = (extra = {}) => ({
    patientName: 'Азизов Бахтиёр', mrn: 'P-1', service: 'УЗИ почек и м/п',
    radiologist: 'Каримов Алишер', radiologistSpec: 'Врач УЗИ-диагностики',
    conclusionAuto: '', conclusionBody: 'Патологии не выявлено.', conclusion: 'Патологии не выявлено.',
    ...extra,
});
// [название, значение, разметка ли (снимок с меткой rich)]
const EMPTY_DESCRIPTIONS = [
    ['пусто', '', false],
    ['пустой абзац разметкой', '<p><br></p>', true],
    ['&nbsp;', '&nbsp;', true],
    ['&#160;', '&#160;', false],
    ['&#xa0; в абзаце', '<p>&#xa0;</p>', true],
    ['невидимый пробел', '\u200b', false],
    ['невидимый пробел в абзаце', '<div>\u200b<br></div>', true],
];
const withRich = (rich) => (rich ? { rich: 1 } : {});

test('диагностика: пустое «Описание» не печатается — ни заголовка, ни «—» (классический и компактный)', () => {
    for (const v of VARIANTS) for (const [name, description, rich] of EMPTY_DESCRIPTIONS) {
        const html = renderDesignedVariant('diag', v, S, diag({ description, ...withRich(rich) }));
        const t = text(html);
        assert.ok(!/Описание|Tavsif/.test(t), `${v}, ${name}: заголовок «Описание» напечатан`);
        assert.ok(!DASH_ALONE.test(t), `${v}, ${name}: прочерк «—» на листе: ${t}`);
        assert.ok(!/data-field="instrumental_text"/.test(html), `${v}, ${name}: пустой блок «Описания» на листе`);
        assert.match(t, /Патологии не выявлено\./, `${v}, ${name}: заключение потерялось`);
    }
});

test('диагностика: в редакторе пустое «Описание» видно — в него пишут', () => {
    for (const v of VARIANTS) for (const [name, description, rich] of EMPTY_DESCRIPTIONS) {
        const html = renderDesignedVariant('diag', v, S, diag({ __editor: true, description, ...withRich(rich) }));
        assert.match(text(html), /Описание/, `${v}, ${name}: в редакторе нет «Описания»`);
        assert.match(html, /data-field="instrumental_text"/, `${v}, ${name}: в редакторе некуда писать`);
    }
});

test('диагностика: заполненное «Описание» печатается; пустая таблица — содержание раздела', () => {
    const TBL = '<table class="a4-tbl"><tbody><tr><th></th><th></th></tr><tr><td></td><td></td></tr></tbody></table>';
    for (const v of VARIANTS) {
        const plain = text(renderDesignedVariant('diag', v, S, diag({ description: 'Почки обычных размеров.' })));
        assert.match(plain, /Описание.*Почки обычных размеров\./, v + ': текст «Описания» не напечатан');
        const rich = text(renderDesignedVariant('diag', v, S, diag({ rich: 1, description: '<p>\u200b</p><ul><li>Почки в норме</li></ul>' })));
        assert.match(rich, /Описание.*Почки в норме/, v + ': разметка «Описания» не напечатана');
        const tbl = renderDesignedVariant('diag', v, S, diag({ rich: 1, description: TBL }));
        assert.match(text(tbl), /Описание/, v + ': пустая таблица — содержание, а «Описание» пропало');
        assert.ok(tbl.includes('class="a4-tbl"'), v + ': таблица не напечатана');
    }
});

test('диагностика: пустое «Заключение» не печатается; строка МКБ-10 без текста врача — печатается', () => {
    for (const v of VARIANTS) {
        for (const body of ['', ' ', '&#160;', '\u200b']) {
            const t = text(renderDesignedVariant('diag', v, S, diag({ description: 'Почки обычных размеров.', conclusionBody: body, conclusion: body })));
            assert.ok(!/Заключение|Xulosa/.test(t), `${v}, ${JSON.stringify(body)}: пустое «Заключение» напечатано`);
            assert.ok(!DASH_ALONE.test(t), `${v}, ${JSON.stringify(body)}: прочерк на листе`);
        }
        const auto = text(renderDesignedVariant('diag', v, S, diag({ description: 'Почки.', conclusionAuto: 'N28.9 — Болезнь почки', conclusionBody: '', conclusion: 'N28.9 — Болезнь почки' })));
        assert.match(auto, /Заключение.*N28\.9 — Болезнь почки/, v + ': код МКБ-10 без текста — «Заключение» пропало');
        // архив до ревью 2: одно поле conclusion
        const old = text(renderDesignedVariant('diag', v, S, { patientName: 'Азизов Бахтиёр', mrn: 'P-1', radiologist: 'Каримов Алишер', description: 'Почки.', conclusion: 'Патологии нет.' }));
        assert.match(old, /Заключение.*Патологии нет\./, v + ': старый снимок потерял «Заключение»');
        // в редакторе пустое «Заключение» видно
        assert.match(text(renderDesignedVariant('diag', v, S, diag({ __editor: true, conclusionBody: '', conclusion: '' }))), /Заключение/, v + ': в редакторе нет «Заключения»');
    }
});

test('заключение врача: раздел из пустоты (&nbsp;, &#160;, U+200B, <p><br></p>) не печатается; в редакторе — виден', () => {
    const EMPTY = ['&nbsp;', '&#160;', '\u200b', ' \u200b ', '<p><br></p>', '<div>&#xa0;</div>'];
    const HEADS = ['Анамнез', 'Осмотр', 'Терапия', 'Рекомендации', 'Заключение'];
    const ORDER = ['chief_complaint', 'hpi', 'physical_exam', 'primary_diagnosis', 'therapy_text', 'recommendations_text', 'conclusion_text'];
    for (const v of VARIANTS) for (const e of EMPTY) {
        const d = { rich: 1, patientName: 'Азизов Бахтиёр', mrn: 'P-1', doctorName: 'Каримов Алишер',
            complaint: 'Кашель 3 дня', hpi: e, exam: e, therapy: e, recsText: e, conclusionText: e, dx: e, sectionOrder: ORDER };
        const html = renderDesignedVariant('conclusion', v, S, d);
        const t = text(html);
        assert.match(t, /Жалобы.*Кашель 3 дня/, `${v}, ${JSON.stringify(e)}: заполненный раздел пропал`);
        for (const hd of HEADS) assert.ok(!html.includes(`<span class="ru">${hd}</span>`), `${v}, ${JSON.stringify(e)}: пустой раздел «${hd}» напечатан`);
        assert.ok(!/Диагноз|Tashxis/.test(t), `${v}, ${JSON.stringify(e)}: пустой «Диагноз» напечатан`);
        assert.ok(!/data-field="(hpi|physical_exam|therapy_text|recommendations_text|conclusion_text)"/.test(html), `${v}, ${JSON.stringify(e)}: пустой блок раздела на листе`);
        // редактор: все разделы видны, в них пишут
        const ed = renderDesignedVariant('conclusion', v, S, { ...d, __editor: true, activeFields: ORDER });
        for (const hd of HEADS) assert.ok(ed.includes(`<span class="ru">${hd}</span>`), `${v}, ${JSON.stringify(e)}: в редакторе нет раздела «${hd}»`);
    }
    // простые строки рекомендаций: строка из невидимых знаков — не пункт списка
    for (const v of VARIANTS) {
        const html = renderDesignedVariant('conclusion', v, S, { patientName: 'Азизов Бахтиёр', mrn: 'P-1', doctorName: 'Каримов Алишер', recsText: 'Покой\n\u200b\n&#160;\nОбильное питьё' });
        assert.equal((html.match(/<li>/g) || []).length, 2, v + ': пустая строка рекомендаций стала пунктом');
    }
});

// Ревью B2 — простой текст в угловых скобках («<норма>», «< 5 мм >», «<N>») —
// текст врача: лист печатает его экранированным, а проверка пустоты срезала его
// как тег и выбрасывала раздел вместе с заголовком.
test('текст в угловых скобках — содержание раздела: печатается с заголовком; пробел и &#160; — по-прежнему пусто', () => {
    for (const v of VARIANTS) for (const rich of [false, true]) {
        const where = `${v}, rich=${rich}`;
        // диагностика: «Описание» и «Заключение»
        const dg = renderDesignedVariant('diag', v, S, diag({ description: '<норма>', conclusionBody: '<N>', conclusion: '<N>', ...withRich(rich) }));
        assert.match(text(dg), /Описание.*&lt;норма&gt;/, where + ': «Описание» «<норма>» не напечатано');
        assert.match(text(dg), /Заключение.*&lt;N&gt;/, where + ': «Заключение» «<N>» не напечатано');
        for (const blank of [' ', '&#160;']) {
            const t = text(renderDesignedVariant('diag', v, S, diag({ description: blank, ...withRich(rich) })));
            assert.ok(!/Описание|Tavsif/.test(t), `${where}, ${JSON.stringify(blank)}: пустое «Описание» напечатано`);
        }
        // заключение врача: раздел, «Диагноз», строка рекомендаций
        const base = { patientName: 'Азизов Бахтиёр', mrn: 'P-1', doctorName: 'Каримов Алишер', complaint: 'Кашель', ...withRich(rich) };
        const cn = renderDesignedVariant('conclusion', v, S, { ...base, exam: '< 5 мм >', dx: '<N>', recsText: '<норма>' });
        assert.ok(cn.includes('<span class="ru">Осмотр</span>'), where + ': раздел «< 5 мм >» не напечатан');
        assert.match(text(cn), /&lt; 5 мм &gt;/, where + ': текст «< 5 мм >» не напечатан');
        assert.match(text(cn), /Диагноз.*&lt;N&gt;/, where + ': «Диагноз» «<N>» не напечатан');
        assert.match(text(cn), /Рекомендации.*&lt;норма&gt;/, where + ': рекомендация «<норма>» не напечатана');
        for (const blank of [' ', '&#160;']) {
            const html = renderDesignedVariant('conclusion', v, S, { ...base, exam: blank, dx: blank, recsText: blank });
            assert.ok(!html.includes('<span class="ru">Осмотр</span>'), `${where}, ${JSON.stringify(blank)}: пустой «Осмотр» напечатан`);
            assert.ok(!/Диагноз|Tashxis/.test(text(html)), `${where}, ${JSON.stringify(blank)}: пустой «Диагноз» напечатан`);
            assert.ok(!/Рекомендации|Tavsiyalar/.test(text(html)), `${where}, ${JSON.stringify(blank)}: пустые «Рекомендации» напечатаны`);
        }
    }
});

// ── шапка и карточки ────────────────────────────────────────────────────────
const BARE = { patientName: 'Азизов Бахтиёр', mrn: 'P-1', doctorName: 'Каримов Алишер', radiologist: 'Каримов Алишер',
    dob: '', sex: '', phone: '', doctorSpec: '', service: '', doctorPhone: '',
    complaint: 'Кашель', description: 'Эхопризнаков патологии нет.', conclusion: 'Норма.' };
const FULL = { ...BARE, dob: '14.03.1989', sex: 'Мужской', phone: '+998 90 123 45 67', doctorSpec: 'Терапевт',
    service: 'Приём терапевта', doctorPhone: '+998 71 200 00 00', study: { area: 'Мочевой пузырь' } };
const SHOWN = {
    'conclusion/classic': ['14.03.1989', 'Мужской', '+998 90 123 45 67', 'Терапевт', 'Приём терапевта', '+998 71 200 00 00'],
    'conclusion/compact': ['14.03.1989', 'Приём терапевта'],
    'diag/classic': ['14.03.1989', 'Приём терапевта', 'Мочевой пузырь'],
    'diag/compact': ['14.03.1989', 'Мужской', 'Приём терапевта', 'Мочевой пузырь'],
};

test('шапка и карточки документов врача: пустые необязательные поля не печатаются, прочерков нет', () => {
    for (const type of ['conclusion', 'diag']) for (const v of VARIANTS) {
        const where = type + '/' + v;
        for (const blank of ['', '\u200b', ' ']) {
            const d = { ...BARE, dob: blank, sex: blank, phone: blank, doctorSpec: blank, service: blank, doctorPhone: blank };
            const t = text(renderDesignedVariant(type, v, S, d));
            for (const re of [/Дата рожд/, /Tug.ilgan/, word('Пол'), /Jinsi/, /Телефон|Telefon/, /Специальность|Mutaxassislik/, /Услуга|Xizmat/, /Область|Soha/]) {
                assert.ok(!re.test(t), `${where}, ${JSON.stringify(blank)}: пустое поле ${re} напечатано`);
            }
            if (where === 'diag/classic') assert.ok(!/Исследование/.test(t), where + ': пустое «Исследование» в шапке');
            assert.ok(!DASH_ALONE.test(t), `${where}, ${JSON.stringify(blank)}: прочерк «—» на листе: ${t}`);
            assert.match(t, /Азизов/, where + ': ФИО пропало');
            assert.match(t, /P-1/, where + ': номер карты пропал');
        }
    }
});

test('шапка и карточки документов врача: заполненные поля печатаются', () => {
    for (const type of ['conclusion', 'diag']) for (const v of VARIANTS) {
        const where = type + '/' + v;
        const t = text(renderDesignedVariant(type, v, S, FULL));
        for (const val of SHOWN[where]) assert.ok(t.includes(val), `${where}: «${val}» не напечатано`);
    }
});

test('ФИО и номер карты — всегда: пустые печатаются прочерком, а не исчезают', () => {
    const none = { ...BARE, patientName: '', mrn: '' };
    const cls = text(renderDesignedVariant('conclusion', 'classic', S, none));
    assert.match(cls, /ФИО · F\.I\.Sh\. —/, 'карточка «Пациент» потеряла ФИО');
    assert.match(cls, /ID пациента · Bemor ID —/, 'карточка «Пациент» потеряла номер карты');
    const cmp = text(renderDesignedVariant('diag', 'compact', S, none));
    assert.match(cmp, /ФИО —/, 'бланк исследования (компактный) потерял ФИО');
    assert.match(cmp, /ID —/, 'бланк исследования (компактный) потерял номер карты');
    for (const [type, v] of [['conclusion', 'compact'], ['diag', 'classic']]) {
        assert.match(text(renderDesignedVariant(type, v, S, none)), /Пациент — Bemor/, type + '/' + v + ': шапка потеряла «Пациент»');
    }
});

// ── рецепт (service-workspace.js, openRecipeModal) ──────────────────────────
// Модуль кабинета при загрузке читает window/document — заглушки, как в cabinet-diag-blank.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, addEventListener() {} };
globalThis.document = { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {}, getElementById: () => null, querySelector: () => null, documentElement: { style: {} } };
const WS = await import('../views/service-workspace.js');
const { readFileSync } = await import('node:fs');
const WS_SRC = readFileSync(new URL('../views/service-workspace.js', import.meta.url), 'utf8');

test('рецепт: пустая кратность — строки «S.:» нет; заполненная — есть; прочерков нет', () => {
    for (const prefix of ['rx-', 'rx-recipe-']) {
        for (const freq of [undefined, '', ' ', '​']) {
            const html = WS.recipeRxItemHtml({ name: 'Амброксол', dose: '30 мг', freq }, prefix);
            assert.ok(!/S\.:/.test(html), `${prefix}, ${JSON.stringify(freq)}: пустая кратность напечатана строкой «S.:»`);
            assert.ok(!/—/.test(html), `${prefix}, ${JSON.stringify(freq)}: прочерк на рецепте`);
            assert.match(html, /<b>Rp\.:<\/b> <span class="[\w-]*drug">Амброксол 30 мг<\/span>/, prefix + ': строка «Rp.:» пропала');
        }
        const full = WS.recipeRxItemHtml({ name: 'Амброксол', dose: '30 мг', freq: 'по 1 таб. 3 раза в день', dur: '5 дней', notes: 'после еды' }, prefix);
        assert.match(full, new RegExp(`<div class="${prefix}item">`), prefix + ': класс назначения');
        assert.match(full, new RegExp(`<div class="${prefix}s"><b>S\\.:</b> по 1 таб\\. 3 раза в день</div>`), prefix + ': кратность не напечатана');
        assert.match(full, /Курс: 5 дней/);
        assert.match(full, /Примечание: после еды/);
        assert.ok(!/Курс|Примечание/.test(WS.recipeRxItemHtml({ name: 'Амброксол', dur: ' ', notes: '​' }, prefix)), prefix + ': пустые курс и примечание напечатаны');
    }
    // экранирование — как было
    const xss = WS.recipeRxItemHtml({ name: '<img src=x onerror=alert(1)>', freq: '<b>x</b>' }, 'rx-');
    assert.ok(!/<img|<b>x/.test(xss), xss);
});

test('рецепт: пустые возраст, пол и дата рождения не печатаются', () => {
    const DOB = "Дата рождения / Tug'ilgan sana";
    assert.deepEqual(WS.recipeHeadRows({}), []);
    assert.deepEqual(WS.recipeHeadRows(null), []);
    assert.deepEqual(WS.recipeHeadRows({ age: '', gender: '', dob: '​', birthDate: ' ' }), []);
    assert.deepEqual(WS.recipeHeadRows({ age: 34, gender: 'M', dob: '14.03.1989' }), [
        { label: 'Возраст / Yosh', value: '34 лет · Муж.' },
        { label: DOB, value: '14.03.1989' },
    ]);
    assert.deepEqual(WS.recipeHeadRows({ age: 34 }), [{ label: 'Возраст / Yosh', value: '34 лет' }]);
    assert.deepEqual(WS.recipeHeadRows({ age: 0 }), [{ label: 'Возраст / Yosh', value: '0 лет' }], 'возраст 0 — значение, а не пустота');
    assert.deepEqual(WS.recipeHeadRows({ gender: 'F' }), [{ label: 'Пол / Jinsi', value: 'Жен.' }]);
    assert.deepEqual(WS.recipeHeadRows({ birthDate: '01.01.2000' }), [{ label: DOB, value: '01.01.2000' }]);
});

test('рецепт: окно и печать берут одни строки; ФИО и номер карты — всегда', () => {
    const code = WS_SRC.replace(/\/\/[^\n]*/g, '');
    const fn = code.slice(code.indexOf('async function openRecipeModal('), code.indexOf('export function recipeRxItemHtml('));
    assert.ok(fn.length > 1000, 'openRecipeModal не найден');
    assert.equal((fn.match(/recipeRxItemHtml\(rx, 'rx-recipe-'\)/g) || []).length, 1, 'окно рецепта рисует назначения не общей функцией');
    assert.equal((fn.match(/recipeRxItemHtml\(rx, 'rx-'\)/g) || []).length, 1, 'печать рецепта рисует назначения не общей функцией');
    assert.match(fn, /recipeHeadRows\(p\)/, 'строки пациента — не общей функцией');
    assert.ok(!/ageStr|sexStr/.test(fn), 'прежние строки возраста и пола с прочерком остались');
    assert.ok(!/p\.birthDate \|\| '—'/.test(fn), 'дата рождения печатается прочерком');
    assert.ok(!/rx\.freq \? escapeHtml\(rx\.freq\) : '—'/.test(fn), 'кратность печатается прочерком');
    // ФИО и номер карты — в окне и в печати всегда
    assert.match(fn, /<span>Пациент \/ Bemor<\/span><b>\$\{escapeHtml\(patientName\)\}<\/b>[\s\S]*<span>Пациент \/ Bemor<\/span><b>\$\{escapeHtml\(patientName\)\}<\/b>/);
    assert.match(fn, /<span>ID<\/span><b>\$\{escapeHtml\(recId\)\}<\/b>/);
    assert.match(fn, /№ \$\{escapeHtml\(recId\)\}/);
});
