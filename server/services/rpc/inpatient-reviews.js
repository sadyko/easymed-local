// INPATIENT_REVIEW_V1 — первичный осмотр главного врача и назначение лечащего
// врача (Задача 3 плана docs/plans/2026-09-04-inpatient-workflow.md).
//
// ─── ЧТО ЭТОТ ФАЙЛ РЕШАЕТ ───────────────────────────────────────────────────
//
// Решение владельца (2026-09-04) дословно: «нет первичного осмотра — нет
// назначений; нет лечащего врача — нет лечения». Задача 1 построила замок
// (assertCanPrescribe: пациент обязан дойти до 'active'), Задача 2 довела
// пациента до койки — и на этом маршрут КОНЧАЛСЯ. Из 'admitted' наружу не вело
// ничего: ни один RPC не умел провести осмотр, значит ни один пациент,
// положенный медсестрой, не мог получить ни назначения, ни — до этой правки —
// даже выписки. Здесь маршрут продолжается.
//
// Два шага, и оба делает главный врач:
//   admission_review_save     осмотр как ДОКУМЕНТ; публикация первичного
//                             двигает 'admitted' → 'examined';
//   admission_set_attending   лечащий врач; двигает 'examined' → 'active' и
//                             тем самым ОТКРЫВАЕТ лечение.
//
// …и чтение, без которого второй шаг слеп:
//   admission_attending_candidates  КОГО можно назначить — тем же признаком
//                             (isDoctorRow), которым назначение потом проверяет
//                             выбранного. Экран не собирает этот список сам:
//                             собранный отдельно, он расходится с сервером
//                             молча (см. шапку функции).
//
// ─── ПОЧЕМУ ЧЕРНОВИК И ПУБЛИКАЦИЯ — РАЗНЫЕ ВЕЩИ ─────────────────────────────
//
// Осмотр набирают у постели или в кабинете, между двумя другими делами, и
// дописывают. Если бы сохранение сразу двигало маршрут, врач был бы обязан
// написать документ целиком с первого раза — иначе пациент уходит в 'examined'
// с половиной записи, и назначения открываются по недописанному осмотру.
// Поэтому сохранение и публикация — два разных действия с разными правами:
// черновик пишет и правит АВТОР, публикует первичный — ТОЛЬКО главный врач.
//
// ─── ПОЧЕМУ ИСПРАВЛЕНИЕ — ЭТО НОВАЯ ЗАПИСЬ ──────────────────────────────────
//
// Опубликованный осмотр не переписывается никогда: врач публикует следующий, а
// прежний получает `superseded_by` и остаётся в истории целиком (миграция
// 095). Переписать медицинский документ на месте — значит стереть то, на
// основании чего уже приняли решения: по прежнему диагнозу успели назначить
// лечение и выставить счёт.
//
// ─── ЧЕГО ЗДЕСЬ НЕТ ─────────────────────────────────────────────────────────
//
// Своих правил маршрута и своей матрицы прав: и «дошёл ли пациент», и «вправе
// ли этот человек» спрашиваются у rpc/inpatient-flow.js — там же, где их
// спрашивают Задачи 2, 4 и 8. Вторая копия этих правил разошлась бы с первой, и
// разошлась бы молча.
//
// Подбора кода МКБ: `diagnosis` — свободный текст (см. шапку 095).
//
// Выписки: 'discharge'-запись здесь можно написать и опубликовать, но маршрут
// она НЕ двигает — двухшаговую выписку строит Задача 8.

import {
  RpcError, loadAdmission, assertAdmissionAtLeast, assertCanPrescribe,
  assertMayTransition, admissionTransition, CLOSED_STATUSES,
} from './inpatient-flow.js';
import { hasAnyRole, effectiveRoles } from '../roles.js';

export { RpcError };

const KINDS = ['primary', 'round', 'discharge'];

