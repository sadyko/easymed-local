// TEST_TMPDIR_V1 — временная папка теста УБИРАЕТ ЗА СОБОЙ.
//
// ЧТО СЛУЧИЛОСЬ. Диск разработочной машины забился до нуля, и запись файла
// оборвалась на полуслове. В %TEMP% лежало 53 165 папок `em-*` на 27,5 ГБ —
// по одной на каждую фикстуру каждого прогона тестов. Полный прогон (4 600
// тестов) оставляет их около тысячи; за неделю набралось столько.
//
// ПРИЧИНА. `fs.mkdtempSync(path.join(os.tmpdir(), 'em-…'))` создаёт папку, но
// удалять её обязан тот, кто создал. Из 69 таких мест удаляли за собой 16 —
// и то лишь на успешном пути: упавший тест не доходил до уборки никогда.
//
// ПОЧЕМУ ИМЕННО ТАК. Уборка привязана к КОНЦУ ПРОЦЕССА, а не к концу теста:
//   • упавший тест, брошенный `assert`, выход по timeout — папка всё равно
//     исчезнет, потому что процесс всё равно завершится;
//   • тесту не нужно помнить про try/finally вокруг каждой фикстуры — а
//     именно это и не соблюдалось в 53 файлах из 69;
//   • пока процесс жив, папка на месте: тест волен читать и писать в неё до
//     последней строки.
//
// V3120_FIX — ВТОРАЯ ДЫРА: ОТКРЫТАЯ БАЗА. На Windows rmSync не может удалить
// easymed.db, пока на неё открыт дескриптор better-sqlite3, а тесты оставляли
// базы открытыми до самого выхода. Уборка на 'exit' падала молча, и папки
// em-apply-*, em-sysbk-*, em-bk-* копились снова. Теперь три слоя:
//   1. closeOnExit(db) — тест регистрирует свой дескриптор, и уборка ЗАКРЫВАЕТ
//      его перед удалением (плюс тесты сами закрывают базы в t.after);
//   2. то, что всё равно не удалилось (дескриптор, о котором никто не сказал),
//      доубирает маленький отдельный процесс-уборщик: он ждёт, пока этот
//      процесс завершится — вместе с ним Windows закрывает все его файлы, — и
//      только тогда удаляет папки;
//   3. при загрузке помощника выметаются брошенные em-* старше суток (от
//      прогонов, убитых до 'exit', или от старых версий этого файла). Сутки —
//      чтобы никогда не тронуть папку ПАРАЛЛЕЛЬНО идущего прогона.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const made = [];
const closeables = new Set();
let armed = false;

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Удалить из `base` папки `em-*` старше maxAgeMs. Возвращает число удалённых.
 * Никогда не бросает: уборка чужого мусора не может ронять тесты.
 */
export function sweepStale(base = os.tmpdir(), { maxAgeMs = STALE_AFTER_MS, now = Date.now() } = {}) {
    let names;
    try { names = fs.readdirSync(base); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
        if (!name.startsWith('em-')) continue;
        const full = path.join(base, name);
        try {
            const st = fs.lstatSync(full);
            if (!st.isDirectory()) continue;
            if (now - st.mtimeMs < maxAgeMs) continue;
            fs.rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
            removed++;
        } catch { /* занята или уже удалена — не наше дело сейчас */ }
    }
    return removed;
}

/**
 * Зарегистрировать дескриптор (база better-sqlite3 или что угодно с .close()),
 * который нужно закрыть до удаления временных папок. Возвращает сам дескриптор,
 * чтобы можно было писать `const db = closeOnExit(openDb(p))`.
 */
export function closeOnExit(handle) {
    if (handle && typeof handle.close === 'function') closeables.add(handle);
    return handle;
}

/** Закрыть всё, что зарегистрировано через closeOnExit, прямо сейчас (для test.after). */
export function closeRegistered() { closeAll(); }

function closeAll() {
    for (const h of closeables) {
        try { if (h.open !== false) h.close(); } catch { /* уже закрыт */ }
    }
    closeables.clear();
}

// Отдельный процесс доубирает то, что держали открытые файлы ЭТОГО процесса.
// detached + unref + stdio:'ignore' — он переживает родителя и ничего не держит.
function spawnJanitor(dirs) {
    const script = `
const fs = require('fs');
const [pid, ...dirs] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
let tries = 0;
const tick = () => {
  if (alive() && tries++ < 600) return setTimeout(tick, 100);
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
};
tick();`;
    try {
        const child = spawn(process.execPath, ['-e', script, String(process.pid), ...dirs], {
            detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
    } catch { /* не смогли — сутки спустя папки выметет sweepStale */ }
}

function cleanup() {
    closeAll();
    const left = [];
    for (const d of made) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* занята — ниже */ }
        if (fs.existsSync(d)) left.push(d);
    }
    if (left.length) spawnJanitor(left);
}

// Слой 3: один раз на процесс, при первой загрузке помощника.
if (process.env.EM_TMPDIR_NO_SWEEP !== '1') sweepStale();

/**
 * Временная папка на время процесса тестов.
 * @param {string} prefix — префикс имени, как у mkdtempSync.
 * @returns {string} путь к созданной папке.
 */
export function tmpDir(prefix = 'em-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    made.push(dir);
    if (!armed) {
        armed = true;
        process.on('exit', cleanup);
    }
    return dir;
}
