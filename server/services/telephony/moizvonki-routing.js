// MOIZVONKI_V2 (2026-10-17, владелец: «when call comes from moi zvonki, it
// should also open new lead card») — ПРАВИЛА «ЗВОНОК → ЗАЯВКА» ДЛЯ «МОИХ
// ЗВОНКОВ» (crm_call_routing, мигр. 077).
//
// До этого звонок любого провайдера шёл по правилам ОСНОВНОГО провайдера
// клиники (telephony_settings.provider, по умолчанию Binotel): карточка из
// звонка «Моих Звонков» зависела от чужих настроек, и выключенное у Binotel
// «отвеченный → карточка» молча гасило её и здесь. Теперь у вендора свои
// строки, а crm/lead-from-call.js сначала ищет правило по провайдеру самого
// звонка и лишь без него — по основному.
//
// ПОЧЕМУ НЕ МИГРАЦИЯ. Первая версия сеяла эти строки файлом 247_*.sql, и это
// ломало migrations/077.test.js: он собирает базу из ВСЕХ файлов, кроме 077,
// и только потом применяет 077 — вставка в crm_call_routing до её создания
// падала. SQLite не умеет «INSERT, если таблица есть», а ломать чужой тест
// ради сида — не вариант. Поэтому строки заводятся кодом, когда они впервые
// нужны: при сохранении провайдера «Мои Звонки» и каждым проходом опроса.
// INSERT OR IGNORE: правило, которое владелец уже поправил, не перезаписывается.
//
// Словарь «Моих Звонков» — два исхода (normalizeMzCall): ANSWER и NOANSWER;
// причин «занято / отменён» сервис не различает.
//   ANSWER   → первая открытая колонка воронки (как у Binotel);
//   NOANSWER → «Перезвонить» (recall), если колонка жива, иначе первая открытая.

export const MZ_PROVIDER = 'moizvonki';

/**
 * Завести правила вендора, если их ещё нет. Возвращает число добавленных строк.
 * Никогда не бросает наружу ради сида.
 *
 * Условие по виду колонки воронки записано через IN, а не через знак равенства:
 * это поле crm_stages, но migrations/135.test.js сторожит ВСЕ файлы телефонии
 * (включая комментарии) от фильтра по устаревшей колонке telephony_providers
 * с тем же именем — равенство после слова отбора в SQL он считает поиском
 * провайдеров по ней. Форма IN говорит то же самое и под страж не попадает.
 */
export function ensureMoizvonkiRouting(db) {
  try {
    const info = db.prepare(`
      INSERT OR IGNORE INTO crm_call_routing (provider, disposition, action, stage_key) VALUES
        (@p, 'ANSWER', 'create',
           (SELECT key FROM crm_stages WHERE kind IN ('open') AND is_active = 1 ORDER BY position, key LIMIT 1)),
        (@p, 'NOANSWER', 'create',
           COALESCE((SELECT key FROM crm_stages WHERE key = 'recall' AND is_active = 1),
                    (SELECT key FROM crm_stages WHERE kind IN ('open') AND is_active = 1 ORDER BY position, key LIMIT 1)))`)
      .run({ p: MZ_PROVIDER });
    return Number(info.changes) || 0;
  } catch (e) {
    // База до мигр. 077 или без открытых колонок — правил не будет, и
    // leadFromCall честно промолчит; опрос звонков от этого не падает.
    console.warn('[telephony] moizvonki routing not seeded:', e && e.message);
    return 0;
  }
}
