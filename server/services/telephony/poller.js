// TELEPHONY_V1 — the background call poller, living inside the server the way
// the Telegram poller does (telegram/index.js): the clinic runs ONE
// `npm start`, and a second silent process is exactly the operational pain
// that design retired. The price is the same obligation — nothing in this
// file may ever take the server down. Every tick is wrapped; every failure
// is "skip this tick, note it, try again".

import { controlState } from '../control/state.js';
import { getDataDir } from '../control/config.js';
import { binotelCall } from './binotel.js';
import { readSettingsRow, getCredentials, recordPoll, noteCallSeen } from './settings.js';
// The SAME patient-by-phone matcher the CRM board and the Telegram bot use
// (it rides on crm-phone-match.js's digit normalisation). Never a second
// matcher: two implementations of "the same number" is how a patient found
// by the operator ends up not found by the call log — the exact failure
// telegram/documents.js documents for the bot.
import { findPatientsByPhone } from '../telegram/documents.js';
// CRM_CONFIG_V1 — «звонок становится карточкой». Wired into recordCall below
// rather than into the poll loop and the webhook separately, for the same
// reason recordCall itself is shared: two call sites would be two chances for
// one call to produce two leads — or, worse, none.
import { leadFromCall } from '../crm/lead-from-call.js';
// TELEPHONY_PROVIDERS_V1 — остальные провайдеры (onlinePBX) опрашиваются тем же
// тиком, каждый своим клиентом, и складываются в ТУ ЖЕ таблицу звонков тем же
// recordCall'ом: журнал, пациент по номеру и «звонок → заявка» одни на всех.
import { pbxHistory, normalizePbxCall } from './onlinepbx.js';
import { pbxOptions, recordProviderPoll, noteProviderCall, providerKind } from './providers.js';
import { recordingUrlOf } from './recording.js';   // CALL_RECORDING_V1
import { uzE164 } from '../../../public/js/admin/views/crm-phone-match.js';   // UZ_PHONE_V1

// Cursor overlap. Binotel's since-methods key on the call's startTime; a call
// that STARTED just before our last poll but was still ringing at poll time
// would fall between two exact-cursor windows forever. Two minutes of re-read
// costs a handful of ON CONFLICT no-ops and closes that gap.
const OVERLAP_SEC = 120;

// First-ever poll looks back one day: the admin who just switched the feature
// on should see today's calls appear immediately — a list that stays empty
// until the NEXT phone call reads as "not working".
const FIRST_WINDOW_SEC = 24 * 60 * 60;

// While disabled (or unlicensed) the loop breathes slowly instead of dying,
// so flipping the toggle needs no server restart; wakePolling() short-cuts
// even that wait the moment settings are saved.
const IDLE_RECHECK_MS = 30_000;

// First tick well after boot, for checkin.js's reason: the server must be
// listening and serving the front desk long before any vendor call fires.
const INITIAL_DELAY_MS = 15_000;

const isoFromUnix = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const unixFromIso = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };

// Binotel's stats methods answer callDetails as an OBJECT keyed by
// generalCallID. Only the values matter here, so an array-shaped answer is
// accepted too — defensiveness against the vendor, not a second contract.
export function callList(data) {
  const cd = data && data.callDetails;
  if (Array.isArray(cd)) return cd.filter((c) => c && typeof c === 'object');
  if (cd && typeof cd === 'object') return Object.values(cd).filter((c) => c && typeof c === 'object');
  return [];
}