// Кто вообще ПИШЕТ врачебную запись. Медсестры здесь нет: осмотр — врачебный
// документ, а сестринская запись в этой базе — отметка в листе назначений
// (rpc/treatment-orders.js). Право написать ЧЕРНОВИК шире права ОПУБЛИКОВАТЬ:
// см. шапку.
const WRITE_ROLES = ['doctor', 'head_doctor', 'admin'];

// Читают записи все, кто ведёт пациента в отделении — тот же круг, что у листа
// назначений (READ_ROLES в treatment-orders.js). Касса и склад в историю
// болезни не ходят.
const READ_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];

// СМЕНУ ЛЕЧАЩЕГО ВРАЧА делает тот же, кто его НАЗНАЧАЕТ — главный врач или
// администратор. Рядовой врач здесь отсутствует намеренно, и это не про
// иерархию: «лечащий врач» — подпись под лечением и под деньгами за него, и
// возможность переписать её на себя означала бы, что любой врач может забрать
// чужого пациента вместе с его назначениями и выработкой.
const CHANGE_ATTENDING_ROLES = ['head_doctor', 'admin'];

// КТО СПРАШИВАЕТ СПИСОК ВРАЧЕЙ ДЛЯ НАЗНАЧЕНИЯ. Ровно те же, кто вправе
// назначить и сменить: 'examined→active' в TRANSITION_ROLES и
// CHANGE_ATTENDING_ROLES — один и тот же круг. Список шире права был бы
// справочником сотрудников для всех, кто открыл стационар, а он здесь не за
// этим.
const ATTENDING_ROLES = CHANGE_ATTENDING_ROLES;

// ГДЕ лечащего врача МЕНЯЮТ. До 'active' его НАЗНАЧАЮТ (первичный осмотр
// главного врача, admission_set_attending) — там менять ещё нечего;
// 'discharging' входит сюда намеренно: между заявкой на выписку и её
// оформлением проходят часы, врач уходит с дежурства, а заявку можно отозвать
// и лечение продолжить — тогда подписывать его должен тот, кто на месте.
// Закрытая госпитализация (выписан / отменена) не меняется вовсе.
const CHANGE_ATTENDING_STATUSES = ['active', 'discharging'];

function str(v, max, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim().slice(0, max);
}

function posIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}

function requireRole(user, allowed, what) {
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError(`${what} — недоступно вашей роли.`, 403);
  }
}

// РОЛЬ, КОТОРОЙ ВОСПОЛЬЗОВАЛИСЬ, — не «первая роль человека». Главный врач
// носит надстройку поверх врача (extra_roles, миграция 091), и в записи должно
// стоять то, ЧЕМ он подписал: разбор «кто пустил пациента в лечение без
// осмотра» приходит именно за этим (см. шапку 095). Порядок в `preferred` —
// это и есть «старшинство подписи».
function usedRole(user, preferred) {
  const mine = effectiveRoles(user);
  return preferred.find((r) => mine.includes(r)) || (user && user.role) || '';
}

/**
 * ПРИЗНАК ВРАЧА — не текст роли.
 *
 * Инвариант этой базы (ADMIN_DOCTOR_LIST_V1, public/js/admin/data.js:416 и
 * service-editor-logic.js): администратор клиники может быть врачом, и у такой
 * учётной записи role='admin', specialty пустая — по тексту роли она врачом не
 * выглядит. Поэтому первым спрашивается `is_doctor`, а role/specialty остаются
 * как поддержка старых строк, заведённых до миграции 018.
 */
export function isDoctorRow(u) {
  if (!u) return false;
  if (u.is_doctor === 1 || u.is_doctor === true) return true;
  if (String(u.role || '').toLowerCase() === 'doctor') return true;
  if (String(u.specialty || '').trim()) return true;
  if (String(u.license_number || '').trim()) return true;
  return false;
}

function loadReview(db, reviewId) {
  const id = posIntOrNull(reviewId);
  if (id === null) throw new RpcError('review_id must be a positive integer.', 400);
  const row = db.prepare('SELECT * FROM admission_reviews WHERE id = ?').get(id);
  if (!row) throw new RpcError('Запись осмотра не найдена.', 400);
  return row;
}

