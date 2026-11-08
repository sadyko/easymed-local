// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — ШИНА ИЗМЕНЕНИЙ ДЛЯ ЖИВОГО ОБНОВЛЕНИЯ ЭКРАНОВ.
//
// Владелец: «in the windows of the users (cashier, doctor, lab etc) when new event
// happened to see the user should refresh. can we make it so whenever the invoice
// created or a patient sent show right away without the refresh». Рабочие экраны
// (касса, «Мои приёмы», «Мой день», лаборатория, процедуры) сами себя не обновляли:
// счёт, выставленный регистратурой, кассир видел только после «Обновить» или F5.
//
// Что здесь. Одна шина на базу (на процесс — одна база):
//   • версия — число, растущее на единицу с каждым событием. Начинается с часов
//     запуска (Date.now()), а не с нуля: после перезапуска сервера она не меньше
//     прежней, и экран, знающий старый номер, получает честный сброс, а не
//     «изменений нет» (since ниже). События идут не чаще раза в COALESCE_MS, так
//     что за время работы версия не обгоняет часы;
//   • bump({ tables, rpc }) — «что-то записано»: маршрут /api/db с именем таблицы,
//     RPC с именем вызова, приём филиала, приём анализаторов;
//   • всплеск склеивается: одно событие на окно COALESCE_MS с объединением имён;
//   • подписчики — потоки Server-Sent Events (routes/live.js).
//
// В СОБЫТИИ ТОЛЬКО ИМЕНА. { v, tables, rpc } — версия, имена таблиц и имена RPC,
// и каждое имя проходит NAME_RE: ни строк, ни номеров, ни имён пациентов. Экран
// по событию сам перечитывает своё обычным запросом — со своими правами.
//
// ПЕРЕХВАТ ЗАПИСЕЙ САМОЙ БАЗОЙ. Записывают в базу не только /api/db и RPC: приём
// анализаторов (lis/ingest.js, по сети и через LIS Proxy), обмен филиалов, боты,
// таймеры. И RPC сам по себе не говорит, ЧТО он записал, — а экрану нужно именно
// это («счёт» или «визит»). Поэтому на наблюдаемые таблицы (LIVE_TABLES) ставятся
// ВРЕМЕННЫЕ триггеры этого соединения (CREATE TEMP TRIGGER — живут только в памяти
// процесса, в файл базы не пишутся, миграции не нужны): каждая вставка, правка и
// удаление строки зовёт em_live_touch('<таблица>'), и шина узнаёт имя таблицы,
// какой бы дорогой ни шла запись. Функция только кладёт имя в Set — запись она
// не замедляет и не роняет: любой сбой глотается (touch ниже).
//
// РАМКА ЗАПИСИ (open/end). Маршрут открывает рамку перед записью: всё, что поймано
// внутри, придерживается. Запись удалась — пойманное уходит в событие; отказ
// (откат транзакции, 4xx) — выбрасывается, и экраны не дёргаются впустую.
// better-sqlite3 синхронен: между open и end чужие записи не вклиниваются.
//
// Сбой шины никогда не мешает записи: bump/touch/flush ничего не бросают.

/** Таблицы, запись в которые ловится самой базой (временные триггеры). Объединение
 *  того, что смотрят рабочие экраны (public/js/admin/live-relevance.js; страж — тест
 *  routes/live.test.js). Только рабочие таблицы: сессии, журналы и счётчики сюда не
 *  входят — иначе каждый запрос будил бы все экраны. */
export const LIVE_TABLES = Object.freeze([
  'visits', 'visit_services',
  'invoices', 'invoice_items', 'payments', 'pay_refund_releases',
  'patient_deposits', 'cash_shifts', 'cash_movements',
  'lab_results', 'admission_services',
]);

/** Окно склейки всплеска, мс. */
export const COALESCE_MS = 150;
/** Сколько последних событий помнится для догоняющих (since). */
export const RING_MAX = 256;

// Имя таблицы или RPC — идентификатор, и только он. Всё остальное (данные,
// кириллица, кавычки) в событие не попадает.
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TOUCH_FN = 'em_live_touch';

