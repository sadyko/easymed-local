// PRUNE_VERSIONS_V1 — старые версии программы удаляются сами.
//
// Владелец: «what can we do for updates take not this much space? can we add
// autodeletion of the backups and updates?». Резервные копии УЖЕ ограничены
// по видам (services/backup.js, KEEP_BY_KIND) и расти не могут. А версии не
// удалялись никогда: на тестовой клинике за месяц накопилось 39 папок на
// 1,8 ГБ, по ~54 МБ на выпуск, и каждый следующий добавлял бы ещё.
//
// ПРАВИЛО — ПО СЧЁТУ, А НЕ ПО КАЛЕНДАРЮ. Хранится запущенная версия и две
// предыдущие. Календарное «старше месяца» было бы хуже: клиника, которая три
// месяца не обновлялась, потеряла бы единственную точку отката — а откат на
// предыдущую версию и есть то, что спасло клинику 07.09.2026, когда 1.1.0
// не запустилась. «Две предыдущие» гарантирует точку отката В ДЕНЬ плохого
// выпуска, сколько бы времени ни прошло с прошлого.
//
// КОГДА — ПРИ ЗАПУСКЕ, ПОСЛЕ УДАЧНЫХ МИГРАЦИЙ. Это первый момент, когда точно
// известно, что текущая версия РАБОТАЕТ. Чистить во время обновления нельзя:
// 1.1.0 удалила бы 1.0.2, а потом упала бы на старте — и откатываться было бы
// не на что.
//
// ЧТО НЕ ТРОГАЕТСЯ НИКОГДА:
//   • запущенная версия — очевидно;
//   • версии НОВЕЕ запущенной — это пакет, поставленный на следующий
//     перезапуск, его удаление сорвало бы обновление;
//   • папки, чьё имя не выглядит как версия (например, отставленная руками
//     «_broken-1.1.0») — они не наши, решает человек.
//
// Любая ошибка здесь — предупреждение в журнал, и ТОЛЬКО. Уборка старых папок
// не имеет права помешать запуску программы.
import fs from 'node:fs';
import path from 'node:path';
import { detectLayout } from './updater.js';

export const KEEP_PREVIOUS = 2;

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Числовое сравнение «1.10.0» > «1.9.0»: строковое дало бы обратное. */
export function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}

/**
 * Что удалить, что оставить — БЕЗ побочных действий. Отдельно от удаления,
 * чтобы правило можно было проверить на списке имён, не трогая диск.
 * @param {string[]} names — имена папок в versions/
 * @param {string} running — версия, которая сейчас запущена
 * @returns {{ remove: string[], keep: string[], ignored: string[] }}
 */
export function planPrune(names, running, { keep = KEEP_PREVIOUS } = {}) {
    const ignored = [];
    const versions = [];
    for (const n of names) (VERSION_RE.test(n) ? versions : ignored).push(n);

    const older = versions
        .filter((v) => compareVersions(v, running) < 0)
        .sort((a, b) => compareVersions(b, a));   // новые раньше
    const newerOrSame = versions.filter((v) => compareVersions(v, running) >= 0);

    return {
        keep: [...newerOrSame, ...older.slice(0, keep)],
        remove: older.slice(keep),
        ignored,
    };
}

/**
 * Удалить лишние версии на диске. Возвращает отчёт; никогда не бросает.
 * @param {string} versionsDir — папка versions/
 * @param {string} running — запущенная версия
 */
export function pruneVersions(versionsDir, running, {
    keep = KEEP_PREVIOUS,
    rmImpl = fs.rmSync,
    log = console,
} = {}) {
    let names;
    try {
        names = fs.readdirSync(versionsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    } catch (e) {
        log.warn('[prune-versions] versions/ не прочитать:', e && e.message);
        return { removed: [], kept: [], failed: [] };
    }

    const plan = planPrune(names, running, { keep });
    const removed = [], failed = [];
    for (const v of plan.remove) {
        try {
            rmImpl(path.join(versionsDir, v), { recursive: true, force: true });
            removed.push(v);
        } catch (e) {
            // Занятый файл на Windows — обычное дело; следующий запуск доберёт.
            failed.push(v);
            log.warn('[prune-versions] не удалилась', v + ':', e && e.message);
        }
    }
    if (removed.length) log.log('[prune-versions] удалено старых версий:', removed.length, '—', removed.join(', '));
    return { removed, kept: plan.keep, failed };
}

/**
 * Точка входа для запуска: сама решает, версионная ли это установка.
 * Из исходников (dev-сервер) папки versions/ нет — тихо ничего не делает.
 * @param {string} appRoot — корень запущенного кода (ROOT в server/index.js)
 */
export function pruneVersionsAtBoot(appRoot, opts = {}) {
    try {
        const layout = detectLayout(appRoot);
        if (!layout.versioned) return null;
        const running = path.basename(path.resolve(appRoot));
        if (!VERSION_RE.test(running)) return null;
        return pruneVersions(path.join(layout.root, 'versions'), running, opts);
    } catch (e) {
        (opts.log || console).warn('[prune-versions] пропущено:', e && e.message);
        return null;
    }
}
