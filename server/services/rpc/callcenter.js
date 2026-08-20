// CALLCENTER_REPORT_V1 — «Отчёты → Колл-центр».
//
// Отвечает на вопросы, которые задают о работе стойки: сколько заявок приняли,
// КОГДА их принимают (самые загруженные часы и дни), чем они кончаются и кто из
// операторов сколько довёл до визита.
//
// Время. Заявки хранятся в UTC; всё временное здесь считается в МЕСТНОМ времени
// клиники через domain/day.js. Без перевода при UTC+5 «пик в 14:00» показался бы
// как 09:00 — час, когда стойка ещё пустая, и отчёт спорил бы сам с собой.
//
// Филиал. У crm_requests нет branch_id: заявка приходит в клинику, а не в
// филиал. Поэтому отчёт филиалом НЕ фильтруется, и селектор филиалов на экране
// скрыт — фильтр, который молча ничего не делает, хуже отсутствующего.

import { localDate, localHour, localWeekday, inLocalRange } from '../domain/day.js';

const STATUS_RU = {
  in_process: 'В работе', scheduled: 'Записан', came: 'Пришёл',
  no_show: 'Не пришёл', stopped: 'Отказ', not_qualified: 'Не целевой',
  converted: 'Конвертирован', recall: 'Перезвонить',
};
const SOURCE_RU = {
  call: 'Звонок', instagram: 'Instagram', website: 'Сайт', telegram: 'Telegram',
  walkin: 'Пришёл сам', referral: 'Рекомендация', other: 'Другое',
};
const WEEKDAY_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const pct = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

