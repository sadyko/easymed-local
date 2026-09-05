// notifications.js — NOTIF_CENTER_V1
// Unifies the trial / company / license / branch banners into ONE notification model with two
// surfaces: a topbar BELL (red unread count + dropdown) and a dismissible top-banner stack.
// Auto-resolving: when a condition is met the item drops out of both surfaces and its dismiss
// flag clears. Dismissing a banner hides it (per clinic+user, localStorage) but it stays in the
// bell until resolved. Replaces renderTrialBanner / renderVerificationBanner / renderSetupChecklist.
import { supabase } from '../supabase.js';
import { h, Icon } from './ui.js';
import { tr, trf } from './i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { openUploadModal } from './verify-banner.js?v=vb2';

let _styled = false;
function injectStyles() {
    if (_styled) return; _styled = true;
    const s = document.createElement('style');
    s.textContent = `
.em-bell{position:relative;width:38px;height:38px;border-radius:10px;border:1px solid #e2e8f0;background:#fff;color:#475569;display:grid;place-items:center;cursor:pointer;font-family:inherit;}
.em-bell:hover{background:#f8fafc;color:#0d8a72;}
.em-bell-badge{position:absolute;top:-5px;right:-5px;min-width:17px;height:17px;padding:0 4px;border-radius:999px;background:#e11d48;color:#fff;font-size:12.5px;font-weight:700;display:grid;place-items:center;line-height:1;box-shadow:0 0 0 2px #fff;}
#em-notif-dropdown{position:absolute;top:46px;right:0;width:340px;max-width:92vw;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 16px 40px rgba(13,30,44,.18);z-index:1000;overflow:hidden;}
#em-notif-dropdown .nd-head{padding:12px 14px;border-bottom:1px solid #eef2f4;font-weight:700;font-size:13.5px;color:#0b3a33;}
#em-notif-dropdown .nd-item{display:flex;gap:11px;padding:12px 14px;border-bottom:1px solid #f1f5f9;}
#em-notif-dropdown .nd-item:last-child{border-bottom:none;}
#em-notif-dropdown .nd-icon{width:30px;height:30px;border-radius:8px;flex:0 0 30px;display:grid;place-items:center;background:#e3f1ec;color:#0d8a72;}
#em-notif-dropdown .nd-item.warn .nd-icon{background:#fff4e0;color:#b45309;}
#em-notif-dropdown .nd-item.danger .nd-icon{background:#ffe4e6;color:#be123c;}
#em-notif-dropdown .nd-body{flex:1;min-width:0;}
#em-notif-dropdown .nd-title{font-weight:600;font-size:13.5px;color:#0c2a26;}
#em-notif-dropdown .nd-msg{font-size:12.5px;color:#5d7d75;margin-top:1px;line-height:1.4;}
#em-notif-dropdown .nd-cta{margin-top:7px;border:1px solid #0d8a72;background:#fff;color:#0a6e61;border-radius:7px;padding:5px 11px;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;}
#em-notif-dropdown .nd-cta:hover{background:#0d8a72;color:#fff;}
#em-notif-dropdown .nd-empty{padding:26px 14px;text-align:center;color:#94a3b8;font-size:13.5px;}
#em-notif-banners{display:flex;flex-direction:column;}
.em-nbn{display:flex;align-items:center;gap:12px;padding:10px 18px;font-size:13.5px;border-bottom:1px solid #eef2f4;background:#f4faf8;color:#0c2a26;}
.em-nbn.warn{background:#fff7ed;border-bottom-color:#fed7aa;color:#7c2d12;}
.em-nbn.danger{background:#fff1f2;border-bottom-color:#fecdd3;color:#9f1239;}
.em-nbn .nbn-msg{flex:1;min-width:0;display:flex;align-items:center;gap:8px;line-height:1.4;}
.em-nbn .nbn-cta{flex:0 0 auto;border:none;border-radius:8px;padding:7px 14px;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;background:#0d8a72;color:#fff;}
.em-nbn.warn .nbn-cta{background:#ea7a18;}
.em-nbn.danger .nbn-cta{background:#e11d48;}
.em-nbn .nbn-x{flex:0 0 auto;border:none;background:transparent;color:inherit;opacity:.6;font-size:17px;line-height:1;cursor:pointer;padding:2px 7px;border-radius:6px;}
.em-nbn .nbn-x:hover{opacity:1;background:rgba(0,0,0,.06);}`;
    document.head.appendChild(s);
}

