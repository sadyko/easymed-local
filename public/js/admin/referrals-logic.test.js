// REFERRALS_CRM_V1 — чистая логика экрана «Реферирование».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultPeriod, dmy, fmtSum, subline, matches, groupByRepresentative, groupTotals,
    dynamicsCell, printSheet, ACTIVITY_LABELS, ACTIVITY_TAG,
    serviceDetailColumns,   // REFERRAL_ADJ_LABEL_I18N_V1
} from './referrals-logic.js';
import { STRINGS } from './i18n-strings.js';   // REFERRAL_ADJ_LABEL_I18N_V1

test('defaultPeriod: с 1-го числа месяца по сегодня, локальные даты', () => {
    assert.deepEqual(defaultPeriod(new Date(2026, 9, 26, 15, 0)), { from: '2026-10-01', to: '2026-10-26' });
    assert.deepEqual(defaultPeriod(new Date(2026, 0, 1, 0, 30)), { from: '2026-01-01', to: '2026-01-01' });
});

test('dmy / fmtSum / subline', () => {
    assert.equal(dmy('2026-10-26'), '26.10.2026');
    assert.equal(dmy(''), '—');
    assert.equal(fmtSum(14705000), '14 705 000');
    assert.equal(fmtSum('x'), '—');
    assert.equal(subline(['№ 0003', '', null, '998912098887']), '№ 0003 · 998912098887');
});

test('matches: несколько полей, без регистра, пустой запрос — всё', () => {
    const row = { name: 'Набиев Ойбек', code: '0086', phone: '+998 90 310 65 70' };
    assert.equal(matches(row, 'ойбек', ['name', 'code']), true);
    assert.equal(matches(row, '0086', ['name', 'code']), true);
    assert.equal(matches(row, '310', ['name', 'code']), false, 'телефон не в списке полей');
    assert.equal(matches(row, '', ['name']), true);
});

test('groupByRepresentative: группы в порядке представителей, пустая группа представителя остаётся, «Без представителя» — последняя и только непустая', () => {
    const reps = [{ id: 4, full_name: 'Один' }, { id: 7, full_name: 'Два' }];
    const sources = [
        { id: 1, name: 'А', representative_id: 7, visits: 2, patients: 2, received: 100 },
        { id: 2, name: 'Б', representative_id: null, visits: 0, patients: 0, received: 0 },
        { id: 3, name: 'В', representative_id: 99, visits: 1, patients: 1, received: 5 },   // уволенный — без представителя
    ];
    const g = groupByRepresentative(sources, reps);
    assert.deepEqual(g.map((x) => (x.rep ? x.rep.full_name : null)), ['Один', 'Два', null]);
    assert.deepEqual(g[0].rows, []);
    assert.deepEqual(g[1].rows.map((r) => r.id), [1]);
    assert.deepEqual(g[2].rows.map((r) => r.id), [2, 3]);
    assert.deepEqual(g[2].totals, { doctors: 2, referring: 1, visits: 1, patients: 1, received: 5 });
    assert.deepEqual(groupByRepresentative([{ id: 1, representative_id: 4, visits: 0 }], reps).length, 2, 'нет «без представителя» — группы нет');
});

test('groupTotals считает врачей, направлявших и суммы; нечисла — нули', () => {
    assert.deepEqual(groupTotals([{ visits: 3, patients: 2, received: '10' }, { visits: 0 }]),
        { doctors: 2, referring: 1, visits: 3, patients: 2, received: 10 });
});

test('dynamicsCell: «+3» / «−2» / «—»', () => {
    assert.deepEqual(dynamicsCell(5, 2), { text: '+3', kind: 'ok' });
    assert.deepEqual(dynamicsCell(1, 3), { text: '−2', kind: 'crit' });
    assert.deepEqual(dynamicsCell(0, 0), { text: '—', kind: '' });
    for (const k of Object.keys(ACTIVITY_LABELS)) assert.ok(k in ACTIVITY_TAG, 'нет цвета у статуса ' + k);
});

test('printSheet: колонки — подписи, строки — массивы в порядке колонок, числа остаются числами', () => {
    const sheet = printSheet({
        title: 'Врачи', from: '2026-10-01', to: '2026-10-26',
        columns: [{ key: 'name', label: 'Врач' }, { key: 'visits', label: 'Визитов' }, { label: 'Код', value: (r) => '№ ' + r.code }],
        rows: [{ name: 'А', visits: 3, code: '0001' }],
    });
    assert.deepEqual(sheet.res, { columns: ['Врач', 'Визитов', 'Код'], rows: [['А', 3, '№ 0001']] });
    assert.deepEqual(sheet.meta, { title: 'Врачи', from: '2026-10-01', to: '2026-10-26' });
});

// REFERRAL_ADJ_LABEL_I18N_V1 (3.22.0, ревью) — «Подробнее» (и его печать): подпись
// корректировки закрытого месяца — на языке экрана, тем же шаблоном словаря, что
// ячейка отчёта (report-totals.js viaTemplate); по-русски — текст сервера как есть.
const MONTHS = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    uz: ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'],
    ru: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
};
const txFor = (lang) => {
    const tr = (s) => (STRINGS[s] && STRINGS[s][lang]) || s;
    return { lang, tr, trf: (tpl, p) => Object.entries(p || {}).reduce((o, [k, v]) => o.split('{' + k + '}').join(String(v)), tr(tpl)),
        monthName: (m) => MONTHS[lang][m] };
};
test('serviceDetailColumns: подпись корректировки — на языке экрана; услуга клиники — как есть', () => {
    const adj = { date: '2026-11-01', patient: 'П', service: 'Корректировка за октябрь 2026',
        service_t: { template: 'Корректировка за {month}', params: { month: '2026-10' } }, status: null, received: 0, reward: -25000 };
    const usg = { date: '2026-11-02', patient: 'П', service: 'УЗИ', status: 'completed', received: 1, reward: 1 };
    const svc = (lang) => serviceDetailColumns(true, { sumText: String, tr: txFor(lang).tr, tx: txFor(lang) }).find((c) => c.label === 'Услуга').value;
    assert.equal(svc('en')(adj), 'Adjustment for October 2026');
    assert.equal(svc('uz')(adj), 'Oktabr 2026 uchun tuzatish');
    assert.equal(svc('ru')(adj), 'Корректировка за октябрь 2026', 'по-русски — текст сервера как есть');
    assert.equal(svc('en')(usg), 'УЗИ', 'название услуги клиники не переводится');
    assert.equal(svc('en')({ service: '' }), '—');
    // Без tx (прежний вызов) — как прежде: текст сервера.
    assert.equal(serviceDetailColumns(true, { sumText: String, tr: txFor('en').tr }).find((c) => c.label === 'Услуга').value(adj), 'Корректировка за октябрь 2026');
    const k = 'Корректировка за {month}';
    assert.ok(STRINGS[k] && STRINGS[k].uz && STRINGS[k].en, k + ': статья словаря');
    assert.ok(!/[Ѐ-ӿ]/.test(STRINGS[k].uz + STRINGS[k].en), k + ': без кириллицы в uz/en');
});

test('экраны «Подробнее» передают в колонки словарь языка экрана (tx), а не один tr', async () => {
    const fs = await import('node:fs');
    for (const f of ['./views/referrals-representatives.js', './views/referrals-activity.js']) {
        const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
        assert.match(src, /serviceDetailColumns\(money, \{ sumText, tr, tx: detailTx\(\) \}\)/, f);
    }
});
