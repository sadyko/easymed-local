// ROLE_ACTIONS_V1 (2026-09-06) — ЭКРАН ПРАВ НЕ ПРЕДЛАГАЕТ ТОГО, ЧЕГО НЕТ.
//
// Владелец: «the roles dont understandable for human to manage… i mean every
// module, every action in every module».
//
// Экран предлагал у каждого из семнадцати разделов выбор из трёх уровней.
// Уровень при этом читают ПЯТЬ ключей во всей программе: у остальных он не
// значит ничего, и «Только просмотр» у кассы оставляло кассу ровно такой же.
// Право, которого нет, показанное галочкой, опаснее отсутствия галочки: первое
// даёт ложную уверенность, второе заставляет спросить.
//
// Этот тест — договор между таблицей действий и ИСХОДНЫМ КОДОМ, в обе стороны:
//   • появилась в коде проверка canEdit('X') — таблица обязана назвать это
//     действие словами, иначе право есть, а управлять им нечем;
//   • таблица называет действие, которого в коде нет — значит экран обещает
//     несуществующее, и это надо убрать.
// Сверять глазами такое невозможно: проверки живут в 105 файлах видов.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODULE_ACTIONS, MODULE_PLAIN, levelsFor, actionFor, openAction, levelFromActions, actionsFromLevel } from '../role-actions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.resolve(HERE, '..', '..');

function sourceFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'vendor') sourceFiles(p, out); }
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
    }
    return out;
}

/** Ключи, для которых код РЕАЛЬНО различает уровень. */
function levelsUsedInCode() {
    const used = new Map();   // key -> Set('editor'|'admin')
    const add = (key, lvl) => {
        if (!used.has(key)) used.set(key, new Set());
        used.get(key).add(lvl);
    };
    for (const file of sourceFiles(JS_ROOT)) {
        // permissions.js САМ объявляет canEdit/canDelete — их определения не в счёт.
        if (path.basename(file) === 'permissions.js') {
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(/canEdit\('([a-z:_-]+)'\)/g)) add(m[1], 'editor');
            for (const m of src.matchAll(/canDelete\('([a-z:_-]+)'\)/g)) add(m[1], 'admin');
            continue;
        }
        const src = fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        for (const m of src.matchAll(/canEdit\('([a-z:_-]+)'\)/g)) add(m[1], 'editor');
        for (const m of src.matchAll(/canDelete\('([a-z:_-]+)'\)/g)) add(m[1], 'admin');
    }
    return used;
}

test('каждый уровень, который код различает, назван на экране словами', () => {
    const used = levelsUsedInCode();
    const missing = [];
    for (const [key, levels] of used) {
        // Разделы настроек описаны одним правилом (section-crud.js правит и
        // удаляет строки любого справочника), поэтому проверяются отдельно ниже.
        if (key.startsWith('settings:')) continue;
        // Раздел, которого нет в списке выдаваемых, управлять нечем — такие
        // ключи ловит другой страж (roles-editor.test.mjs).
        if (!MODULE_ACTIONS[key] && !MODULE_PLAIN[key]) continue;
        for (const lvl of levels) {
            if (!actionFor(key, lvl)) missing.push(key + ' → ' + lvl);
        }
    }
    assert.deepEqual(missing, [],
        'код различает эти уровни, а экран о них молчит — правом нельзя управлять:\n  ' + missing.join('\n  '));
});

test('экран не предлагает уровня, которого код не различает', () => {
    const used = levelsUsedInCode();
    const invented = [];
    for (const key of Object.keys(MODULE_ACTIONS)) {
        for (const lvl of levelsFor(key)) {
            const have = used.get(key);
            if (!have || !have.has(lvl)) invented.push(key + ' → ' + lvl);
        }
    }
    assert.deepEqual(invented, [],
        'экран обещает право, которого в коде нет — это ложная уверенность:\n  ' + invented.join('\n  '));
});

test('разделы без уровней описаны действием, а не пустотой', () => {
    // Именно они и составляют большинство: у них не должно быть выбора уровня,
    // но обязана быть строка «что человек здесь делает» — иначе выдавать
    // раздел приходится наугад по его названию.
    for (const [key, text] of Object.entries(MODULE_PLAIN)) {
        assert.deepEqual(levelsFor(key), [], key + ': у раздела не должно быть выбора уровня');
        assert.ok(text && text.length > 12, key + ': нет понятного описания действия');
        assert.equal(openAction(key), text);
    }
});

test('справочники настроек: правка и удаление строк — настоящие права', () => {
    const used = levelsUsedInCode();
    // section-crud.js зовёт canEdit(currentPermKey())/canDelete(currentPermKey()),
    // то есть уровень применяется к ЛЮБОМУ ключу настроек. Доказываем, что вызов
    // на месте, — иначе описание ниже стало бы обещанием без исполнителя.
    const crud = fs.readFileSync(path.join(JS_ROOT, 'admin', 'views', 'section-crud.js'), 'utf8');
    assert.match(crud, /canEdit\(currentPermKey\(\)\)/, 'справочники больше не спрашивают право на правку');
    assert.match(crud, /canDelete\(currentPermKey\(\)\)/, 'справочники больше не спрашивают право на удаление');

    assert.deepEqual(levelsFor('settings:services'), ['editor', 'admin']);
    assert.ok(actionFor('settings:services', 'editor'));
    assert.ok(actionFor('settings:services', 'admin'));
    assert.ok(openAction('settings:services'));
    assert.ok(used.size > 0, 'обход исходников ничего не нашёл — тест смотрит не туда');
});

test('отметки и сохранённый уровень переводятся друг в друга без потерь', () => {
    // «Удаление» включает «изменение» — так его читает accessLevelFor().
    assert.equal(levelFromActions({ editor: false, admin: false }), 'viewer');
    assert.equal(levelFromActions({ editor: true,  admin: false }), 'editor');
    assert.equal(levelFromActions({ editor: true,  admin: true  }), 'admin');
    assert.equal(levelFromActions({ editor: false, admin: true  }), 'admin',
        'отмеченное удаление без правки обязано сохраниться как «удаление», а не потеряться');

    for (const lvl of ['viewer', 'editor', 'admin']) {
        assert.equal(levelFromActions(actionsFromLevel(lvl)), lvl, 'потеря на обороте: ' + lvl);
    }
    assert.deepEqual(actionsFromLevel('admin'), { editor: true, admin: true });
});
