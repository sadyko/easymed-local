// Per-clinic feature flags. Fail-soft to {} so every consumer treats "can't
// load" as "all features off" (today's behavior). CUSTOM_CLINIC_V1.
//
// V3120_FIX (2026-09-27) — ОФЛАЙН ФЛАГИ НЕ СПРАШИВАЮТСЯ. Флаги жили в облачном
// шлюзе (GET /api/v1/company/flags); у офлайн-сервера такого адреса нет, и
// каждое первое открытие «Услуг» или калькулятора кончалось 404 и
// предупреждением в консоли — с тем же итогом {}, что и сейчас. Ответ
// теперь даётся сразу, без запроса: поведение экранов не меняется, пропадает
// только заведомо проваленный запрос.

const OFFLINE_FLAGS = Object.freeze({});

export async function clinicFlags() { return OFFLINE_FLAGS; }

export function clinicFlagsSync() { return OFFLINE_FLAGS; }