// ─── 1. Сохранить / опубликовать осмотр ─────────────────────────────────────

/**
 * Осмотр: черновик или публикация.
 *
 * ПОРЯДОК ПРОВЕРОК ПРИ ПУБЛИКАЦИИ ПЕРВИЧНОГО — СНАЧАЛА РОЛЬ, ПОТОМ СОСТОЯНИЕ,
 * и это обратно тому, что делает admission_admit. Там койка была важнее роли,
 * потому что «пациент уже лежит» отменяет весь вопрос. Здесь наоборот: суть
 * решения владельца в том, ЧЕЙ это осмотр. Врачу, открывшему чужую форму,
 * правильный ответ — «первичный осмотр проводит главный врач», а не «пациент
 * ещё не на койке»: второй отправляет его звать медсестру там, где дело вообще
 * не в койке.
 *
 * @param {{admission_id:number, kind?:'primary'|'round'|'discharge',
 *          review_id?:number, complaints?:string, objective?:string,
 *          diagnosis?:string, plan?:string, body?:string,
 *          publish?:boolean, supersedes?:number}} args
 */
export function admissionReviewSave(db, args, user) {
  const a = args || {};
  const kind = str(a.kind, 20, 'primary') || 'primary';
  if (!KINDS.includes(kind)) throw new RpcError(`Неизвестный род записи: ${kind}.`, 400);

  requireRole(user, WRITE_ROLES, 'Врачебная запись');

  const publish = a.publish === true || a.publish === 1 || a.publish === 'true';
  const fields = {
    complaints: str(a.complaints, 2000),
    objective:  str(a.objective, 4000),
    diagnosis:  str(a.diagnosis, 500),
    plan:       str(a.plan, 4000),
    body:       str(a.body, 8000),
  };

  const run = db.transaction(() => {
    const adm = loadAdmission(db, a.admission_id);

    // Черновик, который правят, — только СВОЙ и только черновик.
    let existing = null;
    if (a.review_id !== undefined && a.review_id !== null && a.review_id !== '') {
      existing = loadReview(db, a.review_id);
      if (existing.admission_id !== adm.id) {
        throw new RpcError('Эта запись относится к другой госпитализации.', 400);
      }
      if (existing.published_at) {
        // Ровно то правило, ради которого в 095 есть superseded_by.
        throw new RpcError('Опубликованный осмотр не переписывают: сохраните исправление — оно станет новой записью, а прежняя останется в истории.', 400);
      }
      if (existing.author_id !== (user && user.id) && !hasAnyRole(user, ['admin'])) {
        throw new RpcError('Черновик осмотра правит только его автор.', 403);
      }
    }

    // ── Право на ПУБЛИКАЦИЮ (у черновика его не спрашивают) ─────────────────
    let authorRole = usedRole(user, ['head_doctor', 'admin', 'doctor']);
    if (publish) {
      if (kind === 'primary') {
        // 1. Роль — текст отказа называет действие и тех, кто его делает
        //    (ACTION_NAME/ROLE_TITLE в inpatient-flow.js: «Первичный осмотр —
        //    недоступно вашей роли. Это делает: главный врач, администратор.»).
        assertMayTransition('admitted', 'examined', user);
        // 2. Состояние: осматривают ЛЕЖАЩЕГО и ещё не осмотренного. 'examined'
        //    тоже пускаем — это исправление уже опубликованного осмотра.
        if (adm.status !== 'admitted' && adm.status !== 'examined') {
          throw new RpcError(primaryStateRefusal(db, adm), 400);
        }
        authorRole = usedRole(user, ['head_doctor', 'admin']);
      } else {
        // Обход и эпикриз ведёт тот, кто лечит: лечащий врач СВОЕГО пациента,
        // главный врач, администратор — и только по начатому лечению. Это тот
        // же вопрос, что задаёт назначение, поэтому и функция та же.
        assertCanPrescribe(db, adm.id, user);
        authorRole = adm.attending_doctor_id === (user && user.id)
          ? usedRole(user, ['doctor', 'head_doctor', 'admin'])
          : usedRole(user, ['head_doctor', 'admin', 'doctor']);
      }
    }

    const at = nowUtc(db);
    const publishedAt = publish ? at : null;

    let reviewId;
    if (existing) {
      db.prepare(`UPDATE admission_reviews
                     SET kind = ?, complaints = ?, objective = ?, diagnosis = ?, plan = ?, body = ?,
                         author_role = ?, updated_at = ?, published_at = ?
                   WHERE id = ?`)
        .run(kind, fields.complaints, fields.objective, fields.diagnosis, fields.plan, fields.body,
             authorRole, at, publishedAt, existing.id);
      reviewId = existing.id;
    } else {
      reviewId = db.prepare(`INSERT INTO admission_reviews
          (admission_id, kind, complaints, objective, diagnosis, plan, body,
           author_id, author_role, published_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(adm.id, kind, fields.complaints, fields.objective, fields.diagnosis, fields.plan,
             fields.body, (user && user.id) || null, authorRole, publishedAt).lastInsertRowid;
    }

    // ── Что публикация МЕНЯЕТ вокруг себя ──────────────────────────────────
    if (publish) {
      // Явное исправление конкретной записи (любой род) — по её id.
      const supersedes = posIntOrNull(a.supersedes);
      if (supersedes !== null && supersedes !== reviewId) {
        const prev = loadReview(db, supersedes);
        if (prev.admission_id !== adm.id) throw new RpcError('Исправляемая запись относится к другой госпитализации.', 400);
        db.prepare('UPDATE admission_reviews SET superseded_by = ? WHERE id = ?').run(reviewId, prev.id);
      }
      if (kind === 'primary') {
        // Первичный осмотр у госпитализации ОДИН действующий. Второй
        // опубликованный автоматически закрывает прежний: две «действующие»
        // редакции одного документа — это вопрос «по какой из них лечим», на
        // который никто не сможет ответить.
        db.prepare(`UPDATE admission_reviews
                       SET superseded_by = ?
                     WHERE admission_id = ? AND kind = 'primary' AND id <> ?
                       AND published_at IS NOT NULL AND superseded_by IS NULL`)
          .run(reviewId, adm.id, reviewId);

        // И только теперь — шаг маршрута. Исправление осмотра у пациента,
        // который уже в 'examined', ничего не двигает: он там и стоит.
        if (adm.status === 'admitted') {
          admissionTransition(db, { admission_id: adm.id, to: 'examined', at }, user);
        }
      }
    }

    return {
      review: db.prepare('SELECT * FROM admission_reviews WHERE id = ?').get(reviewId),
      admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id),
      published: !!publish,
    };
  });

  return run();
}

// Почему первичный осмотр нельзя опубликовать ИМЕННО СЕЙЧАС — словами
// маршрута. `assertAdmissionAtLeast` уже умеет называть недостающий шаг
// («Пациент ещё не размещён на койке — позовите медсестру»), поэтому для
// «слишком рано» зовём её, а «слишком поздно» описываем здесь.
function primaryStateRefusal(db, adm) {
  try {
    assertAdmissionAtLeast(db, adm.id, 'admitted');
  } catch (e) {
    return e.message;
  }
  return 'Первичный осмотр уже закрыт назначением лечащего врача — исправление вносят записью обхода.';
}

// ─── 2. Назначить лечащего врача ────────────────────────────────────────────

/**
 * Лечащий врач: 'examined' → 'active'. Это и есть тот шаг, после которого
 * открываются назначения, услуги и стол.
 *
 * @param {{admission_id:number, doctor_id:number}} args
 */
export function admissionSetAttending(db, args, user) {
  const a = args || {};
  const doctorId = posIntOrNull(a.doctor_id);
  if (doctorId === null) throw new RpcError('doctor_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const adm = loadAdmission(db, a.admission_id);

    // 1. Роль. «Назначение лечащего врача — недоступно вашей роли. Это делает:
    //    главный врач, администратор.»
    assertMayTransition('examined', 'active', user);

    // 2. Состояние: назначать лечащего можно только ОСМОТРЕННОМУ. До осмотра
    //    отказ называет недостающий шаг сам (assertAdmissionAtLeast).
    assertAdmissionAtLeast(db, adm.id, 'examined');
    if (adm.status !== 'examined') {
      // Текст обещает отдельное действие — и оно есть: admissionChangeAttending
      // ниже (RPC `admission_change_attending`). До этой правки обещание было
      // пустым: смены лечащего врача не существовало нигде, и госпитализация,
      // дошедшая до 'active' с пустым attending_doctor_id (старый admit_patient
      // позволял это, и 091 переносит такие строки как есть), не лечилась
      // вообще — назначения отвечали 403, а назначить врача было нечем.
      throw new RpcError('Лечащий врач уже назначен — смена лечащего врача делается отдельно (главный врач).', 400);
    }

    // 3. ВРАЧ ЛИ ЭТО. Отдельная проверка, а не доверие экрану: список врачей в
    //    браузере собирается по тому же признаку, но /api/rpc открыт curl'ом с
    //    любого компьютера клиники, а лечащий врач — это подпись под лечением.
    const u = db.prepare('SELECT id, full_name, role, is_doctor, specialty, license_number, active FROM users WHERE id = ?').get(doctorId);
    if (!u) throw new RpcError('Врач не найден.', 400);
    if (!isDoctorRow(u)) {
      throw new RpcError('Лечащим врачом можно назначить только врача: у выбранного сотрудника нет признака врача.', 400);
    }
    if (u.active === 0) throw new RpcError('Сотрудник уволен — лечащим врачом его назначить нельзя.', 400);

    // Лечащий врач — это ОТДЕЛЬНАЯ колонка, а не перезапись doctor_id:
    // doctor_id хранит НАПРАВИВШЕГО, и потерять его значило бы потерять ответ
    // на вопрос «кто прислал пациента».
    //
    // НО ЕСЛИ НАПРАВИВШЕГО НЕТ, ДЫРУ ЗАПОЛНЯЕМ. Пациент, поступивший без
    // направления (заявка регистратуры, приёмный покой), приходит с пустым
    // doctor_id, а на него смотрят старые экраны и отчёты — они показывали
    // прочерк там, где врач есть. COALESCE заполняет пустое и НЕ ТРОГАЕТ
    // заполненное: это и есть «согласованы», обещанные шапкой миграции 091, —
    // не равенство двух колонок, а отсутствие пустоты там, где ответ известен.
    db.prepare(
      'UPDATE admissions SET attending_doctor_id = ?, doctor_id = COALESCE(doctor_id, ?) WHERE id = ?',
    ).run(doctorId, doctorId, adm.id);
    const res = admissionTransition(db, { admission_id: adm.id, to: 'active' }, user);

    return { admission: res.admission, attending: { id: u.id, full_name: u.full_name, specialty: u.specialty || '' } };
  });

  return run();
}

// ─── 2b. СМЕНИТЬ лечащего врача ─────────────────────────────────────────────

/**
 * СМЕНА ЛЕЧАЩЕГО ВРАЧА — и ЕДИНСТВЕННЫЙ способ вытащить госпитализацию,
 * которая осталась без него совсем.
 *
 * ─── ЧЕГО НЕ ХВАТАЛО ────────────────────────────────────────────────────────
 *
 * `admission_set_attending` отказывал словами «смена лечащего врача делается
 * отдельно», и ничего отдельного не существовало. Пустое обещание стоило
 * дорого сразу в двух местах:
 *
 *   1. ОБЫЧНАЯ ЖИЗНЬ ОТДЕЛЕНИЯ. Лечащий врач уходит в отпуск, увольняется,
 *      уезжает на неделю — пациент остаётся, и назначения ему подписывать
 *      некому: assertCanPrescribe пускает лечащего врача ЭТОГО пациента,
 *      главного врача и администратора, а обычный врач, которому пациента
 *      передали по-человечески, получает 403.
 *
 *   2. ГОСПИТАЛИЗАЦИИ БЕЗ ЛЕЧАЩЕГО ВРАЧА ВООБЩЕ. Миграция 091 переносит
 *      attending_doctor_id := doctor_id, а старый `admit_patient` разрешал
 *      класть пациента с пустым doctor_id. На живом отделении это означает
 *      десятки открытых госпитализаций, у которых attending_doctor_id NULL:
 *      назначения им отвечают 403 всем без исключения, а `set_attending`
 *      отказывает, потому что смотрит на СТАТУС ('active' — «уже назначен»),
 *      а не на колонку. Такая госпитализация не лечилась и не чинилась ничем.
 *      ЭТО И ЕСТЬ ГЛАВНАЯ РАБОТА ЭТОГО RPC: он спасает их поимённо.
 *
 * ─── ГДЕ ЭТО ЗАПИСАНО И ПОЧЕМУ ИМЕННО ТАМ ──────────────────────────────────
 *
 * В `admission_transfers` — журнале ДВИЖЕНИЙ госпитализации, kind='attending'.
 * Тем же приёмом и по тому же доводу, что отзыв заявки на выписку
 * (kind='discharge_cancel', rpc/inpatient.js): эта таблица уже отвечает на
 * вопрос «что происходило с этой госпитализацией и кто это сделал» — заявка,
 * поступление, перевод, отмена, выписка, отзыв, правка даты. Смена лечащего
 * врача — событие ровно того же рода: не документ, а факт с подписью и
 * временем, который читают подряд с остальными.
 *
 * `admission_reviews` (095) для этого не годится, и это не вкусовщина: там
 * живут ВРАЧЕБНЫЕ ЗАПИСИ — осмотр, обход, эпикриз. У каждой есть автор,
 * публикация, замещение исправлением и правило «опубликованное не
 * переписывают». Смена врача ни одного из этих свойств не имеет: у неё нет
 * черновика, её не публикуют и не исправляют новой редакцией. Положить её
 * туда значило бы завести запись, которую экран истории болезни обязан
 * показывать как документ, а она им не является.
 *
 * ─── ПОЧЕМУ ПРИЧИНА ОБЯЗАТЕЛЬНА НЕ ВСЕГДА ───────────────────────────────────
 *
 * Когда лечащий врач БЫЛ и его меняют — причина обязательна: замена врача
 * посреди лечения это решение, за которым завтра придут («почему пациента
 * забрали у Азизы?»), и журнал без ответа бесполезен. Когда лечащего НЕ БЫЛО
 * (та самая мигрировавшая строка) — это не смена, а НАЗНАЧЕНИЕ, и требовать
 * объяснения за починку данных значит мешать чинить.
 *
 * @param {{admission_id:number, doctor_id:number, reason?:string}} args
 */
export function admissionChangeAttending(db, args, user) {
  const a = args || {};
  const doctorId = posIntOrNull(a.doctor_id);
  if (doctorId === null) throw new RpcError('doctor_id must be a positive integer.', 400);
  const reason = str(a.reason, 300);

  const run = db.transaction(() => {
    const adm = loadAdmission(db, a.admission_id);

    // 1. РОЛЬ — первой. Врачу, открывшему чужую карту, правильный ответ —
    //    «это делает главный врач», а не «пациент ещё не дошёл до лечения».
    requireRole(user, CHANGE_ATTENDING_ROLES, 'Смена лечащего врача');

    // 2. СОСТОЯНИЕ.
    if (CLOSED_STATUSES.includes(adm.status)) {
      throw new RpcError(adm.status === 'discharged'
        ? 'Пациент уже выписан — госпитализация закрыта, лечащего врача в ней не меняют.'
        : 'Заявка на госпитализацию отменена — лечащего врача в ней не меняют.', 400);
    }
    if (!CHANGE_ATTENDING_STATUSES.includes(adm.status)) {
      // До 'active' лечащего ещё НАЗНАЧАЮТ, а не меняют, и делает это первичный
      // осмотр главного врача. Отказ называет тот шаг, а не этот.
      throw new RpcError(
        'Лечащего врача ещё не назначали — его назначает главный врач вместе с первичным осмотром.', 400);
    }

    // 3. ВРАЧ ЛИ ЭТО. Тот же вопрос и тем же признаком, что у назначения:
    //    /api/rpc открыт curl'ом, а лечащий врач — подпись под лечением.
    const u = db.prepare(
      'SELECT id, full_name, role, is_doctor, specialty, license_number, active FROM users WHERE id = ?').get(doctorId);
    if (!u) throw new RpcError('Врач не найден.', 400);
    if (!isDoctorRow(u)) {
      throw new RpcError('Лечащим врачом можно назначить только врача: у выбранного сотрудника нет признака врача.', 400);
    }
    if (u.active === 0) throw new RpcError('Сотрудник уволен — лечащим врачом его назначить нельзя.', 400);

    const previousId = adm.attending_doctor_id || null;

    // Повтор — не ошибка: нажали дважды, открыли на двух экранах. Ничего не
    // меняем и не пишем в журнал вторую одинаковую строку.
    if (previousId === doctorId) {
      return {
        admission: adm,
        attending: { id: u.id, full_name: u.full_name, specialty: u.specialty || '' },
        previous_attending_doctor_id: previousId,
        changed: false,
      };
    }

    // 4. ПРИЧИНА — см. шапку: обязательна там, где это СМЕНА.
    if (previousId && !reason) {
      throw new RpcError('Укажите причину смены лечащего врача.', 400);
    }

    // 5. ЗАПИСЬ. doctor_id (направивший) не перезаписывается — только
    //    заполняется, если он пуст: см. тот же COALESCE в set_attending выше и
    //    исправленную шапку миграции 091.
    db.prepare(
      'UPDATE admissions SET attending_doctor_id = ?, doctor_id = COALESCE(doctor_id, ?) WHERE id = ?',
    ).run(doctorId, doctorId, adm.id);

    const previous = previousId
      ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(previousId)
      : null;
    // Строка журнала читается человеком подряд с поступлением и переводами,
    // поэтому в ней ИМЕНА, а не id: разбор через полгода не должен идти в
    // таблицу users за каждой строкой. Койка и палата — только `to_*`: пациент
    // никуда не переезжает, он остаётся там, где лежал.
    const note = (previous
      ? `Лечащий врач: ${previous.full_name || ('#' + previousId)} → ${u.full_name || ('#' + doctorId)}`
      : `Лечащий врач назначен: ${u.full_name || ('#' + doctorId)} (был не указан)`)
      + (reason ? ` · ${reason}` : '');
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, to_bed_id, to_ward_id, kind, reason, transferred_at, transferred_by)
      VALUES (?, ?, ?, 'attending', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
    `).run(adm.id, adm.bed_id, adm.ward_id, note, (user && user.id) || null);

    return {
      admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id),
      attending: { id: u.id, full_name: u.full_name, specialty: u.specialty || '' },
      previous_attending_doctor_id: previousId,
      changed: true,
    };
  });

  return run();
}

