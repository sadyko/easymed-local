// V3120_FIX (M4, 2026-09-27) — ДАННЫЕ ПАЦИЕНТА ЧЕРЕЗ /api/db — ПО РАЗДЕЛАМ.
//
// Реестр таблиц отдавал пациентов, анализы, документы, диагнозы, показатели,
// счета, платежи и госпитализации ВСЕМУ персоналу (ALL_STAFF). Карта пациента
// при этом была закрыта разделом «Пациенты» и правами вкладок
// (rpc/patient-card.js), но одним запросом к /api/db склад или своя роль без
// раздела пациентов забирали то же самое.
//
// Закрыть таблицы целиком нельзя: их законно читают экраны разных разделов
// (лаборатория — анализы, касса — счета и платежи, стационар — госпитализации,
// колл-центр — пациентов). Поэтому у каждой таблицы — список разделов, КАЖДЫЙ
// из которых её открывает (экраны найдены по коду: кто зовёт from('<таблица>')),
// плюс раздел «Пациенты» с вкладкой карты — тем же правом, которым карта
// показывает эту вкладку. Закрытая вкладка «Счёт» закрывает счета тому, кому их
// давал только раздел пациентов; кассе их даёт её собственный раздел.
//
// Администратор — всегда. Без базы (компилятор вызван без контекста — чистые
// юнит-тесты) правило не применяется: маршрут /api/db базу передаёт всегда.
import { canViewSection, patientTabLevel } from '../services/roles.js';
import { isAdminUser } from '../services/grants.js';

export const PATIENT_TABLES = Object.freeze({
  patients: {
    sections: ['registration', 'crm', 'consultation', 'labs', 'procedures', 'beds', 'cashier', 'cashier-head',
      'patient-documents', 'queue', 'telegram-chat', 'custdev', 'settings'],
    tab: null,
  },
  lab_results: { sections: ['labs', 'consultation', 'beds', 'procedures', 'patient-documents'], tab: 'labs' },
  visit_documents: { sections: ['consultation', 'patient-documents', 'beds'], tab: 'docs' },
  patient_conditions: { sections: ['consultation', 'beds', 'procedures', 'registration', 'labs', 'patient-documents'], tab: 'details' },
  patient_vitals: { sections: ['consultation', 'beds', 'procedures', 'registration', 'labs', 'patient-documents'], tab: 'details' },
  invoices: { sections: ['cashier', 'cashier-head', 'registration', 'beds'], tab: 'billing' },
  payments: { sections: ['cashier', 'cashier-head'], tab: 'billing' },
  admissions: { sections: ['beds', 'consultation', 'labs', 'procedures', 'cashier', 'cashier-head', 'registration'], tab: 'history' },
  // V3120_FINAL (I3) — КЛИНИЧЕСКИЕ ТАБЛИЦЫ. Заметки и заключение визита,
  // заметки строки услуги, отметки о введённых препаратах, депозиты,
  // рекомендации врача и услуги стационара читались через /api/db любой ролью
  // (склад, своя роль без клинических разделов). Разделы — по экранам, которые
  // их читают (обход «зайти отовсюду» всеми 12 ролями + поиск from('<таблица>')):
  //   visits — записи/календарь и окно визита (регистратура, «Пациенты» →
  //     вкладка «Визиты»), кабинет врача, лаборатория, процедуры, стационар,
  //     касса, документы пациентов, очередь, заявки CRM (requests-inbox),
  //     счётчик визитов тарифа (настройки);
  //   visit_services — те же экраны, кроме CRM (строки заявке не нужны);
  //   med_administrations — стационар, процедуры, кабинет врача;
  //   patient_deposits — ровно как счета (касса, регистратура, стационар,
  //     «Пациенты» → «Счёт»); баланс RPC deposit_balance — тем же правилом (I1);
  //   recommended_services — кабинет врача, окно визита регистратуры, процедуры, стационар;
  //   admission_services — стационар, касса, кабинет врача, процедуры.
  visits: { sections: ['registration', 'crm', 'consultation', 'labs', 'procedures', 'beds', 'cashier', 'cashier-head',
    'patient-documents', 'queue', 'settings'], tab: 'visits' },
  visit_services: { sections: ['registration', 'consultation', 'labs', 'procedures', 'beds', 'cashier', 'cashier-head',
    'patient-documents', 'queue'], tab: 'services' },
  med_administrations: { sections: ['beds', 'procedures', 'consultation'], tab: 'history' },
  patient_deposits: { sections: ['cashier', 'cashier-head', 'registration', 'beds'], tab: 'billing' },
  recommended_services: { sections: ['consultation', 'registration', 'procedures', 'beds'], tab: 'services' },
  admission_services: { sections: ['beds', 'cashier', 'cashier-head', 'consultation', 'procedures'], tab: 'history' },
});

export const PATIENT_DATA_DENIED = 'Эти данные пациентов недоступны вашей роли.'
  + ' Доступ открывает администратор клиники: «Настройки» → «Роли» (раздел и вкладки карты пациента).';

/** Текст отказа или null. */
export function patientDataRefusal(table, user, db) {
  const rule = Object.prototype.hasOwnProperty.call(PATIENT_TABLES, table) ? PATIENT_TABLES[table] : null;
  if (!rule || !db) return null;
  if (!user) return PATIENT_DATA_DENIED;
  if (isAdminUser(user)) return null;
  try {
    if (rule.sections.some((s) => canViewSection(db, user, s))) return null;
    if (canViewSection(db, user, 'patients')) {
      if (!rule.tab) return null;
      if (patientTabLevel(db, user, rule.tab) !== 'none') return null;
    }
  } catch {
    return PATIENT_DATA_DENIED;   // права не прочитались — отказ, а не «пропустил»
  }
  return PATIENT_DATA_DENIED;
}
