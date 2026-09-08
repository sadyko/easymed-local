// PRUNE_VERSIONS_V1 — старые версии удаляются по счёту, точка отката остаётся.
//
// Владелец: «can we add autodeletion of the backups and updates, in 1 month
// or something?». Версии не удалялись никогда: 39 папок, 1,8 ГБ за месяц.
// Правило — запущенная плюс две предыдущие, а не «старше месяца»: календарь
// лишил бы редко обновляющуюся клинику единственной точки отката, а именно
// откат на предыдущую версию спас клинику 07.09.2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planPrune, pruneVersions, pruneVersionsAtBoot, compareVersions } from './prune-versions.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const quiet = { log() {}, warn() {} };

test('сравнение версий — числовое: 1.10.0 новее 1.9.0', () => {
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0, 'строковое сравнение перевернуло бы порядок');
    assert.ok(compareVersions('0.9.4', '1.0.0') < 0);
    assert.equal(compareVersions('1.1.2', '1.1.2'), 0);
});

test('план: запущенная + две предыдущие остаются, всё старше — удаляется', () => {
    const names = ['0.9.4', '1.0.0', '1.0.1', '1.0.2', '1.1.0', '1.1.1', '1.1.2'];
    const plan = planPrune(names, '1.1.2');
    assert.deepEqual(plan.keep.sort(), ['1.1.0', '1.1.1', '1.1.2'].sort());
    assert.deepEqual(plan.remove.sort(), ['0.9.4', '1.0.0', '1.0.1', '1.0.2'].sort());
});

test('версия НОВЕЕ запущенной не трогается — это пакет на следующий перезапуск', () => {
    // Удалить её значило бы сорвать обновление, которое уже скачано.
    const plan = planPrune(['1.0.2', '1.1.1', '1.1.2', '1.2.0'], '1.1.1');
    assert.ok(plan.keep.includes('1.2.0'), 'поставленная на перезапуск версия удалена');
    assert.ok(!plan.remove.includes('1.2.0'));
});

test('папки с именем не-версией игнорируются — решает человек', () => {
    // «_broken-1.1.0» отставлена руками; чужое не трогаем.
    const plan = planPrune(['_broken-1.1.0', '1.0.2', '1.1.1', '1.1.2', 'node_modules'], '1.1.2');
    assert.deepEqual(plan.ignored.sort(), ['_broken-1.1.0', 'node_modules'].sort());
    assert.ok(!plan.remove.includes('_broken-1.1.0'));
});

test('запущенная версия не удаляется, даже если она самая старая', () => {
    const plan = planPrune(['1.0.0', '1.5.0', '1.6.0', '1.7.0'], '1.0.0');
    assert.ok(!plan.remove.includes('1.0.0'));
    assert.deepEqual(plan.remove, []);
});

test('на диске: удаляются именно лишние папки, остальные целы', () => {
    const dir = tmpDir('em-prune-');
    for (const v of ['0.9.4', '1.0.2', '1.1.0', '1.1.1', '1.1.2', '_broken-1.1.0']) {
        fs.mkdirSync(path.join(dir, v));
        fs.writeFileSync(path.join(dir, v, 'package.json'), '{}');
    }
    const r = pruneVersions(dir, '1.1.2', { log: quiet });
    assert.deepEqual(r.removed.sort(), ['0.9.4', '1.0.2'].sort());
    assert.deepEqual(r.failed, []);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, ['1.1.0', '1.1.1', '1.1.2', '_broken-1.1.0'].sort());
});

test('сбой удаления одной папки не останавливает остальные и не бросает', () => {
    // На Windows занятый файл — обычное дело; следующий запуск доберёт.
    const dir = tmpDir('em-prune-');
    for (const v of ['1.0.0', '1.0.1', '1.1.1', '1.1.2', '1.1.3']) fs.mkdirSync(path.join(dir, v));
    const rmImpl = (p, o) => { if (p.endsWith('1.0.0')) throw new Error('EBUSY'); fs.rmSync(p, o); };
    const r = pruneVersions(dir, '1.1.3', { rmImpl, log: quiet });
    assert.deepEqual(r.failed, ['1.0.0']);
    assert.deepEqual(r.removed, ['1.0.1']);
});

test('из исходников (нет versions/) — тихо ничего не делает', () => {
    // Dev-сервер запускается из репозитория, а не из versions/<x>: раскладка
    // не версионная, и уборке тут нечего делать.
    const dir = tmpDir('em-prune-');
    const r = pruneVersionsAtBoot(dir, { log: quiet });
    assert.equal(r, null);
});

test('в версионной раскладке уборка находит versions/ по junction current', () => {
    const root = tmpDir('em-prune-');
    const versions = path.join(root, 'versions');
    fs.mkdirSync(versions);
    for (const v of ['1.0.0', '1.0.1', '1.1.1', '1.1.2']) fs.mkdirSync(path.join(versions, v));
    // current -> versions/1.1.2, как делает установщик.
    fs.symlinkSync(path.join(versions, '1.1.2'), path.join(root, 'current'), 'junction');
    const r = pruneVersionsAtBoot(path.join(versions, '1.1.2'), { log: quiet });
    assert.ok(r, 'версионная раскладка не распознана');
    assert.deepEqual(r.removed, ['1.0.0']);
    assert.deepEqual(fs.readdirSync(versions).sort(), ['1.0.1', '1.1.1', '1.1.2']);
});
