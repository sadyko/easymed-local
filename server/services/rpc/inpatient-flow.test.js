// INPATIENT_FLOW_V1 — маршрут госпитализации: порядок шагов и кто их делает.
//
// Проверяется ровно то, что решил владелец 2026-09-04: «Порядок шагов жёстко
// блокируется». Три вопроса, и все три — про сервер, а не про экран:
//   • каждый законный шаг ПРОХОДИТ у той роли, которой он поручен;
//   • он же ОТКАЗЫВАЕТ всем остальным, и отказ называет, кого звать;
//   • через ступень не перепрыгнуть, назад не вернуться, закрытую не открыть.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  admissionTransition, assertAdmissionAtLeast, assertCanPrescribe, admissionFlowState,
  TRANSITION_ROLES, LEGACY_EDGES, FLOW_ORDER, IN_BED_STATUSES, OPEN_STATUSES, RpcError,
} from './inpatient-flow.js';

// Все роли системы — чтобы «запрещено остальным» значило ВСЕМ остальным, а не
// тем троим, о которых вспомнил автор теста.
const EVERY_ROLE = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse',
  'inventory', 'callcenter', 'head_doctor', 'senior_nurse'];

// Носитель роли. Надстроечные роли (head_doctor/senior_nurse) человек носит
// ТОЛЬКО в extra_roles — ровно так, как их выдаёт клиника: врач остаётся
// врачом, медсестра — медсестрой.
function actor(role, id = 1) {
  return ['head_doctor', 'senior_nurse'].includes(role)
    ? { id, role: role === 'head_doctor' ? 'doctor' : 'nurse', extra_roles: [role] }
    : { id, role };
}

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'u1','x','Первый','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'doc','x','Лечащий','doctor')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'doc2','x','Чужой','doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'free')").run();
  return db;
}

