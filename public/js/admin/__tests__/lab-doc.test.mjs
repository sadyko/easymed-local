// LAB_BLANK_DESIGNED_V1 — правила бланка результатов.
//
// Эти функции решают, что пациент увидит на бумаге: отклонение вверх или вниз,
// где стоит метка на полоске нормы и какая строка референса подсвечена. Бланк
// печатается из двух мест (лаборатория и карта пациента) одним и тем же кодом,
// поэтому цена ошибки здесь — расхождение между двумя копиями одного документа.

import test from 'node:test';
import assert from 'node:assert/strict';
import { labFlagFor, labPosFor, fmtDMY, labSexRu, labRefLines, labRefText, rangeText, labFlagCell, isNumericValue,
         buildAnalyteIndex, resolveAnalyteWhy, namedRangeCell, matchResultsToAnalytes, labAccession, labIssueDates, labMaxDate } from '../views/lab-doc.js';

// ── Флаг ─────────────────────────────────────────────────────────────────────
test('прямые флаги переводятся один в один', () => {
    assert.equal(labFlagFor({ flag: 'high' }), 'H');
    assert.equal(labFlagFor({ flag: 'low' }), 'L');
    assert.equal(labFlagFor({ flag: 'normal' }), 'N');
});

test('пустой или неизвестный флаг — норма, а не отклонение', () => {
    assert.equal(labFlagFor({}), 'N');
    assert.equal(labFlagFor({ flag: '' }), 'N');
    assert.equal(labFlagFor({ flag: 'что-то новое' }), 'N');
});

test('abnormal/critical определяются по числу: выше верхней границы — H', () => {
    assert.equal(labFlagFor({ flag: 'critical', numeric_value: 20, ref_low: 4, ref_high: 9 }), 'H');
    assert.equal(labFlagFor({ flag: 'abnormal', numeric_value: 20, ref_low: 4, ref_high: 9 }), 'H');
});

test('abnormal/critical ниже нижней границы — L', () => {
    assert.equal(labFlagFor({ flag: 'critical', numeric_value: 1, ref_low: 4, ref_high: 9 }), 'L');
    assert.equal(labFlagFor({ flag: 'abnormal', numeric_value: 1, ref_low: 4, ref_high: 9 }), 'L');
});

test('отклонение без чисел НЕ превращается в норму', () => {
    // Худший возможный исход — напечатать «·» там, где лаборатория отметила
    // отклонение. Без границ сравнить не с чем, поэтому помечаем H.
    assert.equal(labFlagFor({ flag: 'critical' }), 'H');
    assert.equal(labFlagFor({ flag: 'abnormal', numeric_value: 5 }), 'H');
    assert.equal(labFlagFor({ flag: 'abnormal', ref_low: 1, ref_high: 2 }), 'H');
});

// ── Метка на полоске ─────────────────────────────────────────────────────────
test('границы нормы ложатся на края полосы 22–78%', () => {
    assert.equal(labPosFor({ numeric_value: 4, ref_low: 4, ref_high: 9 }), 22);
    assert.equal(labPosFor({ numeric_value: 9, ref_low: 4, ref_high: 9 }), 78);
    assert.equal(labPosFor({ numeric_value: 6.5, ref_low: 4, ref_high: 9 }), 50);
});

test('отклонение уходит за полосу нормы, но остаётся на шкале', () => {
    const high = labPosFor({ numeric_value: 30, ref_low: 4, ref_high: 9 });
    const low = labPosFor({ numeric_value: -5, ref_low: 4, ref_high: 9 });
    assert.ok(high > 78 && high <= 98, 'выше нормы — правее полосы, не за краем: ' + high);
    assert.ok(low < 22 && low >= 2, 'ниже нормы — левее полосы, не за краем: ' + low);
});

test('без числового диапазона метки нет', () => {
    // null, а не 50: метка в середине читалась бы как «в норме», хотя нормы
    // никто не задавал.
    assert.equal(labPosFor({ numeric_value: 5 }), null);
    assert.equal(labPosFor({ numeric_value: 5, ref_low: 4 }), null);
    assert.equal(labPosFor({ ref_low: 4, ref_high: 9 }), null);
    assert.equal(labPosFor({}), null);
});

