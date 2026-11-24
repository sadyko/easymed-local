// PERF_GZIP_V1 — сжатие текстовых ответов.
//
// Клиент — это 119 несобранных ES-модулей (5.5 МБ), 293 КБ словаря переводов и
// 196 КБ CSS, и всё это уезжало по сети КАК ЕСТЬ: заголовка Content-Encoding в
// ответах не было вовсе. Текст такого рода жмётся в 4–5 раз, то есть примерно
// три четверти трафика были лишними на каждой загрузке экрана.
//
// Своя реализация на встроенном zlib, а не пакет `compression`: машина клиники
// живёт офлайн, и добавлять зависимость (а с ней npm install на рабочем
// сервере) ради одного middleware — плохой размен.
//
// Стратегия — «собрать и сжать», а не потоковая:
//   • заголовки не уходят до конца ответа, поэтому Content-Length и
//     Content-Encoding всегда согласованы с телом — потоковый вариант этим и
//     опасен, там легко разъехаться;
//   • сжатие АСИНХРОННОЕ (zlib.gzip, не gzipSync): sync-вариант заблокировал бы
//     единственный поток сервера на десятки миллисекунд, а мы его как раз и
//     бережём — вся эта работа ради того, чтобы никто никого не ждал;
//   • ответы больше maxBuffer в память не собираются: как только порог пройден,
//     всё уже накопленное уходит как есть и дальше течёт напрямую. Выгрузка
//     реестра (55 МБ JSON) не должна превратиться в 55 МБ в куче.

import zlib from 'node:zlib';

// Сжимаем только то, что от этого выигрывает. Картинки, PDF, xlsx и архивы уже
// сжаты внутри — прогон через gzip тратит время и обычно даёт минус.
// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — кроме text/event-stream: поток
// изменений (/api/live) живёт часами, а «собрать и сжать» копило бы его до конца
// ответа — экран не получил бы ни одного события.
const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:javascript|ecmascript|json|xml|manifest\+json)|image\/svg\+xml)/i;

// V3121_GZIP_CAP (2026-09-28) — ПОРОГ СБОРКИ В ПАМЯТИ — 8 МБ, а не 2.
//
// Словарь переводов (public/js/admin/i18n-strings.js) растёт с каждой
// функцией: на ветке закупок он перешёл 2 МБ (2 121 238 байт), и самый
// тяжёлый файл клиента молча поехал в каждый браузер НЕСЖАТЫМ — тест сжатия
// упал, а экран об этом не сказал бы никогда. 8 МБ — с запасом на годы
// роста словаря, и это безопасно: ответ собирается в память один раз на
// запрос и отпускается сразу после отправки, а выгрузки больше порога
// (реестр — 55 МБ JSON) по-прежнему текут напрямую, не копясь в куче.
// Страж — compress.test.js: любой сжимаемый файл public/ больше порога
// краснеет с именем файла, до того как его увидит клиника.
export const MAX_BUFFER = 8 * 1024 * 1024;

// LOCAL_SPEED_V1 (2026-11-24) — ПРЕДЕЛ ПАМЯТИ ПОД СЖАТЫЕ ФАЙЛЫ СТАТИКИ.
//
// Весь клиент в gzip — ≈4,5 МБ; 64 МБ — с запасом на годы роста и на старые
// версии файлов, пока их не вытеснят. Сверх предела выпадает самый давно
// отданный файл (LRU).
export const STATIC_CACHE_BYTES = 64 * 1024 * 1024;   // LOCAL_SPEED_V1

const DEFAULTS = {
    // Ниже килобайта выигрыш меньше накладных расходов: заголовки, CPU, а для
    // мелких JSON-ответов API — ещё и лишняя задержка на ровном месте.
    threshold: 1024,
    maxBuffer: MAX_BUFFER,
    staticCacheBytes: STATIC_CACHE_BYTES,   // LOCAL_SPEED_V1 — 0 отключает память
};

// LOCAL_SPEED_V1 — СЖАТЫЙ ФАЙЛ СТАТИКИ СЖИМАЕТСЯ ОДИН РАЗ.
//
// После обновления каждый ПК клиники качает весь клиент, и сжатие одних и тех
// же 15 МБ повторялось для каждого ПК и каждого открытия. Теперь gzip целого
// файла (ответ 200 на GET) хранится по (путь, mtimeMs, size) — тем же данным,
// из которых express.static строит ETag. Файл изменился — другой ключ, сжатие
// заново, а прежняя версия того же пути выбрасывается сразу.
//
// Метку ставит express.static в setHeaders (app.js) — markStaticFile ниже;
// ответы API её не получают и в память не попадают никогда. Заголовки ставит
// тот же код, что и при сжатии (Vary, Content-Encoding, Content-Length), всё
// остальное (ETag, Cache-Control, CSP…) ставят те же middleware до него —
// ответ из памяти отличается от сжатого только тем, что zlib не звали.
const STATIC_FILE = Symbol('LOCAL_SPEED_V1.staticFile');

/** LOCAL_SPEED_V1 — пометить ответ как целый файл статики (вызывать из setHeaders express.static). */
export function markStaticFile(res, filePath, stat) {
    if (!res || typeof filePath !== 'string' || !stat || !Number.isFinite(stat.size)) return;
    res[STATIC_FILE] = { file: filePath, size: stat.size, key: filePath + '\0' + stat.mtimeMs + '\0' + stat.size };
}