const BUSES = new WeakMap();

const names = (list) => (Array.isArray(list) ? list : []).filter((n) => typeof n === 'string' && NAME_RE.test(n));

class LiveBus {
  constructor({ coalesceMs = COALESCE_MS, now = Date.now, ringMax = RING_MAX } = {}) {
    this.coalesceMs = Math.max(0, Number(coalesceMs) || 0);
    this.ringMax = Math.max(1, Number(ringMax) || RING_MAX);
    const start = Math.floor(Number(now()) || 0);
    this.version = start > 0 ? start : 0;
    this.floor = this.version;   // всё, что новее floor, известно поимённо (кольцо)
    this.ring = [];
    this.tables = new Set();
    this.rpc = new Set();
    this.timer = null;
    this.listeners = new Set();
    this.scopes = [];
    this.capture = false;        // перехват базой установлен
    this._changes = null;
  }

  get listenerCount() { return this.listeners.size; }

  /** «Записано». Никогда не бросает. */
  bump(change) {
    try {
      if (!change || typeof change !== 'object') return;
      let added = false;
      for (const t of names(change.tables)) { this.tables.add(t); added = true; }
      for (const r of names(change.rpc)) { this.rpc.add(r); added = true; }
      if (added) this._arm();
    } catch { /* шина — не повод отказать записи */ }
  }

  /** Строка наблюдаемой таблицы записана (зовёт временный триггер). Никогда не бросает. */
  touch(table) {
    try {
      if (typeof table !== 'string' || !NAME_RE.test(table)) return;
      const scope = this.scopes[this.scopes.length - 1];
      if (scope) { scope.add(table); return; }
      this.tables.add(table);
      this._arm();
    } catch { /* см. выше */ }
  }

  /**
   * Рамка записи: то, что база поймает до end(), придерживается и возвращается
   * из end() — вызывающий решает, отдать его в событие (bump) или выбросить.
   */
  open() {
    const held = new Set();
    this.scopes.push(held);
    let ended = false;
    return {
      end: () => {
        if (!ended) {
          ended = true;
          const i = this.scopes.lastIndexOf(held);
          if (i >= 0) this.scopes.splice(i, 1);
        }
        return held;
      },
    };
  }

  /** Сколько строк записало это соединение с момента открытия (SQLite total_changes). */
  totalChanges(db) {
    try {
      if (!this._changes || this._changesDb !== db) {
        this._changes = db.prepare('SELECT total_changes() AS n').pluck();
        this._changesDb = db;
      }
      return Number(this._changes.get()) || 0;
    } catch { return 0; }
  }

  _arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.coalesceMs);
    // Таймер не держит процесс: сервер жив и так, а тест завершится вовремя.
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Выпустить накопленное событием сейчас. Возвращает событие или null. */
  flush() {
    try {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (!this.tables.size && !this.rpc.size) return null;
      const ev = { v: this.version + 1, tables: [...this.tables].sort(), rpc: [...this.rpc].sort() };
      this.version = ev.v;
      this.tables = new Set();
      this.rpc = new Set();
      this.ring.push(ev);
      while (this.ring.length > this.ringMax) this.floor = this.ring.shift().v;
      for (const fn of [...this.listeners]) {
        try { fn(ev); } catch { /* один упавший поток не мешает остальным */ }
      }
      return ev;
    } catch { return null; }
  }

  /** Подписка на события. Возвращает отписку (повторный вызов безвреден). */
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * Что изменилось после версии `since` — для догоняющего экрана (вкладка
   * вернулась, связь восстановилась, опрос вместо потока).
   *   { v } — без номера: только текущая версия;
   *   { v, tables, rpc } — объединение пропущенного (пусто — ничего нового);
   *   { v, reset: true, tables: [], rpc: [] } — пропущенное не известно поимённо
   *   (номер старше кольца, из будущего — сервер перезапущен): «могло измениться всё».
   */
  since(since) {
    const v = this.version;
    if (since == null || since === '') return { v };
    const n = Number(since);
    if (!Number.isFinite(n)) return { v };
    if (n === v) return { v, tables: [], rpc: [] };
    if (n > v || n < this.floor) return { v, reset: true, tables: [], rpc: [] };
    const tables = new Set();
    const rpc = new Set();
    for (const ev of this.ring) {
      if (ev.v <= n) continue;
      for (const t of ev.tables) tables.add(t);
      for (const r of ev.rpc) rpc.add(r);
    }
    return { v, tables: [...tables].sort(), rpc: [...rpc].sort() };
  }
}

