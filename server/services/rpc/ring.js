// CALL_RING_V1 (2026-10-17) — «ЗВОНИТ»: три вызова для панели «Телефон» и экрана «Телефония».
//
// Владелец: «is it possible to ring here and number with patient name appear and
// card opens automatically» → «panel show the "Звонит" block with an "Открыть
// карту" button». Карта сама не открывается.
//
//   telephony_live              — что звонит сейчас (telephony/live.js); сам вопрос
//                                 и есть СПРОС: пока панели спрашивают, клиника
//                                 держит длинный опрос публичного сервера.
//   telephony_ring_info         — адрес, который администратор вписывает в кабинет
//                                 onlinePBX (Сервисы → Интеграция → Webhooks):
//                                 через публичный сервер, если Easy-Med включил
//                                 обмен для клиники, иначе прямой адрес клиники.
//   telephony_ring_token_rotate — новый секрет адреса: прежний перестаёт
//                                 подходить, как только такт обмена донесёт новый.
//
// ВОРОТА. Живые звонки — те же, что у рабочего места панели (rpc/phone.js):
// право позвонить ИЛИ право на журнал. Адрес и его смена — раздел «Телефония»
// («Настройки → Роли», ключ settings.telephony), как и остальные его настройки.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { grantAllows, grantAllowsAdminOr } from '../grants.js';
import { getDataDir } from '../control/config.js';
import { RpcError } from './telephony.js';
import { demandLive, liveCalls, liveSource } from '../telephony/live.js';
import { readSettingsRow } from '../telephony/settings.js';
import { publicBaseUrl, wakePublicSync } from '../api/public-sync.js';

const TEL_KEY = 'settings.telephony';
// Те же роли, что PHONE_ROLES в rpc/phone.js, но СВОЕЙ константой: страж
// gate-fallbacks.test.js читает список ролей ворот из того же файла и сверяет
// его с картой gate-fallbacks.js (crm.dial / crm.calls) — импортированную
// константу он разобрать не может, и ворота считались бы неописанными.
const PHONE_ROLES = Object.freeze(['admin', 'registrar', 'callcenter']);
const DENY_WORKPLACE = 'Программа телефонии доступна тем, кому выдано право звонить из программы или смотреть журнал звонков («Настройки → Роли»).';
const DENY_VIEW = 'Адрес событий станции видит тот, кому открыт раздел «Телефония» («Настройки → Роли»).';
const DENY_EDIT = 'Сменить адрес событий станции может тот, кому разрешено менять раздел «Телефония» («Настройки → Роли»).';

const mayWorkplace = (db, user) => grantAllows(db, user, 'crm.dial', 'edit', PHONE_ROLES) || grantAllows(db, user, 'crm.calls', 'view', PHONE_ROLES);
const newToken = () => crypto.randomBytes(16).toString('hex');

function clinicIdOf(dataDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8'));
    return c && typeof c.clinic_id === 'string' ? c.clinic_id : '';
  } catch { return ''; }
}

/** Что звонит сейчас. Вопрос продлевает спрос — опрос публичного сервера идёт, пока спрашивают. */
export function telephonyLive(db, _args, user, { now = Date.now, dataDir = getDataDir() } = {}) {
  if (!mayWorkplace(db, user)) throw new RpcError(DENY_WORKPLACE, 403);
  demandLive(now());
  const src = liveSource(db, dataDir);
  return { calls: liveCalls(now()), source: src.source, reason: src.reason };
}

function ringInfo(db, dataDir, env, row) {
  const src = liveSource(db, dataDir);
  const clinicId = clinicIdOf(dataDir);
  const token = String(row.ring_token || '');
  const relayUrl = clinicId && token ? publicBaseUrl(env) + '/_pbx/v1/' + encodeURIComponent(clinicId) + '/' + token : '';
  const pub = String(row.public_base_url || '').trim().replace(/\/+$/, '');
  const directUrl = pub && token ? pub + '/api/telephony/pbx/' + token : '';
  return {
    ring_token: token,
    relay_url: relayUrl,
    direct_url: directUrl,
    relay_ready: src.source === 'relay',
    relay_reason: src.source === 'relay' ? '' : src.reason,
    clinic_id: clinicId,
  };
}

/** Адрес для кабинета станции. Секрет рождается здесь, при первом взгляде, — а не миграцией на всех установках сразу. */
export function telephonyRingInfo(db, _args, user, { dataDir = getDataDir(), env = process.env } = {}) {
  if (!grantAllowsAdminOr(db, user, TEL_KEY, 'view')) throw new RpcError(DENY_VIEW, 403);   // как rpc/telephony.js: строка adminDefault
  let row = readSettingsRow(db) || {};
  if (!row.ring_token) {
    db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run(newToken());
    wakePublicSync();   // публичный сервер узнаёт хеш секрета ближайшим тактом, а не через 15 секунд
    row = readSettingsRow(db) || {};
  }
  return ringInfo(db, dataDir, env, row);
}

/** Новый секрет: прежний адрес перестаёт подходить. Клиника вписывает новый в кабинет станции. */
export function telephonyRingTokenRotate(db, _args, user, { dataDir = getDataDir(), env = process.env } = {}) {
  if (!grantAllowsAdminOr(db, user, TEL_KEY, 'edit')) throw new RpcError(DENY_EDIT, 403);
  db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run(newToken());
  wakePublicSync();
  return ringInfo(db, dataDir, env, readSettingsRow(db) || {});
}