// ONE implementation of "a Binotel call becomes a row", shared with
// webhooks.js on purpose: if poll and webhook each had their own, the two
// could disagree about field coercion or patient matching, and the same call
// would look different depending on which path won the insert race.
// UNIQUE(general_call_id) + DO NOTHING make that race harmless: first writer
// wins, the second changes nothing (both carry the same unified structure —
// which is also why the plan's "upsert" needs no UPDATE branch).
export function recordCall(db, d, source, provider = null) {
  if (!d || typeof d !== 'object') return false;
  const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  // TELEPHONY_PROVIDERS_V1 — строка либо сырая Binotel (generalCallID/startTime),
  // либо уже приведённая к словарю журнала (general_call_id/started_at) —
  // так приходят звонки onlinePBX через normalizePbxCall. Один INSERT на всех:
  // журнал, пациент по номеру и «звонок → заявка» не знают, чей это звонок.
  let row;
  if (d.general_call_id != null && d.started_at) {
    row = {
      general_call_id: String(d.general_call_id), started_at: String(d.started_at),
      call_type: n(d.call_type) ?? 0, external_number: d.external_number == null ? '' : String(d.external_number),
      internal_number: d.internal_number == null ? '' : String(d.internal_number),
      waitsec: n(d.waitsec), billsec: n(d.billsec), disposition: d.disposition == null ? '' : String(d.disposition),
      is_new_call: n(d.is_new_call), raw: d.raw == null ? d : d.raw,
    };
  } else {
    const id = d.generalCallID == null ? '' : String(d.generalCallID);
    const startUnix = Number(d.startTime);
    // No id or no start time = nothing we could ever de-duplicate or sort —
    // not a call this table can file. Skipped, not thrown: one malformed entry
    // must not cost the rest of the batch.
    if (!id || !Number.isFinite(startUnix) || startUnix <= 0) return false;
    row = {
      general_call_id: id, started_at: isoFromUnix(startUnix),
      call_type: n(d.callType) ?? 0, external_number: d.externalNumber == null ? '' : String(d.externalNumber),
      internal_number: d.internalNumber == null ? '' : String(d.internalNumber),
      waitsec: n(d.waitsec), billsec: n(d.billsec), disposition: d.disposition == null ? '' : String(d.disposition),
      is_new_call: n(d.isNewCall), raw: d,
    };
  }
  if (!row.general_call_id || !row.started_at) return false;

  // UZ_PHONE_V1 — номер приводится к «+998…» ОДИН раз, здесь, на входе. Дальше
  // его читают и журнал, и заявка, и поиск пациента: разные написания одного
  // номера в разных местах — это то же самое, что разные номера.
  row.external_number = uzE164(row.external_number);
  const externalNumber = row.external_number;
  // One phone number can be a whole family (telegram/documents.js's accepted
  // reality); a call row has one patient column, so take the top match —
  // findPatientsByPhone orders active cards first, which is the person most
  // likely to be calling.
  const matches = externalNumber ? findPatientsByPhone(db, externalNumber, 1) : [];
  const startedAt = row.started_at;

  // CALL_RECORDING_V1 — ЗАПИСЬ УЗНАЁТСЯ ПОЗЖЕ САМОГО ЗВОНКА. Станция отдаёт
  // ссылку не сразу: звонок попадает в историю раньше, чем дописывается файл.
  // Вставка у нас «первый записал — остальные молчат» (ON CONFLICT DO NOTHING),
  // и без этой дописки строка навсегда осталась бы без записи, даже когда та
  // появилась. Поэтому: если строка уже есть, записи у неё нет, а сейчас ссылка
  // пришла — дописываем. Существующую ссылку не трогаем никогда.
  const fillRecording = (url) => {
    if (!url) return;
    db.prepare(`UPDATE calls SET recording_url = @url
                 WHERE general_call_id = @id AND (recording_url IS NULL OR recording_url = '')`)
      .run({ url, id: row.general_call_id });
  };

  // CALL_RECORDING_V1 — адрес записи разбирается ОДИН раз, здесь: у каждой
  // телефонии поле зовётся по-своему, и держать этот список на экранах значило
  // бы завести его в трёх местах.
  const recordingUrl = recordingUrlOf(row.raw);

  const info = db.prepare(`INSERT INTO calls
      (general_call_id, started_at, call_type, external_number, internal_number,
       waitsec, billsec, disposition, is_new_call, patient_id, raw, source, provider, provider_id, recording_url)
    VALUES (@general_call_id, @started_at, @call_type, @external_number, @internal_number,
       @waitsec, @billsec, @disposition, @is_new_call, @patient_id, @raw, @source, @provider, @provider_id, @recording_url)
    ON CONFLICT(general_call_id) DO NOTHING`).run({
    ...row,
    recording_url: recordingUrl || null,
    raw: JSON.stringify(row.raw),
    patient_id: matches.length ? matches[0].id : null,
    source,
    provider: provider && provider.kind ? String(provider.kind) : 'binotel',
    provider_id: provider && provider.id ? Number(provider.id) : null,
  });
  // Дописка работает В ОБОИХ случаях: и когда строку только что завели (у
  // станции запись уже была), и когда она лежала с прошлого опроса без записи.
  fillRecording(recordingUrl);
  if (info.changes) {
    if (provider && provider.id) noteProviderCall(db, provider.id, startedAt);
    else noteCallSeen(db, startedAt);
    // CRM_CONFIG_V1 — only on a REAL insert, never on the ON CONFLICT no-op:
    // that is what makes poll-and-webhook double delivery produce one lead
    // instead of two, by exactly the constraint that already de-duplicates
    // the call itself.
    //
    // Wrapped, and deliberately not allowed to fail the call. The call row is
    // the RECORD; the lead is a convenience built on top of it. A broken
    // routing table must never cost the clinic the fact that the phone rang —
    // and on the webhook path a throw here would answer 500 to Binotel, which
    // then retries the same already-filed call seven times over 38 hours.
    try {
      leadFromCall(db, {
        id: info.lastInsertRowid,
        disposition: row.disposition,
        external_number: externalNumber,
        patient_id: matches.length ? matches[0].id : null,
        // CRM_DEDUP_SEARCH_TASKS_V1 — исходящий звонок заводит карточку только
        // номеру, у которого карточки нет вообще; входящий — как раньше.
        call_type: row.call_type,
        // …а звонок между добавочными (onlinePBX 'local') — никакой.
        internal: !!(d && d.internal),
      });
    } catch (e) {
      console.warn('[telephony] lead not created for call:', e && e.message);
    }
  }
  return info.changes > 0;
}

