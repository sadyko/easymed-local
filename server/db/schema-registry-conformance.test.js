// ═══════════════════════════════════════════════════════════════════════════
// REGISTRY_CONFORMANCE_V1 (2026-09-05) — РЕЕСТР НЕ ИМЕЕТ ПРАВА НАЗЫВАТЬ ТО,
// ЧЕГО В БАЗЕ НЕТ.
//
// У db-query-schema.test.mjs есть слепое пятно, и оно ровно обратное его
// собственному. Тот сторож спрашивает: «просит ли вид того, чего реестр не
// отдаёт?» — и ловит 400. Но есть и вторая половина того же вопроса: «отдаёт
// ли реестр то, чего нет в SQLite?» Там ответ страшнее: запрос СОБЕРЁТСЯ,
// уйдёт в better-sqlite3 и упадёт уже там — «no such column». Это 500, а не
// 400, и у него нет ни `kind: 'schema'`, ни заметной плашки в db-client.js.
// То есть первый сторож молчит по определению, а экран падает.
//
// ЭТОТ ФАЙЛ ЗАКРЫВАЕТ ВТОРУЮ ПОЛОВИНУ. Он поднимает НАСТОЯЩУЮ базу (все
// миграции) и сверяет с ней каждое имя реестра: таблицу, каждую колонку чтения
// и записи, каждый фильтр, каждую связь — её таблицу, внешний ключ и колонки.
//
// PRAGMA table_xinfo, А НЕ table_info. Разница не косметическая: `users.active`
// — это `GENERATED ALWAYS AS (is_active) VIRTUAL`, совместимость с облачным
// именем колонки, и table_info такие колонки НЕ ПОКАЗЫВАЕТ. Проверка на
// table_info объявила бы `active` несуществующей и потребовала бы выкинуть её
// из реестра — то есть сломала бы шесть работающих экранов ради ложной тревоги.
// Так же устроены purchase_order_items.line_total и stock_count_items.variance.
//
// ЧЕГО НЕТ ЛОКАЛЬНО — ТОГО НЕТ И В РЕЕСТРЕ. Второй тест закрепляет решение,
// принятое при разборе 102 отвергнутых запросов: десяток таблиц, которые
// спрашивают виды (clinic_items, item_stock, patient_allergies, marketing_tasks,
// support_tickets…), — это имена ОБЛАЧНОГО продукта, и локальной таблицы под
// ними нет. Внести их в реестр было бы худшим из возможных ответов: чистый
// отказ 403 превратился бы в 500 «no such table», а экран так и остался бы
// пустым — только причина спряталась бы глубже.
// ═══════════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { REGISTRY } from './schema-registry.js';

const db = openDb(':memory:');
migrate(db);

const objects = new Map();
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all()) {
  objects.set(name, new Set(db.prepare(`PRAGMA table_xinfo("${name}")`).all().map((c) => c.name)));
}

test('каждая таблица реестра существует в базе', () => {
  const missing = Object.keys(REGISTRY).filter((t) => !objects.has(t));
  assert.deepEqual(missing, [], 'реестр отдаёт таблицу, которой нет в SQLite — это 500, а не 403');
});

test('каждая колонка чтения, записи и фильтра существует в своей таблице', () => {
  const bad = [];
  for (const [t, e] of Object.entries(REGISTRY)) {
    const cols = objects.get(t);
    if (!cols) continue;                       // покрыто тестом выше
    for (const c of e.read.columns) if (!cols.has(c)) bad.push(`${t}.read ${c}`);
    for (const op of ['insert', 'update']) {
      for (const c of (e.write?.[op]?.columns || [])) if (!cols.has(c)) bad.push(`${t}.${op} ${c}`);
    }
    for (const c of (e.filters || [])) if (!cols.has(c)) bad.push(`${t}.filters ${c}`);
    for (const c of (e.json || [])) if (!cols.has(c)) bad.push(`${t}.json ${c}`);
  }
  assert.deepEqual(bad, []);
});

