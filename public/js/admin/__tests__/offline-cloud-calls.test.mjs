// V3120_FIX (2026-09-27) — ОФЛАЙН-КЛИЕНТ НЕ ХОДИТ В ОБЛАКО.
//
// Инспекция v3.12.0 («войти отовсюду» под двенадцатью ролями) насчитала
// запросы, которые офлайн-сервер не может выполнить НИКОГДА — не по праву, а
// потому что адреса или таблицы нет вовсе:
//   * GET /api/v1/company/flags            — clinic-flags.js, 10 ролей;
//   * support_tickets каждые 25 секунд      — support-widget.js, 87 отказов;
//   * GET /api/v1/lookups/catalog          — «Услуги», списки «Тип»/«Категория» пусты;
//   * /api/v1/catalog/*, /identity/doctor  — «Мой профиль» врача (doctor-profile-save.test.mjs).
// Каждый из них — шум в консоли и потерянная секунда на экране, а у «Услуг»
// ещё и пустые списки. Здесь сторожится, что они не вернутся.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

test('флаги клиники отвечают сразу и без запроса', async () => {
    const calls = [];
    globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: false, status: 404, text: async () => '', json: async () => ({}) }; };
    const { clinicFlags, clinicFlagsSync } = await import('../clinic-flags.js');
    assert.deepEqual(await clinicFlags(), {});
    assert.deepEqual(clinicFlagsSync(), {});
    assert.deepEqual(calls, [], 'флаги спросили сеть: ' + calls.join(', '));
    assert.ok(!/gateway\.js/.test(read('clinic-flags.js')), 'clinic-flags.js снова тянет облачный шлюз');
});

test('виджет поддержки не опрашивает облачные таблицы и не предлагает мёртвый чат', () => {
    const src = read('support-widget.js');
    assert.match(src, /export const SUPPORT_CHAT_AVAILABLE = false;/);
    // первый запрос и опрос — только за флагом
    assert.match(src, /async function refresh\(\{ markRead = false \} = \{\}\) \{\n\s*if \(!SUPPORT_CHAT_AVAILABLE\) return;/,
        'refresh() ходит в support_tickets без проверки');
    const mount = src.slice(src.indexOf('export function mountSupportWidget('));
    assert.match(mount, /if \(SUPPORT_CHAT_AVAILABLE\) \{\s*\n\s*refresh\(\);/, 'после входа виджет снова спрашивает тикет');
    assert.ok(!/\n\s{12}refresh\(\);\n\s{12}\/\/ Single owned/.test(mount), 'безусловный опрос вернулся');
    // пункт меню чата — только при доступном чате
    assert.match(src, /SUPPORT_CHAT_AVAILABLE \? `/, 'пункт «Чат поддержки» рисуется безусловно');
});

test('«Тип» и «Категория» услуг читаются из своей базы, а не из облачного каталога', () => {
    const src = read('views/section-crud.js');
    const prime = src.slice(src.indexOf('async function primeFkCache('), src.indexOf('const labelCol = FK_LABEL_COLUMN[table]', src.indexOf('async function primeFkCache(')));
    assert.ok(prime.length > 0, 'primeFkCache не найден — тест проверяет не то');
    assert.ok(!/gw\(/.test(prime), 'справочники услуг снова грузятся через /api/v1/lookups/catalog');
    assert.ok(!/fk cache gw/.test(src), 'осталась ветка чтения каталога через шлюз');
});

test('дополнительные колонки справочников — только те, что есть в офлайн-схеме', async () => {
    const { FK_EXTRA_COLUMNS } = await import('../sections.js');
    const reg = fs.readFileSync(path.join(HERE, '..', '..', '..', '..', 'server', 'db', 'schema-registry.js'), 'utf8');
    for (const [table, cols] of Object.entries(FK_EXTRA_COLUMNS)) {
        const at = reg.indexOf('\n  ' + table + ':');
        assert.ok(at > 0, table + ' нет в реестре схемы');
        const readCols = reg.slice(at, reg.indexOf('\n', at + 1) + 400).match(/read:\s*\{[^}]*columns:\s*\[([^\]]*)\]/);
        assert.ok(readCols, table + ': не нашёл колонки чтения');
        for (const c of cols) assert.ok(readCols[1].includes("'" + c + "'"), table + '.' + c + ' нет в офлайн-схеме — запрос справочника отвергнут целиком');
    }
});