test('вырожденный диапазон не делит на ноль', () => {
    assert.equal(labPosFor({ numeric_value: 5, ref_low: 5, ref_high: 5 }), null);
    assert.equal(labPosFor({ numeric_value: 5, ref_low: 9, ref_high: 4 }), null);
});

// ── Даты и пол ───────────────────────────────────────────────────────────────
test('дата разворачивается в привычный вид', () => {
    assert.equal(fmtDMY('2026-08-18'), '18.08.2026');
    assert.equal(fmtDMY('2026-08-18T09:30:00Z'), '18.08.2026');
});

test('мусорная дата даёт пустоту, а не Invalid Date', () => {
    for (const bad of ['', null, undefined, 'вчера', '18.08.2026']) {
        assert.equal(fmtDMY(bad), '', String(bad));
    }
});

test('пол по-русски, неизвестный — пусто', () => {
    assert.equal(labSexRu('male'), 'Мужской');
    assert.equal(labSexRu('FEMALE'), 'Женский');
    assert.equal(labSexRu(''), '');
    assert.equal(labSexRu(null), '');
});

// ── Референс ─────────────────────────────────────────────────────────────────
test('без именованных диапазонов — одна строка', () => {
    assert.equal(labRefLines('4,0 – 9,0', []), '4,0 – 9,0');
    assert.equal(labRefLines('', []), '—', 'пустой референс печатается прочерком');
});

test('первый именованный диапазон помечается точкой — её подсветит шаблон', () => {
    const out = labRefLines('4,0 – 9,0', ['Беременность: 5,0 – 12,0', 'Менопауза: 3,0 – 8,0']);
    const lines = out.split('\n');
    assert.equal(lines[0], '4,0 – 9,0', 'базовый референс всегда первым');
    assert.ok(lines[1].startsWith('• '), 'подходящий диапазон помечен');
    assert.ok(!lines[2].startsWith('• '), 'остальные — без пометки');
});

test('пустые именованные строки отбрасываются', () => {
    assert.equal(labRefLines('1 – 2', [null, '', undefined]), '1 – 2');
});

// ── LAB_REF_ALL_V1 — все диапазоны показателя в бланке ───────────────────────
test('показатель только с М/Ж печатает ОБА, а не пустоту', () => {
    const fe = { ref_low_m: 8.1, ref_high_m: 28.3, ref_low_f: 6.6, ref_high_f: 26 };
    const out = labRefText(fe, 'female', '', []);
    const lines = out.split('\n');
    assert.equal(lines.length, 2, 'мужская и женская строки');
    assert.ok(lines.some(l => l.includes('М: 8.1–28.3')));
    assert.ok(lines.some(l => l.includes('Ж: 6.6–26')));
});

test('подходящая пациенту строка помечена, и ровно одна', () => {
    const fe = { ref_low_m: 8.1, ref_high_m: 28.3, ref_low_f: 6.6, ref_high_f: 26 };
    const f = labRefText(fe, 'female', '', []).split('\n');
    assert.ok(f.find(l => l.startsWith('• ')).includes('Ж:'), 'женщине помечена женская');
    const m = labRefText(fe, 'male', '', []).split('\n');
    assert.ok(m.find(l => l.startsWith('• ')).includes('М:'), 'мужчине мужская');
    assert.equal(f.filter(l => l.startsWith('• ')).length, 1, 'помечена ровно одна строка');
});

test('пол неизвестен — обе нормы всё равно на бланке', () => {
    // Именно этот случай раньше давал ПУСТУЮ графу «Референс».
    const fe = { ref_low_m: 8.1, ref_high_m: 28.3, ref_low_f: 6.6, ref_high_f: 26 };
    for (const g of ['', null, 'other']) {
        const out = labRefText(fe, g, '', []);
        assert.ok(out.includes('М:') && out.includes('Ж:'), 'пол=' + g + ': ' + out);
        assert.ok(out.trim() !== '' && out !== '—', 'графа не пустая');
    }
});

