// RX_TEMPLATES_V1 (2026-10-02) — РЕЦЕПТЫ: ШАБЛОНЫ ЦЕЛОГО РЕЦЕПТА И «СВОИ» ПРЕПАРАТЫ.
//
// Владелец: «we need to add in to a doctors cabinet the reciept saving option
// for the drugs», решение «Both». Было: «Сохранить рецепт» писал строки в
// visit_services.notes — ни шаблонов рецептов, ни «избранного», ни подсказок.
// Стало, без миграции:
//   • шаблон рецепта — consultation_templates с doc_type '3' и body { rx: [...] };
//     в окне «Новый рецепт» — «Из шаблона» и «Сохранить как шаблон» (Личный /
//     Общий; «личный» — личный на сервере, CABINET_FIX_V1_TPL);
//   • подсказки при вводе названия — по порядку: мои прошлые рецепты
//     (rx_my_drugs), мои шаблоны рецептов, справочник клиники
//     (products.is_drug, только название); выбор заполняет дозу, частоту и
//     длительность.
// Шаблоны рецептов не видны среди шаблонов документов и наоборот (tplKindRows —
// cabinet-templates.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, addEventListener() {} };
globalThis.document = { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {}, getElementById: () => null, querySelector: () => null, documentElement: { style: {} } };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS_SRC = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');
const code = (s) => s.replace(/\/\/[^\n]*/g, '');
const WS = await import('../views/service-workspace.js');

const MINE = [
    { name: 'Амоксициллин', dose: '500 мг', freq: '3 раза в день', dur: '7 дней', count: 5 },
    { name: 'Амброксол', dose: '30 мг', freq: '2 раза в день', dur: '5 дней', count: 2 },
];
const TPL_DRUGS = [{ name: 'Амоксициллин', dose: '250 мг' }, { name: 'Амлодипин', dose: '5 мг', freq: 'утром', dur: '30 дней' }];
const CATALOG = [{ name: 'Амиодарон 200 мг' }, { name: 'амоксициллин' }, { name: 'Парацетамол 500 мг' }];

test('подсказки: сначала мои рецепты, потом мои шаблоны, потом справочник; один препарат — одна строка', () => {
    const s = WS.rxSuggest('ам', { mine: MINE, templates: TPL_DRUGS, catalog: CATALOG });
    assert.deepEqual(s.map((x) => [x.src, x.name]), [
        ['mine', 'Амоксициллин'], ['mine', 'Амброксол'],
        ['tpl', 'Амлодипин'],
        ['catalog', 'Амиодарон 200 мг'], ['catalog', 'Парацетамол 500 мг'],   // «Парацет-ам-ол»: любая часть названия
    ], 'порядок источников или повтор препарата');
    // выбор подсказки несёт дозу, частоту и длительность; справочник — только название
    assert.deepEqual(s[0], { src: 'mine', name: 'Амоксициллин', dose: '500 мг', freq: '3 раза в день', dur: '7 дней' });
    assert.deepEqual(s[3], { src: 'catalog', name: 'Амиодарон 200 мг', dose: '', freq: '', dur: '' });
    // поиск — без учёта регистра, по любой части названия
    assert.deepEqual(WS.rxSuggest('МГ', { catalog: CATALOG }).map((x) => x.name), ['Амиодарон 200 мг', 'Парацетамол 500 мг']);
    assert.deepEqual(WS.rxSuggest('', { mine: MINE }), [], 'пустой ввод — без подсказок');
    assert.equal(WS.rxSuggest('а', { catalog: Array.from({ length: 50 }, (_, i) => ({ name: 'А' + i })) }).length, 8, 'список подсказок не ограничен');
});