export function callcenterReport(db, args, _user) {
  const from = String((args && args.from) || '').slice(0, 10);
  const to = String((args && args.to) || '').slice(0, 10);
  const where = `WHERE ${inLocalRange('r.created_at')}`;
  const p = [from, to];

  const kpiRow = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(r.status = 'came')                       AS came,
           SUM(r.status = 'scheduled')                  AS scheduled,
           SUM(r.status = 'no_show')                    AS no_show,
           SUM(r.status IN ('stopped','not_qualified')) AS lost,
           SUM(r.patient_id IS NOT NULL)                AS became_patient,
           SUM(r.scheduled_date IS NOT NULL AND r.scheduled_date <> '') AS with_date
      FROM crm_requests r ${where}`).get(...p);

  const total = kpiRow.total || 0;

  // Сколько дней проходит от заявки до назначенной даты — показывает, на сколько
  // вперёд забита запись. Считаем только там, где дата есть.
  const lag = db.prepare(`
    SELECT AVG(julianday(r.scheduled_date) - julianday(${localDate('r.created_at')})) AS d
      FROM crm_requests r ${where}
       AND r.scheduled_date IS NOT NULL AND r.scheduled_date <> ''`).get(...p);

  // Все 24 часа и все 7 дней присутствуют всегда: пустой час — это ТОЖЕ факт
  // («в 8 утра не звонят»), а график с дырками читается как сбой загрузки.
  const hourRaw = new Map(db.prepare(`
    SELECT ${localHour('r.created_at')} AS h, COUNT(*) AS c
      FROM crm_requests r ${where} GROUP BY h`).all(...p).map((x) => [x.h, x.c]));
  const byHour = Array.from({ length: 24 }, (_, i) => {
    const hour = String(i).padStart(2, '0');
    return { hour, count: hourRaw.get(hour) || 0 };
  });

  const wdRaw = new Map(db.prepare(`
    SELECT ${localWeekday('r.created_at')} AS w, COUNT(*) AS c
      FROM crm_requests r ${where} GROUP BY w`).all(...p).map((x) => [x.w, x.c]));
  const byWeekday = Array.from({ length: 7 }, (_, i) => ({
    weekday: String(i), label: WEEKDAY_RU[i], count: wdRaw.get(String(i)) || 0,
  }));

  const byDay = db.prepare(`
    SELECT ${localDate('r.created_at')} AS day, COUNT(*) AS count
      FROM crm_requests r ${where} GROUP BY day ORDER BY day`).all(...p);

  const byStatus = db.prepare(`
    SELECT r.status AS status, COUNT(*) AS count
      FROM crm_requests r ${where} GROUP BY r.status ORDER BY count DESC`).all(...p)
    .map((x) => ({ ...x, label: STATUS_RU[x.status] || x.status }));

  const bySource = db.prepare(`
    SELECT r.source AS source, COUNT(*) AS count
      FROM crm_requests r ${where} GROUP BY r.source ORDER BY count DESC`).all(...p)
    .map((x) => ({ ...x, label: SOURCE_RU[x.source] || x.source || '—' }));

  // По оператору — не только объём, но и доля дошедших: сто заявок, из которых
  // никто не пришёл, это не работа.
  const byOperator = db.prepare(`
    SELECT COALESCE(u.full_name, '—') AS name, COUNT(*) AS count, SUM(r.status = 'came') AS came
      FROM crm_requests r LEFT JOIN users u ON u.id = r.created_by
     ${where} GROUP BY r.created_by ORDER BY count DESC`).all(...p)
    .map((x) => ({ ...x, came: x.came || 0, came_pct: pct(x.came || 0, x.count) }));

  // Что именно спрашивают. Строки заявки (crm_request_services) — источник
  // точнее, чем crm_requests.service_id: он хранит лишь первую услугу.
  const topServices = db.prepare(`
    SELECT COALESCE(s.name, '—') AS name, COUNT(*) AS count
      FROM crm_request_services cs
      JOIN crm_requests r ON r.id = cs.request_id
      LEFT JOIN services s ON s.id = cs.service_id
     ${where} GROUP BY cs.service_id ORDER BY count DESC LIMIT 12`).all(...p);
  if (!topServices.length) {
    // Ни одной строки услуг — падаем на service_id самой заявки, иначе у клиники
    // без crm_request_services блок пустой, хотя услуга в заявке названа.
    topServices.push(...db.prepare(`
      SELECT COALESCE(s.name, '—') AS name, COUNT(*) AS count
        FROM crm_requests r LEFT JOIN services s ON s.id = r.service_id
       ${where} AND r.service_id IS NOT NULL GROUP BY r.service_id ORDER BY count DESC LIMIT 12`).all(...p));
  }

  // CC_BY_SERVICE_TYPE_V1 — спрос по ГРУППАМ услуг, а не по отдельным строкам.
  //
  // «Что спрашивают» отвечает на вопрос «какая услуга популярна», но не на
  // вопрос «куда вообще идёт поток»: двенадцать строк консультаций разных
  // врачей читаются как двенадцать разных вещей, хотя это один спрос — приём.
  // Группируем по services.type_id (service_types: Консультации, Диагностика,
  // Лаборатория, Процедуры) — это единственная заполненная классификация:
  // category_id в базе не используется ни одной услугой.
  //
  // Услуги без типа собираем в «Без группы», а не прячем: пропавшие из суммы
  // заявки выглядят как ошибка отчёта.
  const typeSql = (from, extra = '') => `
    SELECT COALESCE(st.name, 'Без группы') AS name, COUNT(*) AS count
      FROM ${from}
     ${where} ${extra}
     GROUP BY COALESCE(st.id, -1) ORDER BY count DESC`;

  let byServiceType = db.prepare(typeSql(`crm_request_services cs
      JOIN crm_requests r ON r.id = cs.request_id
      LEFT JOIN services s      ON s.id = cs.service_id
      LEFT JOIN service_types st ON st.id = s.type_id`)).all(...p);
  if (!byServiceType.length) {
    // Та же подстраховка, что и у topServices: клиника без строк услуг всё
    // равно называет услугу в самой заявке.
    byServiceType = db.prepare(typeSql(`crm_requests r
      LEFT JOIN services s      ON s.id = r.service_id
      LEFT JOIN service_types st ON st.id = s.type_id`, 'AND r.service_id IS NOT NULL')).all(...p);
  }

    // CC_LAST30_V1 — заявки по дням за последние 30 дней, НЕЗАВИСИМО от выбранного
  // периода.
  //
  // «Динамика по дням» рисует выбранный диапазон, а на вопрос «мы растём или
  // падаем?» нужен один и тот же горизонт, иначе два открытия отчёта с разными
  // фильтрами дают несравнимые картинки. 30 дней — это две полные рабочие
  // недели плюс сравнение с предыдущими двумя.
  //
  // Пустые дни присутствуют в ряду обязательно: провал в среду — это факт, а
  // график, где такой день просто отсутствует, показывает ровную линию и врёт.
  const L30_DAYS = 30;
  const last30Raw = new Map(db.prepare(`
    SELECT ${localDate('r.created_at')} AS day, COUNT(*) AS count
      FROM crm_requests r
     WHERE ${localDate('r.created_at')} > date('now','localtime','-${L30_DAYS} days')
       AND ${localDate('r.created_at')} <= date('now','localtime')
     GROUP BY day`).all().map((x) => [x.day, x.count]));

  const todayLocal = db.prepare("SELECT date('now','localtime') d").get().d;
  const last30 = [];
  for (let i = L30_DAYS - 1; i >= 0; i--) {
    const day = db.prepare("SELECT date(?, '-' || ? || ' days') d").get(todayLocal, i).d;
    last30.push({ day, count: last30Raw.get(day) || 0 });
  }

  // Тренд: последние 7 дней против предыдущих 7. Неделя к неделе гасит
  // выходные — сравнение «вторник против воскресенья» показывало бы падение
  // каждую неделю. Половины по 15 дней слишком инертны, чтобы заметить
  // разворот.
  const sum = (arr) => arr.reduce((n, x) => n + x.count, 0);
  const cur = sum(last30.slice(-7));
  const prev = sum(last30.slice(-14, -7));
  const trend = {
    current: cur, previous: prev,
    delta_pct: prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : (cur > 0 ? null : 0),
    direction: cur > prev ? 'up' : cur < prev ? 'down' : 'flat',
    days: L30_DAYS,
  };

    // CC_OPS_V1 — три показателя, которых стойке не хватало. Все три отвечают на
  // вопрос «что делать сейчас», а не «как было»: остальные карточки описывают
  // прошедший период, и по ним нельзя принять ни одного решения сегодня.

  // 1. Конверсия по источникам. «Источники» показывают только объём, а канал с
  //    сорока заявками и конверсией 5% хуже канала с десятью и 60% — по
  //    столбикам объёма это неразличимо, и деньги уходят не туда.
  const sourceConv = db.prepare(`
    SELECT r.source AS src, COUNT(*) AS count, SUM(r.status = 'came') AS came
      FROM crm_requests r ${where} GROUP BY r.source ORDER BY count DESC`).all(...p)
    .map((x) => ({
      name: SOURCE_RU[x.src] || x.src || 'Другое',
      count: x.count, came: x.came || 0, came_pct: pct(x.came || 0, x.count),
    }));

  // 2. Заявки без движения. Лид в работе, которого не трогали несколько дней, —
  //    это потерянный пациент, и узнать о нём из отчёта за период нельзя: там
  //    он просто одна из строк воронки. Считаем по updated_at (последнее
  //    касание), а не по created_at: заявку, с которой вчера работали, «висящей»
  //    называть нельзя.
  //
  //    Периодом НЕ фильтруется: зависшая заявка не перестаёт быть зависшей
  //    оттого, что оператор выбрал другой диапазон дат.
  const staleRows = db.prepare(`
    SELECT r.id, r.full_name, r.phone, r.status,
           CAST(julianday('now','localtime') - julianday(COALESCE(r.updated_at, r.created_at), 'localtime') AS INTEGER) AS days,
           COALESCE(u.full_name, '—') AS operator
      FROM crm_requests r LEFT JOIN users u ON u.id = r.created_by
     WHERE r.status IN ('in_process','recall')
     ORDER BY days DESC LIMIT 200`).all()
    .filter((x) => (x.days || 0) >= 3);

  const stale = {
    total: staleRows.length,
    buckets: [
      { label: '3–7 дней',  count: staleRows.filter((x) => x.days >= 3 && x.days < 7).length },
      { label: '7–14 дней', count: staleRows.filter((x) => x.days >= 7 && x.days < 14).length },
      { label: 'больше 14', count: staleRows.filter((x) => x.days >= 14).length },
    ],
    // Несколько самых давних — чтобы список можно было отработать руками,
    // а не просто посмотреть на цифру.
    oldest: staleRows.slice(0, 6).map((x) => ({
      name: x.full_name || '—', phone: x.phone || '', days: x.days,
      status: STATUS_RU[x.status] || x.status, operator: x.operator,
    })),
  };

  // 3. Запись вперёд по дням. Стойка ЗАПИСЫВАЕТ — и должна видеть, чем занят
  //    ближайший день, а чем нет: «на завтра двенадцать, на четверг пусто» это
  //    указание, кому звонить. Смотрит в БУДУЩЕЕ, поэтому периодом тоже не
  //    фильтруется.
  const FWD_DAYS = 14;
  let fwdRaw = db.prepare(`
    SELECT cs.scheduled_date AS day, COUNT(DISTINCT cs.request_id) AS count
      FROM crm_request_services cs
     WHERE cs.status = 'pending' AND cs.scheduled_date IS NOT NULL
       AND cs.scheduled_date >= date('now','localtime')
       AND cs.scheduled_date <= date('now','localtime','+${FWD_DAYS - 1} days')
     GROUP BY day`).all();
  if (!fwdRaw.length) {
    // Клиника без построчных услуг всё равно ставит дату в самой заявке.
    fwdRaw = db.prepare(`
      SELECT r.scheduled_date AS day, COUNT(*) AS count
        FROM crm_requests r
       WHERE r.scheduled_date IS NOT NULL AND r.scheduled_date <> ''
         AND r.scheduled_date >= date('now','localtime')
         AND r.scheduled_date <= date('now','localtime','+${FWD_DAYS - 1} days')
       GROUP BY day`).all();
  }
  const fwdMap = new Map(fwdRaw.map((x) => [x.day, x.count]));
  const todayFwd = db.prepare("SELECT date('now','localtime') d").get().d;
  const forwardBook = [];
  for (let i = 0; i < FWD_DAYS; i++) {
    const day = db.prepare("SELECT date(?, '+' || ? || ' days') d").get(todayFwd, i).d;
    // Пустые дни на месте: дыра в расписании — это и есть повод позвонить.
    forwardBook.push({ day, count: fwdMap.get(day) || 0 });
  }


  const peakHour = byHour.reduce((best, x) => (x.count > (best ? best.count : 0) ? x : best), null);
  const peakDay = byWeekday.reduce((best, x) => (x.count > (best ? best.count : 0) ? x : best), null);

  // Плоские строки для Excel: одна заявка — одна строка, чтобы стойка могла
  // свести их по-своему, не дожидаясь нового графика.
  const columns = ['Дата', 'Час', 'Имя', 'Телефон', 'Источник', 'Статус', 'Оператор', 'Услуга', 'Дата записи', 'Стал пациентом'];
  const rows = db.prepare(`
    SELECT ${localDate('r.created_at')} AS day, ${localHour('r.created_at')} AS hour,
           r.full_name AS name, r.phone AS phone, r.source AS source, r.status AS status,
           COALESCE(u.full_name, '—') AS operator, COALESCE(s.name, '') AS service,
           COALESCE(r.scheduled_date, '') AS sched, (r.patient_id IS NOT NULL) AS converted
      FROM crm_requests r
      LEFT JOIN users u ON u.id = r.created_by
      LEFT JOIN services s ON s.id = r.service_id
     ${where} ORDER BY r.created_at DESC`).all(...p)
    .map((x) => [x.day, x.hour, x.name || '', x.phone || '',
      SOURCE_RU[x.source] || x.source || '', STATUS_RU[x.status] || x.status,
      x.operator, x.service, x.sched, x.converted ? 'да' : 'нет']);

  return {
    kpi: {
      total,
      came: kpiRow.came || 0, came_pct: pct(kpiRow.came || 0, total),
      scheduled: kpiRow.scheduled || 0,
      no_show: kpiRow.no_show || 0, no_show_pct: pct(kpiRow.no_show || 0, total),
      lost: kpiRow.lost || 0,
      became_patient: kpiRow.became_patient || 0, became_patient_pct: pct(kpiRow.became_patient || 0, total),
      with_date: kpiRow.with_date || 0,
      avg_lead_days: lag && lag.d != null ? Math.round(lag.d * 10) / 10 : null,
    },
    peak: {
      hour: peakHour && peakHour.count ? peakHour.hour : null,
      hour_count: peakHour ? peakHour.count : 0,
      weekday: peakDay && peakDay.count ? peakDay.label : null,
      weekday_count: peakDay ? peakDay.count : 0,
    },
    byHour, byWeekday, byDay, byStatus, bySource, byOperator, topServices, byServiceType,
    sourceConv, stale, forwardBook,
    last30, trend,
    columns, rows,
  };
}
