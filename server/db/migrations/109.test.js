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
        ['consultation', 'lab', 'procedure', 'imaging', 'surgery']);
});

test('«Другое» и «Рентген» больше не принимаются базой', () => {
    // Рентген не значил ничего: своей ветки в маршрутизаторе у него не было,
    // он падал в тот же else, что и «Другое». Услуг с этим типом не было ни в
    // одной базе — удаление никого не задело.
    const db = fresh();
    try {
        for (const dead of ['other', 'radiology']) {
            assert.throws(() => db.prepare('INSERT INTO services (name, type) VALUES (?,?)').run('X', dead),
                /CHECK|constraint/i, 'тип «' + dead + '» всё ещё принимается');
        }
        db.prepare("INSERT INTO services (name, type) VALUES ('Аппендэктомия','surgery')").run();
        assert.equal(db.prepare("SELECT type FROM services WHERE name='Аппендэктомия'").get().type, 'surgery');
    } finally { db.close(); }
});

test('услуги, лежавшие под «Другим», стали процедурами, а не пропали', () => {
    // 183 услуги из 545 в рабочем наборе — вторая по величине группа. Молча
    // потерять их значило бы вынуть из прейскуранта пятую часть клиники.
    const db = openDb(':memory:');
    // Состояние ДО этой миграции: каталог со всеми файлами, кроме 109.
    // migrate() принимает каталог, а не «до какого номера», поэтому копия.
    const stage = tmpDir('em-mig109-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (f.startsWith('109_')) continue;
        if (!f.endsWith('.sql')) continue;
        fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO services (id, name, type) VALUES (900,'Лапароскопическая нефрэктомия','other')").run();
    migrate(db);   // теперь полный набор — 109 доедет и переведёт строку
    const row = db.prepare('SELECT name, type FROM services WHERE id = 900').get();
    assert.ok(row, 'услуга «Другое» пропала при пересборке таблицы');
    // В procedure их переводить БЫЛО БЫ ОШИБКОЙ: в настройках услуг тип
    // 'other' подписан «Хирургия», и все 183 такие услуги в рабочем наборе —
    // настоящие операции. Процедура не требует койки, и правило
    // SURGERY_NEEDS_BED_V1 обошло бы их стороной.
    assert.equal(row.type, 'surgery', 'услуга, записанная как «Хирургия», не стала операцией');
    db.close();
});

test('операцию узнают ПО ТИПУ, а не только по названию', () => {
    // Раньше единственным признаком было имя типа услуги (/хирург|surg|операц/).
    // «Аппендэктомия» под типом «Общая хирургия» угадывалась, а под типом
    // «Стационар» — нет. Теперь тип отвечает прямо.
    assert.equal(isSurgery({ svc_type: 'surgery', svc_type_name: 'Стационар' }), true,
        'тип surgery не распознан');
    assert.equal(isSurgery({ svc_type: 'procedure', svc_type_name: 'Малые операции' }), true,
        'запасной путь по названию пропал — старые услуги перестанут узнаваться');
    assert.equal(isSurgery({ svc_type: 'procedure', svc_type_name: 'Перевязки' }), false);
});