test('базовый диапазон печатается и помечается, когда пол не при чём', () => {
    const hgb = { ref_low: 130, ref_high: 170 };
    assert.equal(labRefText(hgb, 'male', '', []), '• 130–170');
});

test('есть и базовый, и М/Ж — печатаются все три, помечена своя', () => {
    const a = { ref_low: 4, ref_high: 9, ref_low_m: 4.3, ref_high_m: 9.5, ref_low_f: 3.9, ref_high_f: 8.8 };
    const lines = labRefText(a, 'male', '', []).split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '4–9', 'базовый без пометки');
    assert.ok(lines[1].startsWith('• М:'));
});

test('текстовая норма используется, когда чисел нет', () => {
    assert.equal(labRefText({ ref_text: 'отрицательно' }, 'male', '', []), '• отрицательно');
});

test('показателя в панели нет — печатаем то, что сохранено в результате', () => {
    assert.equal(labRefText(null, 'male', '4,0 – 9,0', []), '4,0 – 9,0');
    assert.equal(labRefText({}, 'male', '', []), '—');
});

test('именованные диапазоны идут следом за основными', () => {
    const a = { ref_low_m: 1, ref_high_m: 2, ref_low_f: 3, ref_high_f: 4 };
    const out = labRefText(a, 'female', '', ['Беременность: 5–12']);
    assert.ok(out.endsWith('Беременность: 5–12'));
    assert.equal(out.split('\n').length, 3);
});

test('rangeText: односторонние границы', () => {
    assert.equal(rangeText(4, 9), '4–9');
    assert.equal(rangeText(4, null), '≥ 4');
    assert.equal(rangeText(null, 9), '≤ 9');
    assert.equal(rangeText(null, null), null);
});

// ── LAB_FLAG_NUMERIC_ONLY_V1 ─────────────────────────────────────────────────
test('флаг ставится только числовому значению', () => {
    assert.equal(labFlagCell({ value: '12.8', flag: 'high' }), 'H');
    assert.equal(labFlagCell({ value: '3,4', flag: 'low' }), 'L', 'запятая — тоже число');
    assert.equal(labFlagCell({ value: '5', flag: 'normal' }), 'N');
});

test('текст и вариант из списка остаются БЕЗ флага', () => {
    // «·» у такой строки читается как «в норме», хотя сравнивать не с чем.
    for (const v of ['соломенно-жёлтый', 'отрицательно', 'прозрачная', '', null]) {
        assert.equal(labFlagCell({ value: v, flag: 'normal' }), '', JSON.stringify(v));
    }
    assert.equal(labFlagCell({ value: 'положительно', flag: 'high' }), '',
        'даже помеченный лабораторией текст флага не получает — оценивает врач');
});

test('isNumericValue отличает число от текста', () => {
    for (const v of ['1', '0', '-2.5', '3,4', ' 7 ']) assert.equal(isNumericValue(v), true, String(v));
    for (const v of ['', null, undefined, 'нет', '1-2', 'отр.']) assert.equal(isNumericValue(v), false, String(v));
});

// ── LAB_ANALYTE_RESOLVE_PURE_V1 — поиск показателя ───────────────────────────
// Эти правила решают, увидит ли пациент норму на бланке, и — что важнее —
// НЕ увидит ли он ЧУЖУЮ норму. Поэтому проверяются здесь, а не глазами.
const A = (name, extra = {}) => ({ name, ref_low: 1, ref_high: 9, ...extra });

test('точное имя находится без учёта регистра и лишних пробелов', () => {
    const idx = buildAnalyteIndex([A('ферритин')]);
    for (const n of ['Ферритин', '  ФЕРРИТИН ', 'Ферритин']) {
        assert.equal(resolveAnalyteWhy(idx, n).how, 'exact', n);
    }
    // Живой случай клиники: «WBC%   Лейкоциты» с тройным пробелом.
    const idx2 = buildAnalyteIndex([A('WBC% Лейкоциты')]);
    assert.equal(resolveAnalyteWhy(idx2, 'WBC%   Лейкоциты').how, 'exact');
});