// ─── 3. Чтение ──────────────────────────────────────────────────────────────

/**
 * КОГО МОЖНО НАЗНАЧИТЬ ЛЕЧАЩИМ — СПИСКОМ, ОТ ТОГО ЖЕ ПРАВИЛА, ЧТО И ПРИНИМАЕТ.
 *
 * ПОЧЕМУ ЭТО RPC, А НЕ ЗАПРОС ЭКРАНА К ТАБЛИЦЕ users. Список врачей окно
 * «Назначить лечащего врача» собирало у себя: `.from('users').select('id,
 * full_name, specialty, role, is_doctor, license_number')`. Реестр
 * (server/db/schema-registry.js) колонку `license_number` у users НЕ отдаёт, а
 * компилятор на неразрешённое поле не «пропускает лишнее» — он отказывает
 * ВСЕМУ запросу («unknown column», 400, server/db/query-compiler.js). Ответ
 * приходил пустым, окно рисовало один «Выберите врача», и главный врач видел
 * экран, на котором в клинике будто нет ни одного врача. Тот же класс ошибки
 * уже ронял раздел «Стационар» (patients(phone)) и «Календарь записи» (пять
 * колонок) — здесь он закрыт иначе: экран больше не перечисляет колонки users
 * вообще, и добавить туда лишнюю нечем.
 *
 * И ГЛАВНОЕ — ПРАВИЛО ОДНО. Кто «врач», решает isDoctorRow, и решает ЗДЕСЬ, той
 * же функцией, которой admission_set_attending и admission_change_attending
 * потом проверяют выбранного. Две копии признака (одна в браузере, другая на
 * сервере) — это ровно тот случай, когда экран показывает человека, а сервер
 * его не принимает, или наоборот; сойтись руками они могут, а остаться
 * сошедшимися — нет.
 *
 * ФИЛИАЛ ЗДЕСЬ НЕ ФИЛЬТРУЕТСЯ НАМЕРЕННО. `users.branch_id` ездит между
 * зданиями справочником (STAFF_SYNC_V1), у привезённых из главной клиники он
 * несёт чужое значение, а isDoctorRow про здание не спрашивает вовсе. Отфильтруй
 * мы список по зданию — сервер принимал бы врача, которого экран не показал:
 * та самая расхождение, ради устранения которого этот RPC и написан.
 *
 * ПУСТОЙ ОТВЕТ ОБЪЯСНЯЕТ СЕБЯ. Врачей нет вовсе и «врачи есть, но все уволены» —
 * разные беды с разными починками, поэтому `dismissed` считается и уезжает
 * рядом со списком: окно скажет словами, что именно случилось, вместо пустого
 * выпадающего списка, который читается как поломка.
 *
 * @param {{}} _args не нужны: это справочник клиники, а не свойство пациента
 * @returns {{doctors:Array<{id:number,full_name:string,specialty:string}>, dismissed:number}}
 */
