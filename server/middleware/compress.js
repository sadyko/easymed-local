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
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|ecmascript|json|xml|manifest\+json)|image\/svg\+xml)/i;

const DEFAULTS = {
    // Ниже килобайта выигрыш меньше накладных расходов: заголовки, CPU, а для
    // мелких JSON-ответов API — ещё и лишняя задержка на ровном месте.
    threshold: 1024,
    maxBuffer: 2 * 1024 * 1024,
};

function addVary(res) {
    const prev = res.getHeader('Vary');
    if (!prev) return res.setHeader('Vary', 'Accept-Encoding');
    const list = String(prev).split(',').map((s) => s.trim().toLowerCase());
    if (!list.includes('accept-encoding') && !list.includes('*')) {
        res.setHeader('Vary', prev + ', Accept-Encoding');
    }
}

export function compress(opts = {}) {
    const { threshold, maxBuffer } = { ...DEFAULTS, ...opts };

    return function compressMiddleware(req, res, next) {
        if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();

        const _write = res.write.bind(res);
        const _end = res.end.bind(res);
        let chunks = [];
        let size = 0;
        let raw = false;   // порог пройден или тип несжимаемый — течём напрямую

        const toBuf = (chunk, enc) =>
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');

        const goRaw = () => {
            raw = true;
            for (const c of chunks) _write(c);
            chunks = [];
        };

        // Тип известен уже к первой записи: бинарник не копим вовсе.
        const typeIsCompressible = () => COMPRESSIBLE.test(String(res.getHeader('Content-Type') || ''));

        res.write = function (chunk, enc, cb) {
            if (raw) return _write(chunk, enc, cb);
            if (chunks.length === 0 && chunk && !typeIsCompressible()) { goRaw(); return _write(chunk, enc, cb); }
            if (chunk) {
                const buf = toBuf(chunk, enc);
                chunks.push(buf);
                size += buf.length;
                if (size > maxBuffer) goRaw();
            }
            if (typeof enc === 'function') enc();
            else if (typeof cb === 'function') cb();
            return true;
        };

        res.end = function (chunk, enc, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = null; enc = undefined; }
            else if (typeof enc === 'function') { cb = enc; enc = undefined; }
            if (raw) return _end(chunk, enc, cb);

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

            zlib.gzip(body, (err, gz) => {
                // Сжатие — оптимизация, а не обязанность: сбой отдаёт исходное тело.
                if (err || !gz || gz.length >= body.length) return _end(body, cb);
                res.setHeader('Content-Encoding', 'gzip');
                res.setHeader('Content-Length', String(gz.length));
                _end(gz, cb);
            });
            return res;
        };

        next();
    };
}
