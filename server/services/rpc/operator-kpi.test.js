// OPERATOR_KPI_V1 — «Мой KPI» оператора. Что утверждается:
//   1. заявки оператора — те, что он ВЕДЁТ (assigned_to), а не завёл; ступени — из воронки;
//   2. звонки — по его внутреннему номеру; чужой номер не засчитывается;
//   3. оплата — из карточки сотрудника как есть: оклад, процент, база процента —
//      оплаты в кассу его пациентов (заявка «Пришёл», заведена не позже оплаты);
//      итог «к начислению» — только за месяц;
//   4. не задано в карточке — оплаты нет, показатели есть;
//   5. доступ: оператор — только себя; руководитель — любого; без CRM — 403;
//   6. RPC зарегистрирован и разрешён лапсу лицензии как чтение.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { operatorKpi, kpiRange, salesTeamReport } from './operator-kpi.js';
import { getRpc } from './index.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const HOURS_AGO = (n) => `strftime('%Y-%m-%dT%H:%M:%SZ','now','-${n} hours')`;

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const run = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
  run("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Админ','admin')");
  run(`INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension, salary_type, salary_fixed, salary_percent, kpi_links)
       VALUES (2,'anna','x','Оператор Анна','callcenter','101','fix_plus_kpi',3000000,5,'["revenue"]')`);
  run("INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension) VALUES (3,'bek','x','Оператор Бек','callcenter','102')");
  run("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (4,'nurse','x','Медсестра','nobody_role')");
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('nobody_role', JSON.stringify({ sections: [] }));

  const p1 = run(`INSERT INTO patients (full_name, branch_id, created_at) VALUES ('Пациент 1',1,${NOW})`);
  const p2 = run(`INSERT INTO patients (full_name, branch_id, created_at) VALUES ('Пациент 2',1,${NOW})`);
  // Анна ведёт три заявки (одну завёл Бек): одна дошла, одна записана, одна потеряна.
  run(`INSERT INTO crm_requests (full_name, phone, source, status, assigned_to, created_by, patient_id, created_at)
       VALUES ('Л1','1','call','came',2,3,?,${HOURS_AGO(3)})`, p1);
  run(`INSERT INTO crm_requests (full_name, phone, source, status, assigned_to, scheduled_date, created_at)
       VALUES ('Л2','2','call','scheduled',2,date('now','+1 day'),${NOW})`);
  run(`INSERT INTO crm_requests (full_name, phone, source, status, assigned_to, created_at) VALUES ('Л3','3','call','stopped',2,${NOW})`);
  // Бек: одна заявка, дошла — у его пациента оплата, но в базу Анны она не идёт.
  run(`INSERT INTO crm_requests (full_name, phone, source, status, assigned_to, patient_id, created_at) VALUES ('Л4','4','call','came',3,?,${NOW})`, p2);

  // Оплаты: пациент Анны заплатил 200 000 после заявки; оплата ДО заявки не в счёт.
  const inv1 = run(`INSERT INTO invoices (patient_id, total_amount, paid_amount, status, created_at) VALUES (?,250000,250000,'paid',${NOW})`, p1);
  run(`INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,200000,'cash',${HOURS_AGO(1)})`, inv1);
  run(`INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,50000,'cash',${HOURS_AGO(5)})`, inv1);
  const inv2 = run(`INSERT INTO invoices (patient_id, total_amount, paid_amount, status, created_at) VALUES (?,90000,90000,'paid',${NOW})`, p2);
  run(`INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,90000,'card',${NOW})`, inv2);

  // Звонки: два входящих Анне (один пропущен), исходящий; звонок Беку — не её.
  db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, internal_number, billsec, waitsec, disposition) VALUES
      ('g1',${NOW},0,'111','101',120,8,'ANSWER'),
      ('g2',${NOW},0,'222','101',0,30,'NOANSWER'),
      ('g3',${NOW},1,'333','101',60,0,'ANSWER'),
      ('g4',${NOW},0,'444','102',90,5,'ANSWER')`).run();
  // Задачи Анны: одна выполнена сегодня, одна просрочена.
  run(`INSERT INTO crm_tasks (request_id, text, due_at, assignee_id, done_at, created_at) VALUES (1,'Перезвонить',${HOURS_AGO(2)},2,${NOW},${NOW})`);
  run(`INSERT INTO crm_tasks (request_id, text, due_at, assignee_id, created_at) VALUES (2,'Напомнить',${HOURS_AGO(2)},2,${NOW})`);
  return db;
}

const db = seed();
test.after(() => db.close());
const ANNA = { id: 2, role: 'callcenter' };

test('периоды: неделя — с понедельника, прошлый месяц — целиком', () => {
  assert.deepEqual(kpiRange('2026-11-14', 'week'), { key: 'week', from: '2026-11-09', to: '2026-11-14' });
  assert.deepEqual(kpiRange('2026-11-14', 'month'), { key: 'month', from: '2026-11-01', to: '2026-11-14' });
  assert.deepEqual(kpiRange('2026-11-14', 'prev_month'), { key: 'prev_month', from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(kpiRange('2026-11-14', 'today'), { key: 'today', from: '2026-11-14', to: '2026-11-14' });
});

test('заявки — те, что оператор ведёт; ступени — из воронки', () => {
  const o = operatorKpi(db, { period: 'month' }, ANNA);
  assert.equal(o.operator.name, 'Оператор Анна');
  assert.equal(o.leads.total, 3, 'заявка, которую завёл Бек, а ведёт Анна, — её');
  assert.equal(o.leads.came, 1);
  assert.equal(o.leads.lost, 1);
  assert.equal(o.leads.became_patient, 1);
  assert.equal(o.leads.with_date, 1);
  assert.equal(o.leads.conversion, 33.3);
  assert.equal(o.rank.place, 1);
});

test('звонки — по внутреннему номеру; чужие не в счёт', () => {
  const c = operatorKpi(db, { period: 'today' }, ANNA).calls;
  assert.deepEqual({ i: c.incoming, a: c.answered, m: c.missed, o: c.outgoing, t: c.talk_min, w: c.avg_wait_sec },
    { i: 2, a: 1, m: 1, o: 1, t: 3, w: 8 });
  assert.equal(c.answer_rate, 50);
});

test('оплата: оклад и процент из карточки; база — оплаты её пациентов после заявки; итог — за месяц', () => {
  const m = operatorKpi(db, { period: 'month' }, ANNA).pay;
  assert.equal(m.fixed, 3000000);
  assert.equal(m.percent, 5);
  assert.equal(m.revenue_base, 200000, 'оплата до заявки и чужой пациент не в счёт');
  assert.equal(m.bonus, 10000);
  assert.equal(m.total, 3010000);
  assert.deepEqual(m.kpi_links, ['revenue']);
  const t = operatorKpi(db, { period: 'today' }, ANNA).pay;
  assert.equal(t.bonus, 10000);
  assert.equal(t.total, null, 'месячный оклад в дневной итог не входит');
  const w = operatorKpi(db, { period: 'week' }, ANNA);
  assert.equal(w.tasks.done, 1);
  assert.equal(w.tasks.overdue, 1);
});

test('не задано в карточке — оплаты нет, показатели есть', () => {
  const o = operatorKpi(db, { period: 'month' }, { id: 3, role: 'callcenter' });
  assert.equal(o.pay.configured, false);
  assert.equal(o.pay.bonus, null);
  assert.equal(o.leads.came, 1);
});

test('доступ: оператор — только себя; руководитель — любого; без CRM — отказ', () => {
  assert.throws(() => operatorKpi(db, { user_id: 3 }, ANNA), (e) => e.status === 403);
  assert.equal(operatorKpi(db, {}, ANNA).can_pick, false);
  const adm = operatorKpi(db, { user_id: 2 }, { id: 1, role: 'admin' });
  assert.equal(adm.operator.id, 2);
  assert.equal(adm.can_pick, true);
  assert.ok(adm.operators.some((x) => x.name === 'Оператор Бек'));
  assert.throws(() => operatorKpi(db, {}, { id: 4, role: 'nobody_role' }), (e) => e.status === 403);
});

// KPI_SCOPE_V1 — чужие показатели (с окладом и процентом из карточки) открываются
// только у операторов колл-центра — тех же, кого предлагает выбор руководителя
// (operatorList). Зарплату главного врача руководитель колл-центра, врач с правом
// «вся доска CRM» и администратор через этот вызов не получают.
test('KPI_SCOPE_V1: чужой KPI — только оператора из списка выбора; врача — отказ 403', () => {
  const d = seed();
  try {
    d.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
      .run('head_cc', JSON.stringify({ sections: ['crm'], levels: {}, grants: { 'crm.all': 'edit' } }));
    d.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
      .run('doc_crm', JSON.stringify({ sections: ['crm'], levels: {}, grants: { 'crm.all': 'edit' } }));
    d.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (6,'head','x','Руководитель КЦ','head_cc')").run();
    d.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, salary_type, salary_fixed, salary_percent)
               VALUES (5,'chief','x','Главврач','doctor','fix_plus_kpi',9000000,30)`).run();
    d.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, salary_type, salary_fixed)
               VALUES (7,'drcrm','x','Врач с CRM','doc_crm','fixed',5000000)`).run();
    const HEAD = { id: 6, role: 'head_cc' };
    const DRCRM = { id: 7, role: 'doc_crm' };
    const ADMIN = { id: 1, role: 'admin' };

    // Разрешено: руководитель — оператора из списка; администратор — оператора; каждый — себя.
    const anna = operatorKpi(d, { user_id: 2, period: 'month' }, HEAD);
    assert.equal(anna.operator.id, 2);
    assert.equal(anna.pay.fixed, 3000000, 'оклад оператора руководителю виден, как и раньше');
    assert.ok(anna.operators.some((o) => o.id === 2));
    assert.ok(!anna.operators.some((o) => o.id === 5), 'главврач не в списке выбора');
    assert.equal(operatorKpi(d, { user_id: 3 }, ADMIN).operator.id, 3);
    assert.equal(operatorKpi(d, {}, HEAD).operator.id, 6, 'свой KPI — всегда');
    assert.equal(operatorKpi(d, { user_id: 7, period: 'month' }, DRCRM).pay.fixed, 5000000, 'врач видит свою оплату');

    // Отказ: оклад главврача не уходит никому, кто его не он сам.
    for (const [who, u] of [['руководитель КЦ', HEAD], ['врач с crm.all', DRCRM], ['администратор', ADMIN]]) {
      assert.throws(() => operatorKpi(d, { user_id: 5, period: 'month' }, u), (e) => {
        assert.equal(e.status, 403, who + ': не 403');
        assert.equal(e.message, 'Показатели и оплату открывают только у операторов колл-центра.');
        return true;
      }, who + ' прочитал оплату главврача');
    }
    // Несуществующий и выключенный — тоже отказ, без подсказки, есть ли такой сотрудник.
    assert.throws(() => operatorKpi(d, { user_id: 999 }, HEAD), (e) => e.status === 403);
    d.prepare('UPDATE users SET is_active = 0 WHERE id = 3').run();
    assert.throws(() => operatorKpi(d, { user_id: 3 }, HEAD), (e) => e.status === 403);
  } finally { d.close(); }
});

test('RPC зарегистрирован', () => {
  assert.equal(typeof getRpc('crm_operator_kpi'), 'function');
});

// CRM_SALES_TEAM_V1 — отдел продаж по менеджерам: те же определения, что у
// «Мой KPI», деньги — оплаты пациентов, доведённых менеджером до «Пришёл»,
// после заявки; оператору чужие деньги не открываются.
test('отдел продаж: заявки и деньги по каждому менеджеру, итог без повторов', () => {
  const ADMIN = { id: 1, role: 'admin' };
  const r = salesTeamReport(db, { days: 1 }, ADMIN);
  const anna = r.managers.find((m) => m.user_id === 2);
  const bek = r.managers.find((m) => m.user_id === 3);
  assert.equal(anna.name, 'Оператор Анна');
  assert.equal(anna.total, 3);
  assert.equal(anna.came, 1);
  assert.equal(anna.scheduled, 1);
  assert.equal(anna.revenue, 200000, 'оплата до заявки (50 000) не засчитана, после — засчитана');
  assert.equal(anna.paying_patients, 1);
  assert.equal(anna.avg_check, 200000);
  assert.equal(bek.revenue, 90000);
  assert.equal(r.totals.revenue, 290000);
  assert.equal(r.totals.paying_patients, 2);
  assert.equal(r.totals.total, 4);
  // Сортировка — по деньгам: Анна (200 000) выше Бека (90 000).
  assert.ok(r.managers.indexOf(anna) < r.managers.indexOf(bek));
  // То же число, что в «Мой KPI» Анны за тот же день.
  assert.equal(operatorKpi(db, { period: 'today' }, ANNA).pay.revenue_base, anna.revenue);
});

test('отдел продаж: оператору — отказ; без CRM — отказ; RPC разрешён лапсу как чтение', async () => {
  assert.throws(() => salesTeamReport(db, { days: 30 }, ANNA), (e) => e.status === 403);
  assert.throws(() => salesTeamReport(db, { days: 30 }, { id: 4, role: 'nobody_role' }), (e) => e.status === 403);
  assert.equal(typeof getRpc('crm_sales_team_report'), 'function');
  const { isReadOnlyRpc } = await import('../control/gate.js');
  assert.ok(isReadOnlyRpc('crm_sales_team_report'));
});

// CRM_SALES_CHARTS_V1 — ряд для графиков: день — шаг, пустые дни тоже есть,
// деньги — по дню оплаты по тому же правилу, итог ряда = итог отчёта.
test('отдел продаж: ряд по дням для графиков сходится с итогами', () => {
  const r = salesTeamReport(db, { days: 7 }, { id: 1, role: 'admin' });
  assert.equal(r.step, 'day');
  assert.equal(r.series.length, 7, 'каждый день периода, и пустой тоже');
  const sum = (k) => r.series.reduce((s, x) => s + x[k], 0);
  assert.equal(sum('leads'), r.totals.total);
  assert.equal(sum('came'), r.totals.came);
  assert.equal(sum('revenue'), r.totals.revenue);
  assert.equal(salesTeamReport(db, { days: 0 }, { id: 1, role: 'admin' }).step, 'month');
});
