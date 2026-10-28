// META_LEADS_V1_POLL (разбор и подшивка) — из сырой заявки Graph API делается
// карточка CRM.
//
// Путь в CRM — тот же, что у заявки партнёра из API (api/bookings.js
// createCard): прямой INSERT в crm_requests с именем, телефоном в формате
// клиники (uzE164), источником И списком источников (sources пишется вручную:
// серверный INSERT минует crmSourcesWrite из routes/db.js), первой открытой
// колонкой воронки и комментарием. Комментарий несёт всё, что человек
// написал в форме, и откуда он пришёл (форма, кампания, объявление): доска
// показывает его строкой на карточке и целиком в окне правки.
//
// Повторы — два разных вопроса:
//   * та же заявка Meta (leadgen_id) второй раз — повтор окна времени или сбой
//     на полпути: журнал meta_leads держит leadgen_id уникальным, вторая
//     карточка невозможна по построению;
//   * тот же ЧЕЛОВЕК (телефон) — правило окна повторного обращения CRM, как у
//     входящего звонка (crm/lead-from-call.js): открытая карточка с этим
//     телефоном получает ответы формы в комментарий и источник «Meta» в
//     список источников вместо второй карточки; карточку, которую пора
//     вернуть в работу, — возвращаем; всё остальное (нет карточек, закрыта
//     давно) — новая карточка. Единственное отличие от звонка: «закрыта только
//     что» для звонка значит «ничего не делать», а для заполненной формы —
//     новая карточка: человек сам написал заявку, терять её молча хуже, чем
//     показать регистратуре вторую (доска подсветит дубликат по телефону).

import { uzE164 } from '../../../public/js/admin/views/crm-phone-match.js';
import { contactDecision, firstStageKey, reopenLead } from '../crm/contact-window.js';
import { leadsForPhone } from '../crm/lead-from-call.js';
import { patientIdForPhone } from '../crm/patient-by-phone.js';   // FIX_318_V1 (L3) — пациент по номеру, правилом звонка

export const META_SOURCE_KEY = 'meta_ads';
export const META_SOURCE_LABEL = 'Meta (Facebook / Instagram)';

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

// Стандартные поля формы Meta, которые идут в свои колонки, а не в ответы.
const NAME_FIELDS = new Set(['full_name', 'first_name', 'last_name']);
const PHONE_FIELDS = new Set(['phone_number', 'phone', 'work_phone_number']);
const EMAIL_FIELDS = new Set(['email', 'work_email']);

const str = (v) => (v == null ? '' : String(v)).trim();
const valuesOf = (f) => (Array.isArray(f && f.values) ? f.values : (f && f.values != null ? [f.values] : [])).map(str).filter(Boolean);

