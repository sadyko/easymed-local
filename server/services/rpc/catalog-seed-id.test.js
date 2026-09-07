// SEED_ID_DELETE_V1 — услугу с ОТРИЦАТЕЛЬНЫМ id можно проверить и удалить.
//
// ЖИВОЙ СЛУЧАЙ. Владелец нажал «удалить» на «Общем анализе крови (CBC)» и
// получил «p_service_id must be a positive integer». Услуга не битая: миграция
// 041 нарочно заводит её под id = -41, чтобы образец не столкнулся с настоящими
// строками и не сдвинул счётчик. Проверка «> 0» на входе отвергала её раньше,
// чем дело доходило до разбора истории, — и вместо честного «используется в
// визитах, отключите» человек видел бессмысленную ошибку про число.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { deleteService, serviceDeleteCheck } from './catalog.js';

const ADMIN = { id: 1, role: 'admin' };
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

// Один визит с этой услугой — ровно та история, что была у владельца
// (у него 5 визитов, 3 счёта и панель). Посеянная миграцией панель на свежей
// базе не переживает поздние миграции, поэтому ссылка заводится здесь.
function referenceIt(db, serviceId) {
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'П')").run();
    db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1, 1, '2026-09-07T09:00:00Z')").run();
    db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (1, ?, 1, 1, 1)').run(serviceId);
}

test('образцовая услуга с id = -41 существует после миграций и её можно ПРОВЕРИТЬ', () => {
    const db = fresh();
    try {
        const seed = db.prepare("SELECT id FROM services WHERE code = 'LAB-CBC'").get();
        assert.ok(seed && seed.id < 0, 'образец CBC не посеян под отрицательным id: ' + JSON.stringify(seed));

        referenceIt(db, seed.id);
        // Раньше здесь летел 400 про «positive integer». Теперь — честный ответ.
        const chk = serviceDeleteCheck(db, { p_service_id: seed.id }, ADMIN);
        assert.equal(chk.name, 'Общий анализ крови (CBC)');
        // На образец ссылается визит — удалять нельзя, и человеку это скажут
        // словами («визиты: 1»), а не «числом».
        assert.equal(chk.deletable, false);
        assert.ok(chk.blocking.some((b) => b.table === 'visit_services' && b.count === 1),
            'визит, ссылающийся на образец, не назван: ' + JSON.stringify(chk.blocking));
    } finally { db.close(); }
});

test('удаление услуги с историей отвергается ПО СУЩЕСТВУ (409), а не по форме id', () => {
    const db = fresh();
    try {
        const seed = db.prepare("SELECT id FROM services WHERE code = 'LAB-CBC'").get();
        referenceIt(db, seed.id);
        assert.throws(() => deleteService(db, { p_service_id: seed.id }, ADMIN),
            (e) => e.status === 409 && /используется/.test(e.message),
            'ожидался отказ 409 с объяснением про историю');
        assert.ok(db.prepare('SELECT 1 FROM services WHERE id = ?').get(seed.id), 'услуга пропала вопреки отказу');
    } finally { db.close(); }
});

test('неиспользованная услуга с отрицательным id удаляется без следа', () => {
    // Сама возможность отрицательного номера не должна мешать удалению того,
    // на что никто не ссылается.
    const db = fresh();
    try {
        db.prepare("INSERT INTO services (id, name, price, type) VALUES (-77, 'Пробная', 1, 'consultation')").run();
        const r = deleteService(db, { p_service_id: -77 }, ADMIN);
        assert.equal(r.deleted, true);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM services WHERE id = -77').get().n, 0);
    } finally { db.close(); }
});

test('ноль и не-число по-прежнему отвергаются на входе', () => {
    const db = fresh();
    try {
        for (const bad of [0, 'abc', null, undefined, 1.5]) {
            assert.throws(() => serviceDeleteCheck(db, { p_service_id: bad }, ADMIN),
                (e) => e.status === 400, 'значение ' + String(bad) + ' прошло проверку формы');
        }
    } finally { db.close(); }
});