function companyComplete(co) { return !!(co && co.name && co.phone && co.address); }

function nav(view) { try { window.easymed?.navigate?.(view); } catch (e) {} closeDropdown(); }

// NOTIF_LOCAL_ONLY_V1 — запрашиваем ТОЛЬКО то, что существует локально.
//
// Прежний loadState был наследием SaaS-версии: просил у companies колонки
// plan / trial_ends_at / is_locked / verification_status / name_ru, у branches —
// name_ru / district / company_id, и ходил в шлюз /public-site/dashboard.
// НИ ОДНОЙ из этих колонок в локальной базе нет, шлюза нет тоже — оба запроса
// падали 400 при КАЖДОЙ загрузке страницы с первого дня локальной версии.
// try/catch глотал ошибку, поэтому никто не видел; лог db-client её показал.
// Уведомления о пробном периоде и профиле филиала локально невозможны в
// принципе — убраны вместе с запросами, а не спрятаны обратно под catch.
async function loadState(clinic) {
    let co = null;
    try {
        const { data } = await supabase.from('companies')
            .select('id,name,phone,address').eq('id', clinic.id).limit(1);
        co = data && data[0];
    } catch (e) { /* нет строки — нет и напоминания */ }
    return { co, inpatient: await loadInpatient() };
}

// ===========================================================================
// INPATIENT_REQUEST_NOTIF_V1 (2026-09-05) — ЗАЯВКА СТАЦИОНАРА ЗВОНИТ В КОЛОКОЛ
// ===========================================================================
// Владелец: «we cannot see the request admissions. also the request admission
// should have come as notifications.»
//
// ЧТО ОКАЗАЛОСЬ ПРИЧИНОЙ. Не запрос, не право и не вкладка: раздел «Стационар»
// поднимается и показывает заявку КАЖДОЙ роли, которой он положен (проверено
// живьём против настоящего сервера — см. inpatient-notifications.test.mjs).
// Сломано было не «увидеть», а «узнать»: заявку не объявлял НИКТО. У раздела
// нет счётчика в боковой панели (navCounts в admin.js знает пациентов, чат и
// кассу — стационара там нет), колокол считал ровно одно уведомление про
// незаполненный профиль клиники, а единственное сообщение, которое заявка
// вообще порождала, — тост в кабинете ВРАЧА, то есть у того, кто её и подал.
// Пост медсестры узнавал о заявке, только если кто-то сам открывал «Стационар»
// и смотрел. Это и есть обе половины жалобы одной строкой.
//
// ─── ПОЧЕМУ ЭТО СЧИТАЕТСЯ, А НЕ ХРАНИТСЯ ────────────────────────────────────
// Механизм уведомлений здесь — ВЫЧИСЛЯЕМЫЙ (см. шапку файла): уведомление это
// не строка в таблице с адресатом и отметкой «прочитано», а УСЛОВИЕ, которое
// каждый браузер проверяет у себя. Заводить рядом вторую, хранимую машину
// (очередь доставки, список получателей, отметки прочтения) значило бы держать
// два разных ответа на вопрос «есть ли работа» — и однажды они разойдутся.
//
// ─── КАК РАЗРЕШЁН «МЕХАНИЗМ ПОФАМИЛЬНЫЙ, А РАБОТА ПОРОЛЕВАЯ» ────────────────
// Никак не разрешён — вопрос снимается сам. Раз уведомление вычисляется в
// сеансе смотрящего, получатель это не адрес, а ПРЕДИКАТ: «вправе ли ЭТОТ
// человек сделать следующий шаг». Спрашиваем ровно там, где спрашивает сам
// экран, — у сервера (`inpatient_capabilities`, матрица TRANSITION_ROLES в
// rpc/inpatient-flow.js). Вторая копия списка ролей здесь разошлась бы с
// первой в день правки матрицы: медсестре перестали бы звонить, а кассиру
// начали. Фан-аута нет, дублей доставки нет, «кто прочитал» вести не нужно.
//
//   can.admit   — кто КЛАДЁТ на койку (медсестра, старшая, главный врач,
//                 админ): им «Ждут размещения».
//   can.examine — кто ПРОВОДИТ первичный осмотр (главный врач, админ): им
//                 «Ждут первичного осмотра» — следующий шаг маршрута.
//
// ─── ЧТО ГАСИТ УВЕДОМЛЕНИЕ ──────────────────────────────────────────────────
// СОСТОЯНИЕ ПАЦИЕНТА, и только оно. Уведомление утверждает «есть человек,
// которого никто не положил»; положили — 'ordered' стал 'admitted', и строка
// уходит из выборки сама. Осмотрели — 'admitted' стал 'examined', уходит
// вторая. Отменили заявку — уходит тоже.
//
// НЕ «кто-то открыл» и НЕ «кто-то нажал крестик»: ни то, ни другое пациента не
// размещает. Погасни оно от прочтения — напоминание исчезло бы у той смены,
// которая на него посмотрела, и не вернулось бы; это ровно та беда, из-за
// которой заявка и терялась. Крестик у баннера в этом файле и так гасит только
// баннер, а в колоколе строка остаётся до выполнения — договор NOTIF_CENTER_V1,
// и он здесь не нарушается: очереди смены баннера не получают вовсе (bellOnly
// ниже) — полоса поперёк каждого экрана на всю смену это шум, а не сигнал.
//
// ─── ОДНА СТРОКА НА ОЧЕРЕДЬ, А НЕ НА ЗАЯВКУ ─────────────────────────────────
// Отсюда «ничто не уведомляет дважды об одной заявке» — не проверкой на дубль,
// а формой: у пункта постоянный id ('inpatient-orders' / 'inpatient-exam') и
// ЧИСЛО в тексте. Десять заявок — одна строка «Ждут размещения: 10», десять
// перерисовок — та же одна строка.
//
// ─── ЧУЖОЕ ЗДАНИЕ ───────────────────────────────────────────────────────────
// Вопрос снимается схемой: `admissions` НЕ ЕЗДИТ между филиалами. Её нет в
// SHIPPED (services/branch-sync/journal.js — там только patients, visits,
// visit_services, lab_results, invoices, invoice_items, payments), у неё нет ни
// uid, ни sync_origin, ни журнальных триггеров (шапка миграции 091 говорит это
// дословно и на этом основывает безопасность пересборки таблицы). Заявка,
// оформленная в другом здании, в эту базу не попадает вовсе — «чужих» заявок не
// существует, и фильтровать по колонке, которой нет, нельзя. Если однажды
// admissions начнут возить, тест `foreign` в inpatient-notifications.test.mjs
// упадёт, и решение придётся принять осознанно, а не унаследовать молча.
const OPEN_REQUEST_STATUSES = ['ordered', 'admitted'];

