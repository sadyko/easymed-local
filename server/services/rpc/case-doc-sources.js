// CASE_DOC_A4_V1 — что можно ВСТАВИТЬ в документ истории болезни.
//
// Владелец (2026-09-08): правая панель «Вставить в документ» — диагноз,
// функциональные исследования, лучевая диагностика, лабораторные исследования.
// Ровно так это работает в кабинете врача: врач не переписывает результат
// руками, он кладёт его в документ готовым блоком.
//
// ЭТО ЧТЕНИЕ, И ТОЛЬКО. Панель ничего не создаёт и ничего не меняет: она
// показывает уже существующие результаты ЭТОГО пациента и отдаёт их экрану,
// который вставит их в раздел документа.
//
// ГДЕ ЛЕЖАТ РЕЗУЛЬТАТЫ. В стационаре услуги живут в `admission_services`, но
// РЕЗУЛЬТАТОВ у них нет: лабораторные показатели (`lab_results`) привязаны к
// `visit_services`, и заключения пишутся в документе визита. Поэтому источник
// здесь — визиты ПАЦИЕНТА, а не услуги госпитализации: анализы лежащего
// пациента заказывают тем же порядком, что и амбулаторные.
import { RpcError, loadAdmission } from './inpatient-flow.js';
import { hasAnyRole } from '../roles.js';
// TG_LAB_MATRIX_V1 — посев (панель-таблица) открывается в истории болезни таблицей.
import { matrixGroupPart } from '../../../public/js/shared/lab-matrix.js';
import { labDocIssued } from '../../../public/js/shared/lab-doc-batches.js';   // LAB_DOC_NOT_READY_V1

export const DOC_SOURCE_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];

/** Сколько последних услуг пациента просматривается: панель — не архив. */
const LIMIT = 60;

const LAB_TYPES = new Set(['lab']);
const IMAGING_TYPES = new Set(['imaging', 'radiology']);
const FUNCTIONAL_TYPES = new Set(['procedure']);