// The licensed-module gate — the same question the UI asks of licence_status.
// controlState is documented never to throw, but the poller backstops that
// promise anyway (checkin.js's "backstop a guarantee, don't just assume it"):
// a licensing bug must cost a skipped poll, never the tick loop.
function defaultHasModule(db) {
  try { return controlState(db, getDataDir()).has('callcenter'); } catch { return false; }
}

// Re-entrancy guard, checkin.js's TWO_OVERLAPPING_CHECKINS_V1 discipline: a
// Binotel answer slower than the poll interval must not let two overlapping
// ticks double-poll. Guarded in the OUTER function so an early bail-out can
// never touch the flag the in-flight run resets in its own finally.
let inFlight = false;

/** One poll attempt. Never throws, never rejects — exported for tests and wired to the timer below. */
export async function pollOnce(db, opts = {}) {
  if (inFlight) return;
  inFlight = true;
  try {
    await performPoll(db, opts);
  } catch (e) {
    // Backstop: every step inside already guards itself. Something unforeseen
    // still resolves to "try again next tick", never to a dead loop.
    console.warn('[telephony] poll failed, will retry next tick:', e && e.message);
  } finally {
    inFlight = false;
  }
}

async function performPoll(db, opts = {}) {
  const { hasModule = defaultHasModule } = opts;
  // Licence check every tick, not once at boot: a module granted at the next
  // check-in (or lapsing mid-day) must take effect without a restart. One
  // licence for the whole feature: Binotel and every other provider alike.
  if (!hasModule(db)) return;
  await pollBinotel(db, opts);
  await pollProviders(db, opts);
}

async function pollBinotel(db, { fetchImpl, timeoutMs, maxBytes } = {}) {
  const row = readSettingsRow(db);
  // Disabled, or the migration somehow hasn't run — not an error, just quiet.
  if (!row || !row.enabled) return;
  const { key, secret } = getCredentials(db);
  if (!key || !secret) return;   // saveSettings forbids this while enabled; belt for hand-edited rows

  // Binotel's cursor is over Binotel's OWN rows: another provider's fresher
  // call must not push this window past a Binotel call still in flight.
  const maxStarted = db.prepare("SELECT MAX(started_at) AS m FROM calls WHERE provider = 'binotel'").get().m;
  const maxUnix = maxStarted ? unixFromIso(maxStarted) : null;
  const since = maxUnix ? maxUnix - OVERLAP_SEC : Math.floor(Date.now() / 1000) - FIRST_WINDOW_SEC;

  // Incoming and outgoing are two vendor methods over one cursor; a failure
  // in one direction must not silence the other, so both are always tried
  // and the tick reports the LAST failure it saw.
  let failure = '';
  for (const method of ['stats/all-incoming-calls-since', 'stats/all-outgoing-calls-since']) {
    const r = await binotelCall(method, { timestamp: since }, { key, secret, fetchImpl, timeoutMs, maxBytes });
    if (!r.ok) { failure = r.reason; continue; }
    for (const call of callList(r.data)) {
      try {
        recordCall(db, call, 'poll');
      } catch (e) {
        // One unfiled call (an FK surprise, a constraint) loses one row, not
        // the batch and not the loop.
        console.warn('[telephony] call not recorded:', e && e.message);
      }
    }
  }
  recordPoll(db, { ok: !failure, error: failure });
}