/** Госпитализация ровно в состоянии `status` (мимо машины — это фикстура). */
function admission(db, status, extra = {}) {
  const cols = { patient_id: 1, ward_id: 1, status, ...extra };
  const keys = Object.keys(cols);
  const id = db.prepare(`INSERT INTO admissions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => cols[k])).lastInsertRowid;
  return id;
}

// ─── 1. Каждый законный шаг: проходит у своих, отказывает всем остальным ─────

for (const [key, allowed] of Object.entries(TRANSITION_ROLES)) {
  const [from, to] = key.split('→');

  test(`переход ${from} → ${to}: проходит у каждой роли, которой он поручен (${allowed.join(', ')})`, () => {
    for (const role of allowed) {
      const db = seed();
      const id = admission(db, from);
      const res = admissionTransition(db, { admission_id: id, to, reason: 'причина' }, actor(role, 1));
      assert.equal(res.admission.status, to, `${role}: шаг не выполнен`);
      db.close();
    }
  });

  test(`переход ${from} → ${to}: отказывает всем остальным ролям, и отказ называет, кого звать`, () => {
    for (const role of EVERY_ROLE.filter((r) => !allowed.includes(r))) {
      const db = seed();
      const id = admission(db, from);
      let thrown = null;
      try { admissionTransition(db, { admission_id: id, to }, actor(role, 1)); }
      catch (e) { thrown = e; }
      assert.ok(thrown, `${role} не должен был пройти ${from} → ${to}`);
      assert.equal(thrown.status, 403, `${role}: отказ по роли — это 403, а не «неверный запрос»`);
      assert.match(thrown.message, /недоступно вашей роли/, `${role}: отказ обязан сказать, в чём дело`);
      assert.match(thrown.message, /Это делает: /, `${role}: отказ обязан назвать, кого звать`);
      // Строка не тронута: отказ не должен ничего менять.
      assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(id).status, from);
      db.close();
    }
  });
}

// ─── 2. Порядок шагов ────────────────────────────────────────────────────────

test('через ступень не перепрыгнуть — и отказ говорит, какого шага не хватает', () => {
  const db = seed();
  const cases = [
    ['ordered', 'examined',   /Нельзя пропустить шаг/],
    ['ordered', 'active',     /Нельзя пропустить шаг/],
    ['ordered', 'discharged', /Нельзя пропустить шаг/],
    // Наследственные шаги v0.8.0: база их ещё разрешает (старые RPC ими ходят),
    // но МАШИНА не предлагает — иначе первичный осмотр можно было бы
    // перепрыгнуть одним запросом.
    ['ordered', 'active',     /Нельзя пропустить шаг/],
    ['active', 'discharged',  /Нельзя пропустить шаг/],
    ['admitted', 'active',    /Нельзя пропустить шаг/],
    ['admitted', 'discharging', /Нельзя пропустить шаг/],
    ['examined', 'discharging', /Нельзя пропустить шаг/],
  ];
  for (const [from, to, re] of cases) {
    const id = admission(db, from);
    // Даже администратору, у которого есть КАЖДОЕ право: это запрет маршрута,
    // а не запрет по роли.
    assert.throws(() => admissionTransition(db, { admission_id: id, to }, actor('admin')),
      (e) => e instanceof RpcError && e.status === 400 && re.test(e.message),
      `${from} → ${to} должен быть отвергнут маршрутом`);
    assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(id).status, from);
  }
  db.close();
});

test('назад по маршруту хода нет — кроме отзыва заявки на выписку', () => {
  const db = seed();
  for (const [from, to] of [['admitted', 'ordered'], ['active', 'admitted'], ['examined', 'admitted']]) {
    const id = admission(db, from);
    assert.throws(() => admissionTransition(db, { admission_id: id, to }, actor('admin')),
      /нельзя вернуть на предыдущий шаг/, `${from} → ${to}`);
  }
  // ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ (TWO_STEP_DISCHARGE_V1, Задача 8): поданную заявку
  // на выписку ОТЗЫВАЮТ. Между «врач признал готовым» и «медсестра оформила»
  // проходят часы, и за эти часы состояние меняется. Референс этого не умеет —
  // и заставляет отделение выписать и завести госпитализацию заново, то есть
  // соврать в истории болезни и в деньгах. Койка при отзыве не трогается:
  // 'discharging' — состояние «в койке», пациент никуда не уходил.
  const back = admission(db, 'discharging', { bed_id: 1 });
  const res = admissionTransition(db, { admission_id: back, to: 'active' }, actor('doctor', 2));
  assert.equal(res.admission.status, 'active');
  assert.equal(res.admission.bed_id, 1, 'койка осталась за пациентом');
  db.close();
});

test('выписанную госпитализацию не открыть заново, отменённую — не продолжить', () => {
  const db = seed();
  const out = admission(db, 'discharged');
  for (const to of ['active', 'admitted', 'discharging', 'cancelled']) {
    assert.throws(() => admissionTransition(db, { admission_id: out, to }, actor('admin')),
      /уже выписан/, 'discharged → ' + to);
  }
  const cancelled = admission(db, 'cancelled');
  for (const to of ['ordered', 'admitted', 'active']) {
    assert.throws(() => admissionTransition(db, { admission_id: cancelled, to }, actor('admin')),
      /отменена/, 'cancelled → ' + to);
  }
  db.close();
});

test('начатое лечение отменяют не отменой, а выпиской', () => {
  const db = seed();
  for (const from of ['active', 'discharging']) {
    const id = admission(db, from);
    assert.throws(() => admissionTransition(db, { admission_id: id, to: 'cancelled' }, actor('admin')),
      /начатую — выписывают/, from + ' → cancelled');
  }
  db.close();
});

test('повтор того же состояния идемпотентен — двойное нажатие не ошибка', () => {
  const db = seed();
  const id = admission(db, 'admitted');
  const res = admissionTransition(db, { admission_id: id, to: 'admitted' }, actor('nurse'));
  assert.equal(res.admission.status, 'admitted');
  db.close();
});

// ─── 3. Шаг подписан: кем и когда ───────────────────────────────────────────

test('каждый шаг оставляет подпись — иначе «почему пациент третьи сутки без осмотра» некуда смотреть', () => {
  const db = seed();
  const id = admission(db, 'ordered');

  admissionTransition(db, { admission_id: id, to: 'admitted', at: '2026-09-04T09:00:00Z' }, actor('nurse', 1));
  let row = db.prepare('SELECT * FROM admissions WHERE id=?').get(id);
  assert.equal(row.admitted_by, 1);
  assert.equal(row.admitted_at, '2026-09-04T09:00:00Z');

  admissionTransition(db, { admission_id: id, to: 'examined', at: '2026-09-04T11:30:00Z' }, actor('head_doctor', 2));
  row = db.prepare('SELECT * FROM admissions WHERE id=?').get(id);
  assert.equal(row.examined_by, 2);
  assert.equal(row.examined_at, '2026-09-04T11:30:00Z');
  db.close();
});

test('отмена сохраняет причину и время — «отменили и всё» не ответ', () => {
  const db = seed();
  const id = admission(db, 'ordered');
  admissionTransition(db, { admission_id: id, to: 'cancelled', reason: 'состояние улучшилось' }, actor('registrar'));
  const row = db.prepare('SELECT * FROM admissions WHERE id=?').get(id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancel_reason, 'состояние улучшилось');
  assert.ok(row.discharged_at, 'заявка закрыта — у неё есть время закрытия');
  db.close();
});

// ─── 4. Охранники, которые вызовут Задачи 4–6 ───────────────────────────────

test('assertAdmissionAtLeast: пускает дошедших, отказывает не дошедшим — и называет недостающий шаг', () => {
  const db = seed();
  const need = 'active';
  // Отказ называет СЛЕДУЮЩИЙ шаг — того, кого звать сейчас, а не конечную цель.
  const expect = {
    ordered:     /не размещён на койке — позовите медсестру/,
    admitted:    /не осмотрен главным врачом/,
    examined:    /Лечащий врач ещё не назначен/,
  };
  for (const status of FLOW_ORDER) {
    const id = admission(db, status);
    if (['active', 'discharging'].includes(status)) {
      assert.equal(assertAdmissionAtLeast(db, id, need).id, id, status + ': должен пройти');
    } else if (status === 'discharged') {
      assert.throws(() => assertAdmissionAtLeast(db, id, need), /уже выписан/,
        'выписанному дописывать услуги нельзя — это правило было и до маршрута');
    } else {
      assert.throws(() => assertAdmissionAtLeast(db, id, need), expect[status], status);
    }
  }
  const cancelled = admission(db, 'cancelled');
  assert.throws(() => assertAdmissionAtLeast(db, cancelled, need), /отменена/);
  db.close();
});

test('assertAdmissionAtLeast: «хотя бы до admitted» — то, что спросит окно медсестры', () => {
  const db = seed();
  assert.throws(() => assertAdmissionAtLeast(db, admission(db, 'ordered'), 'admitted'),
    /не размещён на койке/);
  for (const s of IN_BED_STATUSES) {
    assert.ok(assertAdmissionAtLeast(db, admission(db, s), 'admitted'), s);
  }
  db.close();
});

test('assertAdmissionAtLeast: несуществующая госпитализация и мусор в id — понятный отказ, не 500', () => {
  const db = seed();
  assert.throws(() => assertAdmissionAtLeast(db, 999, 'active'), /не найдена/);
  for (const bad of [0, -1, 1.5, null, undefined, 'x']) {
    assert.throws(() => assertAdmissionAtLeast(db, bad, 'active'), /positive integer/);
  }
  db.close();
});

test('assertCanPrescribe: до осмотра — тот самый отказ из решения владельца', () => {
  const db = seed();
  const doc = { id: 2, role: 'doctor' };
  assert.throws(() => assertCanPrescribe(db, admission(db, 'ordered', { attending_doctor_id: 2 }), doc),
    /Пациент ещё не осмотрен главным врачом — назначения недоступны/);
  assert.throws(() => assertCanPrescribe(db, admission(db, 'admitted', { attending_doctor_id: 2 }), doc),
    /Пациент ещё не осмотрен главным врачом — назначения недоступны/);
  // Осмотрен, но лечащего ещё нет — другая беда, и слова другие.
  assert.throws(() => assertCanPrescribe(db, admission(db, 'examined', { attending_doctor_id: 2 }), doc),
    /Лечащий врач ещё не назначен — назначения недоступны/);
  db.close();
});

test('assertCanPrescribe: назначает лечащий врач своего пациента, главный врач и администратор', () => {
  const db = seed();
  const id = admission(db, 'active', { attending_doctor_id: 2 });

  assert.equal(assertCanPrescribe(db, id, { id: 2, role: 'doctor' }).id, id, 'лечащий врач');
  assert.equal(assertCanPrescribe(db, id, actor('head_doctor', 9)).id, id, 'главный врач — по всему отделению');
  assert.equal(assertCanPrescribe(db, id, { id: 1, role: 'admin' }).id, id, 'администратор');

  // Чужой врач — нет. Матрица плана: «✔ (свой пациент)».
  assert.throws(() => assertCanPrescribe(db, id, { id: 3, role: 'doctor' }),
    (e) => e.status === 403 && /лечащий врач этого пациента/.test(e.message));
  // Медсестра назначений не делает — она их выполняет.
  assert.throws(() => assertCanPrescribe(db, id, { id: 4, role: 'nurse' }), (e) => e.status === 403);
  db.close();
});

test('assertCanPrescribe: закрытой госпитализации назначать нечего', () => {
  const db = seed();
  assert.throws(() => assertCanPrescribe(db, admission(db, 'discharged', { attending_doctor_id: 2 }), { id: 2, role: 'doctor' }),
    /уже выписан/);
  assert.throws(() => assertCanPrescribe(db, admission(db, 'cancelled', { attending_doctor_id: 2 }), { id: 2, role: 'doctor' }),
    /отменена/);
  db.close();
});

// ─── 5. Чтение состояния для экранов ────────────────────────────────────────

test('admission_flow_state отвечает, что ЭТОТ человек может сделать сейчас', () => {
  const db = seed();
  const id = admission(db, 'ordered');

  const nurse = admissionFlowState(db, { admission_id: id }, actor('nurse'));
  assert.equal(nurse.status, 'ordered');
  assert.equal(nurse.in_bed, false);
  assert.equal(nurse.open, true);
  assert.equal(nurse.can.admitted, true, 'медсестра кладёт на койку');
  assert.equal(nurse.can.cancelled, false, 'но заявку не отменяет');

  const reg = admissionFlowState(db, { admission_id: id }, actor('registrar'));
  assert.equal(reg.can.admitted, false);
  assert.equal(reg.can.cancelled, true);

  // Врач с надстройкой «главный врач» — и то, и другое.
  const head = admissionFlowState(db, { admission_id: id }, actor('head_doctor'));
  assert.equal(head.can.admitted, true);
  assert.equal(head.can.cancelled, true);
  db.close();
});

test('admission_flow_state: «в койке» — это четыре состояния, а не одно', () => {
  const db = seed();
  for (const s of FLOW_ORDER.concat('cancelled')) {
    const st = admissionFlowState(db, { admission_id: admission(db, s) }, actor('admin'));
    assert.equal(st.in_bed, IN_BED_STATUSES.includes(s), s + ': in_bed');
    assert.equal(st.open, OPEN_STATUSES.includes(s), s + ': open');
  }
  db.close();
});

// ─── 6. Надстроечные роли работают ИМЕННО как надстройка ────────────────────

test('главный врач остаётся врачом: право приходит из extra_roles, не вместо основной роли', () => {
  const db = seed();
  const id = admission(db, 'admitted');
  // Обычный врач первичный осмотр не проводит…
  assert.throws(() => admissionTransition(db, { admission_id: id, to: 'examined' }, { id: 2, role: 'doctor' }),
    /недоступно вашей роли/);
  // …а тот же врач с надстройкой — проводит, не перестав быть врачом.
  const res = admissionTransition(db, { admission_id: id, to: 'examined' },
    { id: 2, role: 'doctor', extra_roles: ['head_doctor'] });
  assert.equal(res.admission.status, 'examined');
  db.close();
});

test('старшая медсестра оформляет выписку, обычная — нет', () => {
  const db = seed();
  assert.throws(() => admissionTransition(db, { admission_id: admission(db, 'discharging'), to: 'discharged' },
    { id: 5, role: 'nurse' }), /недоступно вашей роли/);
  const res = admissionTransition(db, { admission_id: admission(db, 'discharging'), to: 'discharged' },
    { id: 5, role: 'nurse', extra_roles: ['senior_nurse'] });
  assert.equal(res.admission.status, 'discharged');
  assert.ok(res.admission.discharged_at);
  db.close();
});

// ─── 7. Матрица не разошлась с маршрутом ────────────────────────────────────

test('матрица прав и маршрут расходятся ровно на объявленное наследство v0.8.0', async () => {
  const { TRANSITIONS } = await import('../domain/lifecycle.js');
  const legal = [];
  for (const [from, tos] of Object.entries(TRANSITIONS.admission)) {
    for (const to of tos) legal.push(`${from}→${to}`);
  }
  const matrix = Object.keys(TRANSITION_ROLES);
  // Разрешено базой, но не машиной — только два наследственных шага, и каждый
  // назван. Любой третий значил бы дыру: шаг, который старый RPC делает, а
  // новый порядок не описывает.
  assert.deepEqual(legal.filter((k) => !matrix.includes(k)).sort(), [...LEGACY_EDGES].sort(),
    'необъявленный обход маршрута');
  assert.deepEqual(matrix.filter((k) => !legal.includes(k)), [],
    'право на переход, которого маршрут не знает, — мёртвая строка');
});
