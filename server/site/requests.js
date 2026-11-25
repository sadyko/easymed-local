// WEBSITE_V1 — приём заявки. Слаги из формы разрешаются В опубликованные
// id здесь, на сервере; клиентские id не принимаются вообще.
import crypto from 'node:crypto';
import { serviceBySlug, doctorBySlug } from './content.js';
import { bumpDailyStat } from './analytics.js'; // WEBSITE_V1 (задача W3-2) — свёртка 'requests'
import { phoneKey, uzE164 } from '../../public/js/admin/views/crm-phone-match.js'; // тот же приём, что в db/phone-key.js
import { firstStageKey } from '../services/crm/contact-window.js';
import { patientIdForPhone } from '../services/crm/patient-by-phone.js';
import { notifyNewRequest } from './notify.js'; // WEBSITE_V1 (задача W3-5) — уведомление в Telegram

const err = (status, code, message) => Object.assign(new Error(message), { status, code });

export function handleRequest(db, body, meta) {
  const type = ['appointment', 'contact', 'callback'].includes(body.type) ? body.type : null;
  if (!type) throw err(400, 'bad_request', 'Неизвестный тип заявки.');
  // Формы без JS (static-pages.js, задача 9) шлют поле "name" — единого имени
  // с JSON-контрактом задачи 10 (full_name) у них никогда не было и трогать
  // их разметку эта задача не должна; поэтому full_name принимает оба имени.
  const fullName = String(body.full_name || body.name || '').trim().slice(0, 200);
  if (!fullName) throw err(400, 'bad_request', 'Name is required.');
  const phoneRaw = String(body.phone || '').trim().slice(0, 32);
  if (phoneKey(phoneRaw).length < 7) throw err(400, 'bad_request', 'Номер телефона указан неверно.');
  const message = String(body.message || '').trim().slice(0, 2000);
  const email = String(body.email || '').trim().slice(0, 200);
  const day = new Date().toISOString().slice(0, 10);
  // Клиентский min=today на <input type=date> — чисто косметика: ничто не
  // мешает отправить прошлую дату напрямую через API. Прошлая дата в
  // scheduled_date немедленно попадает под автоматику воронки CRM (сегодня
  // прошёл без визита -> "не пришёл", см. миграцию 047) — заявка ещё не
  // существовала на ту дату, поэтому такое значение отбрасываем молча
  // (NULL), а не 400: дата необязательна, ломать всю заявку из-за неё нет
  // смысла. Верхняя граница (+6 месяцев) — та же защита от абсурда с другой
  // стороны, без привязки к реальному горизонту записи клиники.
  const maxDateObj = new Date();
  maxDateObj.setUTCMonth(maxDateObj.getUTCMonth() + 6);
  const maxDay = maxDateObj.toISOString().slice(0, 10);
  let date = /^\d{4}-\d{2}-\d{2}$/.test(body.preferred_date || '') ? body.preferred_date : null;
  if (date && (date < day || date > maxDay)) date = null;
  const time = ['morning', 'afternoon', 'evening'].includes(body.preferred_time) ? body.preferred_time : '';
  const lang = ['uz', 'ru', 'en'].includes(body.lang) ? body.lang : '';
  const svc = body.service ? serviceBySlug(db, String(body.service)) : undefined;
  const doc = body.doctor ? doctorBySlug(db, String(body.doctor)) : undefined;
  // Спам-ловушки: боту отвечаем 200, заявку топим в spam и не трогаем CRM.
  const isSpam = String(body.website || '') !== '' ||
    !(Number(body.ts) > 0 && Date.now() - Number(body.ts) >= 3000);
  const ipHash = crypto.createHash('sha256').update(day + '|' + (meta.ip || '')).digest('hex').slice(0, 24);
  // W3-2 — связь с сессией аналитики: кука wsid — 24-символьный hex
  // (см. analytics.js::recordBeacon), как и у самого website_requests.session_id
  // (миграция 087). Всё, что не совпадает с этим форматом — не наша кука или
  // подделка — заявка сохраняется, просто без связи (NULL — штатный случай).
  const sessionId = typeof meta?.wsid === 'string' && /^[0-9a-f]{24}$/.test(meta.wsid) ? meta.wsid : null;

  const tx = db.transaction(() => {
    let crmId = null;
    if (type === 'appointment' && !isSpam) {
      // WEBSITE_V1 (Easy-Med) — карточка так же, как у Telegram-ссылок и Meta: источник
      // в source И в sources (по sources строят фильтры и отчёты), первая стадия
      // воронки этой клиники, номер в +998…, пациент по номеру правилом звонка.
      const SOURCE_KEY = 'website';
      const phoneNorm = uzE164(phoneRaw) || phoneRaw;
      const info = db.prepare(`INSERT INTO crm_requests (full_name, phone, source, sources, status, note, patient_id, service_id, scheduled_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fullName, phoneNorm.slice(0, 40), SOURCE_KEY, JSON.stringify([SOURCE_KEY]),
        firstStageKey(db) || 'in_process', (message ? message + ' ' : '') + '[сайт' + (lang ? ', ' + lang : '') + ']',
        patientIdForPhone(db, phoneNorm), svc ? svc.service_id : null, date);
      crmId = info.lastInsertRowid;
      db.prepare(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, doctor_id, note)
        VALUES (?,?,?, 'pending', ?, ?)`).run(crmId, svc ? svc.service_id : null, date,
        doc ? doc.user_id : null, time || null);
    }
    const wr = db.prepare(`INSERT INTO website_requests
      (type, status, full_name, phone, email, message, service_id, doctor_id,
       preferred_date, preferred_time, locale, page, crm_request_id, ip_hash, user_agent, session_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      type, isSpam ? 'spam' : 'new', fullName, phoneRaw, email, message,
      svc ? svc.service_id : null, doc ? doc.user_id : null,
      date, time, lang, String(body.page || '').slice(0, 200), crmId,
      ipHash, String(meta.ua || '').slice(0, 300), sessionId);
    // Спам не считается в отчёте посещаемости/заявок (W3-3 читает 'requests'
    // как «сколько реальных заявок пришло»).
    if (!isSpam) bumpDailyStat(db, day, 'requests', '');
    return { id: wr.lastInsertRowid };
  });
  const out = tx();
  // WEBSITE_V1 (задача W3-5) — уведомление в Telegram ВНЕ транзакции и не
  // блокируя ответ пациенту: setImmediate откладывает отправку на следующий
  // тик, а .catch() — просто щит на случай, если notify.js вообще не
  // вернёт промис (сама notifyNewRequest уже глотает все свои ошибки).
  if (!isSpam) {
    setImmediate(() => {
      notifyNewRequest(db, { id: out.id, type, full_name: fullName, phone: phoneRaw, preferred_date: date }).catch(() => {});
    });
  }
  return out;
}
