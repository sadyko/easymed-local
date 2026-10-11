// PUBLIC_SERVER_V1 — СОСТОЯНИЕ ЛИЦЕНЗИИ КЛИНИКИ ДЛЯ ПАРТНЁРОВ. ОДНО МЕСТО.
//
// Решение владельца 4: лицензия не продлена — партнёры получают 503.
// Решение владельца 17: и с ПЕРВОЙ отметки «не оплачено» в панели, не дожидаясь
// конца срока. Отметку сервер лицензий вписывает в ПОДПИСАННУЮ лицензию (шаг 8c,
// предложение — payload.subscription: 'active' | 'unpaid'); клиника кладёт
// licence.dat в каждый запрос как есть (8a). Неподписанное слово из control.json
// сюда не доходит и не годится: его клиника могла бы подменить.
//
// ШОВ ДЛЯ 8c: если 8c назовёт поле иначе — меняется ТОЛЬКО subscriptionOf
// (и тест licence-gate.test.js). Неизвестное значение — 'active': называть
// платящую клинику неплательщиком хуже (правило easymed-licence-lockout).
//
//   'active' — партнёры видят клинику;
//   'unpaid' — партнёрам 503, канал клиники /_sync/v1 открыт (события по уже
//              принятым записям должны дойти до партнёров — дизайн §9);
//   'lapsed' — срок лицензии вышел: партнёрам 503 и каналу клиники 503 (§10).
export function subscriptionOf(payload) {
  return payload && payload.subscription === 'unpaid' ? 'unpaid' : 'active';
}

/** @param {{licence_valid_until?:string, licence_subscription?:string}} clinic строка clinics */
export function licenceStanding(clinic, nowMs) {
  const until = Date.parse(String((clinic && clinic.licence_valid_until) || ''));
  if (!Number.isFinite(until) || until <= nowMs) return 'lapsed';
  return clinic.licence_subscription === 'unpaid' ? 'unpaid' : 'active';
}