test('каждая связь ведёт в существующую таблицу по существующему ключу', () => {
  const bad = [];
  for (const [t, e] of Object.entries(REGISTRY)) {
    const cols = objects.get(t);
    for (const [rel, emb] of Object.entries(e.embed || {})) {
      const target = objects.get(emb.table);
      if (!target) { bad.push(`${t}.${rel} -> нет таблицы ${emb.table}`); continue; }
      // Внешний ключ лежит на БАЗОВОЙ таблице и смотрит в первичный ключ цели:
      // именно такую форму строит compileEmbed (ON base.fk = target.id).
      if (cols && !cols.has(emb.fk)) bad.push(`${t}.${rel} -> нет колонки ${t}.${emb.fk}`);
      if (!target.has('id')) bad.push(`${t}.${rel} -> у ${emb.table} нет id`);
      for (const c of emb.columns) if (!target.has(c)) bad.push(`${t}.${rel} -> нет ${emb.table}.${c}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('колонки-псевдонимы из облака видны только через table_xinfo — проверка обязана их видеть', () => {
  // Сторож самого сторожа. Если проверку однажды перепишут на table_info, эти
  // три имени «исчезнут», тесты выше потребуют убрать их из реестра — и шесть
  // экранов (списки врачей по `active`) сломаются от «починки». Пусть падает
  // здесь и объясняет причину.
  const hidden = [['users', 'active'], ['purchase_order_items', 'line_total'], ['stock_count_items', 'variance']];
  for (const [t, c] of hidden) {
    const xinfo = db.prepare(`PRAGMA table_xinfo("${t}")`).all().map((r) => r.name);
    const info = db.prepare(`PRAGMA table_info("${t}")`).all().map((r) => r.name);
    assert.ok(xinfo.includes(c), `${t}.${c} должна быть в table_xinfo`);
    assert.ok(!info.includes(c), `${t}.${c} — GENERATED VIRTUAL, её не видно в table_info`);
    assert.ok(REGISTRY[t].read.columns.includes(c), `${t}.${c} читается видами и обязана остаться в реестре`);
  }
});

// ─── ЧЕГО ЗДЕСЬ НЕТ — ТОГО НЕ РЕГИСТРИРОВАТЬ ────────────────────────────────
test('таблицы облачного продукта отсутствуют и в базе, и в реестре', () => {
  // Разбор 102 отвергнутых запросов (BASELINE в db-query-schema.test.mjs) дал
  // ровно эти имена. Ни одного локального аналога у них НЕТ:
  //   • товарные — местная модель это `products` + `products.on_hand`, один
  //     склад; так и записано в миграции 028 («Item table is products, NOT
  //     easymed's clinic_items»). Партий, ячеек хранения и остатков по филиалам
  //     здесь не существует как понятия.
  //   • маркетинг и поддержка — части SaaS-версии; support-виджет уже отключён
  //     в public/admin.html с этой же причиной в комментарии.
  //   • patient_allergies — единственный случай, где локальный аналог напрашивается:
  //     миграция 024 завела patient_conditions и НЕ завела аллергии. Экран от этого
  //     сегодня не страдает — карта пациента показывает свободный текст
  //     patients.allergies, а структурный загрузчик loadPatientAllergies()
  //     в data.js не вызывается ни одним видом. Нужна МИГРАЦИЯ, а не строка
  //     в реестре: без таблицы запись здесь превратила бы честный 403 в 500.
  const cloudOnly = ['clinic_items', 'item_stock', 'batch_stock', 'stock_locations',
    'marketing_tasks', 'notification_templates', 'notification_messages',
    'support_tickets', 'support_messages', 'patient_allergies'];
  for (const t of cloudOnly) {
    assert.ok(!objects.has(t), `${t} появилась в схеме — теперь её МОЖНО и НУЖНО внести в реестр`);
    assert.ok(!REGISTRY[t], `${t} внесена в реестр, но таблицы нет: запрос дойдёт до SQLite и упадёт 500`);
  }
});