// Временные триггеры на наблюдаемые таблицы. Не вышло (старая база без таблицы,
// запрещённая функция) — шина работает без перехвата: маршруты всё равно называют
// свои таблицы и RPC сами. Возвращает true, если поставлен хоть один.
function installCapture(db, bus, tables) {
  try {
    db.function(TOUCH_FN, { deterministic: false }, (t) => {
      try { bus.touch(t); } catch { /* запись важнее */ }
      return null;
    });
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
    let n = 0;
    for (const t of tables) {
      if (!NAME_RE.test(t) || !have.has(t)) continue;
      for (const [op, tag] of [['INSERT', 'i'], ['UPDATE', 'u'], ['DELETE', 'd']]) {
        db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS em_live_${tag}_${t} AFTER ${op} ON main."${t}" `
          + `BEGIN SELECT ${TOUCH_FN}('${t}'); END`);
      }
      n++;
    }
    return n > 0;
  } catch (e) {
    console.warn('[live] перехват записей базой не установлен — экраны узнают только о записях через /api/db и RPC:', e && e.message);
    return false;
  }
}

/** Шина этой базы (одна на базу; повторный вызов отдаёт ту же). */
export function createLiveBus(db, opts = {}) {
  const existing = BUSES.get(db);
  if (existing) return existing;
  const bus = new LiveBus(opts);
  BUSES.set(db, bus);
  bus.capture = installCapture(db, bus, opts.watch || LIVE_TABLES);
  return bus;
}

/**
 * LIVE_REFRESH_V1 (ревью 3.22.0, M6) — ВЫКЛЮЧАТЕЛЬ. EASYMED_LIVE=0|off|false|no
 * (переменная окружения ПК-сервера, как EASYMED_MDNS и EASYMED_REPORT_WORKERS) —
 * шина не заводится: ни триггеров, ни событий, /api/live отвечает 503
 * live_unavailable, и вкладки перестают стучаться — экраны работают как до 3.22.0.
 * Пусто или любое другое значение — включено.
 */
export function liveEnabled(env = process.env) {
  const v = String((env && env.EASYMED_LIVE) || '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(v);
}

/** Шина базы или null (тесты модулей без приложения шины не заводят). */
export function liveBusFor(db) {
  try { return (db && BUSES.get(db)) || null; } catch { return null; }
}

/**
 * Обёртка СИНХРОННОГО маршрута записи (/api/db): рамка вокруг обработчика. Обработчик
 * вернулся без исключения и ответил статусом < 400 — событие с тем, что назвал маршрут
 * (describe(req, res) → { tables, rpc }), и с тем, что поймала база внутри рамки. Иначе
 * (отказ, откат, исключение) пойманное выбрасывается. Без шины — обработчик как есть.
 */
export function liveWrapSync(db, describe, handler) {
  return function liveWrapped(req, res, next) {
    const bus = liveBusFor(db);
    if (!bus) return handler(req, res, next);
    const scope = bus.open();
    let ok = false;
    try {
      const out = handler(req, res, next);
      ok = true;
      return out;
    } finally {
      const held = scope.end();
      try {
        if (ok && res.statusCode < 400) {
          const named = describe(req, res) || {};
          bus.bump({ tables: [...held, ...(Array.isArray(named.tables) ? named.tables : [])], rpc: named.rpc });
        }
      } catch { /* событие — не повод испортить ответ */ }
    }
  };
}

/** «Записано» для кода, у которого есть только база (обмен филиалов, анализаторы). Никогда не бросает. */
export function liveBump(db, change) {
  try {
    const bus = liveBusFor(db);
    if (bus) bus.bump(change);
  } catch { /* см. шапку */ }
}
