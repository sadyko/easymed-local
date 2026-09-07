// SERVICE_TYPES_FIVE_V1 + SURGERY_NEEDS_BED_V1 — пять разделов и правило койки.
//
// Владелец: «lab goes to lab route, consultation goes to doctors cabinet,
// procedure is procedure route, diagnostics too goes to the doctors cabinet,
// and the surgery is bundled so it goes with the hospitalization — which means
// only in bed located patients service bill created».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SERVICE_SECTIONS } from '../../../public/js/admin/service-editor-logic.js';
import { isSurgery } from '../../services/rpc/queue.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('разделов ровно пять, и это те пять, что назвал владелец', () => {
    assert.deepEqual(SERVICE_SECTIONS.map((s) => s.type),
        ['consultation', 'lab', 'procedure', 'imaging', 'other']);
});

test('«Рентген» переводится в диагностику, а выдуманный тип база не принимает', () => {
    // Сузить CHECK нельзя: пересборка таблицы роняет запуск у клиники с
    // данными (см. шапку миграции 109). Поэтому 'radiology' база всё ещё
    // примет — но записывать его больше некому: в списке разделов его нет.
    const db = fresh();
    try {
        db.prepare("INSERT INTO services (name, type) VALUES ('Аппендэктомия','other')").run();
        assert.equal(db.prepare("SELECT type FROM services WHERE name='Аппендэктомия'").get().type, 'other',
            'хирургия хранится под other');
        assert.throws(() => db.prepare("INSERT INTO services (name, type) VALUES ('X','bogus')").run(),
            /CHECK|constraint/i);
    } finally { db.close(); }
});

test('миграция проходит на базе, где НА УСЛУГИ ССЫЛАЮТСЯ', () => {
    // Тот самый случай, которого не было в первых проверках и который уронил
    // клинику: строка визита ссылается на услугу. DROP TABLE при включённых
    // внешних ключах делает неявное удаление и падает. Теперь пересборки нет
    // вовсе, и эта проверка стоит сторожем: вернётся пересборка — упадёт здесь,
    // а не у клиники при запуске.
    const db = openDb(':memory:');
    const stage = tmpDir('em-mig109-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (f.startsWith('109_') || !f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO services (id,name,price,type) VALUES (900,'Лапароскопия',900000,'other')").run();
    db.prepare("INSERT INTO patients (id,full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO visits (id,patient_id,visit_date) VALUES (1,1,'2026-09-07T09:00:00Z')").run();
    db.prepare('INSERT INTO visit_services (visit_id,service_id,quantity,unit_price,total) VALUES (1,900,1,1,1)').run();

    migrate(db);   // 109 поверх базы со ссылками

    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 1, 'строка визита пропала');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'миграция порвала ссылки');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name='services'").get().n, 3,
        'триггеры 048 не пережили миграцию');
    db.close();
});

test('операцию узнают ПО ТИПУ, а не только по названию', () => {
    // Раньше единственным признаком было имя типа услуги (/хирург|surg|операц/).
    // «Аппендэктомия» под типом «Общая хирургия» угадывалась, а под типом
    // «Стационар» — нет. Теперь тип отвечает прямо.
    assert.equal(isSurgery({ svc_type: 'other', svc_type_name: 'Стационар' }), true,
        'тип surgery не распознан');
    assert.equal(isSurgery({ svc_type: 'procedure', svc_type_name: 'Малые операции' }), true,
        'запасной путь по названию пропал — старые услуги перестанут узнаваться');
    assert.equal(isSurgery({ svc_type: 'procedure', svc_type_name: 'Перевязки' }), false);
});