async function loadInpatient() {
    let can = null;
    try {
        const { data, error } = await supabase.rpc('inpatient_capabilities', {});
        if (error) return null;
        can = (data && data.can) || {};
    } catch (e) { return null; }
    // Ни класть, ни осматривать — значит это не его работа, и звонить ему не о
    // чем. Заодно это единственный запрос, который здесь вообще делается: у
    // кассы и склада колокол не ходит в стационар ни разу.
    if (!can.admit && !can.examine) return null;
    try {
        const { data, error } = await supabase.from('admissions')
            .select('id, status, admission_type, created_by, ordered_by')
            .in('status', OPEN_REQUEST_STATUSES).limit(200);
        if (error) return null;
        return { can, rows: data || [] };
    } catch (e) { return null; }
}

/** Кто сейчас смотрит. null — неизвестен, и тогда никого не исключаем. */
function viewerId() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    return u && u.id != null ? String(u.id) : null;
}

// АВТОР ЗАЯВКИ — по обеим колонкам, потому что входов два и пишут они разное:
// заявка регистратуры (admission_order_create) ставит ordered_by И created_by,
// направление врача из кабинета (request_admission) — только created_by.
// Проверять одну ordered_by значило бы звонить врачу о его же направлении.
function filedBy(row, me) {
    if (me == null) return false;
    return String(row.created_by) === me || String(row.ordered_by) === me;
}