// TELEPHONY_PROVIDERS_V1 — каждый включённый провайдер опрашивается своим
// курсором: MAX(started_at) ЕГО звонков минус перекрытие. Отказ одного
// провайдера — его last_error; соседям и Binotel он не мешает.
async function pollProviders(db, { fetchImpl, timeoutMs, maxBytes, pbxHistoryImpl = pbxHistory } = {}) {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM telephony_providers WHERE enabled = 1 ORDER BY id').all(); } catch { return; }
  for (const p of rows) {
    // MOIZVONKI_V1 — вид берётся из vendor, а не из kind: в kind у ВСЕХ строк
    // стоит 'onlinepbx' из-за старого CHECK (миграция 135). По kind опрос
    // полез бы в onlinePBX за историей «Моих Звонков».
    if (providerKind(p) !== 'onlinepbx') continue;
    try {
      const o = pbxOptions(db, p, { fetchImpl, timeoutMs, maxBytes });
      if (!o.domain || (!o.authKey && !o.creds)) { recordProviderPoll(db, p.id, { ok: false, error: 'bad_credentials' }); continue; }
      const maxStarted = db.prepare('SELECT MAX(started_at) AS m FROM calls WHERE provider_id = ?').get(p.id).m;
      const maxUnix = maxStarted ? unixFromIso(maxStarted) : null;
      const since = maxUnix ? maxUnix - OVERLAP_SEC : Math.floor(Date.now() / 1000) - FIRST_WINDOW_SEC;
      const r = await pbxHistoryImpl(o.domain, since, o);
      if (!r.ok) { recordProviderPoll(db, p.id, { ok: false, error: r.reason }); continue; }
      for (const c of (Array.isArray(r.data) ? r.data : [])) {
        const norm = normalizePbxCall(c);
        if (!norm) continue;
        try { recordCall(db, norm, 'poll', { id: p.id, kind: providerKind(p) }); }
        catch (e) { console.warn('[telephony] onlinepbx call not recorded:', e && e.message); }
      }
      recordProviderPoll(db, p.id, { ok: true });
    } catch (e) {
      // One provider's surprise costs that provider's tick, never the loop.
      console.warn('[telephony] provider poll failed:', p.id, e && e.message);
      try { recordProviderPoll(db, p.id, { ok: false, error: 'server_error' }); } catch {}
    }
  }
}

// --------------------------------------------------------------------------
// Scheduling — the shape of scheduleCheckin (unref'd timers, wrapped ticks)
// with telegram/index.js's wake-on-save so a settings change acts in seconds.
// --------------------------------------------------------------------------

let timer = null;
let stopped = false;
let armFn = null;

// Each tick re-reads the interval so a changed setting takes effect on the
// very next arm, without a restart. Exported for tests.
export function nextDelayMs(db) {
  // TELEPHONY_PROVIDERS_V1 — шаг цикла — самый частый из включённых: Binotel
  // и провайдеры. Ни одного включённого — редкое дыхание, как раньше.
  let providerMs = null;
  try {
    const r = db.prepare('SELECT MIN(poll_interval_sec) AS m FROM telephony_providers WHERE enabled = 1').get();
    if (r && r.m) providerMs = Math.max(10, Number(r.m)) * 1000;
  } catch { providerMs = null; }
  let row = null;
  try { row = readSettingsRow(db); } catch { row = null; }
  let binotelMs = null;
  if (row && row.enabled) {
    const sec = Number(row.poll_interval_sec);
    binotelMs = (Number.isFinite(sec) && sec >= 10 ? sec : 30) * 1000;
  }
  if (binotelMs == null && providerMs == null) return IDLE_RECHECK_MS;
  if (binotelMs == null) return providerMs;
  if (providerMs == null) return binotelMs;
  return Math.min(binotelMs, providerMs);
}

// Called from rpc/telephony.js right after a save, so «включить» starts
// polling in seconds rather than at the end of the previous interval —
// wakeTelegramBot's reasoning, applied here.
export function wakePolling() {
  if (armFn) armFn(0);
}

/**
 * Wires the poller into the running process; returns {stop}. Only ever one
 * pending timer: arm() clears the previous one, so a wake during an in-flight
 * tick cannot fork the chain (the re-entrancy guard in pollOnce absorbs the
 * extra fire). unref() on every timer — a clinic shutting down must not wait
 * on a telephony timer with nothing urgent to do.
 */
export function schedulePolling(db, opts = {}) {
  const { initialDelayMs = INITIAL_DELAY_MS, ...tickOpts } = opts;
  stopped = false;

  const arm = (ms) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    if (timer.unref) timer.unref();
  };
  const tick = () => {
    // pollOnce never rejects, but a timer callback has no caller to hand a
    // rejection to anyway — same wrapping scheduleCheckin gives runCheckin.
    pollOnce(db, tickOpts)
      .catch((e) => console.warn('[telephony] scheduled poll failed:', e && e.message))
      .finally(() => arm(nextDelayMs(db)));
  };
  armFn = arm;
  arm(initialDelayMs);
  console.log('[telephony] poller scheduled');
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      armFn = null;
    },
  };
}
