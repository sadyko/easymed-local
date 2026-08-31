// BRANCH_SYNC_V1 — ЧТО именно едет между филиалами, и как оно приземляется.
//
// Этап 1 переносит только СПРАВОЧНИК: сведения о клинике, услуги с ценами и
// лабораторные панели с показателями. Ни пациентов, ни визитов, ни результатов,
// ни счетов, ни платежей — это Этапы 2 и 3, и до них правило владельца
// «НЕ ПЕРСОНАЛЬНЫЕ ДАННЫЕ ПАЦИЕНТОВ» держится здесь самым простым способом из
// возможных: таблицы и колонки перечислены В КОДЕ, и выгрузка физически не
// умеет отдать ничего другого.
//
// Это та же идея, что у STATS_V1 (control/metrics.js): не «отфильтруем лишнее
// перед отправкой», а «сборщик умеет собрать только вот это». Фильтр забывают
// обновить, когда в таблицу добавляют колонку; перечень — нет, потому что новая
// колонка просто не попадает в выгрузку, пока её сюда не впишут. Гарантия
// закреплена тестом: в базу-источник сажается пациент-маркер со счётом и
// анализом, и весь JSON выгрузки проверяется на отсутствие его следов.
//
// ГЛАВНОЕ РЕШЕНИЕ ПРИЁМА — строки приезжают ПО СОБСТВЕННЫМ id принимающей базы,
// а соответствие хранится в branch_sync_map (см. миграцию 079 с разбором, почему
// перенос «как есть, вместе с id» испортил бы уже выставленные счета филиала).

// Колонки doc_settings, которые описывают КЛИНИКУ, а не ЗДАНИЕ.
//
// address / phone / email намеренно НЕ синхронизируются, хотя владелец
// перечислил «информацию о компании» целиком. Причина видна на первом же
// напечатанном документе: doc_settings — источник шапки печатных форм
// (rpc/clinic.js get_clinic_by_slug), и, приехав из главного филиала, адрес с
// телефоном заменили бы на бланках второго филиала его собственные контакты
// чужими. Пациент, пришедший по такому направлению, поехал бы в другое здание.
// Свой адрес и телефон у филиала уже есть — в таблице branches, которая и
// заведена ровно для этого.
//
// id / updated_at не переносятся: id всегда 1 (строка одна по CHECK), а
// updated_at должен показывать, когда справочник изменился ЗДЕСЬ.
export const DOC_SETTINGS_COLUMNS = [
  'clinic_name', 'license', 'logo_data_url', 'accent_color',
  'paper_size', 'show_watermark', 'footer_note', 'legal_note',
];

// Таблицы справочника — В ПОРЯДКЕ ЗАВИСИМОСТЕЙ. Порядок не косметика: services
// ссылается на service_types/service_categories/departments, а
// lab_panel_analytes — на lab_panels, и родитель должен получить свой локальный
// id раньше, чем ребёнок попытается на него сослаться.
//
//   columns   — что переносим (id идёт отдельно, как remote_id);
//   refs      — колонки-ссылки: чужой id переводится в свой через карту;
//   natural   — по чему УСЫНОВЛЯТЬ уже существующую местную строку (ниже);
//   scopeRef  — для дочерних таблиц: искать кандидата на усыновление только
//               внутри своего родителя.
export const TABLES = [
  {
    name: 'service_types',
    columns: ['name', 'code', 'billing_mode', 'active'],
    refs: {},
    natural: ['code', 'name'],
  },
  {
    name: 'service_categories',
    columns: ['code', 'name', 'parent_id', 'description', 'active'],
    // Ссылка на саму себя — поэтому parent_id проставляется вторым проходом,
    // когда все категории уже получили локальные id (см. applyCatalogue).
    refs: { parent_id: 'service_categories' },
    selfRef: 'parent_id',
    natural: ['code', 'name'],
  },
  {
    // Отделения тянутся не сами по себе, а как ЗАВИСИМОСТЬ услуг:
    // services.department_id — внешний ключ, а foreign_keys включён
    // (db/connection.js), поэтому услуга с чужим department_id без своей
    // строки в departments не вставилась бы вовсе. Данные при этом
    // неклинические: название, код, вид отделения. Сотрудники (users.
    // department_id) не переносятся — приезжают только сами отделения.
    name: 'departments',
    columns: ['name', 'code', 'kind', 'active'],
    refs: {},
    natural: ['code', 'name'],
  },
  {
    name: 'services',
    columns: [
      'name', 'code', 'price', 'tax_rate', 'duration_minutes', 'requires_doctor', 'active',
      'is_lab', 'specimen', 'result_unit', 'ref_low', 'ref_high', 'ref_text', 'type',
      'type_id', 'category_id', 'department_id', 'tube_color',
      // SERVICE_EDITOR_V1 (миграция 081) — доля исполнителя по умолчанию ЕДЕТ:
      // это ценовая политика клиники, и она путешествует вместе с прайсом.
      'default_doctor_percent',
      // services.room_id (та же миграция 081) НАМЕРЕННО ОТСУТСТВУЕТ: кабинет —
      // факт ЗДАНИЯ, а не клиники. «Кабинет 5» главного филиала ничего не
      // значит во втором корпусе, а приехавший чужой id указал бы на случайную
      // местную комнату или в никуда. Принимающий филиал хранит свой
      // NULL/локальный кабинет; перечень колонок здесь — и есть гарантия, что
      // room_id физически не попадает в выгрузку (пин: 081.test.js).
    ],
    refs: { type_id: 'service_types', category_id: 'service_categories', department_id: 'departments' },
    natural: ['code', 'name'],
  },
  {
    name: 'lab_panels',
    // core_panel_id — не внешний ключ на местную таблицу, а номер панели в
    // облачном каталоге CORE; он одинаково осмыслен во всех установках и едет
    // как есть.
    columns: ['name', 'code', 'modality', 'has_narrative', 'service_id', 'core_panel_id', 'active'],
    refs: { service_id: 'services' },
    natural: ['code', 'name'],
  },
  {
    name: 'lab_panel_analytes',
    columns: [
      'panel_id', 'code', 'name', 'unit', 'value_type', 'value_options', 'decimals',
      'ref_low', 'ref_high', 'ref_text', 'ref_low_m', 'ref_high_m', 'ref_low_f', 'ref_high_f',
      'group_label', 'sort_order', 'ref_ranges', 'active',
    ],
    refs: { panel_id: 'lab_panels' },
    natural: ['code', 'name'],
    scopeRef: 'panel_id',
  },
];

