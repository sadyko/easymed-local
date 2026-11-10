// REPEAT_VISIT_V1 (ревью, остаток 10) — ОДИН ЭКЗЕМПЛЯР КАТАЛОГА: ОДИН КЭШ СВОБОДНОГО ВРЕМЕНИ.
//
// service-picker-modal.js держит кэш дней врача на модуле (loadSlotDay / forgetSlots):
// мастер, калькулятор, окно «Повторный визит» кабинета (service-workspace.js) и запись
// (visit-booking.js → calendarBookOrAsk → forgetSlots) обязаны видеть ОДИН кэш. Модуль,
// загруженный по другому адресу (без ?v=ownrep4 или с другим штампом), — второй экземпляр
// со своим кэшем: запись сбрасывает один, окно читает другой — и показывает свободным
// только что занятое время. Так были загружены тесты (адрес без штампа): их forgetSlots()
// не сбрасывал кэш экранов, которые они проверяют.
//
// Страж: каждый импорт service-picker-modal.js под public/js и в тестах сервера —
// статический (from '…'), побочный (import '…') и динамический (import('…')) — ведёт к
// views/service-picker-modal.js с одним и тем же штампом. И проверка поведения: сброс
// кэша со стороны записи (visit-booking.js) действует на кэш, из которого читает loadSlotDay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './cabinet-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_ROOT = resolve(HERE, '..', '..');                     // public/js
const REPO = resolve(JS_ROOT, '..', '..');
const PICKER = resolve(JS_ROOT, 'admin', 'views', 'service-picker-modal.js');
const NAME = ['service', 'picker', 'modal'].join('-');          // имя из частей: образцы ниже стражу не попадаются
const PICKER_IMPORT = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"\x60])([^'"\x60\n]*` + NAME + String.raw`\.js[^'"\x60\n]*)\1`, 'g');

/** Импорты каталога в тексте модуля: [{ spec, path, stamp }] — stamp: всё от ? или # (или ''). */
function pickerImports(src) {
    const out = [];
    for (const m of String(src).matchAll(PICKER_IMPORT)) {
        const spec = m[2];
        const cut = spec.search(/[?#]/);
        out.push({ spec, path: cut < 0 ? spec : spec.slice(0, cut), stamp: cut < 0 ? '' : spec.slice(cut) });
    }
    return out;
}

function jsFiles(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) jsFiles(p, out);
        else if (/\.(m?js)$/.test(e.name)) out.push(p);
    }
    return out;
}

test('страж: детектор находит импорт каталога — статический, побочный, динамический; штамп отделяется; комментарий — не импорт', () => {
    const sample = [
        `import { openServicePickerModal } from './${NAME}.js?v=ownrep4';`,
        `import { loadSlotDay }\n    from './${NAME}.js';`,
        `import '../views/${NAME}.js#x';`,
        `const m = await import("../views/${NAME}.js?v=2");`,
    ].join('\n');
    assert.deepEqual(pickerImports(sample).map((x) => x.stamp), ['?v=ownrep4', '', '#x', '?v=2']);
    assert.deepEqual(pickerImports(`// (${NAME}.js askEmergencyReason)`), [], 'комментарий принят за импорт');
    assert.deepEqual(pickerImports(`fs.readFileSync(new URL('../views/${NAME}.js', import.meta.url))`), [], 'чтение файла принято за импорт');
});

test('страж: каждый импорт service-picker-modal.js — один файл и один штамп (один экземпляр модуля, один кэш времени)', () => {
    const found = [];
    const files = [...jsFiles(JS_ROOT), ...jsFiles(resolve(REPO, 'server'))];
    for (const file of files) {
        for (const { spec, path, stamp } of pickerImports(readFileSync(file, 'utf8'))) {
            const rel = file.slice(REPO.length + 1).replace(/\\/g, '/');
            assert.ok(path.startsWith('.'), `${rel}: «${spec}» — не относительный адрес`);
            assert.equal(resolve(dirname(file), path), PICKER, `${rel}: «${spec}» — не views/service-picker-modal.js`);
            found.push({ rel, stamp });
        }
    }
    const stamps = [...new Set(found.map((f) => f.stamp))];
    assert.equal(stamps.length, 1, 'разные адреса каталога — разные экземпляры и кэши: '
        + JSON.stringify(stamps.map((s) => [s, found.filter((f) => f.stamp === s).map((f) => f.rel)])));
    // Страж не проходит «вхолостую»: каталог грузят кабинет врача, запись, мастер и CRM.
    for (const must of ['public/js/admin/views/service-workspace.js', 'public/js/admin/views/visit-booking.js',
        'public/js/admin/views/visit-wizard.js', 'public/js/admin/views/crm.js']) {
        assert.ok(found.some((f) => f.rel === must), 'страж не нашёл импорт каталога в ' + must);
    }
});

// ─── поведение: сброс кэша записью действует на кэш loadSlotDay ─────────────
installFakeDom();
let slotCalls = 0;
globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (u === '/api/rpc/calendar_slots') {
        slotCalls += 1;
        return ok({ window: { from: '09:00', to: '18:00' }, slots: [{ start: '10:00' }, { start: '10:20' }], busy: [] });
    }
    if (u === '/api/rpc/calendar_book') return ok({ visit: { id: 501, visit_date: '2026-12-10T05:00:00.000Z' }, created: true });
    return { ok: false, status: 404, json: async () => ({ error: { message: 'нет маршрута ' + u } }) };
};
const STAMP = pickerImports(readFileSync(resolve(JS_ROOT, 'admin', 'views', 'service-workspace.js'), 'utf8'))[0].stamp;
const SPM = await import('../views/service-picker-modal.js?v=ownrep4');
const VB = await import('../views/visit-booking.js');

test('кэш времени один: forgetSlots записи (visit-booking.js) и запись bookVisit сбрасывают кэш, из которого читает loadSlotDay', async () => {
    assert.equal(STAMP, '?v=ownrep4', 'кабинет врача грузит каталог не по тому адресу, что этот тест');
    assert.equal(VB.forgetSlots, SPM.forgetSlots, 'запись сбрасывает другой экземпляр кэша');
    const ask = () => SPM.loadSlotDay(11, '2026-12-10', 30);   // SLOT_PACK_V1 — без своего шага
    SPM.forgetSlots();
    slotCalls = 0;
    await ask(); await ask();
    assert.equal(slotCalls, 1, 'день не закэширован');
    VB.forgetSlots();
    await ask();
    assert.equal(slotCalls, 2, 'forgetSlots записи не сбросил кэш loadSlotDay');
    const booked = await VB.bookVisit({ patient_id: 77, doctor_id: 11, start: '2026-12-10T05:00:00.000Z', duration_minutes: 30, status: 'scheduled' });
    assert.equal(booked.created, true);
    await ask();
    assert.equal(slotCalls, 3, 'после записи окно «Повторный визит» показало бы прежнее свободное время');
});
