// CALL_FROM_CRM_V1 — внутренний номер сотрудника: колонка есть, экраны её
// читают, пишет её только карточка сотрудника, и набирается он проверенным.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { readableColumns, canWrite } from '../schema-registry.js';
import { parseEmployeeFields } from '../../routes/users.js';

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    return db;
}

test('у сотрудника есть внутренний номер, и экраны его читают', () => {
    const db = seed();
    try {
        const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
        assert.ok(cols.includes('pbx_extension'), 'нет колонки pbx_extension');
        assert.ok(readableColumns('users').includes('pbx_extension'),
            'внутренний номер не читается — разбор по операторам покажет числа вместо имён');
    } finally { db.close(); }
});

test('внутренний номер не правится через общий доступ к базе — только карточкой сотрудника', () => {
    const db = seed();
    try {
        // users целиком закрыт на запись через /api/db (так было и до этого):
        // сотрудников заводит и правит routes/users.js со своими проверками.
        // Спрашиваем реестр тем же вопросом, что и компилятор запросов: список
        // ролей наружу он не отдаёт.
        const ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter'];
        for (const op of ['insert', 'update', 'delete']) {
            const who = ROLES.filter((r) => canWrite('users', op, r));
            assert.deepEqual(who, [], 'таблица сотрудников открылась на запись через общий доступ к базе: ' + op);
        }
    } finally { db.close(); }
});

test('номер проверяется как НАБИРАЕМАЯ строка, а не как любой текст', () => {
    const db = seed();
    try {
        // Годное.
        assert.equal(parseEmployeeFields({ pbx_extension: '101' }, db).fields.pbx_extension, '101');
        assert.equal(parseEmployeeFields({ pbx_extension: ' 0912 ' }, db).fields.pbx_extension, '0912',
            'пробелы по краям должны срезаться, а ведущий ноль — остаться');
        assert.equal(parseEmployeeFields({ pbx_extension: '' }, db).fields.pbx_extension, null,
            'пустое поле должно СТИРАТЬ номер: не все сотрудники сидят на телефоне');

        // Негодное. Каждая из этих строк ушла бы на станцию как «кому звонить».
        for (const bad of ['abc', '10 1', '+998901234567', '101;rm', '1234567890123']) {
            const r = parseEmployeeFields({ pbx_extension: bad }, db);
            assert.equal(r.ok, false, 'принят негодный внутренний номер: ' + bad);
        }
    } finally { db.close(); }
});