test('панель услуги важнее общего справочника', () => {
    const idx = buildAnalyteIndex([A('Глюкоза', { ref_high: 99 })]);
    const local = new Map([['глюкоза', A('Глюкоза', { ref_high: 6.1 })]]);
    const r = resolveAnalyteWhy(idx, 'Глюкоза', local);
    assert.equal(r.how, 'panel');
    assert.equal(r.analyte.ref_high, 6.1, 'норма своей панели, а не чужой');
});

test('подбор по словам: имя результата входит в имя показателя', () => {
    const idx = buildAnalyteIndex([A('Тиреотропный гормон  ТТГ  (TSH)')]);
    const r = resolveAnalyteWhy(idx, 'Тиреотропный гормон (ТТГ)');
    assert.equal(r.how, 'tokens');
});

test('ОБРАТНОЕ направление запрещено — иначе подставится чужая норма', () => {
    // «Билирубин» (2–21.1) и «Dбил прямой билирубин» (0–5.13) — РАЗНЫЕ анализы.
    const idx = buildAnalyteIndex([A('Билирубин', { ref_low: 2, ref_high: 21.1 })]);
    const r = resolveAnalyteWhy(idx, 'Dбил прямой билирубин');
    assert.equal(r.analyte, null, 'общая норма не должна попасть на прямой билирубин');
});

test('имя из одного слова не подбираем — слишком общее', () => {
    const idx = buildAnalyteIndex([A('Лейкоциты в моче')]);
    assert.equal(resolveAnalyteWhy(idx, 'Лейкоциты').analyte, null);
});

test('спорное имя (разные нормы в разных панелях) остаётся без нормы', () => {
    const idx = buildAnalyteIndex([
        A('Лейкоциты', { ref_low: 4, ref_high: 9 }),      // кровь
        A('Лейкоциты', { ref_low: 0, ref_high: 5 }),      // моча
    ]);
    const r = resolveAnalyteWhy(idx, 'Лейкоциты');
    assert.equal(r.how, 'conflict');
    assert.equal(r.analyte, null, 'чужая норма хуже пустой графы');
    assert.ok(idx.conflicts.has('лейкоциты'));
});

test('одинаковое имя с ОДИНАКОВОЙ нормой спорным не считается', () => {
    const idx = buildAnalyteIndex([A('Мочевина'), A('Мочевина')]);
    assert.equal(resolveAnalyteWhy(idx, 'Мочевина').how, 'exact');
});

test('кандидат без нормы в подбор по словам не берётся', () => {
    const idx = buildAnalyteIndex([{ name: 'Холестерин общий (TC)' }]);   // норм нет
    assert.equal(resolveAnalyteWhy(idx, 'Холестерин общий').analyte, null);
});

test('именованные диапазоны едут вместе с показателем, где бы он ни нашёлся', () => {
    // Это и был случай ФСГ: показатель найден в другой панели, и все четыре
    // фазы цикла терялись, оставляя женщине одну мужскую норму.
    const fsg = {
        name: 'фолликулостимулирующий гормон. ФСГ', ref_low_m: 1.5, ref_high_m: 12.4,
        ref_ranges: JSON.stringify([
            { label: 'фолликулярная', low: 3.5, high: 12.5 },
            { label: 'постменопауза', low: 25.8, high: 134.8 },
        ]),
    };
    const idx = buildAnalyteIndex([fsg]);
    const found = resolveAnalyteWhy(idx, 'ФСГ (гормон)').analyte;
    assert.ok(found, 'ФСГ должен находиться по словам');
    const named = namedRangeCell(found, 'female', 35);
    assert.equal(named.count, 2, 'обе фазы дошли до бланка');
    const ref = labRefText(found, named.marked ? '' : 'female', '', named.texts);
    assert.ok(ref.includes('фолликулярная'), ref);
    assert.ok(ref.includes('постменопауза'), ref);
});

// ── LAB_PANEL_IS_TRUTH_V1 — панель услуги задаёт показатели заказа ───────────
const AN = (name, lo, hi) => ({ name, ref_low: lo, ref_high: hi });