function buildNotifs(clinic, st) {
    const { co, inpatient } = st;
    const list = [];
    // NOTIF_POLICY_V2 (owner, 2026-07-21): напоминание срабатывает только по реально
    // ПРОЧИТАННОЙ и действительно неполной строке.
    if (co && !companyComplete(co)) list.push({ id: 'company', sev: 'info', icon: 'Building',
        title: 'Данные клиники', message: 'Заполните название, телефон и адрес клиники.',
        ctaLabel: 'Заполнить', onCta: () => nav('settings:companies') });

    if (inpatient) {
        const me = viewerId();
        if (inpatient.can.admit) {
            // СЕБЕ НЕ ЗВОНИМ: тот, кто минуту назад оформил заявку, уже знает о
            // ней — ему про неё сказал тост в момент оформления. Колокол,
            // повторяющий человеку его собственное действие, учит не смотреть
            // на колокол.
            const waiting = inpatient.rows.filter((r) => r.status === 'ordered' && !filedBy(r, me));
            if (waiting.length) {
                // Экстренная не должна тонуть среди плановых и в колоколе тоже:
                // она красит строку и называет себя словом, а не оттенком.
                const urgent = waiting.some((r) => r.admission_type === 'emergency');
                list.push({
                    id: 'inpatient-orders', sev: urgent ? 'danger' : 'warn', icon: 'Bed', bellOnly: true,
                    title: tr('Заявки на госпитализацию'),
                    message: urgent
                        ? trf('Ждут размещения: {n}. Среди них экстренная.', { n: waiting.length })
                        : trf('Ждут размещения: {n}.', { n: waiting.length }),
                    ctaLabel: tr('Открыть стационар'),
                    onCta: () => nav('admissions'),
                });
            }
        }
        if (inpatient.can.examine) {
            // ЗДЕСЬ АВТОРА НЕ ИСКЛЮЧАЕМ, и это отдельное решение, а не забытая
            // симметрия. Первичный осмотр проводит главный врач и только он;
            // если он же и положил пациента, осмотр всё равно за ним, и убрать
            // у него единственное напоминание значило бы спрятать ту самую
            // очередь, ради которой она заведена: пациент лежит, койка занята,
            // суточное идёт — а лечения нет.
            const exam = inpatient.rows.filter((r) => r.status === 'admitted');
            if (exam.length) list.push({
                id: 'inpatient-exam', sev: 'warn', icon: 'Stethoscope', bellOnly: true,
                title: tr('Ждут первичного осмотра'),
                message: trf('Пациентов без первичного осмотра: {n}.', { n: exam.length }),
                ctaLabel: tr('Открыть стационар'),
                onCta: () => nav('admissions'),
            });
        }
    }
    return list;
}

function dismKey(clinic) { const u = (window.easymed && window.easymed.state && window.easymed.state.user) || {}; return 'em.notif.dismissed.' + (clinic.id || 'x') + '.' + (u.id || u.auth_user_id || 'x'); }
function getDismissed(clinic) { try { return JSON.parse(localStorage.getItem(dismKey(clinic)) || '[]'); } catch (e) { return []; } }
function setDismissed(clinic, ids) { try { localStorage.setItem(dismKey(clinic), JSON.stringify(ids)); } catch (e) {} }

function closeDropdown() { document.getElementById('em-notif-dropdown')?.remove(); }

let _docBound = false;
function bindOutsideClose() {
    if (_docBound) return; _docBound = true;
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('em-notif-dropdown');
        if (dd && !dd.contains(e.target) && !e.target.closest('.em-bell')) dd.remove();
    });
}

// INPATIENT_REQUEST_NOTIF_V1 — КОЛОКОЛ ОБЯЗАН ОБНОВЛЯТЬСЯ САМ.
//
// До сих пор renderNotifications звали ОДИН раз, при входе (admin.js), и этого
// хватало: единственное уведомление говорило о незаполненном профиле клиники —
// условии, которое за смену не меняется. Заявка на госпитализацию меняется
// каждый час, и колокол, который узнаёт о ней только после F5, для поста
// медсестры бесполезен ровно так же, как его отсутствие.
//
// Свой таймер, а не чужой: счётчики боковой панели (loadNavCounts, каждые 20 с)
// живут в admin.js, и вешать на них второй смысл значило бы связать два
// механизма, которые чинят и ломают по отдельности. Минута — потому что это
// напоминание, а не сигнал тревоги: у экрана «Стационар» есть своя кнопка
// «Обновить», и тот, кто ждёт заявку прямо сейчас, стоит на нём.
const POLL_MS = 60000;
let _timer = null;

/** Остановить самообновление (выход из сеанса, тесты). */
export function stopNotificationsPolling() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

