// MOIZVONKI_V1 — третья телефония ложится в ту же таблицу подключений, и
// старый потолок видов её больше не держит.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { saveProvider, listProviders, getProviderRow, providerKind } from '../../services/telephony/providers.js';

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    return db;
}

test('у подключения есть колонка настоящего вида, а звонки по-прежнему на неё ссылаются', () => {
    const db = seed();
    try {
        const cols = db.prepare('PRAGMA table_info(telephony_providers)').all().map((c) => c.name);
        assert.ok(cols.includes('vendor'), 'нет колонки vendor');
        // Ради этого внешнего ключа таблицу и не пересобирали: журнал звонков
        // помнит, через какое подключение приехал каждый звонок.
        const fks = db.prepare('PRAGMA foreign_key_list(calls)').all();
        assert.ok(fks.some((f) => f.table === 'telephony_providers'),
            'связь звонка с подключением потеряна — журнал оторвётся от телефонии');
    } finally { db.close(); }
});

test('«Мои Звонки» заводятся и читаются своим видом, а не чужим', () => {
    const db = seed();
    try {
        const saved = saveProvider(db, {
            kind: 'moizvonki', name: 'Мои Звонки',
            config: { domain: 'clinic.moizvonki.ru', user_name: 'a@b.uz' },
            secret: { api_key: 'secret-key' },
            enabled: true,
        });
        assert.equal(saved.kind, 'moizvonki');
        assert.equal(saved.kind_label, 'Мои Звонки');
        assert.equal(saved.config.domain, 'clinic.moizvonki.ru');
        assert.equal(saved.config.user_name, 'a@b.uz');
        // Ключ наружу не выходит — только признак «сохранён».
        assert.equal(saved.secret_set.api_key, true);
        assert.equal(saved.api_key, undefined);
        assert.equal(JSON.stringify(saved).includes('secret-key'), false, 'ключ уехал в браузер');

        const [row] = listProviders(db);
        assert.equal(row.kind, 'moizvonki', 'в списке подключение названо чужим видом');
        assert.equal(providerKind(getProviderRow(db, row.id)), 'moizvonki');
    } finally { db.close(); }
});

test('старая колонка kind осталась историей: по ней «Мои Звонки» не найти — и код по ней не ищет', () => {
    const db = seed();
    try {
        saveProvider(db, {
            kind: 'moizvonki', name: 'Мои Звонки',
            config: { domain: 'clinic.moizvonki.ru', user_name: 'a@b.uz' },
            secret: { api_key: 'k' }, enabled: true,
        });
        // Вот она, ловушка, ради которой написан этот тест: прямой запрос по
        // kind возвращает подключение как onlinePBX.
        const byKind = db.prepare("SELECT kind, vendor FROM telephony_providers").get();
        assert.equal(byKind.kind, 'onlinepbx', 'легенда изменилась — перечитайте миграцию 135');
        assert.equal(byKind.vendor, 'moizvonki');

        // Поэтому весь код обязан спрашивать vendor. Проверяем это не на словах:
        // ни один файл телефонии не фильтрует по kind в SQL.
        const dir = new URL('../../services/telephony/', import.meta.url);
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
            const src = fs.readFileSync(new URL(f, dir), 'utf8');
            assert.equal(/WHERE[^;]*\bkind\s*=/.test(src), false,
                f + ' фильтрует подключения по kind — «Мои Звонки» молча выпадут');
        }
    } finally { db.close(); }
});

test('старые строки без vendor читаются как onlinePBX — их никто не переписывал', () => {
    const db = seed();
    try {
        db.prepare(`INSERT INTO telephony_providers (kind, name, enabled, config, secret)
                    VALUES ('onlinepbx', 'Старое подключение', 1, '{"domain":"a.onpbx.ru"}', '{"auth_key":"k"}')`).run();
        const [row] = listProviders(db);
        assert.equal(row.kind, 'onlinepbx');
        assert.equal(row.kind_label, 'onlinePBX');
    } finally { db.close(); }
});