/**
 * Снимок справочника этой установки — то, что главный филиал отдаёт по сети.
 *
 * Строки берутся ЦЕЛИКОМ, включая active = 0. Снятая с продажи услуга обязана
 * доехать до филиала именно как снятая: пропустить её означало бы, что филиал
 * продолжает её продавать, а «удалить у себя то, чего нет у главного» этот этап
 * делать не будет (см. applyCatalogue — ничего не удаляем).
 */
export function exportCatalogue(db, { now = () => new Date() } = {}) {
  const out = {
    generated_at: now().toISOString(),
    doc_settings: null,
  };

  const settings = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
  if (settings) {
    const picked = {};
    for (const col of DOC_SETTINGS_COLUMNS) picked[col] = settings[col] ?? null;
    out.doc_settings = picked;
  }

  for (const spec of TABLES) {
    const cols = ['id', ...spec.columns].map((c) => `"${c}"`).join(', ');
    // Имена таблиц и колонок — из константы выше, не из запроса, поэтому
    // интерполяция здесь не строит SQL из пользовательского ввода (тот же
    // инвариант, что и в db/query-compiler.js: идентификаторы только из
    // белого списка, значения — только параметрами).
    out[spec.name] = db.prepare(`SELECT ${cols} FROM "${spec.name}" ORDER BY id`).all();
  }
  return out;
}

