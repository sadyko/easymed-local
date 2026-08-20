// TELEGRAM_BOT_V1 — какие документы есть у пациента и как собрать каждый.
//
// Пациент опознаётся ТОЛЬКО по номеру телефона, который подтвердил сам
// Telegram, и получает документы ВСЕХ пациентов, записанных на этот номер
// (решение принято осознанно: один номер на семью — обычное дело в клинике).
// Поэтому связка хранит телефон, а не patient_id: пациенты подбираются заново
// на каждый запрос, и новый член семьи попадает в выдачу без синхронизации.
//
// Сопоставление номеров делает crm-phone-match.js — ТОТ ЖЕ модуль, которым
// call-центр ищет пациента по телефону. Иначе два места начали бы считать
// «тот же номер» по-разному, и пациент, найденный оператором, был бы не найден
// ботом (или наоборот, что хуже).

import { digitsOf, uzLocalDigits, phoneLikePattern, MIN_PHONE_DIGITS } from '../../../public/js/admin/views/crm-phone-match.js';
// LAB_PANEL_IS_TRUTH_V1 — бот собирает бланк ТЕМИ ЖЕ правилами, что экранные
// печати: показатели берутся из панели услуги (по имени, остальные по
// порядку), нормы и фазы — из справочника на момент отправки. Раньше бот
// печатал только то, что было сохранено в строке результата, и нормы,
// заведённые после сдачи анализа, до пациента не доходили.
import { matchResultsToAnalytes, labRefText, namedRangeCell, labFlagCell, labPosFor, ageYears,
         labAccession, labIssueDates, labMaxDate }
    from '../../../public/js/admin/views/lab-doc.js';

export { digitsOf };

// Пациенты, записанные на этот номер.
//
// Сравнение по цифрам: в базе телефон лежит форматированным («+998 90 961 00 04»),
// а Telegram присылает «998909610004». Короткие огрызки не ищем — иначе
// «совпадёт» половина картотеки.
//
// Отбор двухступенчатый, как в CRM, и это не украшение: в этой базе почти
// 70 000 пациентов с телефонами. Тянуть их всех в JS на каждое сообщение бота
// нельзя, поэтому грубый отсев делает SQLite по LIKE-шаблону `%9%0%9%…`
// (разделители между цифрами он пропускает), а точную проверку «цифры идут
// ПОДРЯД» — уже JS на десятке оставшихся строк.
export function findPatientsByPhone(db, rawPhone, limit = 20) {
  const d = digitsOf(rawPhone);
  if (d.length < MIN_PHONE_DIGITS) return [];
  const local = uzLocalDigits(d);

  // Архивные карточки (active = 0) НЕ отсеиваются, и это осознанно: снятие
  // отметки «активен» — административное решение о том, лечится ли человек
  // сейчас, а не о том, чьи это результаты. Пациент с закрытой карточкой
  // всё равно вправе получить свой прошлый анализ. Активные идут первыми.
  const rows = db.prepare(
    `SELECT id, full_name, mrn, phone, date_of_birth, gender, active
       FROM patients
      WHERE phone <> '' AND (phone LIKE ? OR phone LIKE ?)
      ORDER BY (active = 1) DESC, id DESC
      LIMIT 200`).all(phoneLikePattern(local), phoneLikePattern(d));

  return rows.filter((r) => {
    const sf = digitsOf(r.phone);
    return sf && (sf.includes(local) || sf.includes(d));
  }).slice(0, limit);
}


// Положение результата на шкале «норма» — для индикаторной полоски в бланке.

const ruDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString('ru-RU');
};

// Возраст/пол/номер карты в шапку бланка.
function patientHead(p) {
  return {
    patientName: p.full_name || '',
    mrn: p.mrn || String(p.id),
    dob: p.date_of_birth ? ruDate(p.date_of_birth) : '',
    sex: p.gender === 'male' ? 'Мужской' : p.gender === 'female' ? 'Женский' : '',
  };
}

