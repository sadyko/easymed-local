// CRM_SMETA_BADGE_V1 (3.23.0) — «ИЗ ЗАЯВКИ» ЗАМЕТНО В СМЕТЕ РЕГИСТРАТУРЫ.
//
// Владелец (2026-11-10): «when i am booked the service to the patient is not seen in the booked
// patient. and also the badge dont seen in the registrator window. in the right side as prominent
// badge». Потом: «its there in the smeta but its not prominent». Услуга, которую колл-центр записал
// в карточке CRM (строка crm_request_services, её подставляет RPC crm_day_lines), в каталоге мастера
// помечена чипом «ИЗ ЗАЯВКИ», а в правой «Смете» — ничем: строка выглядела набранной руками, и
// регистратор не видел, что пациент записан из заявки.
//
// Теперь одна пара значков на обе сметы (мастер визита — visit-wizard.js repaintRail, каталог
// услуг/калькулятор — service-picker-modal.js paintCatRail):
//   • у строки из заявки — «из заявки · 10.11» (день строки; у желания без даты — «из заявки»);
//   • у пациента — «Записан из заявки на 10.11» (самый ранний день строк из заявки; только
//     желания без даты — «Услуги из заявки»).
// Вид — как чип «ИЗ ЗАЯВКИ» каталога: бирюзовый, жирный, прописные (класс .tag — форма); у
// пациента — крупнее, плашкой, с иконкой календаря. Чистые функции от строк сметы: экран сам
// решает, где их поставить.
import { h, Icon } from '../ui.js';
import { tr, trf } from '../i18n.js';

// Цвета и начертание чипа «ИЗ ЗАЯВКИ» каталога мастера (visit-wizard.js, CRM_CONVERT_V1).
const TEAL = { background: 'var(--teal-50, #e0f2f1)', color: 'var(--teal-700, #00796b)', borderColor: 'var(--teal-200, #b2dfdb)' };

/** 'YYYY-MM-DD…' → «10.11»; не дата — ''. */
export function crmDayShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}` : '';
}

/** Самый ранний день из списка ('YYYY-MM-DD' или пусто); нет ни одного — null. */
export function earliestCrmDay(days) {
  const ds = (Array.isArray(days) ? days : []).map((d) => String(d || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return ds.length ? ds[0] : null;
}

/** Подпись строки: «из заявки · 10.11» или «из заявки». */
export function crmLineText(day) {
  const d = crmDayShort(day);
  return d ? trf('из заявки · {date}', { date: d }) : tr('из заявки');
}

/**
 * Подпись у пациента по дням строк из заявки (null — у неявленной даты); пусто — null.
 * «Записан из заявки на 10.11» или «Услуги из заявки».
 */
export function crmBookedText(days) {
  const list = Array.isArray(days) ? days : [];
  if (!list.length) return null;
  const first = earliestCrmDay(list);
  return first ? trf('Записан из заявки на {date}', { date: crmDayShort(first) }) : tr('Услуги из заявки');
}

/** Значок строки сметы из заявки. day — день строки заявки (или null). */
export function crmLineBadge(day) {
  return h('span', {
    class: 'tag', 'data-crm-line': crmDayShort(day) || '-',
    style: { ...TEAL, flexShrink: 0, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', verticalAlign: 'middle' },
  }, Icon('Headset', { size: 12 }), crmLineText(day));
}

/**
 * Значок у пациента: «Записан из заявки на 10.11». days — дни строк из заявки в смете (null — без
 * даты); строк из заявки нет — null (значка нет).
 */
export function crmBookedBadge(days) {
  const text = crmBookedText(days);
  if (!text) return null;
  const first = earliestCrmDay(days);
  return h('div', {
    'data-crm-booked': first ? crmDayShort(first) : '-', role: 'status',
    style: { ...TEAL, display: 'flex', alignItems: 'center', gap: '7px', margin: '8px 0 2px', padding: '7px 11px',
      border: '1px solid', borderColor: TEAL.borderColor, borderRadius: '10px',
      fontSize: '13.5px', fontWeight: 700, lineHeight: 1.3 },
  }, Icon('Calendar', { size: 15 }), text);
}
