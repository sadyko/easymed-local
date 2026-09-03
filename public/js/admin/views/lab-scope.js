// LAB_ONE_CLINIC_V1 — кого обслуживает лаборатория. Модуль ЧИСТЫЙ: ни DOM, ни
// сети — его читают и экран, и тесты (тот же приём, что у record-origin.js и
// lab-service.js).
//
// Требование владельца, дословно: «the lab can be one single so whenever clinic
// registrates the patient the all clinics laborants should see the list of the
// patients and enter the data.» До этого лабораторная очередь и история
// «Готово» фильтровались по `sync_origin IS NULL` — каждое здание видело только
// свои пробирки (решение владельца 2026-09-02 про очередь врача и регистратуру
// остаётся в силе, эта настройка касается ТОЛЬКО лаборатории).
//
// Значение хранится в doc_settings.lab_scope (миграция 085) и приезжает
// филиалам со справочником (branch-sync/catalogue.js DOC_SETTINGS_COLUMNS),
// поэтому все здания отвечают на этот вопрос одинаково.

export const LAB_SCOPE_CLINIC = 'clinic';       // вся клиника: заказы всех филиалов
export const LAB_SCOPE_BUILDING = 'building';   // только своё здание (поведение до 0.7.0)

// ПО УМОЛЧАНИЮ — вся клиника: так просил владелец. Для клиники в одном здании
// это не меняет ничего (чужих строк там нет вовсе), а клиника с двумя
// настоящими лабораториями переключает настройку явно.
export const LAB_SCOPE_DEFAULT = LAB_SCOPE_CLINIC;

/**
 * Привести хранимое значение к одному из двух. Всё, что не 'building' —
 * включая NULL, пустую строку и старую базу без колонки — это «вся клиника».
 * Молчаливое сужение до своего здания было бы худшим из отказов: очередь
 * выглядела бы просто пустой, и никто бы не понял, что часть работы спрятана.
 * @param {unknown} v
 * @returns {'clinic'|'building'}
 */
export function normalizeLabScope(v) {
  return v === LAB_SCOPE_BUILDING ? LAB_SCOPE_BUILDING : LAB_SCOPE_DEFAULT;
}

/** Лаборатория заперта в своём здании? */
export function ownBuildingOnly(scope) {
  return normalizeLabScope(scope) === LAB_SCOPE_BUILDING;
}

/**
 * Наложить настройку на запрос очереди — ОДНО место, где решается граница.
 *
 * Фильтр применяется к запросу, а не к уже полученным строкам: у очереди есть
 * .limit(), и отсев после выборки означал бы, что лимит съеден чужими строками,
 * а своя работа не доехала (та самая история LAB_QUEUE_NO_TRUNCATION_V1, только
 * наоборот). `qb` — построитель supabase-совместимого клиента; возвращается он
 * же, чтобы вызов оставался цепочкой.
 *
 * @param {{is: Function}} qb
 * @param {unknown} scope
 */
export function scopeQuery(qb, scope) {
  return ownBuildingOnly(scope) ? qb.is('sync_origin', null) : qb;
}
