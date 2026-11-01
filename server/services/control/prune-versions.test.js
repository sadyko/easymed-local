// PRUNE_VERSIONS_V1 — старые версии удаляются по счёту, точка отката остаётся.
//
// Владелец: «can we add autodeletion of the backups and updates, in 1 month
// or something?». Версии не удалялись никогда: 39 папок, 1,8 ГБ за месяц.
// Правило — запущенная плюс две предыдущие, а не «старше месяца»: календарь
// лишил бы редко обновляющуюся клинику единственной точки отката, а именно
// откат на предыдущую версию спас клинику 07.09.2026. DISK_GUARD_V1 (ревью
// C4): и версия, с которой пришло обновление, не удаляется никогда — на неё
// откатывает EasyMed.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planPrune, pruneVersions, pruneVersionsAtBoot, compareVersions, rollbackGuards, KEEP_PREVIOUS } from './prune-versions.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const quiet = { log() {}, warn() {} };

test('сравнение версий — числовое: 1.10.0 новее 1.9.0', () => {
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0, 'строковое сравнение перевернуло бы порядок');
    assert.ok(compareVersions('0.9.4', '1.0.0') < 0);
    assert.equal(compareVersions('1.1.2', '1.1.2'), 0);
});

test('DISK_GUARD_V1 (ревью C4): хранятся текущая и ДВЕ предыдущие — одна могла бы оставить откат без версии', () => {
    // Выигрыш одной папки — ~55 МБ; риск — клиника без программы, когда
    // EasyMed.exe не найдёт, на что откатить упавшую версию.
    assert.equal(KEEP_PREVIOUS, 2);
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

// --- DISK_GUARD_V1 (ревью C4): точка отката EasyMed.exe не удаляется -----------

// Версионная установка с data/ рядом, как у клиники: <root>/versions/<v>,
// <root>/current -> versions/<running>, <root>/data.
function clinic(versions, running) {
    const root = tmpDir('em-prune-guard-');
    for (const v of versions) fs.mkdirSync(path.join(root, 'versions', v), { recursive: true });
    fs.symlinkSync(path.join(root, 'versions', running), path.join(root, 'current'), 'junction');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    const put = (name, obj) => fs.writeFileSync(path.join(dataDir, name), JSON.stringify(obj));
    return { root, dataDir, put, appRoot: path.join(root, 'versions', running), left: () => fs.readdirSync(path.join(root, 'versions')).sort() };
}

test('DISK_GUARD_V1: 3.18.1 откатили, поставили 3.18.2 — версия, с которой пришли (pending.from 3.18.0), остаётся; откаченная места не занимает', () => {
    // Случай ревью: 3.18.1 упала и откачена (на диске осталась), 3.18.2 только
    // что запустилась и ещё не подтверждена. Если 3.18.2 упадёт, EasyMed.exe
    // (install/rollback.mjs runAuto) вернёт pending.from — 3.18.0. Удалить её
    // значит оставить клинику без программы.
    const c = clinic(['3.17.1', '3.18.0', '3.18.1', '3.18.2'], '3.18.2');
    c.put('update-pending.json', { version: '3.18.2', from: '3.18.0', backup: 'pre-3.18.2.db' });
    c.put('update-result.json.sent', { version: '3.18.1', from: '3.18.0', ok: false, db: 'restored' });
    const r = pruneVersionsAtBoot(c.appRoot, { dataDir: c.dataDir, log: quiet });
    assert.ok(r);
    assert.ok(!r.removed.includes('3.18.0'), 'точка отката EasyMed.exe');
    assert.deepEqual(r.removed, ['3.18.1'], 'откаченная версия — не точка отката и слот не занимает');
    assert.deepEqual(c.left(), ['3.17.1', '3.18.0', '3.18.2']);
});

test('DISK_GUARD_V1: версия, с которой пришли, остаётся, даже если в слоты не попадает', () => {
    const plan = planPrune(['3.17.1', '3.18.0', '3.18.1', '3.18.2'], '3.18.2', { keep: 1, protect: ['3.18.0'] });
    assert.ok(plan.keep.includes('3.18.0'));
    assert.ok(plan.keep.includes('3.18.1'), 'слот по счёту');
    assert.deepEqual(plan.remove, ['3.17.1']);
});

test('DISK_GUARD_V1: from последней удачной установки тоже под защитой (на неё возвращает recover.cmd)', () => {
    const c = clinic(['3.16.0', '3.17.0', '3.17.1', '3.18.0'], '3.18.0');
    c.put('update-result.json', { version: '3.18.0', from: '3.16.0', ok: true, db: 'current' });
    const r = pruneVersionsAtBoot(c.appRoot, { dataDir: c.dataDir, keep: 1, log: quiet });
    assert.deepEqual(r.removed, ['3.17.0']);
    assert.deepEqual(c.left(), ['3.16.0', '3.17.1', '3.18.0']);
});

test('DISK_GUARD_V1: rollbackGuards — что защищено и что откачено, по файлам обновления', () => {
    const c = clinic(['3.18.0'], '3.18.0');
    assert.deepEqual(rollbackGuards(c.dataDir, '3.18.2'), { protect: [], skip: [] }, 'ничего нет — обычная чистка');
    c.put('update-pending.json', { version: '3.18.2', from: '3.18.0' });
    c.put('update-result.json', { version: '3.18.0', from: '3.17.1', ok: true });
    c.put('update-result.json.sent', { version: '3.17.5', from: '3.17.1', ok: false });
    c.put('update-rolled-back.json', { version: '3.17.4', to: '3.17.1' });
    const g = rollbackGuards(c.dataDir, '3.18.2');
    assert.deepEqual(g.protect.sort(), ['3.17.1', '3.18.0']);
    assert.deepEqual(g.skip.sort(), ['3.17.4', '3.17.5']);
    // pending на версию, которая НЕ запущена, — так и не подтвердилась.
    assert.deepEqual(rollbackGuards(c.dataDir, '3.18.0').skip.sort(), ['3.17.4', '3.17.5', '3.18.2']);
    // Мусор вместо версий — не в счёт.
    c.put('update-pending.json', { version: '../x', from: 'C:\\evil' });
    assert.ok(!rollbackGuards(c.dataDir, '3.18.2').protect.includes('C:\\evil'));
});

test('DISK_GUARD_V1: защищённая версия остаётся, даже если она же числится откаченной', () => {
    const plan = planPrune(['1.0.0', '1.1.0', '1.2.0', '1.3.0'], '1.3.0', { protect: ['1.0.0'], skip: ['1.0.0', '1.2.0'] });
    assert.ok(plan.keep.includes('1.0.0'));
    assert.deepEqual(plan.remove, ['1.2.0']);
});

test('DISK_GUARD_V1: без файлов обновления — обычная чистка старых версий', () => {
    const c = clinic(['1.0.0', '1.0.1', '1.1.1', '1.1.2'], '1.1.2');
    const r = pruneVersionsAtBoot(c.appRoot, { dataDir: c.dataDir, log: quiet });
    assert.deepEqual(r.removed, ['1.0.0']);
    assert.deepEqual(c.left(), ['1.0.1', '1.1.1', '1.1.2']);
});