// ---------------------------------------------------------------------------
// Каталог документов пациента
// ---------------------------------------------------------------------------
//
// `kinds` — разрешённые администратором виды (telegram_settings.doc_kinds).
// Каждая запись несёт `ref` вида 'lab:25' — он же ложится в telegram_deliveries
// и служит ключом «этот документ уже отправляли».
export function listDocuments(db, patientId, kinds = ['lab', 'conclusion', 'diag', 'invoice', 'file']) {
  const allow = new Set(kinds);
  const out = [];

  // Анализы: у лаборатории НЕТ строки в visit_documents (результат выводится из
  // lab_results — см. комментарий в laboratory.js), поэтому собираем сами.
  // Единица выдачи — одна лабораторная услуга: это то, что пациент сдавал.
  if (allow.has('lab')) {
    const rows = db.prepare(
      `SELECT vs.id AS vsid, MAX(lr.verified_at) AS ready_at, COUNT(*) AS n,
              COALESCE(s.name,'Лабораторное исследование') AS service_name, v.visit_date
         FROM lab_results lr
         JOIN visit_services vs ON vs.id = lr.visit_service_id
         JOIN visits v          ON v.id  = vs.visit_id
         LEFT JOIN services s   ON s.id  = vs.service_id
        WHERE v.patient_id = ? AND lr.verified_at IS NOT NULL
        GROUP BY vs.id
        ORDER BY ready_at DESC`).all(patientId);
    for (const r of rows) {
      out.push({ kind: 'lab', ref: `lab:${r.vsid}`, title: r.service_name,
        date: r.ready_at || r.visit_date, count: r.n });
    }
  }

  // Заключения и протоколы: подписанный снимок уже лежит в visit_documents.body
  // — тот же JSON, которым рисует «Архив документов».
  const docTypes = [];
  if (allow.has('conclusion')) docTypes.push('protocol', 'conclusion');
  if (allow.has('diag')) docTypes.push('diag');
  if (docTypes.length) {
    const q = docTypes.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, title, doc_type, created_at FROM visit_documents
        WHERE patient_id = ? AND body IS NOT NULL AND body <> '' AND doc_type IN (${q})
        ORDER BY created_at DESC`).all(patientId, ...docTypes);
    for (const r of rows) {
      out.push({ kind: r.doc_type === 'diag' ? 'diag' : 'conclusion',
        ref: `doc:${r.id}`, title: r.title || 'Заключение', date: r.created_at });
    }
  }

  // Загруженные файлы отдаются как есть — их не надо рендерить.
  if (allow.has('file')) {
    const rows = db.prepare(
      `SELECT id, title, file_name, created_at FROM visit_documents
        WHERE patient_id = ? AND file_path IS NOT NULL AND file_path <> ''
        ORDER BY created_at DESC`).all(patientId);
    for (const r of rows) {
      out.push({ kind: 'file', ref: `file:${r.id}`,
        title: r.title || r.file_name || 'Файл', date: r.created_at });
    }
  }

  // Счета — только по запросу: автоматическая рассылка счетов отключена в
  // push-конвейере, здесь они появляются, потому что пациент сам открыл раздел.
  if (allow.has('invoice')) {
    const rows = db.prepare(
      `SELECT id, invoice_number, total_amount, status, created_at FROM invoices
        WHERE patient_id = ? ORDER BY created_at DESC LIMIT 20`).all(patientId);
    for (const r of rows) {
      out.push({ kind: 'invoice', ref: `invoice:${r.id}`,
        title: 'Счёт ' + (r.invoice_number || '№' + r.id), date: r.created_at });
    }
  }

  out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return out;
}

// ---------------------------------------------------------------------------
// Сборка одного документа
// ---------------------------------------------------------------------------
//
// Возвращает либо {mode:'pdf', type, data, title, idLine} — тогда render.js
// собирает PDF тем же кодом, что и кнопка «Печать», либо
// {mode:'file', path, name} для загруженного файла, который надо просто
// переслать.
export function buildDocument(db, ref, patientId) {
  const [kind, idRaw] = String(ref || '').split(':');
  const id = Number(idRaw);
  if (!kind || !Number.isInteger(id) || id <= 0) return null;

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) return null;

  if (kind === 'lab') return buildLab(db, id, patient);
  if (kind === 'doc') return buildSigned(db, id, patient);
  if (kind === 'file') return buildFile(db, id, patient);
  if (kind === 'invoice') return buildInvoice(db, id, patient);
  return null;
}

function buildLab(db, vsid, patient) {
  // Принадлежность услуги пациенту проверяем ЗАПРОСОМ, а не доверяем ссылке:
  // ref приходит из callback-кнопки Telegram, то есть снаружи.
  const head = db.prepare(
    `SELECT vs.id, vs.service_id, vs.sample_collected_at, COALESCE(s.name,'Лабораторное исследование') AS service_name,
            s.ref_low AS s_lo, s.ref_high AS s_hi, s.ref_text AS s_tx,
            v.visit_date, v.patient_id
       FROM visit_services vs
       JOIN visits v        ON v.id = vs.visit_id
       LEFT JOIN services s ON s.id = vs.service_id
      WHERE vs.id = ? AND v.patient_id = ?`).get(vsid, patient.id);
  if (!head) return null;

  const rows = db.prepare(
    `SELECT * FROM lab_results WHERE visit_service_id = ? AND verified_at IS NOT NULL
      ORDER BY id`).all(vsid);
  if (!rows.length) return null;

  // Показатели панели этой услуги, в порядке sort_order.
  const panelList = head.service_id == null ? [] : db.prepare(
    `SELECT a.* FROM lab_panel_analytes a
       JOIN lab_panels p ON p.id = a.panel_id
      WHERE p.service_id = ? ORDER BY a.sort_order`).all(head.service_id);
  const byOrder = matchResultsToAnalytes(panelList, rows.map((r) => r.parameter));
  const gender = String(patient.gender || '').toLowerCase();
  const age = ageYears(patient.date_of_birth);
  const svcFallback = (head.s_lo != null || head.s_hi != null || head.s_tx)
    ? { ref_low: head.s_lo, ref_high: head.s_hi, ref_text: head.s_tx } : null;

  const tests = rows.map((r, ri) => {
    const analyte = byOrder[ri] || svcFallback;
    const named = namedRangeCell(analyte, gender, age);
    const manyRanges = named.count >= 2;
    return {
      name: (r.parameter || '').trim() || '—',
      code: '',
      value: r.value == null ? '' : String(r.value),
      unit: r.unit || (analyte && analyte.unit) || '',
      ref: labRefText(analyte, named.marked ? '' : gender, r.reference_range, named.texts),
      // Флаг только у числа; при двух и более диапазонах не ставится вовсе —
      // фазу цикла решает врач (те же правила, что на экранных бланках).
      flag: manyRanges ? '' : labFlagCell(r),
      pos: manyRanges ? null : labPosFor(r),
    };
  });

  const verifier = db.prepare(
    `SELECT u.full_name FROM lab_results lr LEFT JOIN users u ON u.id = lr.verified_by
      WHERE lr.visit_service_id = ? AND lr.verified_by IS NOT NULL LIMIT 1`).get(vsid);

  // LAB_SHEET_HEAD_V1 — шапка та же, что в лаборатории и карте: «Заявка
  // LAB-xxxxxx» (раньше бот печатал голый номер без префикса), «Приём» —
  // забор или день визита, «Выдан» — проверка или последний ввод. Пациент
  // в Telegram получает ТОТ ЖЕ документ, что и на стойке.
  const { dateIn, dateOut } = labIssueDates({
    visitDate: head.visit_date,
    collectedAt: head.sample_collected_at,
    verifiedAt: labMaxDate(rows, 'verified_at'),
    lastEnteredAt: labMaxDate(rows, 'entered_at'),
  });
  return {
    mode: 'pdf', type: 'lab',
    title: head.service_name,
    idLine: labAccession(vsid),
    data: {
      ...patientHead(patient),
      requestNo: labAccession(vsid),
      dateIn,
      dateOut,
      labChief: (verifier && verifier.full_name) || '',
      labChiefSpec: 'Врач клинической лабораторной диагностики',
      groups: [{ title: head.service_name + ' · № ' + labAccession(vsid), tests }],
    },
  };
}

function buildSigned(db, id, patient) {
  const row = db.prepare(
    'SELECT * FROM visit_documents WHERE id = ? AND patient_id = ?').get(id, patient.id);
  if (!row || !row.body) return null;

  // body — это JSON-снимок, который положил service-workspace при подписании.
  // Ровно он же скармливается рендереру в «Архиве документов».
  let data;
  try { data = typeof row.body === 'string' ? JSON.parse(row.body) : row.body; }
  catch { return null; }
  if (!data || typeof data !== 'object') return null;

  // Режим редактора не должен попасть в выдачу пациенту: он дорисовывает
  // кнопки «+ Добавить раздел» прямо в бланк.
  delete data.__editor;

  return {
    mode: 'pdf',
    type: row.doc_type === 'diag' ? 'diag' : 'conclusion',
    title: row.title || 'Заключение',
    idLine: 'DOC-' + String(id).padStart(6, '0'),
    data: { ...patientHead(patient), ...data },
  };
}

function buildFile(db, id, patient) {
  const row = db.prepare(
    'SELECT * FROM visit_documents WHERE id = ? AND patient_id = ?').get(id, patient.id);
  if (!row || !row.file_path) return null;
  return {
    mode: 'file',
    path: row.file_path,
    name: row.file_name || ('document-' + id),
    title: row.title || row.file_name || 'Файл',
  };
}

function buildInvoice(db, id, patient) {
  const inv = db.prepare(
    'SELECT * FROM invoices WHERE id = ? AND patient_id = ?').get(id, patient.id);
  if (!inv) return null;
  const items = db.prepare(
    `SELECT ii.quantity, ii.unit_price, ii.total, COALESCE(s.name, ii.description, 'Услуга') AS name
       FROM invoice_items ii LEFT JOIN services s ON s.id = ii.service_id
      WHERE ii.invoice_id = ?`).all(id);

  return {
    mode: 'pdf', type: 'invoice',
    title: 'Счёт',
    idLine: inv.invoice_number || String(id),
    data: {
      ...patientHead(patient),
      docNo: inv.invoice_number || String(id),
      date: ruDate(inv.created_at),
      items: items.map((i) => ({ name: i.name, qty: i.quantity || 1, price: i.unit_price || 0 })),
      subtotal: inv.subtotal != null ? inv.subtotal : inv.total_amount,
      total: inv.total_amount || 0,
    },
  };
}
