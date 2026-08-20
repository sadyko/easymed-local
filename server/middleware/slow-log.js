// PERF_SLOWLOG_V1 — кто именно держит сервер.
//
// Замер снаружи показал одиночный запрос на 31 СЕКУНДУ при обычной медиане в
// 1 мс. То есть сервер не «медленный вообще», а иногда встаёт целиком — и
// понять, на чём именно, снаружи нельзя: better-sqlite3 синхронный, поэтому
// виновник блокирует и себя, и всех остальных, а в логе не остаётся ничего.
//
// Пишем строку по КАЖДОМУ запросу дольше порога, с таблицей или именем RPC —
// без этого «тормозит» так и останется догадкой. Порог задаётся переменной
// EASYMED_SLOW_MS (по умолчанию 200 мс), 0 отключает.
//
// Тело читаем в момент завершения, а не на входе: express.json к тому времени
// уже разобрал его, и лишней работы на быстрых запросах не делается.

const DEFAULT_MS = 200;

function label(req) {
    const b = req.body;
    if (req.path.startsWith('/api/rpc/')) return 'rpc ' + req.path.slice('/api/rpc/'.length);
    if (req.path.startsWith('/api/db')) {
        const t = (b && (b.table || b.from)) || (req.query && req.query.table);
        return 'db ' + (t || '?') + (b && b.select ? '' : '');
    }
    return req.path;
}

export function slowLog({ thresholdMs, log = console.warn } = {}) {
    const limit = thresholdMs != null
        ? thresholdMs
        : Number(process.env.EASYMED_SLOW_MS || DEFAULT_MS);
    if (!(limit > 0)) return (req, res, next) => next();

    return function slowLogMiddleware(req, res, next) {
        const started = process.hrtime.bigint();
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            if (ms < limit) return;
            log('[slow] ' + ms.toFixed(0) + 'ms  ' + req.method + ' ' + label(req)
                + '  status=' + res.statusCode
                + (req.user && req.user.username ? '  user=' + req.user.username : ''));
        };
        res.on('finish', finish);
        res.on('close', finish);
        next();
    };
}