test('панель из одного показателя всегда покрывает единственный результат — как бы его ни назвали', () => {
    // Ровно случай АМГ/ДЭАС/Т3: панель привязана к услуге, но имя в результате
    // отличается — раньше бланк печатал «—», теперь берёт норму панели.
    const panel = [AN('Антимюллеров гормон АМГ (ИФА)', 1.32, 12)];
    for (const written of ['Антимюллеров гормон (АМГ)', 'АМГ', 'amh', 'совсем другое имя']) {
        const m = matchResultsToAnalytes(panel, [written]);
        assert.equal(m[0] && m[0].ref_high, 12, written);
    }
});

test('точные имена сопоставляются по имени, остальные — по порядку', () => {
    const panel = [AN('WBC', 4, 10), AN('Гемоглобин (старое имя)', 120, 150), AN('PLT', 150, 400)];
    const m = matchResultsToAnalytes(panel, ['WBC', 'Гемоглобин', 'PLT']);
    assert.equal(m[0].name, 'WBC');
    assert.equal(m[1].name, 'Гемоглобин (старое имя)', 'переименованный взят по позиции');
    assert.equal(m[2].name, 'PLT');
});

test('счёт не совпал — позиционных догадок нет', () => {
    // Ввели только один показатель из трёх: пары были бы наугад.
    const panel = [AN('WBC', 4, 10), AN('RBC', 3.5, 5.5), AN('HGB', 120, 150)];
    const m = matchResultsToAnalytes(panel, ['ГЕМОГЛОБИН ПЕРЕИМЕНОВАННЫЙ']);
    assert.equal(m[0], null, 'лучше пусто, чем норма WBC на гемоглобине');
});

test('имя из панели совпало — позиция другого не сбивает', () => {
    const panel = [AN('А', 1, 2), AN('Б', 3, 4)];
    const m = matchResultsToAnalytes(panel, ['Б', 'что-то новое']);
    assert.equal(m[0].name, 'Б', 'по имени');
    assert.equal(m[1].name, 'А', 'оставшийся — по порядку');
});

test('пустая панель или нет результатов — просто нули, без ошибок', () => {
    assert.deepEqual(matchResultsToAnalytes([], ['X']), [null]);
    assert.deepEqual(matchResultsToAnalytes(null, ['X']), [null]);
    assert.deepEqual(matchResultsToAnalytes([AN('A', 1, 2)], []), []);
});

// ── LAB_SHEET_HEAD_V1 — одна шапка на все пути печати ────────────────────────
test('Заявка № — всегда формат LAB-xxxxxx', () => {
    assert.equal(labAccession(501), 'LAB-000501');
    assert.equal(labAccession(7), 'LAB-000007');
});

test('Приём: забор, а без забора — день визита', () => {
    assert.equal(labIssueDates({ visitDate: '2026-08-18T19:00:00Z', collectedAt: '2026-08-19T06:00:00Z' }).dateIn, '19.08.2026');
    assert.equal(labIssueDates({ visitDate: '2026-08-18T19:00:00Z' }).dateIn, '18.08.2026');
});

test('Выдан: проверка, без неё — последний ввод, и НИКОГДА не «сегодня»', () => {
    assert.equal(labIssueDates({ verifiedAt: '2026-08-20T10:00:00Z', lastEnteredAt: '2026-08-19T06:43:46Z' }).dateOut, '20.08.2026');
    assert.equal(labIssueDates({ lastEnteredAt: '2026-08-19T06:43:46Z' }).dateOut, '19.08.2026');
    assert.equal(labIssueDates({}).dateOut, '', 'нет ни проверки, ни ввода — дата пустая, а не текущая');
});

test('labMaxDate берёт самую позднюю дату колонки', () => {
    const rows = [{ entered_at: '2026-08-19T06:00:00Z' }, { entered_at: '2026-08-19T07:15:00Z' }, { entered_at: null }];
    assert.equal(labMaxDate(rows, 'entered_at'), '2026-08-19T07:15:00Z');
    assert.equal(labMaxDate([], 'entered_at'), null);
});