test('шаблон рецепта: тело { rx } из строк окна и обратно', () => {
    const body = WS.rxTemplateBody([
        { name: 'Амоксициллин', dose: '500 мг', freq: '3 раза в день', dur: '7 дней', notes: 'после еды', nurse: '' },
        { name: '  ', dose: '1' },
        { name: 'Лоратадин', dose: '10 мг', freq: '', dur: '', notes: '', nurse: 'в/м' },
    ]);
    assert.deepEqual(body, { rx: [
        { name: 'Амоксициллин', dose: '500 мг', freq: '3 раза в день', dur: '7 дней', notes: 'после еды', nurse: '' },
        { name: 'Лоратадин', dose: '10 мг', freq: '', dur: '', notes: '', nurse: 'в/м' },
    ] }, 'пустая строка ушла в шаблон или поля потеряны');
    assert.deepEqual(WS.rxRowsFromTemplate({ doc_type: '3', body }).map((r) => r.name), ['Амоксициллин', 'Лоратадин']);
    assert.deepEqual(WS.rxRowsFromTemplate({ doc_type: '3', body: { rx: 'мусор' } }), []);
    assert.deepEqual(WS.rxRowsFromTemplate(null), []);
});

test('окно «Новый рецепт»: «Из шаблона», «Сохранить как шаблон» (Личный / Общий), подсказки при вводе', () => {
    const c = code(WS_SRC);
    const dlg = c.slice(c.indexOf('function openPrescriptionDialog('), c.indexOf('async function removePrescription('));
    assert.ok(dlg.length > 1000, 'окно рецепта не найдено');
    assert.match(dlg, /'Из шаблона'/);
    assert.match(dlg, /'Сохранить как шаблон'/);
    assert.match(dlg, /'data-rx-tpl-scope': val/);
    assert.match(dlg, /scopeBtn\('private', 'Личный', 'User'\)/, 'нет выбора «Личный»');
    assert.match(dlg, /scopeBtn\('shared', 'Общий', 'Globe'\)/, 'нет выбора «Общий»');
    // шаблон рецепта — doc_type '3' и тело { rx }
    assert.match(dlg, /from\('consultation_templates'\)\s*\.insert\(\{[^}]*doc_type: '3'[^}]*body: rxTemplateBody\(/, 'шаблон рецепта пишется не родом «3»');
    // список шаблонов — только рецепты
    assert.match(c, /out\.tpls = tplKindRows\(tpls, '3'\)/, 'в окне рецепта видны шаблоны документов');
    assert.match(dlg, /const list = rxSrc\.tpls;/, '«Из шаблона» показывает не шаблоны рецептов');
    // подсказки: мои рецепты (RPC), мои шаблоны, справочник is_drug
    assert.match(c, /supabase\.rpc\('rx_my_drugs'/, 'подсказки не берут мои прошлые рецепты');
    assert.match(c, /from\('products'\)[\s\S]{0,120}is_drug/, 'подсказки не берут справочник препаратов');
    assert.match(dlg, /rxSuggest\(/);
    assert.match(dlg, /'data-rx-suggest': ''/);
    // выбор подсказки заполняет дозу, частоту и длительность
    assert.match(dlg, /if \(s\.dose\) doseInput\.value = s\.dose;[\s\S]{0,80}if \(s\.freq\) freqInput\.value = s\.freq;[\s\S]{0,80}if \(s\.dur\) durInput\.value = s\.dur;/,
        'подсказка не заполняет дозу, частоту и длительность');
    // отказ сервера — с причиной
    assert.match(dlg, /trf\('Не удалось сохранить: \{msg\}', \{ msg: errText\(error\) \}\)/);
});

test('подписи окна рецепта и сообщение сервера — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of ['Из шаблона', 'Сохранить как шаблон', 'Шаблонов рецептов пока нет', 'Шаблон рецепта сохранён',
        'Добавьте хотя бы один препарат', 'Добавлено препаратов: {n}', 'мои назначения', 'мой шаблон', 'справочник клиники',
        'Подсказки препаратов — только врачу или администратору.']) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет перевода ' + lang);
    }
});