export async function renderNotifications(clinic, opts = {}) {
    const poll = opts.poll !== false;
    injectStyles(); bindOutsideClose();
    // Перерисовка НЕ ВЫРЫВАЕТ ОТКРЫТЫЙ СПИСОК ИЗ-ПОД РУКИ: paintBell чистит
    // mount, а выпадающий список лежит в нём же. ТИК ТАЙМЕРА, попавший на
    // открытый список, пропускается — следующий придёт через минуту. Условие
    // именно на `polled`, а не на «нас позвали без повтора»: явный вызов
    // (вход в систему, тест) обязан перерисовать колокол всегда.
    if (opts.polled && typeof document !== 'undefined' && document.getElementById('em-notif-dropdown')) return;
    document.getElementById('em-notif-banners')?.remove();
    if (!clinic || !clinic.id) { paintBell([], clinic); return; }
    const st = await loadState(clinic);
    const notifs = buildNotifs(clinic, st);
    const active = new Set(notifs.map((n) => n.id));
    const dism = getDismissed(clinic).filter((id) => active.has(id));
    setDismissed(clinic, dism);
    paintBell(notifs, clinic);
    paintBanners(notifs, clinic, dism);
    if (poll && typeof setInterval === 'function') {
        stopNotificationsPolling();
        _timer = setInterval(() => {
            renderNotifications(clinic, { poll: false, polled: true }).catch(() => { /* подсказка, не операция */ });
        }, POLL_MS);
    }
}

function paintBell(notifs, clinic) {
    const mount = document.getElementById('topbar-bell');
    if (!mount) return;
    mount.innerHTML = '';
    const count = notifs.length;
    const btn = h('button', { class: 'em-bell', type: 'button', title: 'Уведомления',
        onclick: (e) => { e.stopPropagation(); if (document.getElementById('em-notif-dropdown')) { closeDropdown(); return; } openDropdown(notifs, clinic, mount); } },
        Icon('Bell', { size: 18 }),
        count > 0 ? h('span', { class: 'em-bell-badge' }, count > 9 ? '9+' : String(count)) : '');
    mount.appendChild(btn);
}

function openDropdown(notifs, clinic, mount) {
    closeDropdown();
    const dd = h('div', { id: 'em-notif-dropdown' },
        h('div', { class: 'nd-head' }, 'Уведомления'),
        notifs.length === 0
            ? h('div', { class: 'nd-empty' }, 'Всё в порядке — уведомлений нет.')
            : h('div', null, ...notifs.map((n) => h('div', { class: 'nd-item ' + (n.sev || 'info') },
                h('div', { class: 'nd-icon' }, Icon(n.icon || 'Info', { size: 15 })),
                h('div', { class: 'nd-body' },
                    h('div', { class: 'nd-title' }, n.title),
                    h('div', { class: 'nd-msg' }, n.message),
                    h('button', { class: 'nd-cta', type: 'button', onclick: n.onCta }, n.ctaLabel))))));
    mount.appendChild(dd);
}

function paintBanners(notifs, clinic, dism) {
    // bellOnly — очереди смены (INPATIENT_REQUEST_NOTIF_V1). Баннер это полоса
    // поперёк КАЖДОГО экрана, и место ей там, где условие касается всей клиники
    // и держится днями (незаполненный профиль, лицензия). Работа, которая
    // появляется и уходит по нескольку раз за смену, в баннере превращается в
    // мигающую ленту, которую перестают читать; ей место в колоколе, где её
    // видно числом и открывают по нажатию.
    const visible = notifs.filter((n) => !n.bellOnly && !dism.includes(n.id));
    if (!visible.length) return;
    const wrap = h('div', { id: 'em-notif-banners' }, ...visible.map((n) => {
        const row = h('div', { class: 'em-nbn ' + (n.sev || 'info') },
            h('span', { class: 'nbn-msg' }, Icon(n.icon || 'Info', { size: 15 }), n.message),
            h('button', { class: 'nbn-cta', type: 'button', onclick: n.onCta }, n.ctaLabel),
            h('button', { class: 'nbn-x', type: 'button', title: 'Скрыть', onclick: () => {
                const d = getDismissed(clinic); if (!d.includes(n.id)) d.push(n.id); setDismissed(clinic, d); row.remove();
                if (!document.querySelector('#em-notif-banners .em-nbn')) document.getElementById('em-notif-banners')?.remove();
            } }, '×'));
        return row;
    }));
    const root = document.querySelector('.app') || document.body.firstChild;
    document.body.insertBefore(wrap, root);
}
