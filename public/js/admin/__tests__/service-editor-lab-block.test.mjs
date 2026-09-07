// LAB_REFS_IN_PANELS_V1 — редактор услуги НЕ спрашивает единицы и нормы.
//
// Владелец: «when the lab selected, system asking for references etc. — this
// type of settings should be handled in labs/panels». И он прав по существу:
// у услуги одна единица и один диапазон, а у анализа их столько, сколько
// показателей. У общего анализа крови около двадцати, у каждого своя единица,
// свой диапазон и свои нормы для мужчин и женщин. Всё это живёт в панели, и
// бланк печатается по ней (LAB_PANEL_IS_TRUTH_V1). Поле «одна норма на
// услугу» заполняли, а на бланк оно не попадало.
//
// У редактора нет DOM-обвязки в тестах, поэтому проверка статическая: читаем
// исходник и ловим сам приём — возврат полей, а не их отрисовку.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'views', 'service-editor.js'), 'utf8');

test('в лабораторном блоке остались только материал и пробирка — единиц и норм нет', () => {
    for (const gone of ['Единица результата', 'Референс: от', 'Референс: до', 'Референс (текст)']) {
        assert.ok(!SRC.includes(gone), 'поле «' + gone + '» вернулось в редактор услуги — его место в панели');
    }
    assert.ok(SRC.includes('Материал (кровь, моча…)'), 'материал забора пропал из редактора');
    assert.ok(SRC.includes('Цвет пробирки'), 'цвет пробирки пропал из редактора');
    assert.ok(/Лаборатория → Панели/.test(SRC), 'нет подсказки, где задаются показатели и нормы');
});

test('прежние значения единиц и норм НЕ затираются при сохранении', () => {
    // Сервер пишет `lab.result_unit ?? null`: пропущенный ключ обнулил бы то,
    // что уже лежит в строке, — а у услуги без панели ввод результата всё ещё
    // падает на эти колонки (laboratory.js). Поэтому редактор обязан
    // отправлять их как есть, из строки.
    const block = SRC.slice(SRC.indexOf('args.lab = {'), SRC.indexOf('};', SRC.indexOf('args.lab = {')));
    for (const key of ['result_unit', 'ref_low', 'ref_high', 'ref_text']) {
        assert.ok(new RegExp(key + '\\s*:\\s*.*row').test(block),
            'ключ ' + key + ' не берётся из строки — сохранение обнулит его');
    }
    assert.ok(/specimen\s*:\s*specimenInp/.test(block), 'материал не берётся из поля');
    assert.ok(/tube_color\s*:\s*tubeSel/.test(block), 'пробирка не берётся из поля');
});