export function admissionAttendingCandidates(db, _args, user) {
  requireRole(user, ATTENDING_ROLES, 'Список врачей для назначения лечащим');

  const rows = db.prepare(
    'SELECT id, full_name, role, is_doctor, specialty, license_number, active FROM users ORDER BY full_name',
  ).all();

  // ТОТ ЖЕ ПРЕДИКАТ И ТОТ ЖЕ ПОРЯДОК ПРОВЕРОК, что у назначения ниже по файлу:
  // сначала «врач ли», потом «не уволен ли». Уволенных считаем отдельно — это и
  // есть третье состояние пустоты.
  const all = rows.filter(isDoctorRow);
  const working = all.filter((u) => u.active !== 0);

  return {
    doctors: working.map((u) => ({
      id: u.id,
      full_name: u.full_name || '',
      specialty: u.specialty || '',
    })),
    dismissed: all.length - working.length,
  };
}

/**
 * Все врачебные записи госпитализации, по порядку.
 *
 * ЧЕРНОВИКИ ВИДНЫ НЕ ВСЕМ. Недописанный осмотр — это ещё не документ, и
 * показывать его отделению значило бы дать читать половину диагноза как целый.
 * Его видит автор, главный врач и администратор — те, кто его и допишет.
 */
export function admissionReviewsList(db, args, user) {
  requireRole(user, READ_ROLES, 'Врачебные записи');
  const adm = loadAdmission(db, args && args.admission_id);

  const rows = db.prepare(`
    SELECT r.*, u.full_name AS author_name
      FROM admission_reviews r
      LEFT JOIN users u ON u.id = r.author_id
     WHERE r.admission_id = ?
     ORDER BY r.id
  `).all(adm.id);

  const seesDrafts = hasAnyRole(user, ['admin', 'head_doctor']);
  const uid = (user && user.id) || null;
  const reviews = rows.filter((r) => r.published_at || seesDrafts || (uid && r.author_id === uid));

  return {
    admission_id: adm.id,
    status: adm.status,
    attending_doctor_id: adm.attending_doctor_id,
    examined_at: adm.examined_at,
    examined_by: adm.examined_by,
    reviews,
  };
}