/** «какая_услуга_вас_интересует?» → «Какая услуга вас интересует?» */
export function humanizeField(name) {
  const s = str(name).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** Сырая заявка Graph (/{form}/leads) → наш плоский вид. Никогда не бросает на кривом вводе. */
export function parseLead(raw, { formName = '' } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const fields = Array.isArray(r.field_data) ? r.field_data.filter((f) => f && typeof f === 'object') : [];
  let fullName = '', first = '', last = '', phone = '', email = '';
  const answers = [];
  for (const f of fields) {
    const name = str(f.name).toLowerCase();
    const vals = valuesOf(f);
    const value = vals.join(', ');
    if (name === 'full_name') { fullName = fullName || value; continue; }
    if (name === 'first_name') { first = first || value; continue; }
    if (name === 'last_name') { last = last || value; continue; }
    if (PHONE_FIELDS.has(name)) { phone = phone || value; continue; }
    if (EMAIL_FIELDS.has(name)) { email = email || value; continue; }
    if (!value) continue;
    answers.push({ name: humanizeField(f.name), value });
  }
  const phoneNorm = phone ? (uzE164(phone) || phone) : '';
  const name = fullName || [first, last].filter(Boolean).join(' ') || email || phoneNorm || 'Заявка Meta';
  return {
    leadgen_id: str(r.id),
    created_time: str(r.created_time),
    form_id: str(r.form_id),
    form_name: str(formName),
    ad_id: str(r.ad_id), ad_name: str(r.ad_name),
    campaign_id: str(r.campaign_id), campaign_name: str(r.campaign_name),
    platform: str(r.platform),
    full_name: name.slice(0, 200),
    phone: phoneNorm.slice(0, 40),
    email: email.slice(0, 200),
    answers,
    field_data: fields,
  };
}

const PLATFORM = { ig: 'Instagram', fb: 'Facebook' };

/** Дата Meta («2026-10-16T09:05:00+0000») — в местное время сервера клиники, как date(...,'localtime') в базе. */
function fmtLocal(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Комментарий карточки: откуда заявка и что человек написал — построчно. */
export function noteFor(lead) {
  const l = lead || {};
  const lines = [];
  const when = fmtLocal(l.created_time);
  lines.push(`Заявка из рекламы Meta (${PLATFORM[l.platform] || 'Meta'})` + (when ? ` · ${when}` : ''));
  const origin = [];
  if (l.form_name) origin.push(`Форма: «${l.form_name}»`);
  if (l.campaign_name) origin.push(`Кампания: «${l.campaign_name}»`);
  if (l.ad_name) origin.push(`Объявление: «${l.ad_name}»`);
  if (origin.length) lines.push(origin.join(' · '));
  if (l.email) lines.push(`E-mail: ${l.email}`);
  for (const a of l.answers || []) lines.push(`${a.name}: ${a.value}`);
  return lines.join('\n');
}

/** Источник «Meta» в словаре источников CRM: один раз; выключенный — включается обратно. */
export function ensureMetaSource(db) {
  const cur = db.prepare('SELECT is_active FROM crm_sources WHERE key = ?').get(META_SOURCE_KEY);
  if (!cur) {
    db.prepare(`INSERT INTO crm_sources (key, label, position, is_active)
                VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM crm_sources), 1)`).run(META_SOURCE_KEY, META_SOURCE_LABEL);
  } else if (!cur.is_active) {
    db.prepare('UPDATE crm_sources SET is_active = 1 WHERE key = ?').run(META_SOURCE_KEY);
  }
  return META_SOURCE_KEY;
}

function appendToCard(db, id, note) {
  const row = db.prepare('SELECT note, sources, source FROM crm_requests WHERE id = ?').get(id);
  if (!row) return false;
  let sources = [];
  try { const arr = JSON.parse(row.sources || '[]'); sources = Array.isArray(arr) ? arr.map(String) : []; } catch { sources = []; }
  if (!sources.length && row.source) sources = [String(row.source)];
  if (!sources.includes(META_SOURCE_KEY)) sources.push(META_SOURCE_KEY);
  const merged = row.note ? row.note + '\n\n' + note : note;
  db.prepare(`UPDATE crm_requests SET note = @note, sources = @sources, updated_at = ${NOW_SQL} WHERE id = @id`)
    .run({ id, note: merged, sources: JSON.stringify(sources) });
  return true;
}

function insertJournal(db, lead, { status, crmId = null, error = '' }) {
  db.prepare(`INSERT INTO meta_leads (leadgen_id, form_id, form_name, ad_id, ad_name, campaign_id, campaign_name, platform,
                created_time, field_data_json, full_name, phone, email, crm_request_id, status, error)
              VALUES (@leadgen_id, @form_id, @form_name, @ad_id, @ad_name, @campaign_id, @campaign_name, @platform,
                @created_time, @field_data_json, @full_name, @phone, @email, @crm_request_id, @status, @error)`).run({
    leadgen_id: lead.leadgen_id, form_id: lead.form_id || '', form_name: lead.form_name || '',
    ad_id: lead.ad_id || '', ad_name: lead.ad_name || '', campaign_id: lead.campaign_id || '', campaign_name: lead.campaign_name || '',
    platform: lead.platform || '', created_time: lead.created_time || '',
    field_data_json: JSON.stringify(Array.isArray(lead.field_data) ? lead.field_data : []),
    full_name: lead.full_name || '', phone: lead.phone || '', email: lead.email || '',
    crm_request_id: crmId, status, error: String(error || '').slice(0, 500),
  });
}

/**
 * Подшить разобранную заявку: журнал + CRM, одной транзакцией.
 * Возвращает { status: 'created' | 'merged' | 'duplicate', crm_request_id }.
 */
export function fileLead(db, lead) {
  if (!lead || !lead.leadgen_id) throw new Error('У заявки Meta нет номера (leadgen_id).');
  return db.transaction(() => {
    const dup = db.prepare('SELECT crm_request_id FROM meta_leads WHERE leadgen_id = ?').get(lead.leadgen_id);
    if (dup) return { status: 'duplicate', crm_request_id: dup.crm_request_id };
    ensureMetaSource(db);
    const note = noteFor(lead);
    let decision = { action: 'new', lead: null };
    if (lead.phone) decision = contactDecision(db, leadsForPhone(db, lead.phone));
    if ((decision.action === 'same' || decision.action === 'reopen') && decision.lead) {
      if (decision.action === 'reopen') reopenLead(db, decision.lead.id);
      appendToCard(db, decision.lead.id, note);
      insertJournal(db, lead, { status: 'merged', crmId: decision.lead.id });
      return { status: 'merged', crm_request_id: decision.lead.id };
    }
    // FIX_318_V1 (L3) — новая карточка находит пациента по номеру тем же
    // правилом, что карточка звонка (crm/patient-by-phone.js).
    const crmId = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, sources, status, note, patient_id)
                                     VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(lead.full_name || 'Заявка Meta', lead.phone || '', META_SOURCE_KEY, JSON.stringify([META_SOURCE_KEY]),
        firstStageKey(db) || 'in_process', note, patientIdForPhone(db, lead.phone)).lastInsertRowid);
    insertJournal(db, lead, { status: 'created', crmId });
    return { status: 'created', crm_request_id: crmId };
  })();
}

/** Журнал: заявка, которую не удалось подшить (ошибка в тексте) — видна на экране, не повторяется опросом. */
export function recordLeadError(db, lead, message) {
  try { insertJournal(db, lead, { status: 'error', error: message }); } catch { /* повтор leadgen_id — уже записана */ }
}
