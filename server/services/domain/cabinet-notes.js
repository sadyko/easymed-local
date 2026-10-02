// CABINET_FIX_V1_R4 (ревью 4, п. 2) — ПОДПИСАННАЯ ВЕРСИЯ ДОКУМЕНТА СТРОКИ НЕ
// СТИРАЕТСЯ ЗАПИСЬЮ.
//
// Записи кабинета врача (visit_services.notes) — JSON с меткой
// __service_workspace_v1 и историей версий: черновики, направления и
// подписанные версии. Браузер пишет их целиком. Окно со старой копией (вторая
// вкладка, другой компьютер, экран, перерисованный во время подписи) писало
// историю без подписанной версии, уже сохранённой другим окном, — и она
// пропадала. Подписанная версия не удаляется ни одним сценарием кабинета
// (удаляются только черновики и направления — handleDeleteEntry), поэтому
// правило простое: каждая подписанная версия, уже сохранённая у строки, обязана
// быть и в новой записи (сверка по savedAt). Правило действует, только если и
// сохранённые, и новые notes — JSON кабинета с историей; прочие записи notes
// (текст, другие экраны) не трогаются. Чистая функция — сервер и проверки.
const TAG = '__service_workspace_v1';

function cabinetNotes(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let p = null;
  try { p = JSON.parse(raw); } catch { return null; }
  return p && typeof p === 'object' && p[TAG] === 1 && Array.isArray(p.history) ? p : null;
}

/** true — новая запись notes потеряла подписанную версию, сохранённую у строки. */
export function signedVersionsDropped(storedRaw, nextRaw) {
  const prev = cabinetNotes(storedRaw);
  const next = cabinetNotes(nextRaw);
  if (!prev || !next) return false;
  const kept = new Set(next.history.filter((e) => e && e.kind === 'signed').map((e) => String(e.savedAt)));
  return prev.history.some((e) => e && e.kind === 'signed' && !kept.has(String(e.savedAt)));
}

export const SIGNED_CONFLICT_MESSAGE = 'Документ уже подписан в другом окне — обновите его и сохраните ещё раз.';