// LOCAL_SPEED_V1 — память с пределом по байтам: Map хранит порядок вставки, и
// обращение переставляет запись в конец, поэтому первая — самая давняя.
function gzipMemory(maxBytes) {
    const entries = new Map();   // key → { gz, file }
    const keyOfFile = new Map();   // file → key (одна версия файла)
    let bytes = 0;
    const drop = (key) => {
        const e = entries.get(key);
        if (!e) return;
        entries.delete(key);
        bytes -= e.gz.length;
        if (keyOfFile.get(e.file) === key) keyOfFile.delete(e.file);
    };
    return {
        get(key) {
            const e = entries.get(key);
            if (!e) return null;
            entries.delete(key);
            entries.set(key, e);
            return e.gz;
        },
        set(file, key, gz) {
            if (!(gz.length <= maxBytes)) return;
            drop(key);
            const prev = keyOfFile.get(file);
            if (prev) drop(prev);   // прежняя версия этого файла больше не понадобится
            entries.set(key, { gz, file });
            keyOfFile.set(file, key);
            bytes += gz.length;
            while (bytes > maxBytes) drop(entries.keys().next().value);
        },
    };
}

function addVary(res) {
    const prev = res.getHeader('Vary');
    if (!prev) return res.setHeader('Vary', 'Accept-Encoding');
    const list = String(prev).split(',').map((s) => s.trim().toLowerCase());
    if (!list.includes('accept-encoding') && !list.includes('*')) {
        res.setHeader('Vary', prev + ', Accept-Encoding');
    }
}

export function compress(opts = {}) {
    const { threshold, maxBuffer, staticCacheBytes } = { ...DEFAULTS, ...opts };
    // LOCAL_SPEED_V1 — сжатие подставляется тестами (счётчик вызовов); по умолчанию
    // zlib.gzip берётся в момент вызова, не при создании.
    const gzip = typeof opts.gzip === 'function' ? opts.gzip : (buf, cb) => zlib.gzip(buf, cb);
    const memory = staticCacheBytes > 0 ? gzipMemory(staticCacheBytes) : null;   // LOCAL_SPEED_V1 — своя у каждого приложения

    return function compressMiddleware(req, res, next) {
        if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();

        const _write = res.write.bind(res);
        const _end = res.end.bind(res);
        let chunks = [];
        let size = 0;
        let raw = false;   // порог пройден или тип несжимаемый — течём напрямую
        // LOCAL_SPEED_V1 — сжатый файл из памяти: undefined — ещё не смотрели,
        // null — нет, Buffer — есть (байты файла тогда не копим: они уже в нём).
        let cached;

        const toBuf = (chunk, enc) =>
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');

        const goRaw = () => {
            raw = true;
            for (const c of chunks) _write(c);
            chunks = [];
        };

        // Тип известен уже к первой записи: бинарник не копим вовсе.
        const typeIsCompressible = () => COMPRESSIBLE.test(String(res.getHeader('Content-Type') || ''));

        // LOCAL_SPEED_V1 — целый файл статики (200 на GET, ещё не сжат никем): его метка.
        const staticWhole = () => {
            const f = res[STATIC_FILE];
            if (!memory || !f || res.statusCode !== 200 || req.method !== 'GET' || res.getHeader('Content-Encoding')) return null;
            return f;
        };
        const lookup = () => {
            const f = staticWhole();
            return f && typeIsCompressible() ? memory.get(f.key) : null;
        };

        res.write = function (chunk, enc, cb) {
            if (raw) return _write(chunk, enc, cb);
            if (chunks.length === 0 && !cached && chunk && !typeIsCompressible()) { goRaw(); return _write(chunk, enc, cb); }
            if (chunk) {
                if (cached === undefined) cached = lookup();   // LOCAL_SPEED_V1
                if (!cached) {
                    const buf = toBuf(chunk, enc);
                    chunks.push(buf);
                    size += buf.length;
                    if (size > maxBuffer) goRaw();
                }
            }
            if (typeof enc === 'function') enc();
            else if (typeof cb === 'function') cb();
            return true;
        };

        res.end = function (chunk, enc, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = null; enc = undefined; }
            else if (typeof enc === 'function') { cb = enc; enc = undefined; }
            if (raw) return _end(chunk, enc, cb);

            // LOCAL_SPEED_V1 — файл уже сжат в памяти: те же заголовки, что ниже у
            // сжатия, и сжатое тело. Если статус сменился посреди отдачи (файл не
            // дочитался — send отвечает ошибкой), дальше — как без памяти, с тем,
            // что пришло в end.
            if (cached === undefined && chunk) cached = lookup();
            if (cached) {
                const gz = cached;
                cached = null;
                if (staticWhole()) {
                    addVary(res);
                    res.setHeader('Content-Encoding', 'gzip');
                    res.setHeader('Content-Length', String(gz.length));
                    return _end(gz, cb);
                }
            }

            if (chunk) { const b = toBuf(chunk, enc); chunks.push(b); size += b.length; }
            const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
            chunks = [];

            addVary(res);

            const skip =
                res.getHeader('Content-Encoding') ||     // кто-то уже сжал
                res.statusCode === 204 || res.statusCode === 304 ||
                req.method === 'HEAD' ||                 // тела нет, заголовки чужие
                !typeIsCompressible() ||
                body.length < threshold ||
                body.length > maxBuffer;

            if (skip) return _end(body.length ? body : undefined, cb);

            // LOCAL_SPEED_V1 — целый файл (тело того размера, что видел stat) пойдёт в память.
            const f = staticWhole();
            const keep = f && body.length === f.size ? f : null;
            gzip(body, (err, gz) => {
                // Сжатие — оптимизация, а не обязанность: сбой отдаёт исходное тело.
                if (err || !gz || gz.length >= body.length) return _end(body, cb);
                if (keep) memory.set(keep.file, keep.key, gz);   // LOCAL_SPEED_V1
                res.setHeader('Content-Encoding', 'gzip');
                res.setHeader('Content-Length', String(gz.length));
                _end(gz, cb);
            });
            return res;
        };

        next();
    };
}
