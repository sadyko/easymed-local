// CLINIC_API_STEP7_V1 — RPC экрана «Настройки → API и подключения»
// (docs/plans/2026-10-10-clinic-api-7-api-screen.md).
//
// Почему RPC, а не /api/db: таблицы api_* намеренно НЕ зарегистрированы в
// schema-registry.js (как telegram_settings) — /api/db их не знает по
// построению. Значения ключей и секретов уходят только в четырёх ответах и
// только администратору: черновик, создание, «Показать / Скопировать»,
// выпуск нового. Маршрут /api/rpc печатает только имя RPC и текст ошибки, а
// тексты ошибок здесь значений не содержат (routes/api-connections-http.test.js).
//
// Права (строка «API» в «Ролях», settings.api; без настройки — только администратор):
//   «Просмотр»  — подключения, права, источники, журнал; ключи и секреты скрыты (даже хвост);
//   «Изменение» — включить и выключить, название, сайт, контакт;
//   администратор — имя в адресе, новое подключение, права подключения,
//     уведомления, безопасность, ключи и секреты, удаление.
// CLINIC_API_STEP7_V1 (ревью №1) — записи администратора требуют И «Изменения»,
// И администратора: своя роль на основе администратора с «API: Просмотр» не
// пишет ничего. Ключ и секрет она открывает («Показать / Скопировать» — решение
// владельца 5: ключи видят администраторы; как у телефонии).
// Филиал — только чтение: подключения живут в главном здании (публичный сервер
// шага 8 получает данные оттуда), записи — 409.
import { grantAllowsAdminOr, isAdminUser } from '../grants.js';
import { readIdentity } from '../branch-sync/identity.js';
import { apiBaseUrl } from '../../../public/js/shared/api-connections.js';
import {
  actorOf, readSlug, saveSlug, slugSuggestion, companyWebsite, clinicName, listConnections, listJournal,
  createConnection, updateConnection, revealSecret, regenerateSecret, deleteConnection,
} from '../api/connections.js';
import { makeDraft, renewDraft } from '../api/drafts.js';
import { companyAddressProblems } from '../api/partner-address.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
const KEY = 'settings.api';
export const RPC_MESSAGES = Object.freeze({
  noAccess:  'Раздел «API» недоступен вашей роли. Права выдаёт администратор в «Настройки → Роли».',
  noEdit:    'Менять подключения API может роль с правом «API: Изменение».',
  adminOnly: 'Это делает только администратор: ключи и секреты, права, уведомления и безопасность подключений, новое подключение и имя в адресе.',
  mainOnly:  'Подключения API настраиваются в главном здании клиники.',
  nothing:   'Нечего сохранять.',
});
// Поля карточки по уровню: «Изменение» — первые; остальное — администратор.
const EDIT_FIELDS = ['name', 'site_url', 'contact', 'active'];
const ADMIN_FIELDS = ['scopes', 'webhook_url', 'webhook_events', 'rate_limit', 'key_ttl', 'ip_allow'];

function buildingRole(db) {
  try { return readIdentity(db).role === 'secondary' ? 'secondary' : 'main'; } catch { return 'main'; }
}
function requireView(db, user) {
  if (!grantAllowsAdminOr(db, user, KEY, 'view')) throw new RpcError(RPC_MESSAGES.noAccess, 403);
}
function requireEdit(db, user) {
  requireView(db, user);
  if (!grantAllowsAdminOr(db, user, KEY, 'edit')) throw new RpcError(RPC_MESSAGES.noEdit, 403);
}
// CLINIC_API_STEP7_V1 (ревью №1) — запись администратора: «Изменение» + администратор.
// Раньше хватало просмотра: роль на основе администратора с «API: Просмотр»
// удаляла подключения, выпускала ключи и меняла имя в адресе.
function requireAdmin(db, user) {
  requireEdit(db, user);
  if (!isAdminUser(user)) throw new RpcError(RPC_MESSAGES.adminOnly, 403);
}
// «Показать / Скопировать» — администратор с правом хотя бы на «Просмотр».
function requireRevealer(db, user) {
  requireView(db, user);
  if (!isAdminUser(user)) throw new RpcError(RPC_MESSAGES.adminOnly, 403);
}
function requireMain(db) {
  if (buildingRole(db) === 'secondary') throw new RpcError(RPC_MESSAGES.mainOnly, 409);
}
// Не администратору — без масок: правило Telegram-бота («даже хвост не видит»).
const forViewer = (c, admin) => (admin ? c : { ...c, key_mask: '', secret_mask: '' });

export function apiSettingsGet(db, _args, user) {
  requireView(db, user);
  const admin = isAdminUser(user);   // маски — тому, кто может открыть ключ
  const edit = grantAllowsAdminOr(db, user, KEY, 'edit');
  const slug = readSlug(db);
  return {
    slug,
    base_url: apiBaseUrl(slug),
    slug_suggestion: slug ? '' : slugSuggestion(db),
    public_server: false,   // шаг 8 — публичный сервер ещё не включён
    building_role: buildingRole(db),
    clinic_name: clinicName(db),
    company_website: companyWebsite(db),
    partner_address_missing: Object.keys(companyAddressProblems(db)),   // решение владельца 11
    // CLINIC_API_STEP7_V1 (ревью №1) — admin: записи администратора (нужны и «Изменение»);
    // reveal: «Показать / Скопировать» ключ и секрет (администратору и на «Просмотре»).
    can: { view: true, edit, admin: admin && edit, reveal: admin },
    connections: listConnections(db).map((c) => forViewer(c, admin)),
  };
}
export function apiSlugSave(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  return saveSlug(db, args && args.slug, actorOf(db, user));
}
export function apiConnectionDraft(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  const me = actorOf(db, user).id;
  if (a.draft_id && a.renew) { const d = renewDraft(a.draft_id, me, a.renew); if (d) return d; }
  return makeDraft(me);
}
export function apiConnectionCreate(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  const out = createConnection(db, a, actorOf(db, user), { draftId: a.draft_id });
  return { ...out, base_url: apiBaseUrl(readSlug(db)) };
}
export function apiConnectionUpdate(db, args, user) {
  requireEdit(db, user); requireMain(db);
  const a = args || {};
  const patch = {};
  for (const k of [...EDIT_FIELDS, ...ADMIN_FIELDS]) if (Object.prototype.hasOwnProperty.call(a, k)) patch[k] = a[k];
  if (!Object.keys(patch).length) throw new RpcError(RPC_MESSAGES.nothing);
  if (ADMIN_FIELDS.some((k) => k in patch)) requireAdmin(db, user);
  return { connection: forViewer(updateConnection(db, a.id, patch, actorOf(db, user)), isAdminUser(user)) };
}
export function apiConnectionReveal(db, args, user) {
  requireRevealer(db, user); requireMain(db);   // CLINIC_API_STEP7_V1 (ревью №1)
  const a = args || {};
  return { value: revealSecret(db, a.id, a.what, actorOf(db, user)) };
}
export function apiConnectionRegenerate(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  return regenerateSecret(db, a.id, a.what, actorOf(db, user), { confirm: a.confirm });
}
export function apiConnectionDelete(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  return deleteConnection(db, a.id, actorOf(db, user), { confirm: a.confirm });
}
export function apiJournalList(db, args, user) {
  requireView(db, user);
  const a = args || {};
  return listJournal(db, { connectionId: a.connection_id ?? null, limit: a.limit });
}
