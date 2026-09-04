// LIFECYCLE_V1 — the allowed status transitions, written down in one place.
//
// Statuses used to be assigned ad hoc wherever a handler happened to need one.
// Nothing described the shape of a lifecycle, so two opposite faults appeared
// and neither was visible from any single call site:
//
//   • states that could never be LEFT — an 'ordered' (тогда 'requested')
//     admission had no handler that could fulfil or cancel it, and because
//     request_admission refuses a second open request, the first one blocked
//     that patient forever;
//   • states that could never be REACHED — 'refunded' is checked in five places
//     and assigned by nobody.
//
// A transition table makes both kinds fall out of a test (see lifecycle.test.js)
// instead of out of a support call.
//
// Rule: a status column is written only after assertTransition() has approved
// the move. Terminal states are declared, not discovered.

export class TransitionError extends Error {
  constructor(msg) {
    super(msg);
    this.status = 400;
  }
}

// entity -> { from -> [allowed to] }. A state mapping to [] is TERMINAL BY
// DESIGN; the reachability test asserts each one is deliberate.
export const TRANSITIONS = {
  // INPATIENT_FLOW_V1 — маршрут госпитализации целиком (миграция 091, решение
  // владельца 2026-09-04). Порядок шагов ЖЁСТКО блокируется: нет заявки — нет
  // койки, нет первичного осмотра — нет назначений, нет лечащего врача — нет
  // лечения. Кто вправе совершить каждый переход — отдельный вопрос, и он
  // живёт в rpc/inpatient-flow.js: здесь только «что вообще возможно».
  //
  // 'requested' переименован в 'ordered' миграцией 091. Это то же самое
  // состояние («заявка оформлена, койки нет»), а не новое.
  admission: {
    // Заявка: медсестра кладёт на койку, регистратура — отменяет.
    //
    // 'active' в этом списке — НАСЛЕДСТВО v0.8.0, названное вслух. Так ходит
    // существующий admit_patient: он выполняет заявку и кладёт пациента одним
    // движением, потому что до 091 между «на койке» и «лечится» разницы не
    // было. Стрелка живёт здесь, чтобы работающая клиника продолжала работать,
    // но МАШИНА МАРШРУТА ЕЁ НЕ ПРЕДЛАГАЕТ: в TRANSITION_ROLES
    // (rpc/inpatient-flow.js) строки 'ordered→active' нет, и admissionTransition
    // отвечает на неё «нельзя пропустить шаг». Задача 2 заменяет admit_patient
    // на admission_admit и убирает стрелку.
    ordered:     ['admitted', 'active', 'cancelled'],
    // На койке: суточное начисление идёт, ждём первичный осмотр.
    //
    // 'discharged' у 'admitted' и 'examined' — НЕ новый порядок, а ЗАПЛАТА, и
    // она названа вслух (Задача 3). Задача 2 научила медсестру класть пациента
    // в 'admitted', а discharge_patient (v0.8.0) умел выписывать только из
    // 'active' — то есть пациента, попавшего на койку через окно медсестры,
    // нельзя было выписать ВООБЩЕ, пока его не осмотрит главный врач и не
    // назначит лечащего. Держать человека в клинике из-за того, что маршрут
    // строится по частям, нельзя: прямая выписка работает из любого состояния
    // «в койке» (IN_BED_STATUSES). Двухшаговую выписку (заявка врача →
    // оформление старшей медсестрой) строит Задача 8 — она и уберёт эти
    // стрелки вместе с самим прямым путём.
    admitted:    ['examined', 'discharged', 'cancelled'],
    // Осмотрен главным врачом: остаётся назначить лечащего.
    examined:    ['active', 'discharged', 'cancelled'],
    // ЛЕЧЕНИЕ ИДЁТ. Отсюда два пути, и второй — наследство, названное вслух:
    //   'discharging' — новый порядок: врач подаёт заявку на выписку, старшая
    //                   медсестра её оформляет (Задача 8);
    //   'discharged'  — ПРЯМАЯ выписка существующего discharge_patient
    //                   (v0.8.0). Она работает в живых клиниках прямо сейчас, и
    //                   убрать её здесь значило бы сломать кнопку «Выписать» до
    //                   того, как появится та, что придёт ей на смену. Задача 8
    //                   уберёт эту стрелку вместе с самим прямым путём.
    // Отмены отсюда нет намеренно: законченную госпитализацию закрывает
    // ВЫПИСКА, а не отмена — иначе исчезли бы деньги за уже прожитые сутки.
    active:      ['discharging', 'discharged'],
    // ЗАЯВКУ НА ВЫПИСКУ МОЖНО ОТОЗВАТЬ (TWO_STEP_DISCHARGE_V1, Задача 8) — и
    // это единственная стрелка НАЗАД во всём маршруте. Она здесь намеренно:
    // в референсе (Aurora) поданную заявку отозвать нельзя, и это его ДЫРА, а
    // не строгость. Между «врач признал готовым» и «выписка оформлена»
    // проходят часы, и за эти часы состояние меняется: поднялась температура,
    // пришёл анализ, родственники не забрали. Без обратного хода отделению
    // остаётся один выход — ОФОРМИТЬ выписку и завести новую госпитализацию,
    // то есть соврать и в истории болезни, и в деньгах (новые сутки, новый
    // счёт), чтобы обойти программу.
    //
    // Возврат безопасен ровно потому, что 'discharging' — состояние «в койке»
    // (IN_BED_STATUSES): койка всё это время занята, суточное идёт, ничего не
    // закрывалось и освобождать нечего. Отзывает тот, кто подавал — врач,
    // главный врач, администратор (TRANSITION_ROLES в rpc/inpatient-flow.js);
    // старшей медсестры в этом списке нет: отменять врачебное решение — не её
    // работа.
    discharging: ['discharged', 'active'],
    discharged:  [],   // terminal: the stay is over and billed
    cancelled:   [],   // terminal: the request was declined
  },
  invoice: {
    unpaid:   ['partial', 'paid', 'debt', 'void'],
    partial:  ['paid', 'debt', 'unpaid', 'void'],      // unpaid again after a full refund
    debt:     ['paid', 'unpaid', 'void'],              // stays 'debt' while part-paid — see money.js
    paid:     ['partial', 'unpaid', 'refunded'],       // refunds walk the ladder back down
    void:     [],       // terminal: cancelled before any money moved
    refunded: [],       // terminal: settled then fully returned
  },
};

// States a lifecycle may legitimately end in. Anything else with no outgoing
// transition is a dead end and fails the reachability test.
export const TERMINAL = {
  admission: ['discharged', 'cancelled'],
  invoice: ['void', 'refunded'],
};

// The state every entity starts in.
export const INITIAL = {
  admission: ['ordered', 'active'],   // a walk-in is admitted without a request (admit_patient, v0.8.0)
  invoice: ['unpaid', 'paid'],          // a zero-balance invoice is born paid
};

export function canTransition(entity, from, to) {
  const table = TRANSITIONS[entity];
  if (!table) throw new TransitionError(`unknown entity: ${entity}`);
  if (from === to) return true;                    // idempotent re-assert
  return (table[from] || []).includes(to);
}

export function assertTransition(entity, from, to) {
  if (!canTransition(entity, from, to)) {
    throw new TransitionError(`${entity} cannot go from '${from}' to '${to}'.`);
  }
}
