// V3120_FIX — сторож уборки временных папок (см. tmpdir.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sweepStale, closeOnExit, tmpDir } from './tmpdir.js';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmpdir.js');

test('sweepStale убирает только em-* старше суток и не трогает свежие и чужие', () => {
    const base = tmpDir('em-sweepbase-');
    const old = path.join(base, 'em-old-1');
    const fresh = path.join(base, 'em-fresh-1');
    const foreign = path.join(base, 'other-old');
    for (const d of [old, fresh, foreign]) {
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'f.txt'), 'x');
    }
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    fs.utimesSync(foreign, twoDaysAgo, twoDaysAgo);

    assert.equal(sweepStale(base), 1);
    assert.equal(fs.existsSync(old), false, 'старая em-* папка выметена');
    assert.equal(fs.existsSync(fresh), true, 'свежая — возможно, параллельный прогон — осталась');
    assert.equal(fs.existsSync(foreign), true, 'не em-* не трогаем никогда');
});

test('sweepStale на несуществующей папке — ноль, не исключение', () => {
    assert.equal(sweepStale(path.join(os.tmpdir(), 'em-definitely-missing-' + process.pid)), 0);
});

test('closeOnExit возвращает сам дескриптор и игнорирует то, что закрыть нельзя', () => {
    const h = { close() {} };
    assert.equal(closeOnExit(h), h);
    assert.equal(closeOnExit(null), null);
});

test('папка с ОТКРЫТОЙ базой всё равно исчезает после выхода процесса', { timeout: 30_000 }, async () => {
    // Дочерний процесс создаёт папку через помощник, открывает в ней базу и
    // выходит, НЕ закрыв её и НЕ зарегистрировав — худший случай. Путь папки
    // печатает в stdout.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { tmpDir } from ${JSON.stringify(pathToFileURL(HELPER).href)};
        import Database from 'better-sqlite3';
        const d = tmpDir('em-leakcheck-');
        const db = new Database(d + '/easymed.db');
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1);');
        console.log(d);
    `], { encoding: 'utf8', cwd: path.dirname(HELPER), env: { ...process.env, EM_TMPDIR_NO_SWEEP: '1' } });
    assert.equal(child.status, 0, child.stderr);
    const dir = child.stdout.trim().split(/\r?\n/).pop();
    assert.ok(dir && dir.includes('em-leakcheck-'), 'дочерний процесс напечатал путь: ' + child.stdout);

    const deadline = Date.now() + 20_000;
    while (fs.existsSync(dir) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.existsSync(dir), false, 'уборщик доубрал папку после выхода процесса');
});