export function admissionDocSources(db, args, user) {
  if (!hasAnyRole(user, DOC_SOURCE_ROLES)) throw new RpcError('Источники для документа — недоступно вашей роли.', 403);
  const adm = loadAdmission(db, args && args.admission_id);

  // ── диагноз ─────────────────────────────────────────────────────────────
  // Клинический — из ОПУБЛИКОВАННОГО и не исправленного первичного осмотра
  // (тот же источник, что у обзора госпитализации): второй копии диагноза в
  // базе нет и заводить её здесь нельзя.
  const primary = db.prepare(`
    SELECT diagnosis FROM admission_reviews
     WHERE admission_id = ? AND kind = 'primary' AND published_at IS NOT NULL AND superseded_by IS NULL
     ORDER BY published_at DESC LIMIT 1`).get(adm.id);
  const diagnosis = {
    referral: adm.admission_diagnosis || '',
    clinical: (primary && primary.diagnosis) || '',
  };

  // ── услуги пациента с результатами ──────────────────────────────────────
  const rows = db.prepare(`
    SELECT vs.id, vs.service_id, vs.status, vs.verified_at, vs.scheduled_at,
           v.visit_date, v.conclusion, v.conclusion_type,
           COALESCE(s.name, '') AS name, COALESCE(s.type, 'other') AS type, s.is_lab AS is_lab
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN services s ON s.id = vs.service_id
     WHERE v.patient_id = ?
     ORDER BY v.visit_date DESC, vs.id DESC
     LIMIT ?`).all(adm.patient_id, LIMIT);

  const ids = rows.map((r) => r.id);
  const byService = new Map();
  if (ids.length) {
    const results = db.prepare(`
      SELECT id, visit_service_id, parameter, value, unit, reference_range, flag
        FROM lab_results
       WHERE visit_service_id IN (${ids.map(() => '?').join(',')})
       ORDER BY id`).all(...ids);
    // Повторный ввод того же показателя ЗАМЕНЯЕТ строку, разные показатели
    // панели живут все — то же правило, что у архива документов.
    const latest = new Map();
    for (const r of results) latest.set(r.visit_service_id + '\u0000' + (r.parameter || ''), r);   // TG_LAB_MATRIX_V1 (ревью) — разделитель ключа — escape, а не сам символ: файл для git снова текст
    for (const r of [...latest.values()].sort((x, y) => x.id - y.id)) {
      if (!byService.has(r.visit_service_id)) byService.set(r.visit_service_id, []);
      byService.get(r.visit_service_id).push({
        parameter: r.parameter || '', value: r.value || '', unit: r.unit || '',
        reference_range: r.reference_range || '', flag: r.flag || '',
      });
    }
  }

  // TG_LAB_MATRIX_V1 (3.23.0) — у анализа, чья АКТИВНАЯ панель — таблица (бак.
  // посев), — таблица посева из тех же показателей (общая часть группы бланка,
  // shared/lab-matrix.js matrixGroupPart): экран кладёт её в бланк, и посев
  // открывается таблицей, а не списком «строка · графа». Обычная, снятая с работы
  // или испорченная панель — {}. Сбой чтения панели — анализ списком, как прежде.
  let panelOf = null;
  const labMatrixPart = (serviceId, results) => {
    if (serviceId == null) return {};
    try {
      panelOf = panelOf || db.prepare('SELECT kind, matrix_json FROM lab_panels WHERE service_id = ? AND active = 1');
      return matrixGroupPart(panelOf.get(serviceId), results);
    } catch { return {}; }
  };

  const lab = [];
  const imaging = [];
  const functional = [];
  // INSERT_SOURCES_V2 (2026-09-10) — владелец: «remove functional diagnostics,
  // and the radiology, leave only the diagnosis, consultations/diagnostics and
  // the lab». Деление на «лучевую» и «функциональные» было делением ПО ТИПУ
  // УСЛУГИ, а вставляют не тип, а ЗАКЛЮЧЕНИЕ — и пишется оно одинаково, кем бы
  // ни было написано: консультантом, рентгенологом или функционалистом.
  // Поэтому здесь один список: всё нелабораторное, у чего есть заключение.
  const studies = [];
  for (const r of rows) {
    const at = r.verified_at || r.scheduled_at || r.visit_date || null;
    const isLab = LAB_TYPES.has(r.type) || r.is_lab === 1;
    if (isLab) {
      const results = byService.get(r.id) || [];
      if (!results.length) continue;   // анализ без показателей вставлять нечем
      // LAB_DOC_NOT_READY_V1 (3.25.0) — внесённый, но не подтверждённый лабораторией
      // анализ помечен unverified — ровно как «Вставить результаты» кабинета врача
      // (patient-doc-sources.js collectLabs, PASTE_SOURCES_V1): показатели видны, экран
      // пишет «не проверено» в панели и во вставке, а бланк результатов не открывает.
      const unverified = !labDocIssued(r.status, r.verified_at);
      lab.push({ id: r.id, name: r.name, at, results, unverified, ...labMatrixPart(r.service_id, results) });   // TG_LAB_MATRIX_V1
      continue;
    }
    // Заключение исследования пишется В ДОКУМЕНТЕ ВИЗИТА: у услуги своего поля
    // заключения нет. Услуга без заключения показывается, но вставлять её
    // нечем — экран скажет об этом словами вместо пустого блока.
    const conclusion = r.conclusion_type === 'diagnostic' || r.conclusion_type === 'consultation'
      ? String(r.conclusion || '').trim() : '';
    const item = { id: r.id, name: r.name, at, conclusion };
    studies.push(item);
    // Прежнее деление остаётся для вкладки «Обследования и услуги»: там оно
    // отвечает на другой вопрос — что за исследование, а не что в него вставить.
    if (IMAGING_TYPES.has(r.type)) imaging.push(item);
    else if (FUNCTIONAL_TYPES.has(r.type)) functional.push(item);
  }

  return { admission_id: adm.id, diagnosis, lab, imaging, functional, studies };
}