// Одинаковы ли значения, приехавшее и местное. SQLite вернёт цену как 250000
// (INTEGER) там, где JSON привёз 250000.0, а пустая строка и NULL в этих
// таблицах взаимозаменяемы по смыслу — без нормализации каждая синхронизация
// «находила» изменения там, где их нет, и делала бесконечный UPDATE всего
// справочника (и снимала бы резервную копию на каждый пустой прогон).
function sameValue(a, b) {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  if (typeof na === 'number' || typeof nb === 'number') {
    const fa = Number(na); const fb = Number(nb);
    if (Number.isFinite(fa) && Number.isFinite(fb)) return fa === fb;
  }
  return String(na) === String(nb);
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Приземлить справочник главного филиала в эту базу.
 *
 * ВЫЗЫВАТЬ ВНУТРИ ОДНОЙ ТРАНЗАКЦИИ (rpc/branch-sync.js так и делает) — половина
 * приехавшего прайса хуже, чем не приехавший вовсе.
 *
 * Три правила, каждое выбрано в сторону «не трогать чужое»:
 *
 * 1. НИЧЕГО НЕ УДАЛЯЕМ. Строки, которых у главного филиала нет, остаются как
 *    были. Локальная услуга может уже стоять в выставленных счетах и в
 *    оказанных визитах — удаление порвало бы историю, а «спрятать» её
 *    (active = 0) означало бы, что филиал перестал продавать то, что реально
 *    оказывает. Снять услугу с продажи главный филиал может явно: он
 *    выставляет active = 0 у себя, и это приезжает обычным обновлением.
 *
 * 2. УСЫНОВЛЕНИЕ ПЕРЕД ВСТАВКОЙ. Филиалы почти всегда заводят справочник
 *    руками ещё до связывания. Без этого шага первая же синхронизация
 *    удвоила бы весь прайс: два «Приём кардиолога», и регистратура выбирает
 *    из них наугад. Поэтому для несопоставленной чужой строки ищется
 *    местная — по коду, а если кода нет, по названию. Усыновление
 *    происходит, только когда кандидат РОВНО ОДИН и он ещё ни за кем не
 *    закреплён: при двух одинаковых названиях угадывать нечего, и создаётся
 *    новая строка.
 *
 * 3. dryRun ПРОГОНЯЕТ ТОТ ЖЕ КОД. «Изменится ли что-нибудь» решает не
 *    отдельный предсказатель (он разошёлся бы с реальным приёмом на первой же
 *    правке), а этот же проход с отключённой записью. Так «повторный запуск
 *    ничего не делает» — проверяемое свойство, и именно оно позволяет не
 *    снимать резервную копию на каждый пустой прогон.
 *
 * @returns {{changed:number, created:object, updated:object, adopted:object, settings:boolean}}
 */
export function applyCatalogue(db, payload, { dryRun = false } = {}) {
  const summary = { changed: 0, created: {}, updated: {}, adopted: {}, settings: false };
  if (!payload || typeof payload !== 'object') return summary;

  // ---- сведения о клинике (одна строка, id = 1) --------------------------
  if (payload.doc_settings && typeof payload.doc_settings === 'object') {
    const local = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
    if (local) {
      const changes = {};
      for (const col of DOC_SETTINGS_COLUMNS) {
        if (!(col in payload.doc_settings)) continue;
        if (!sameValue(payload.doc_settings[col], local[col])) changes[col] = payload.doc_settings[col];
      }
      const keys = Object.keys(changes);
      if (keys.length) {
        summary.settings = true;
        summary.changed += 1;
        if (!dryRun) {
          const sets = keys.map((k) => `"${k}" = ?`).join(', ');
          db.prepare(`UPDATE doc_settings SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`)
            .run(...keys.map((k) => changes[k]));
        }
      }
    }
  }

  // ---- карта соответствий -------------------------------------------------
  // Читается целиком в память: справочник клиники — это тысячи строк, не
  // миллионы, а тысяча точечных SELECT-ов внутри транзакции стоила бы дороже.
  const mapped = new Map();          // 'таблица:чужой id' -> свой id
  const claimed = new Map();         // 'таблица' -> Set(своих id, уже закреплённых)
  for (const row of db.prepare('SELECT table_name, remote_id, local_id FROM branch_sync_map').all()) {
    mapped.set(`${row.table_name}:${row.remote_id}`, row.local_id);
    if (!claimed.has(row.table_name)) claimed.set(row.table_name, new Set());
    claimed.get(row.table_name).add(row.local_id);
  }
  const claimSet = (t) => { if (!claimed.has(t)) claimed.set(t, new Set()); return claimed.get(t); };

  // Свои id раздаются подряд от этого счётчика только в dryRun: настоящие
  // выдаёт SQLite. Отрицательные — чтобы «выдуманный» id нельзя было спутать с
  // настоящим, если он куда-то просочится.
  let fakeId = -1;

  const insertMap = db.prepare(
    'INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES (?, ?, ?) '
    + 'ON CONFLICT(table_name, remote_id) DO UPDATE SET local_id = excluded.local_id, '
    + "synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
  );
  const remember = (table, remoteId, localId) => {
    mapped.set(`${table}:${remoteId}`, localId);
    claimSet(table).add(localId);
    if (!dryRun) insertMap.run(table, remoteId, localId);
  };

  // Чужой id -> свой. Если у чужой строки соответствия нет вовсе (ссылка в
  // никуда — строка, которой у главного филиала уже нет), ставится NULL:
  // отказаться от всей услуги из-за отсутствующей категории было бы хуже, чем
  // принять её без категории.
  const resolveRef = (table, remoteId) => {
    if (remoteId === null || remoteId === undefined || remoteId === '') return null;
    return mapped.get(`${table}:${remoteId}`) ?? null;
  };

  for (const spec of TABLES) {
    const rows = Array.isArray(payload[spec.name]) ? payload[spec.name] : [];
    // Колонки, которые ставим сразу. Самоссылка (service_categories.parent_id)
    // откладывается: на первом проходе половина родителей ещё не существует.
    const firstPass = spec.columns.filter((c) => c !== spec.selfRef);

    // Кандидаты на усыновление — все свои строки таблицы, по одному чтению.
    const localRows = db.prepare(`SELECT * FROM "${spec.name}"`).all();

    for (const remote of rows) {
      if (!remote || typeof remote !== 'object' || remote.id === undefined || remote.id === null) continue;

      // ВЕРСИОННЫЙ ПЕРЕКОС — нормальное состояние: обновления приезжают
      // помашинно, и главный филиал может неделями отдавать выгрузку БЕЗ
      // колонки, которую эта база уже получила миграцией (первой так поехала
      // default_doctor_percent из 081). Отсутствующий ключ значит «экспортёр
      // старой версии», а не NULL: NULL валил бы INSERT об NOT NULL и затирал
      // бы местную настройку на UPDATE. Поэтому дальше участвуют только
      // колонки, которые в строке ДЕЙСТВИТЕЛЬНО есть — ровно тот же приём,
      // которым ветка doc_settings выше всегда и жила (`col in payload…`).
      const present = firstPass.filter((col) => col in remote);
      const values = {};
      for (const col of present) {
        values[col] = spec.refs[col] ? resolveRef(spec.refs[col], remote[col]) : (remote[col] ?? null);
      }

      let localId = mapped.get(`${spec.name}:${remote.id}`) ?? null;
      let localRow = localId != null ? localRows.find((r) => r.id === localId) : null;
      if (localId != null && !localRow) {
        // Соответствие есть, а строки нет: её удалили здесь руками. Считаем
        // строку несопоставленной и заводим заново — иначе UPDATE ушёл бы в
        // пустоту и справочник навсегда остался бы неполным.
        localId = null;
      }

      // --- усыновление -----------------------------------------------------
      if (localId == null) {
        const key = ['code', 'name'].find((k) => spec.natural.includes(k) && norm(remote[k]));
        if (key) {
          const scopeVal = spec.scopeRef ? values[spec.scopeRef] : undefined;
          const candidates = localRows.filter((r) =>
            !claimSet(spec.name).has(r.id)
            && norm(r[key]) === norm(remote[key])
            && (!spec.scopeRef || r[spec.scopeRef] === scopeVal));
          if (candidates.length === 1) {
            localId = candidates[0].id;
            localRow = candidates[0];
            remember(spec.name, remote.id, localId);
            summary.adopted[spec.name] = (summary.adopted[spec.name] || 0) + 1;
          }
        }
      }

      // --- вставка ---------------------------------------------------------
      if (localId == null) {
        summary.created[spec.name] = (summary.created[spec.name] || 0) + 1;
        summary.changed += 1;
        if (dryRun) {
          remember(spec.name, remote.id, fakeId--);
        } else {
          // Только приехавшие колонки: отсутствующие получают умолчание своей
          // таблицы, как у любой местной вставки.
          const cols = present.map((c) => `"${c}"`).join(', ');
          const qs = present.map(() => '?').join(', ');
          const info = db.prepare(`INSERT INTO "${spec.name}" (${cols}) VALUES (${qs})`)
            .run(...present.map((c) => values[c]));
          remember(spec.name, remote.id, Number(info.lastInsertRowid));
        }
        continue;
      }

      // --- обновление ------------------------------------------------------
      const changedCols = localRow ? present.filter((c) => !sameValue(values[c], localRow[c])) : present;
      if (changedCols.length) {
        summary.updated[spec.name] = (summary.updated[spec.name] || 0) + 1;
        summary.changed += 1;
        if (!dryRun) {
          const sets = changedCols.map((c) => `"${c}" = ?`).join(', ');
          db.prepare(`UPDATE "${spec.name}" SET ${sets} WHERE id = ?`)
            .run(...changedCols.map((c) => values[c]), localId);
        }
      }
    }

    // --- второй проход: самоссылка ----------------------------------------
    if (spec.selfRef) {
      const after = dryRun ? localRows : db.prepare(`SELECT * FROM "${spec.name}"`).all();
      for (const remote of rows) {
        const localId = mapped.get(`${spec.name}:${remote.id}`);
        if (localId == null) continue;
        // Тот же версионный перекос, что и выше: строка без этой колонки —
        // старый экспортёр, местное значение остаётся.
        if (!remote || !(spec.selfRef in remote)) continue;
        const want = resolveRef(spec.refs[spec.selfRef], remote[spec.selfRef]);
        const have = after.find((r) => r.id === localId)?.[spec.selfRef] ?? null;
        // В dryRun у только что «вставленных» строк локальной копии нет, и have
        // будет undefined -> null: это и есть честный ответ «значение изменится».
        if (sameValue(want, have)) continue;
        summary.updated[spec.name] = (summary.updated[spec.name] || 0) + 1;
        summary.changed += 1;
        if (!dryRun) db.prepare(`UPDATE "${spec.name}" SET "${spec.selfRef}" = ? WHERE id = ?`).run(want, localId);
      }
    }
  }

  return summary;
}
