// LAB_PRINT_SPACING_V1 (решение владельца 2026-11-07) — на бланке результатов
// анализы шли вплотную: таблица следующего анализа начиналась сразу под
// предыдущей, и на образцах клиники было не понять, где кончается один анализ.
// Теперь между блоками анализов — место и пунктирная черта; в полном и
// экономичном бланке, в том числе в общем бланке всех анализов визита.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml } from '../../shared/doc-render.js';

const S = { clinicName: 'Клиника', accent: '#0f766e', ink: '#16213f' };
const T = (name) => [{ name, value: '5', unit: 'г/л', ref: '1 – 9', flag: 'N', pos: 50 }];
const sheet = (variant, n = 3) => buildSheetHtml({
    type: 'lab', s: variant ? { ...S, variant: { lab: variant } } : S,
    data: { patientName: 'Тест Т.', groups: Array.from({ length: n }, (_, i) => ({ title: 'Анализ ' + (i + 1), tests: T('П' + i) })) },
});

test('полный бланк: каждый анализ — свой блок, между блоками место и черта', () => {
    const html = sheet(null);
    assert.equal((html.match(/<div class="grp">/g) || []).length, 3);
    assert.match(html, /\.grp \+ \.grp\{[^}]*margin-top:22px[^}]*border-top:1\.5px dashed/);
});

test('экономичный бланк: каждый анализ — свой блок (заголовок и таблица вместе), между блоками место и черта', () => {
    const html = sheet('compact');
    const blocks = html.match(/<div class="lgrp"><div class="secbar">[\s\S]*?<\/table><\/div>/g) || [];
    assert.equal(blocks.length, 3, 'заголовок анализа и его таблица — в одном блоке');
    assert.match(html, /\.lgrp \+ \.lgrp\{[^}]*margin-top:16px[^}]*border-top:1\.5px dashed/);
});

test('один анализ — черты нет (правило «блок + блок»)', () => {
    for (const v of [null, 'compact']) {
        const html = sheet(v, 1);
        assert.equal((html.match(/<div class="(?:grp|lgrp)">/g) || []).length, 1);
    }
});
