// Visit wizard — VISIT_WIZARD_LOCAL_V1 — the full-screen «Добавить услугу к
// визиту» flow from production easymed (service-picker-modal.js / BOOK_WIZARD_V1),
// rebuilt lean on the local /api. Four steps:
//   ① Услуги и пациент — service catalog with search + category chips, СМЕТА rail
//   ② Направление      — дата/время, врач, тип визита, источник направления
//   ③ Кто платит       — самооплата или плательщик (payers)
//   ④ Подтверждение    — summary; creates visit + visit_services (+ invoice)
//
// On confirm: inserts the visit, one visit_services row per line, then (opt-in
// checkbox, default on) raises the invoice via create_invoice_for_visit so the
// visit lands in the cashier's «Приём оплат» immediately. If a payer other than
// самооплата is chosen it is saved to patients.payer_id (the local schema has
// no per-invoice payer column — the patient card's «Страховка» tile reads the
// same field, so the two stay coherent).
//
// Local notes: service categories are derived (is_lab + name heuristics) since
// services has no category column.
//
// WIZ_TEMPLATES_LOCAL_V1 — «Выбрать шаблон» / «Сохранить как шаблон» ARE ported.
// The note that used to sit here said they were not, "no templates table
// locally" — which stopped being true at migration 027, where service_templates
// was created. Nobody revisited the note, so the patient card's «Добавить
// услуги» went without templates while the Калькулятор had them.

import { supabase } from '../../supabase.js';
import { CAT_ORDER, categoryOf } from '../../shared/service-categories.js';   // SERVICE_CATALOG_FILTER_V1
import { h, Icon, clear, toast, Avatar, initials, avColor, field } from '../ui.js';
import { listTemplates, createTemplate, retireTemplate, resolveTemplate, templateSize } from './service-templates.js?v=tpl1';   // WIZ_TEMPLATES_LOCAL_V1
import { doctorPoolFor } from './doctor-pool.js?v=dp1';   // DOCTOR_POOL_V1
import { printableSheet } from './doc-settings.js?v=q3company1';   // WIZ_INVOICE_PRINT_V1 — тот же брендированный бланк «Счёт» (Настройки → Документы); ?v как у всех импортёров

const RU_M_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function fmtRuDateTime(iso) {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getDate()} ${RU_M_GEN[d.getMonth()]} ${d.getFullYear()} г. в ${hh}:${mm}`;
}

// Local services have no category column — derive one (is_lab is authoritative
// for the lab; the rest is a name heuristic, good enough for catalog filtering).
// SERVICE_CATALOG_FILTER_V1 — раскладка по разделам переехала в
// shared/service-categories.js: тот же каталог показывает и добавление услуг
// госпитализации, и держать два набора правил значило бы, что одна услуга
// попадает в разные разделы на двух экранах.
// CATALOG_PAGE_V1 — сколько строк каталога рисуем за раз (и добавляем по кнопке).
const PAGE_SIZE = 50;
// REFERRAL_TWO_STEP_V1 — пункт для источников, у которых категория не заполнена:
// без него выбрать их было бы негде. Значение служит ключом «корзины», а не
// категорией — в базу оно не попадает.
const REF_UNCAT = '—  без категории';
const refCatOf = (s) => ((s && s.category) || '').trim();
const refSourcesIn = (sources, cat) => (sources || []).filter(s => (cat === REF_UNCAT ? !refCatOf(s) : refCatOf(s) === cat));

function currentUserId() {
    try { return (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.id) || null; }
    catch (e) { return null; }
}

// patient: { id, full_name, mrn, phone } — the wizard is always launched for a
// known patient (from the patient card). onSaved runs after a successful create.
export async function openVisitWizard(onSaved, patient, opts = {}) {
    if (!patient || !patient.id) { toast('Сначала выберите пациента.', 'fail'); return; }

    const wiz = {
        step: 1,
        services: [],        // catalog
        // CATALOG_DIAG_V4 — null until the catalog load finishes; a string means
        // it failed and the empty state must say so rather than claim the
        // catalogue is empty.
        loadError: null,
        doctors: [],
        sources: [],
        payers: [],
        payersError: null,   // PAYER_LOAD_V2 — «не загрузились» ≠ «не заведены»
        cart: [],            // [{ svc, qty }]
        search: '',
        cat: 'Все',
        // CATALOG_PAGE_V1 — каталог бывает на 500+ услуг, и отрисовка всех строк
        // разом заметно тормозит шаг 1. Рисуем первые PAGE_SIZE, остальное — по
        // кнопке «Показать ещё». Сбрасывается при смене поиска/категории.
        limit: PAGE_SIZE,
        // REFERRAL_TICK_V1 — «пациент по направлению»: галочка в СМЕТЕ; по
        // умолчанию снята — шаг «Направление» пропускается целиком.
        hasReferral: false,
        // step 2
        when: defaultWhen(),
        doctorId: '',
        visitType: 'outpatient',
        sourceId: '',
        // REFERRAL_TWO_STEP_V1 — категория источника («Врач», «Клиника», …).
        // Только для выбора: в визит уходит sourceId, категория живёт на самом
        // источнике (referral_sources.category).
        sourceCat: '',
        notes: '',
        // PAYER_WHO_V1 — «Кто платит» = СТОРОНА, на которую пойдёт счёт:
        //   self — платит сам пациент (способ оплаты выберет касса при приёме);
        //   b2b  — платит организация по договору;
        //   dms  — платит страховая по полису.
        // Наличные/Карта/Эквайринг отсюда убраны: это способ оплаты, вопрос кассы,
        // а не регистратуры — он подтверждается в момент приёма денег.
        // Для b2b и dms включается шаг «Кто платит» (выбор контрагента).
        payerId: 'self',
        payMethod: 'self',   // 'self' | 'b2b' | 'dms'
        // PAYER_TYPE_THEN_COMPANY_V1 — выбранный ТИП: 'self' либо ключ из
        // kindKey() (insurance / corporate / government). Компании показываются
        // под рядом типов; пока компания не выбрана, payerId остаётся 'self'.
        payKind: 'self',
        policyNo: (patient && patient.insurance_policy_number) || '',   // № полиса (ДМС)
        // DISCOUNT_ABS_V1 — скидку задают ДВУМЯ способами: процентом от сметы или
        // суммой в сумах («минус 200 000»). Раньше был только процент, и круглую
        // скидку приходилось пересчитывать в проценты вручную — с ошибкой на
        // копейки и разной суммой при изменении сметы.
        //
        // Режим хранится отдельно от значений, а значения — по одному на режим:
        // переключение туда-обратно не затирает уже введённое число.
        // На сервер в любом случае уходит СУММА (create_invoice_for_visit
        // принимает discount_amount в сумах) — процент существует только здесь.
        discountMode: 'pct', // 'pct' | 'abs'
        discountPct: 0,      // «Скидка (лояльность), %»
        discountAbs: 0,      // «Скидка (лояльность), сум»
        promo: null,         // применённый patient_discounts: { name, percent, amount }
        promoOpen: false,    // PROMO_TICK_V1 — поле промокода раскрыто галочкой (редкий случай)
        // step 4
        raiseInvoice: true,
        creating: false,
    };

    // Страховка платит по полису (её выбор добавляет шаг с номером полиса);
    // любая другая организация — корпоратив, госпрограмма вроде ФМС — платит по
    // договору, полиса у неё нет. Пустой kind трактуем как страховую.
    const isDmsPayer = (p) => ['insurance', 'dms', ''].includes(String(p && p.kind || '').toLowerCase());
    // (payersFor убран вместе с выбором компании в смете — шаг «Кто платит»
    //  фильтрует точнее, по конкретному типу: payersOfKind.)

    // PAYER_TYPE_THEN_COMPANY_V1 — «Кто платит» в два уровня: сначала ТИП
    // плательщика, под ним — компании этого типа.
    //
    // История: сначала здесь были три жёстких кнопки «Пациент / B2B / ДМС», а
    // компания выбиралась отдельным шагом — и типы не совпадали с тем, что
    // реально заведено (обе госкомпании клиники падали в «B2B», кнопка «ДМС»
    // вела в пустой список). Потом типы убрали совсем и показывали плоский
    // список компаний — при десятке плательщиков это стена одинаковых кнопок.
    // Теперь типы СТРОЯТСЯ ИЗ ДАННЫХ: показывается только тот тип, у которого
    // есть хотя бы одна компания, поэтому пустых веток не бывает по построению.

    // Нормализуем синонимы kind к трём каноническим типам.
    function kindKey(p) {
        const k = String(p && p.kind || '').toLowerCase();
        if (k === 'corporate' || k === 'b2b') return 'corporate';
        if (k === 'government' || k === 'state') return 'government';
        return 'insurance';   // insurance / dms / пусто
    }
    const KIND_ICON = { insurance: 'Receipt', corporate: 'Building', government: 'Building' };
    const KIND_SUB = {
        insurance:  'платит страховая — по полису',
        corporate:  'платит организация по договору',
        government: 'платит госпрограмма по договору',
    };

    // Типы, у которых есть хотя бы один активный плательщик, в порядке справочника.
    function payerKinds() {
        const seen = new Map();
        for (const p of wiz.payers) {
            const k = kindKey(p);
            if (!seen.has(k)) seen.set(k, { id: k, label: payerKindRu(p.kind), icon: KIND_ICON[k], sub: KIND_SUB[k] });
        }
        return [...seen.values()];
    }
    // Кнопки верхнего ряда: «Пациент» + существующие типы.
    function payTypeChoices() {
        return [
            // Иконка «Bank» в наборе отсутствует — Icon() рисовал бы пустой кружок.
            { id: 'self', label: 'Пациент', sub: 'платит сам — способ оплаты подтвердит касса', icon: 'User' },
            ...payerKinds(),
        ];
    }
    const payersOfKind = (k) => wiz.payers.filter(p => kindKey(p) === k);

    // SVC_DOCTORS_V1 — в выборе врача для строки сметы предлагаются ТОЛЬКО
    // врачи, назначенные на эту услугу (Сотрудники → «Услуги и ставки»,
    // users.service_rates: [{ service_id, ... }]).
    // DOCTOR_POOL_V1 — правило и его исключение вынесены в doctor-pool.js (там же
    // тесты). Коротко: предлагаем отмеченных исполнителей, а если услуга ТРЕБУЕТ
    // врача и ни одного не отмечено — всех врачей, иначе мастер встаёт в тупик
    // (выбрать некого, а строку без врача из сметы не убрать).
    function doctorsForService(svcId) {
        const svc = wiz.services.find(s => String(s.id) === String(svcId));
        return doctorPoolFor(wiz.doctors, svc || { id: svcId, requires_doctor: 0 });
    }

    // DOCTOR_OWN_PRICE_V1 — what this line will actually be billed at. MUST mirror
    // server/services/domain/pricing.js: the chosen doctor's own price when they
    // have one, otherwise the catalog price. The invoice is computed server-side
    // regardless, so if this drifts the patient is quoted one number at booking
    // and charged another at the till.
    // A stored price of 0 is a real free-of-charge price, so test for null/undefined
    // rather than falsiness.
    function linePrice(svc, doctorId) {
        const cat = Number(svc && svc.price) || 0;
        if (!doctorId) return cat;
        const doc = wiz.doctors.find(d => String(d.id) === String(doctorId));
        if (!doc || !Array.isArray(doc.service_rates)) return cat;
        const rate = doc.service_rates.find(r => r && String(r.service_id) === String(svc.id));
        if (!rate || rate.price == null) return cat;
        const own = Number(rate.price);
        return Number.isFinite(own) && own >= 0 ? own : cat;
    }
    const cartLinePrice = (c) => linePrice(c.svc, c.doctorId);

    // COVERAGE_SPLIT_V1 — что именно берёт на себя контрагент. Строка сметы
    // считается покрытой, пока её явно не сняли: выбирая плательщика, регистратор
    // чаще всего отдаёт ему ВЕСЬ визит, а исключения отмечает руками. Поэтому
    // `covered === false` — это осознанное «за это платит пациент», а отсутствие
    // поля — «покрыто». При самооплате покрытых строк нет по определению.
    const isCovered = (c) => wiz.payKind !== 'self' && c.covered !== false;
    const coveredTotal  = () => wiz.cart.filter(isCovered).reduce((s, c) => s + cartLinePrice(c) * c.qty, 0);
    const patientTotal  = () => Math.max(0, cartTotal() - coveredTotal());

    // PAYER_FROM_SETTINGS_V1 — «Направление» по галочке.
    // COVERAGE_SPLIT_V1 — шаг «Кто платит» нужен ЛЮБОМУ контрагенту, а не только
    // страховой: там делят услуги на «покрывает плательщик» и «платит пациент».
    // Раньше он показывался лишь при ДМС (ради номера полиса), и организация по
    // договору проскакивала мимо разделения. Самооплата шаг по-прежнему пропускает:
    // делить нечего, весь визит на пациенте.
    function stepSeq() {
        return [1, ...(wiz.hasReferral ? [2] : []), ...(wiz.payKind === 'self' ? [] : [3]), 4];
    }

    // PAYER_TYPE_THEN_COMPANY_V1 — выбор ТИПА. Компании этого типа появятся
    // рядом ниже; сама компания ещё не выбрана, поэтому payerId сбрасывается —
    // счёт не должен уйти на организацию из прежнего типа.
    // Единственную компанию в типе выбираем сразу: выбирать там не из чего.
    function setPayKind(kindId) {
        wiz.payKind = kindId;
        if (kindId === 'self') {
            wiz.payerId = 'self';
            wiz.payMethod = 'self';
        } else {
            wiz.payMethod = kindId === 'insurance' ? 'dms' : 'b2b';
            const list = payersOfKind(kindId);
            const keep = list.some(p => String(p.id) === String(wiz.payerId));
            if (!keep) wiz.payerId = list.length === 1 ? String(list[0].id) : 'self';
        }
        // Шаг 3 существует только у страховой — при уходе с неё не оставляем
        // мастер стоять на исчезнувшем шаге.
        if (wiz.step === 3 && wiz.payMethod !== 'dms') wiz.step = 4;
        paint();
    }

    // Выбор КОМПАНИИ внутри типа. payMethod выводится из её kind, поэтому
    // «сторона счёта» и «кто именно» не могут разойтись.
    function setPayer(choiceId) {
        if (choiceId === 'self') { setPayKind('self'); return; }
        const p = wiz.payers.find(x => String(x.id) === String(choiceId));
        if (!p) return;
        wiz.payerId = String(p.id);
        wiz.payKind = kindKey(p);
        wiz.payMethod = isDmsPayer(p) ? 'dms' : 'b2b';
        // COVERAGE_SPLIT_V1 — с шага 3 больше не сбрасываем: там теперь делят
        // услуги между плательщиком и пациентом, и это нужно любому контрагенту.
        paint();
    }

    // PAYER_COMPANY_ON_STEP2_V1 - ряд компаний и всплывающий список «Ещё N»
    // удалены вместе с выбором компании в СМЕТЕ: компанию выбирают на шаге
    // «Кто платит», где рядом видно и что она покрывает.

    function defaultWhen() {
        const d = new Date();
        d.setMinutes(d.getMinutes() - (d.getMinutes() % 5), 0, 0);
        const p = (x) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // ---- shell ----
    const overlay = h('div', {
        style: {
            position: 'fixed', inset: '0', zIndex: '150',
            background: 'var(--ink-25, #f6f8f9)',
            display: 'flex', flexDirection: 'column',
        },
    });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    overlay.appendChild(h('header', {
        style: {
            display: 'flex', alignItems: 'center', gap: '12px',
            padding: '13px 22px', background: 'var(--white, #fff)',
            borderBottom: '1px solid var(--ink-100)', flex: '0 0 auto',
        },
    },
        h('span', { style: { color: 'var(--ink-700)', display: 'flex' } }, Icon('Plus', { size: 16 })),
        h('div', { style: { fontSize: '15px', fontWeight: 700, color: 'var(--ink-900)' } }, 'Добавить услуги'),   // DAY_VISIT_V1 — работаем услугами; визит (день) считается сам
        h('span', { style: { flex: 1 } }),
        h('button', {
            class: 'btn',
            style: {
                fontSize: '13px', fontWeight: '700',
                background: '#dc2626', borderColor: '#dc2626', color: 'white',
                padding: '8px 16px', borderRadius: '10px',
                boxShadow: '0 2px 8px rgba(220,38,38,0.35)',
            },
            onmouseenter: (e) => { e.currentTarget.style.background = '#b91c1c'; },
            onmouseleave: (e) => { e.currentTarget.style.background = '#dc2626'; },
            onclick: close,
        }, '✕ Закрыть'),
    ));

    const stepsEl = h('div', {
        style: { padding: '12px 22px 0', display: 'flex', gap: '8px', flexWrap: 'wrap', flex: '0 0 auto' },
    });
    overlay.appendChild(stepsEl);

    const mainEl = h('div', {
        style: { flex: '1 1 auto', minHeight: 0, display: 'flex', gap: '16px', padding: '14px 22px', alignItems: 'stretch' },
    });
    overlay.appendChild(mainEl);

    overlay.appendChild(h('div', {
        style: { padding: '10px 22px', background: 'var(--white, #fff)', borderTop: '1px solid var(--ink-100)', display: 'flex', flex: '0 0 auto' },
    },
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, 'Отмена'),
    ));

    // TDZ_FIX_V1 — railEl must be initialized BEFORE the first paint(): paint →
    // estimateRail assigns railEl, and a `let` further down is still in its
    // temporal dead zone here (this crashed the wizard before data ever loaded).
    let railEl = null;
    // TDZ_FIX_V2 — то же для расписания. Пока СМЕТА пуста, paint() до них не
    // добирается, но с предзаполненной услугой (CRM_PRESET_V1) paint() рисует
    // планировщик строки → slotsForDay/dayLabel читают busyMap и RU_DOW. Эти
    // const'ы объявлялись ниже по файлу, и обращение к ним из раннего paint()
    // падало с ReferenceError, оставляя мастер пустым.
    const busyMap = new Map();   // doctorId -> [{start,end}] за 8 дней (ms)
    const WH_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const RU_DOW = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

    // SCROLL_KEEP_TDZ_V1 — declared HERE, before the first paint(), and not down
    // beside paint() itself where it used to live.
    //
    // paint() is a hoisted function declaration, so calling it early was legal —
    // but its body assigns to this `let`, and a `let` further down the same scope
    // is in the temporal dead zone until execution reaches it. So the first
    // paint() rendered the entire modal and THEN threw
    // «Cannot access '_lastPaintedStep' before initialization» on the last line.
    //
    // The throw landed between the modal being drawn and the catalogue being
    // fetched below, and openVisitWizard is async — so it surfaced only as an
    // unhandled rejection in the console. The wizard opened looking perfectly
    // normal, with an empty catalogue and «Каталог услуг пуст», while the
    // services request was never sent at all.
    let _lastPaintedStep = null;

    document.body.appendChild(overlay);
    paint();

    // ---- data ----
    try {
        const [svcRes, docRes, srcRes, payerRes] = await Promise.all([
            supabase.from('services').select('id, name, price, duration_minutes, requires_doctor, is_lab, type').eq('active', true).order('name').limit(1000),
            supabase.from('users').select('id, full_name, username, role, is_active, service_rates').eq('role', 'doctor').eq('is_active', true).order('full_name'),   // SVC_DOCTORS_V1 — назначения услуг
            supabase.from('referral_sources').select('id, name, category').eq('active', true).order('name'),
            // PAYER_LOAD_V2 — читаем ВЕСЬ справочник и отсеиваем неактивных здесь.
            // Раньше стоял .eq('active', true): если серверный реестр не разрешает
            // фильтр по этой колонке, запрос падает целиком и список плательщиков
            // молча оказывается пустым. Плательщиков единицы — лишние строки
            // ничего не стоят, а картина «есть в настройках, но не выбрать» уходит.
            supabase.from('payers').select('id, name, kind, active').order('name'),
        ]);
        wiz.services = svcRes.data || [];
        wiz.doctors  = docRes.data || [];
        wiz.sources  = srcRes.data || [];
        // PAYER_LOAD_V2 — ошибка загрузки и «не заведены» — РАЗНЫЕ факты (тот же
        // урок, что CATALOG_DIAG_V4 ниже): раньше ошибка превращалась в пустой
        // массив, и мастер уверенно сообщал «Плательщики не заведены», когда они
        // были заведены. Теперь причина сохраняется и показывается.
        wiz.payersError = payerRes.error ? (payerRes.error.message || String(payerRes.error)) : null;
        wiz.payers   = (payerRes.data || []).filter(p => p.active === undefined || !!p.active);
        if (payerRes.error) {
            console.error('[visit-wizard] payers load failed:', payerRes.error);
            toast('Плательщики не загрузились: ' + wiz.payersError, 'fail');
        }
        // CATALOG_DIAG_V4 — «каталог пуст» and «каталог не загрузился» are
        // different facts and must never render the same sentence.
        //
        // The previous version decided between them by searching wiz.dbg for the
        // word «ОШИБКА» — but the catch branch below wrote «сбой загрузки», which
        // does not contain it. So ANY thrown exception rendered the reassuring
        // «Каталог услуг пуст — добавьте услуги в настройках», sending whoever
        // read it off to add services that were already there. The status is now
        // a field of its own instead of a phrase to be pattern-matched.
        wiz.loadError = svcRes.error ? (svcRes.error.message || String(svcRes.error)) : null;
        wiz.dbg = 'услуги: ' + (svcRes.error ? 'ОШИБКА ' + wiz.loadError : wiz.services.length)
                + ' · врачи: ' + (docRes.error ? 'ОШИБКА ' + docRes.error.message : wiz.doctors.length);
        // Leaves a trace in the console even when nobody is looking at the toast.
        // The build tag is printed too: this module had NO cache-buster for its
        // whole life, so a browser could sit on a copy downloaded months earlier
        // and no amount of editing this file would change what ran. Seeing the
        // tag is the difference between "the fix did not work" and "the fix
        // never loaded".
        // The tag MUST match the ?v= in the import URLs (crm.js, patient-card.js):
        // it is what tells you whether the browser is running the file you just
        // edited, which is exactly the question when a fix "does not work".
        console.info('[visit-wizard vw7] catalog load —', wiz.dbg,
            '· плательщики:', wiz.payersError ? 'ОШИБКА ' + wiz.payersError : wiz.payers.length);
        if (svcRes.error) toast('Услуги не загрузились: ' + wiz.loadError, 'fail');
        if (docRes.error) toast('Врачи не загрузились: ' + docRes.error.message, 'fail');
    } catch (e) {
        wiz.loadError = (e && e.message) || String(e);
        wiz.dbg = 'сбой загрузки: ' + wiz.loadError;
        console.error('[visit-wizard] catalog load threw:', e);
        toast('Не удалось загрузить каталог: ' + wiz.loadError, 'fail');
    }
    // SCHED_V1 — график врача (users.working_hours / scheduling_mode) становится
    // читаемым после перезапуска сервера (registry-обновление); до этого молча
    // работаем с окном по умолчанию 09:00–18:00 каждый день.
    try {
        const ext = await supabase.from('users').select('id, working_hours, scheduling_mode')
            .eq('role', 'doctor').eq('is_active', true);
        if (!ext.error && ext.data) {
            const m = new Map(ext.data.map(u => [u.id, u]));
            for (const d of wiz.doctors) Object.assign(d, m.get(d.id) || {});
        }
    } catch (e) { /* фолбэк — окно по умолчанию */ }
    paint();
    // CRM_PRESET_V1 — предзаполнение сметы (например, «интересующая услуга» из CRM).
    const presetIds = Array.isArray(opts.presetServiceIds) ? opts.presetServiceIds : [];
    let presetAdded = 0;
    for (const pid of presetIds) {
        const svc = wiz.services.find(sv => String(sv.id) === String(pid));
        if (!svc) continue;
        addToCart(svc);
        // CRM_CONVERT_V1 — пометка «из заявки»: в каталоге такая услуга сразу
        // видна как добавленная, а не как «Добавить».
        const line = wiz.cart.find(c => c.svc.id === svc.id);
        if (line) line.fromCrm = true;
        presetAdded++;
    }
    // CRM_CONVERT_V1 — addToCart перерисовывает только СМЕТУ; без этого каталог
    // остаётся с кнопкой «Добавить» у услуги, которая уже в смете.
    if (presetAdded) paint();

    // CRM_SCHEDULE_V1 — услуги, записанные колл-центром НА ЭТОТ ДЕНЬ.
    //
    // Колл-центр сохраняет «услуга + дата» строками crm_request_services и на
    // этом останавливается: он не регистрирует, не считает и не выставляет счёт.
    // Регистратура открывает пациента в день приёма — услуги уже в смете,
    // остаётся подтвердить и выставить счёт.
    //
    // Совпадение по дате — обязательное: услуга, записанная на пятницу, не
    // должна подставиться пациенту, который зашёл во вторник. В любой другой
    // день смета открывается пустой, как и раньше.
    await prefillFromCrm();

    // CRM_SCHEDULE_V1 — пациент пришёл и услуги оформлены: закрываем именно те
    // строки заявки, которые подставились. Родительская заявка переходит в
    // «Пришёл» ТОЛЬКО когда в ней не осталось незакрытых строк — заявка на три
    // дня должна пережить первый визит, иначе остальные дни исчезнут у
    // регистратуры. Лучшая попытка: услуги уже сохранены, и сбой здесь не должен
    // выглядеть как «не удалось сохранить».
    async function closeCrmLines() {
        const lineIds = wiz.crmLineIds || [];
        const reqIds  = wiz.crmRequestIds || [];
        if (!lineIds.length) return;
        try {
            await supabase.from('crm_request_services').update({ status: 'done' }).in('id', lineIds);
            for (const rid of reqIds) {
                const { data: left } = await supabase.from('crm_request_services')
                    .select('id').eq('request_id', rid).eq('status', 'pending').limit(1);
                if (!left || !left.length) {
                    await supabase.from('crm_requests').update({ status: 'came' }).eq('id', rid);
                }
            }
        } catch (e) {
            console.warn('[visit-wizard] CRM lines not closed:', e && e.message);
        }
        wiz.crmLineIds = []; wiz.crmRequestIds = [];
    }

    async function prefillFromCrm() {
        // День, на который открыт мастер (по умолчанию — сегодня).
        const dayIso = String(wiz.when || '').slice(0, 10);
        if (!patient.id || !dayIso) return;
        try {
            const { data: reqs, error: reqErr } = await supabase.from('crm_requests')
                .select('id')
                .eq('patient_id', patient.id)
                .in('status', ['scheduled', 'approved', 'in_process', 'recall']);
            // Ошибку показываем, а не проглатываем. Молчаливый catch здесь стоил
            // трёх кругов отладки: смета оставалась пустой и выглядела как «фича
            // не работает», хотя запрос падал (например, сервер не перезапущен
            // после добавления crm_request_services в реестр — таблица есть в
            // базе, но процесс о ней не знает).
            if (reqErr) throw new Error('заявки: ' + (reqErr.message || reqErr));
            if (!reqs || !reqs.length) return;

            const { data: lines, error: lineErr } = await supabase.from('crm_request_services')
                .select('id, request_id, service_id, scheduled_date, status, doctor_id')
                .in('request_id', reqs.map(r => r.id))
                .eq('scheduled_date', dayIso)
                .eq('status', 'pending');
            if (lineErr) throw new Error('услуги заявки: ' + (lineErr.message || lineErr));
            if (!lines || !lines.length) return;

            const names = [];
            for (const ln of lines) {
                if (!ln.service_id) continue;
                const svc = wiz.services.find(sv => String(sv.id) === String(ln.service_id));
                if (!svc) continue;                                  // услуга удалена из каталога после звонка
                if (wiz.cart.some(c => String(c.svc.id) === String(svc.id))) continue;
                addToCart(svc);
                const line = wiz.cart.find(c => c.svc.id === svc.id);
                if (line) {
                    line.fromCrm = true;
                    // CRM_LINE_DOCTOR_V1 — врач, к которому записал колл-центр.
                    // Без него услуга с requires_doctor не попадает в СМЕТУ
                    // (visibleCart фильтрует именно по этому), и подстановка
                    // выглядела бы как «ничего не подставилось».
                    if (ln.doctor_id && wiz.doctors.some(d => String(d.id) === String(ln.doctor_id))) {
                        line.doctorId = Number(ln.doctor_id);
                        if (typeof autoPickSlot === 'function' && !line.when) { try { autoPickSlot(line); } catch (_) {} }
                    }
                }
                names.push(svc.name);
            }
            if (!names.length) return;
            // Какие строки заявки закрыть после создания визита.
            wiz.crmLineIds = lines.map(l => l.id);
            wiz.crmRequestIds = [...new Set(lines.map(l => l.request_id))];
            paint();
            toast('Из заявки колл-центра на ' + dayIso.split('-').reverse().join('.') + ': ' + names.join(', '), 'ok');
        } catch (e) {
            // Подстановка — удобство: сбой не мешает набрать услуги руками, но
            // МОЛЧАТЬ о нём нельзя — пустая смета неотличима от «записей нет».
            const msg = (e && e.message) || String(e);
            console.error('[visit-wizard] CRM prefill failed:', e);
            toast('Записи колл-центра не загрузились (' + msg + '). Услуги можно добавить вручную.', 'fail');
        }
    }

    // ---------------------------------------------------------------------
    // paint — steps bar + current step + СМЕТА rail
    // ---------------------------------------------------------------------
    // SCROLL_KEEP_V1 — левая колонка ПЕРЕСОЗДАЁТСЯ на каждый paint(), а вместе с
    // ней теряется прокрутка: добавил услугу где-то в середине каталога — и
    // список отбросило в начало, к строке с выбором врача приходилось
    // возвращаться руками. Запоминаем позицию и возвращаем её на место.
    // При СМЕНЕ шага прокрутку не переносим: там другое содержимое и логичнее
    // начать сверху.
    // `_lastPaintedStep` is declared far ABOVE, next to the first paint() call —
    // see the note there. It must not be re-declared here.
    function paint() {
        const prevLeft = mainEl.firstElementChild;
        const keepTop = (prevLeft && _lastPaintedStep === wiz.step) ? prevLeft.scrollTop : 0;
        paintSteps();
        clear(mainEl);
        const left = h('div', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'auto' } });
        if (wiz.step === 1)      paintStep1(left);
        else if (wiz.step === 2) paintStep2(left);
        else if (wiz.step === 3) paintStep3(left);
        else                     paintStep4(left);
        mainEl.appendChild(left);
        mainEl.appendChild(estimateRail());
        if (keepTop) left.scrollTop = keepTop;
        _lastPaintedStep = wiz.step;
    }

    function paintSteps() {
        clear(stepsEl);
        const TITLES = { 1: 'Услуги и пациент', 2: 'Направление', 3: 'Кто платит', 4: 'Подтверждение' };
        const seq = stepSeq();   // REFERRAL_TICK_V1 + PAY_DMS_V1
        const items = seq.map((st, i) => [st, TITLES[st], i + 1]);
        for (const [n, label, num] of items) {
            const active = wiz.step === n;
            const done = seq.indexOf(wiz.step) > seq.indexOf(n);
            stepsEl.appendChild(h('button', {
                type: 'button',
                onclick: () => { if (n < wiz.step) { wiz.step = n; paint(); } },
                style: {
                    display: 'inline-flex', alignItems: 'center', gap: '8px',
                    padding: '6px 14px 6px 6px', borderRadius: '999px',
                    cursor: n < wiz.step ? 'pointer' : 'default', fontFamily: 'inherit',
                    fontSize: '12.5px', fontWeight: active ? 700 : 500,
                    border: '1px solid ' + (active ? 'var(--primary-300, #7fcbb8)' : 'var(--ink-150, var(--ink-200))'),
                    background: active ? 'var(--primary-25, #f2faf8)' : 'var(--white, #fff)',
                    color: active || done ? 'var(--primary-700)' : 'var(--ink-400)',
                },
            },
                h('span', {
                    style: {
                        width: '22px', height: '22px', borderRadius: '999px',
                        display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 700,
                        background: active || done ? 'var(--primary-600)' : 'var(--ink-100)',
                        color: active || done ? '#fff' : 'var(--ink-500)',
                    },
                }, done ? '✓' : String(num)),
                label,
            ));
        }
    }

    // ---------------------------------------------------------------------
    // Step 1 — Услуги и пациент
    // ---------------------------------------------------------------------
    function paintStep1(root) {
        // patient chip
        root.appendChild(h('div', { style: { marginBottom: '12px' } },
            h('span', {
                style: {
                    display: 'inline-flex', alignItems: 'center', gap: '8px',
                    padding: '6px 14px 6px 6px', borderRadius: '999px',
                    border: '1px solid var(--primary-200, #b6e2d6)', background: 'var(--white, #fff)',
                    fontSize: '12.5px', fontWeight: 600, color: 'var(--primary-700)',
                },
            },
                Avatar({ initials: initials(patient.full_name || '?'), color: avColor(patient.id), size: 'sm' }),
                [patient.full_name, patient.mrn, patient.phone].filter(Boolean).join(' · '),
            ),
        ));

        // search
        const searchInp = h('input', {
            type: 'text', value: wiz.search, placeholder: 'Поиск услуги или врача…',
            style: {
                height: '40px', padding: '0 14px', width: '100%',
                border: '1px solid var(--ink-200)', borderRadius: '10px',
                fontSize: '13px', fontFamily: 'inherit', background: 'var(--white, #fff)',
            },
        });
        let tmr = null;
        searchInp.addEventListener('input', () => {
            clearTimeout(tmr);
            tmr = setTimeout(() => { wiz.search = searchInp.value; repaintCatalog({ toTop: true }); }, 180);
        });
        // category chips
        const chipsEl = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
        const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
        // CATALOG_STICKY_HEAD_V1 — поиск и категории ПРИЛИПАЮТ к верху колонки.
        // Раньше они уезжали вместе со списком: на ноутбуке (а с масштабом ОС
        // 125–150% высоты остаётся ~430px) каталог прокручен почти всегда, и
        // чтобы сменить категорию приходилось возвращаться в самое начало.
        // Фон непрозрачный — иначе строки услуг просвечивали бы под ними.
        // WIZ_TEMPLATES_LOCAL_V1 — «Выбрать шаблон» делит строку с поиском: набор
        // услуг чаще повторяется, чем придумывается заново, и начинать с готового
        // списка быстрее, чем искать те же пять позиций каждый раз.
        const tplPickBtn = h('button', {
            class: 'btn btn-outline', type: 'button',
            style: { flex: 'none', whiteSpace: 'nowrap', height: '40px' },
            onclick: () => openTemplatePicker(),
        }, Icon('Layers', { size: 14 }), ' Выбрать шаблон');
        root.appendChild(h('div', {
            style: {
                position: 'sticky', top: '0', zIndex: '5',
                background: 'var(--ink-25, #f6f8f9)',
                paddingBottom: '10px', marginBottom: '2px',
                display: 'flex', flexDirection: 'column', gap: '10px',
            },
        }, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, searchInp), tplPickBtn), chipsEl));
        root.appendChild(listEl);

        // SCROLL_KEEP_V1 — paintList() очищает список внутри скроллера, и позиция
        // схлопывается к нулю. Сохраняем её: выбор врача, дня и времени происходит
        // прямо в строке услуги, и список не должен уезжать из-под курсора.
        // toTop:true — для смены поиска/категории: там список другой, начинаем сверху.
        function repaintCatalog({ toTop = false } = {}) {
            // CATALOG_PAGE_V1 — новый поиск/категория = новый список: снова с первых 50.
            if (toTop) wiz.limit = PAGE_SIZE;
            const top = toTop ? 0 : root.scrollTop;
            paintChips();
            paintList();
            root.scrollTop = top;
        }

        function matches(s) {
            const q = wiz.search.trim().toLowerCase();
            if (q && !(s.name || '').toLowerCase().includes(q)) return false;
            if (wiz.cat !== 'Все' && categoryOf(s) !== wiz.cat) return false;
            return true;
        }

        function paintChips() {
            clear(chipsEl);
            const counts = new Map();
            for (const s of wiz.services) {
                const c = categoryOf(s);
                counts.set(c, (counts.get(c) || 0) + 1);
            }
            const chip = (label, count) => {
                const active = wiz.cat === label;
                return h('button', {
                    type: 'button',
                    onclick: () => { wiz.cat = label; repaintCatalog({ toTop: true }); },
                    style: {
                        padding: '6px 13px', borderRadius: '999px', cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: '12px', fontWeight: 600,
                        border: '1px solid ' + (active ? 'var(--primary-400, #4bb39a)' : 'var(--ink-150, var(--ink-200))'),
                        background: active ? 'var(--primary-50)' : 'var(--white, #fff)',
                        color: active ? 'var(--primary-700)' : 'var(--ink-600)',
                    },
                }, `${label} · ${count}`);
            };
            chipsEl.appendChild(chip('Все', wiz.services.length));
            for (const c of CAT_ORDER) {
                if (counts.get(c)) chipsEl.appendChild(chip(c, counts.get(c)));
            }
        }

        function paintList() {
            clear(listEl);
            const rows = wiz.services.filter(matches);
            if (!rows.length) {
                // CATALOG_DIAG_V4 — three distinct outcomes, three distinct messages:
                // the search matched nothing, the load failed, or the catalogue
                // really is empty. Only the last one is the user's to fix.
                const msg = wiz.services.length
                    ? 'Ничего не найдено — измените поиск или категорию.'
                    : wiz.loadError
                        ? 'Каталог не загрузился: ' + wiz.loadError
                        : 'Каталог услуг пуст — добавьте услуги в настройках.';
                listEl.appendChild(h('div', { class: 'empty' }, msg));
                return;
            }
            const shown = Math.min(wiz.limit, rows.length);
            for (const s of rows.slice(0, shown)) {
                const inCart = wiz.cart.find(c => c.svc.id === s.id);
                const headRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
                    h('div', { style: { minWidth: 0, flex: 1 } },
                        h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: inCart ? 'var(--primary-700)' : 'var(--ink-900)' } },
                            s.name, inCart ? (inCart.svc.requires_doctor && !inCart.doctorId ? ' — выберите врача' : ' — добавлено') : '',
                            // CRM_CONVERT_V1 — услуга пришла из заявки колл-центра
                            inCart && inCart.fromCrm
                                ? h('span', { style: { marginLeft: '8px', padding: '2px 8px', borderRadius: '999px', fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', background: 'var(--teal-50, #e0f2f1)', color: 'var(--teal-700, #00796b)', verticalAlign: 'middle' } }, 'из заявки')
                                : null),
                        h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } },
                            [categoryOf(s), (s.duration_minutes || 30) + ' мин', s.requires_doctor ? 'нужен врач' : 'врач не требуется'].join(' · ')),
                    ),
                    h('span', { class: 'num', style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)', whiteSpace: 'nowrap' } },
                        fmtPrice(s.price) + ' сум'),
                    inCart
                        ? h('button', {
                            class: 'btn btn-sm', type: 'button',
                            style: { borderRadius: '999px', minWidth: '80px', color: 'var(--crit-600, #dc2626)', fontWeight: 700 },
                            onclick: () => { wiz.cart = wiz.cart.filter(x => x !== inCart); repaintRail(); repaintCatalog(); },
                        }, 'убрать')
                        : h('button', {
                            class: 'btn btn-primary btn-sm', type: 'button',
                            style: { borderRadius: '999px', minWidth: '96px' },
                            onclick: () => {
                                addToCart(s);
                                repaintCatalog();
                                // SCROLL_KEEP_V1 — планировщик разворачивается ПОД
                                // строкой и может оказаться за нижним краем.
                                // 'nearest' не двигает то, что и так видно целиком.
                                const row = listEl.querySelector(`[data-svc-row="${s.id}"]`);
                                if (row) row.scrollIntoView({ block: 'nearest' });
                            },
                        }, 'Добавить'),
                );
                listEl.appendChild(h('div', {
                    dataset: { svcRow: String(s.id) },   // SCROLL_KEEP_V1 — якорь строки после перерисовки
                    style: {
                        background: 'var(--white, #fff)',
                        border: inCart ? '1px dashed var(--primary-300, #7fcbb8)' : '1px solid var(--ink-100)',
                        borderRadius: '12px', padding: '12px 16px',
                    },
                    // DOC_FIRST_V1 — без врача нет и планировщика.
                    // DATE_ONLY_V1 — услуге без врача время не нужно: только дата.
                }, headRow, !inCart ? null : (s.requires_doctor ? schedulePanel(inCart) : datePanel(inCart))));
            }
            // CATALOG_PAGE_V1 — «хвост» списка за кнопкой: сколько показано,
            // сколько осталось. Порция та же — PAGE_SIZE.
            if (rows.length > shown) {
                listEl.appendChild(h('div', {
                    style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '4px 0 2px' },
                },
                    h('button', {
                        class: 'btn btn-sm', type: 'button',
                        style: { borderRadius: '999px', minWidth: '180px', fontWeight: 600 },
                        onclick: () => { wiz.limit += PAGE_SIZE; repaintCatalog(); },
                    }, `Показать ещё ${Math.min(PAGE_SIZE, rows.length - shown)}`),
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } },
                        `показано ${shown} из ${rows.length}`),
                ));
            }
            // DATE_ONLY_V1 — услуга без врача (лаборатория, забор, справка) не
            // занимает слот в расписании: у неё есть только ДЕНЬ, без времени.
            function datePanel(line) {
                const dateInp = h('input', {
                    type: 'date', value: (line.when || '').slice(0, 10) || isoDay(line.ui.day),
                    style: { padding: '7px 9px', border: '1px solid var(--ink-200)', borderRadius: '9px', fontFamily: 'inherit', fontSize: '12.5px', background: 'var(--white, #fff)' },
                });
                dateInp.addEventListener('change', () => {
                    if (!dateInp.value) { dateInp.value = isoDay(line.ui.day); return; }
                    line.ui.day = new Date(dateInp.value + 'T00:00:00').getTime();
                    line.when = dateInp.value + 'T00:00';
                    repaintRail();
                });
                return h('div', {
                    style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--ink-150, var(--ink-200))' },
                }, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Дата'),
                    dateInp,
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } }, 'время не требуется — услуга без врача'));
            }

            // SCHED_V1_COMPACT — компактный планировщик: три дропдауна в одну строку
            // (врач → день → время) + краткое резюме. Занятость и график те же.
            function schedulePanel(line) {
                const selStyle = { padding: '7px 9px', border: '1px solid var(--ink-200)', borderRadius: '9px', fontFamily: 'inherit', fontSize: '12.5px', background: 'var(--white, #fff)', maxWidth: '190px' };

                // --- врач: комбобокс с поиском (печатайте фамилию — список фильтруется) ---
                const selDoc = wiz.doctors.find(d => d.id === line.doctorId) || null;
                const docWrap = h('div', { style: { position: 'relative', flex: '0 0 auto' } });
                const docInp = h('input', {
                    type: 'text', placeholder: 'Врач — поиск…',
                    value: selDoc ? selDoc.full_name : '',
                    style: { ...selStyle, width: '200px', maxWidth: '200px', boxSizing: 'border-box' },
                });
                const docList = h('div', {
                    style: {
                        position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 60,
                        minWidth: '230px', maxHeight: '220px', overflow: 'auto',
                        background: 'var(--white, #fff)', border: '1px solid var(--ink-200)',
                        borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', display: 'none',
                    },
                });
                const pickDoc = (d) => {
                    line.doctorId = d.id; line.when = null;
                    if (d.scheduling_mode === 'live_queue') { repaintRail(); repaintCatalog(); return; }   // LIVE_QUEUE_V1
                    loadBusy(d.id).then(() => { autoPickSlot(line); repaintRail(); repaintCatalog(); });
                };
                const paintDocList = () => {
                    clear(docList);
                    const q = docInp.value.trim().toLowerCase();
                    // SVC_DOCTORS_V1 — пул кандидатов: только назначенные на услугу
                    const pool = doctorsForService(line.svc.id);
                    // открытие с уже выбранным именем показывает весь список
                    const rows = (selDoc && docInp.value === selDoc.full_name) ? pool
                        : pool.filter(d => !q || (d.full_name || '').toLowerCase().includes(q));
                    if (!rows.length) {
                        docList.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } },
                            pool.length ? 'Не найдено'
                                : 'Нет врачей, назначенных на эту услугу — отметьте её врачу в Сотрудники → «Услуги и ставки».'));
                        return;
                    }
                    for (const d of rows) {
                        const active = d.id === line.doctorId;
                        docList.appendChild(h('div', {
                            onmousedown: (e) => { e.preventDefault(); pickDoc(d); },
                            onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                            onmouseleave: (e) => { e.currentTarget.style.background = active ? 'var(--primary-25, #f2faf8)' : ''; },
                            style: {
                                padding: '9px 12px', cursor: 'pointer', fontSize: '13px',
                                fontWeight: active ? 700 : 500,
                                color: active ? 'var(--primary-700)' : 'var(--ink-800)',
                                background: active ? 'var(--primary-25, #f2faf8)' : '',
                            },
                        }, d.full_name));
                    }
                };
                docInp.addEventListener('focus', () => { paintDocList(); docList.style.display = ''; docInp.select(); });
                docInp.addEventListener('input', () => { paintDocList(); docList.style.display = ''; });
                docInp.addEventListener('blur', () => {
                    setTimeout(() => {
                        docList.style.display = 'none';
                        docInp.value = (wiz.doctors.find(d => d.id === line.doctorId) || {}).full_name || '';
                    }, 150);
                });
                docWrap.appendChild(docInp);
                docWrap.appendChild(docList);

                // LIVE_QUEUE_V1 — врач живой очереди: без календаря и времени
                const liveQ = line.doctorId ? isLiveQueueDoc(line.doctorId) : false;

                // --- день: мини-календарь (SCHED_CAL_V1) ---
                const d0 = new Date(); d0.setHours(0, 0, 0, 0);
                if (line.ui.calShift === undefined) line.ui.calShift = 0;   // 0 = текущий месяц, 1 = следующий
                const selDate = new Date(line.ui.day);
                const dayLabelBtn = (line.ui.day === d0.getTime() ? 'Сегодня' : selDate.getDate() + ' ' + RU_M_GEN[selDate.getMonth()].slice(0, 3)) +
                    (line.doctorId ? ' · ' + slotsForDay(line, line.ui.day).length + ' окн.' : '');
                const dayWrap = h('div', { style: { position: 'relative', flex: '0 0 auto' } });
                const dayBtn = h('button', {
                    type: 'button', disabled: line.doctorId ? null : true,
                    style: { ...selStyle, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', opacity: line.doctorId ? 1 : 0.5 },
                }, Icon('Calendar', { size: 13 }), dayLabelBtn);
                const calPop = h('div', {
                    style: {
                        position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 60,
                        width: '252px', background: 'var(--white, #fff)', border: '1px solid var(--ink-200)',
                        borderRadius: '12px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: '10px', display: 'none',
                    },
                });
                const paintCal = () => {
                    clear(calPop);
                    const base = new Date(d0.getFullYear(), d0.getMonth() + line.ui.calShift, 1);
                    const monthName = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'][base.getMonth()];
                    const navBtn = (txt, dis, fn) => h('button', {
                        type: 'button', disabled: dis ? true : null, onclick: fn,
                        style: { width: '26px', height: '26px', borderRadius: '8px', border: '1px solid var(--ink-200)', background: 'var(--white, #fff)', cursor: dis ? 'default' : 'pointer', opacity: dis ? 0.4 : 1, fontWeight: 700 },
                    }, txt);
                    calPop.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
                        navBtn('‹', line.ui.calShift === 0, () => { line.ui.calShift = 0; paintCal(); }),
                        h('span', { style: { flex: 1, textAlign: 'center', fontSize: '13px', fontWeight: 800 } }, monthName + ' ' + base.getFullYear()),
                        navBtn('›', line.ui.calShift === 1, () => { line.ui.calShift = 1; paintCal(); }),
                    ));
                    calPop.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' } },
                        ...['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(w =>
                            h('div', { class: 'muted', style: { textAlign: 'center', fontSize: '10px', fontWeight: 800 } }, w))));
                    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' } });
                    const firstDow = (base.getDay() + 6) % 7;   // Пн = 0
                    for (let i = 0; i < firstDow; i++) grid.appendChild(h('div'));
                    const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
                    const horizon = d0.getTime() + 34 * 86400000;   // предел загруженной занятости
                    for (let dd = 1; dd <= daysInMonth; dd++) {
                        const dayMs = new Date(base.getFullYear(), base.getMonth(), dd).getTime();
                        const past = dayMs < d0.getTime();
                        const beyond = dayMs > horizon;
                        const free = (!past && !beyond) ? slotsForDay(line, dayMs).length : 0;
                        const disabled = past || beyond || free === 0;
                        const active = line.ui.day === dayMs;
                        grid.appendChild(h('button', {
                            type: 'button', disabled: disabled ? true : null,
                            onclick: () => {
                                line.ui.day = dayMs;
                                const fs = slotsForDay(line, dayMs);
                                line.when = fs.length ? slotToLocalIso(fs[0]) : null;
                                repaintRail(); repaintCatalog();
                            },
                            title: past || beyond ? '' : (free ? free + ' окн.' : 'нет окон'),
                            style: {
                                padding: '4px 0 3px', borderRadius: '8px', fontFamily: 'inherit',
                                border: active ? '2px solid var(--primary-600)' : '1px solid transparent',
                                background: active ? 'var(--primary-600)' : 'transparent',
                                color: active ? '#fff' : disabled ? 'var(--ink-300)' : 'var(--ink-800)',
                                cursor: disabled ? 'default' : 'pointer', textAlign: 'center',
                            },
                        },
                            h('div', { style: { fontSize: '12.5px', fontWeight: 700, lineHeight: 1.1 } }, String(dd)),
                            h('div', { style: { fontSize: '8.5px', lineHeight: 1, opacity: active ? 0.9 : 0.75, minHeight: '9px' } },
                                (!disabled || active) && free ? free + ' окн' : ''),
                        ));
                    }
                    calPop.appendChild(grid);
                };
                const closeCal = (e) => {
                    if (!dayWrap.contains(e.target)) { calPop.style.display = 'none'; document.removeEventListener('mousedown', closeCal); }
                };
                dayBtn.addEventListener('click', () => {
                    if (calPop.style.display === 'none') { paintCal(); calPop.style.display = ''; document.addEventListener('mousedown', closeCal); }
                    else { calPop.style.display = 'none'; document.removeEventListener('mousedown', closeCal); }
                });
                dayWrap.appendChild(dayBtn);
                dayWrap.appendChild(calPop);

                // --- время ---
                const slots = line.doctorId ? slotsForDay(line, line.ui.day) : [];
                const selMs = line.when ? new Date(line.when).getTime() : null;
                const timeSel = h('select', { style: { ...selStyle, maxWidth: '110px' }, disabled: slots.length ? null : true });
                if (!slots.length) timeSel.appendChild(h('option', { value: '' }, line.doctorId ? 'нет окон' : '—'));
                const grp = (label, list) => {
                    if (!list.length) return null;
                    const g = h('optgroup', { label });
                    for (const t of list) g.appendChild(h('option', { value: String(t), selected: selMs === t }, fmtSlot(t)));
                    return g;
                };
                const gs = [grp('Утро', slots.filter(t => new Date(t).getHours() < 12)),
                            grp('День', slots.filter(t => { const hh = new Date(t).getHours(); return hh >= 12 && hh < 17; })),
                            grp('Вечер', slots.filter(t => new Date(t).getHours() >= 17))].filter(Boolean);
                for (const g of gs) timeSel.appendChild(g);
                timeSel.addEventListener('change', () => {
                    if (timeSel.value) { line.when = slotToLocalIso(Number(timeSel.value)); repaintRail(); repaintCatalog(); }
                });

                // --- резюме ---
                let summary = null;
                if (liveQ) {
                    summary = h('span', {
                        style: { fontSize: '12px', fontWeight: 700, color: 'var(--primary-700)', background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-200, #bfe3d8)', borderRadius: '999px', padding: '6px 12px', whiteSpace: 'nowrap' },
                    }, 'Живая очередь — приём без записи');
                } else if (line.when) {
                    const t = new Date(line.when);
                    const dur = Number(line.svc.duration_minutes) || 30;
                    const end = new Date(t.getTime() + dur * 60000);
                    summary = h('span', { class: 'muted', style: { fontSize: '12px', whiteSpace: 'nowrap' } },
                        fmtSlot(t.getTime()) + '–' + fmtSlot(end.getTime()) + ' · ' + dur + ' мин');
                } else if (line.svc.requires_doctor && !line.doctorId) {
                    summary = h('span', { style: { fontSize: '12px', color: 'var(--crit-600, #dc2626)', whiteSpace: 'nowrap' } }, 'выберите врача');
                }

                return h('div', { style: { marginTop: '10px', borderTop: '1px dashed var(--ink-100)', paddingTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                    docWrap, ...(liveQ ? [] : [dayWrap, timeSel]), summary);
            }

            if (rows.length > 200) {
                listEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', padding: '8px 4px' } },
                    `Показаны первые 200 из ${rows.length} — уточните поиск.`));
            }
        }

        repaintCatalog();
    }

    // ---------------------------------------------------------------------
    // SCHED_V1 — слоты врача, как в easymed: окно дня из users.working_hours
    // (Сотрудники → График), занятость из существующих визитов врача + строк
    // этой же сметы. Пустой график → 09:00–18:00 каждый день. Шаг 30 минут.
    // ---------------------------------------------------------------------
    // busyMap / WH_KEYS / RU_DOW объявлены выше первого paint() — см. TDZ_FIX_V1.

    async function loadBusy(docId) {
        if (busyMap.has(docId)) return;
        const from = new Date(); from.setHours(0, 0, 0, 0);
        const to = new Date(from); to.setDate(to.getDate() + 35);   // SCHED_CAL_V1 — горизонт календаря
        const { data, error } = await supabase.from('visits')
            .select('visit_date, duration_minutes, status')
            .eq('doctor_id', docId)
            .gte('visit_date', from.toISOString())
            .lte('visit_date', to.toISOString())
            .in('status', ['scheduled', 'confirmed', 'arrived']);
        if (error) { toast('Занятость врача не загрузилась: ' + error.message, 'fail'); busyMap.set(docId, []); return; }
        busyMap.set(docId, (data || []).map(v => {
            const s = new Date(v.visit_date).getTime();
            return { start: s, end: s + (Number(v.duration_minutes) || 30) * 60000 };
        }));
    }

    function dayWindow(doc, date) {
        let wh = null;
        try { wh = doc && doc.working_hours ? (typeof doc.working_hours === 'string' ? JSON.parse(doc.working_hours) : doc.working_hours) : null; }
        catch (e) { wh = null; }
        const d = wh && wh[WH_KEYS[date.getDay()]];
        if (d && d.on === false) return null;   // выходной по графику
        const from = (d && d.on && d.from) || '09:00';
        const to = (d && d.on && d.to) || '18:00';
        return { from, to };
    }

    function slotsForDay(line, dayStart) {
        if (!line.doctorId) return [];
        const doc = wiz.doctors.find(x => x.id === line.doctorId);
        const date = new Date(dayStart);
        const win = dayWindow(doc, date);
        if (!win) return [];
        const step = 30 * 60000;
        const dur = (Number(line.svc.duration_minutes) || 30) * 60000;
        const [fh, fm] = win.from.split(':').map(Number);
        const [th, tm] = win.to.split(':').map(Number);
        const start = new Date(date); start.setHours(fh, fm, 0, 0);
        const end = new Date(date); end.setHours(th, tm, 0, 0);
        // занято: чужие визиты врача + другие строки этой сметы у того же врача
        const bz = (busyMap.get(line.doctorId) || []).concat(
            wiz.cart.filter(c => c !== line && c.doctorId === line.doctorId && c.when)
                .map(c => { const s = new Date(c.when).getTime(); return { start: s, end: s + (Number(c.svc.duration_minutes) || 30) * 60000 }; }));
        const now = Date.now();
        const out = [];
        for (let t = start.getTime(); t + dur <= end.getTime(); t += step) {
            if (t < now) continue;
            if (bz.some(b => t < b.end && b.start < t + dur)) continue;
            out.push(t);
        }
        return out;
    }

    // LIVE_QUEUE_V1 — врач с «Живой очередью» принимает без записи: слоты
    // не выбираются, услуга идёт без времени (кассир/очередь решают на месте).
    function isLiveQueueDoc(docId) {
        const d = wiz.doctors.find(x => x.id === docId);
        return !!(d && d.scheduling_mode === 'live_queue');
    }
    // DOC_FIRST_V1 — врачебная услуга попадает в СМЕТУ только после выбора врача.
    function visibleCart() {
        return wiz.cart.filter(c => !c.svc.requires_doctor || c.doctorId);
    }

    function autoPickSlot(line) {
        const d0 = new Date(); d0.setHours(0, 0, 0, 0);
        for (let i = 0; i < 14; i++) {
            const day = d0.getTime() + i * 86400000;
            const slots = slotsForDay(line, day);
            if (slots.length) { line.ui.day = day; line.when = slotToLocalIso(slots[0]); return; }
        }
        line.when = null;
    }

    function slotToLocalIso(ms) {
        const d = new Date(ms);
        const p = (x) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function fmtSlot(ms) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
    function isoDay(ms) { return slotToLocalIso(ms).slice(0, 10); }   // DATE_ONLY_V1
    function dayLabel(ms) {
        const d = new Date(ms); const today = new Date(); today.setHours(0, 0, 0, 0);
        return d.getTime() === today.getTime() ? 'СЕГОДНЯ' : RU_DOW[d.getDay()];
    }

    // SINGLE_PER_VISIT_V1 — консультации, лаборатория, диагностика и прочие
    // услуги добавляются в визит только один раз (qty всегда 1). Повторное
    // количество разрешено только процедурам: type='procedure' из Настроек →
    // Услуги, либо процедурное имя — фолбэк для записей, где тип ещё не
    // проставлен (колонка по умолчанию 'consultation').
    function isMultiQty(s) {
        if (s.type === 'procedure') return true;
        return /процедур|инъекц|укол|капельниц|массаж|физио|перевязк/i.test(s.name || '');
    }

    function addToCart(svc) {
        const item = wiz.cart.find(c => c.svc.id === svc.id);
        if (item) {
            if (!isMultiQty(svc)) {
                toast('«' + svc.name + '» уже в смете — эту услугу можно добавить только один раз за визит.', 'info');
                return;
            }
            item.qty += 1;
            repaintRail();
            return;
        }
        const d0 = new Date(); d0.setHours(0, 0, 0, 0);
        const line = { svc, qty: 1, doctorId: null, when: null, ui: { day: d0.getTime(), pickDoc: false } };
        // DATE_ONLY_V1 — услуге без врача слот не нужен: только день, по
        // умолчанию сегодняшний. dateOnly отличает её от записи на время.
        if (!svc.requires_doctor) { line.dateOnly = true; line.when = isoDay(d0.getTime()) + 'T00:00'; }
        wiz.cart.push(line);
        // SCHED_V1 + SVC_DOCTORS_V1 — если на услугу назначен ровно один врач,
        // выбираем его и ближайший слот сами; иначе регистратор выбирает из
        // назначенных на услугу.
        const pool = doctorsForService(svc.id);
        if (pool.length === 1) {
            line.doctorId = pool[0].id;
            if (isLiveQueueDoc(line.doctorId)) { line.when = null; repaintRail(); }
            else loadBusy(line.doctorId).then(() => { autoPickSlot(line); repaintRail(); if (wiz.step === 1) paint(); });
        }
        repaintRail();
    }

    // ---------------------------------------------------------------------
    // Step 2 — Направление (источник → кто направил, врач, заметка)
    // ---------------------------------------------------------------------
    function paintStep2(root) {
        const needsDoctor = wiz.cart.some(c => c.svc.requires_doctor);

        // DATE_FIELD_DROPPED_V1 — поля «Дата и время» здесь больше нет: дату и
        // время каждая услуга получает СВОЮ на шаге 1 (планировщик врача или
        // «только дата» для услуг без врача), и сохраняется именно она
        // (`c.when || wiz.when` в submit). Это поле было запасным значением для
        // строк без своей даты — оно и осталось, просто невидимым: wiz.when
        // держит defaultWhen(), так что запасной вариант никуда не делся.

        const docSel = h('select', null,
            h('option', { value: '' }, needsDoctor ? '— Выберите врача —' : '— Без врача —'),
            ...wiz.doctors.map(d => h('option', { value: d.id, selected: String(wiz.doctorId) === String(d.id) }, d.full_name || d.username)));
        docSel.addEventListener('change', () => { wiz.doctorId = docSel.value; });

        // VISIT_TYPE_FIELD_DROPPED_V1 — селектора «Тип визита» здесь нет:
        // регистратура заводит амбулаторный приём, и выбор из трёх значений был
        // лишним вопросом на каждом визите. Само поле визита никуда не делось —
        // wiz.visitType держит 'outpatient' и уходит в ensure_visit как раньше;
        // стационар заводится через «Койки», а не через этот мастер.

        // REFERRAL_TWO_STEP_V1 — направление выбирается в ДВА шага, как в
        // подборе услуг (service-picker-modal): сперва ИСТОЧНИК (категория —
        // «Врач», «Клиника», «Реклама»…), и только потом появляется КТО именно
        // направил. Одним плоским списком всех партнёров пользоваться было
        // нельзя: на реальной базе это сотни строк вида «Имя · категория».
        // В визит по-прежнему уходит wiz.sourceId — схема не менялась.
        const cats = [...new Set(wiz.sources.map(refCatOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
        const hasUncat = wiz.sources.some(s => !refCatOf(s));

        // Правка существующего направления: категорию восстанавливаем из источника.
        if (wiz.sourceId && !wiz.sourceCat) {
            const cur = wiz.sources.find(s => String(s.id) === String(wiz.sourceId));
            if (cur) wiz.sourceCat = refCatOf(cur) || REF_UNCAT;
        }

        const catSel = h('select', null,
            h('option', { value: '' }, '— Без направления —'),
            ...cats.map(c => h('option', { value: c, selected: wiz.sourceCat === c }, c)),
            ...(hasUncat ? [h('option', { value: REF_UNCAT, selected: wiz.sourceCat === REF_UNCAT }, REF_UNCAT)] : []));
        catSel.addEventListener('change', () => {
            wiz.sourceCat = catSel.value;
            wiz.sourceId  = '';       // сменили категорию — прежний партнёр к ней не относится
            paint();                  // перерисовываем: поле «Кто направил» появляется/исчезает
        });

        const inCat = wiz.sourceCat ? refSourcesIn(wiz.sources, wiz.sourceCat) : [];
        const srcSel = h('select', null,
            h('option', { value: '' }, inCat.length ? '— Выберите, кто направил —' : 'В этой категории пока никого нет'),
            ...inCat.map(s => h('option', { value: s.id, selected: String(wiz.sourceId) === String(s.id) }, s.name)));
        srcSel.addEventListener('change', () => { wiz.sourceId = srcSel.value; });

        const notesInp = h('textarea', { rows: '2', placeholder: 'Заметка (необязательно)' });
        notesInp.value = wiz.notes;
        notesInp.addEventListener('input', () => { wiz.notes = notesInp.value; });

        root.appendChild(h('div', { class: 'card', style: { padding: '18px 20px', maxWidth: '640px' } },
            h('h3', { style: { margin: '0 0 14px', fontSize: '14px' } }, Icon('Send', { size: 15 }), ' Направление'),
            h('div', { class: 'field-row', style: { gridTemplateColumns: '1fr 1fr' } },
                field('Источник направления', catSel),
                // Второе поле показываем ТОЛЬКО после выбора источника.
                wiz.sourceCat ? field('Кто направил', srcSel) : null,
            ),
            h('div', { class: 'field-row', style: { gridTemplateColumns: '1fr 1fr' } },
                field(needsDoctor ? 'Врач (обязательно — есть врачебные услуги)' : 'Врач', docSel, { required: needsDoctor }),
            ),
            field('Заметка', notesInp),
        ));
    }

    // AKT_DOC_V1 — АКТ выполненных работ по счёту плательщика. Печатается на том
    // же брендированном бланке (Настройки → Документы), но это НЕ счёт пациенту:
    // документ адресован организации, содержит только покрытые ею услуги и место
    // для подписей обеих сторон — им закрывают расчёт по договору.
    function printAkt({ invoice, payerId, lines, visitDate }) {
        const payer = wiz.payers.find(p => String(p.id) === String(payerId));
        const no = invoice.invoice_number || String(invoice.id);
        const docName = (c) => {
            const id = c.doctorId || (c.svc.requires_doctor ? wiz.doctorId : null);
            const d = id ? wiz.doctors.find(x => String(x.id) === String(id)) : null;
            return d ? (d.full_name || d.username || '') : '';
        };
        const dms = payer ? isDmsPayer(payer) : false;
        // В бланке 'act' уже есть блок плательщика, покрытие и подписи сторон
        // (пациент / врач / представитель страховой) — свой бланк не нужен,
        // достаточно отдать данные в его форме. Итоги он считает по items сам.
        printableSheet({
            type: 'act',
            idLine: 'АКТ ' + no,
            data: {
                title: 'Акт оказанных медицинских услуг',
                docNo: 'АКТ ' + no,
                issueDate: 'Дата ' + new Date().toLocaleDateString('ru-RU'),
                coverage: dms ? 'По полису ДМС' : 'По договору',
                patient: [
                    ['ФИО', patient.full_name || '—'],
                    ['Карта №', patient.mrn || '—'],
                    ['Дата услуг', (visitDate || '').split('-').reverse().join('.')],
                ],
                payer: [
                    ['Организация', payer ? payer.name : '—'],
                    [dms ? 'Полис' : 'Договор', dms ? (wiz.policyNo.trim() || '—') : ('счёт ' + no)],
                    ['Покрытие', '100% от суммы акта'],
                ],
                items: lines.map((c, i) => {
                    const dn = docName(c);
                    return { name: c.svc.name + (dn ? ' · ' + dn : ''), qty: c.qty, price: cartLinePrice(c), _alt: i % 2 === 1 };
                }),
            },
        });
    }

    // ---------------------------------------------------------------------
    // Step 3 — Кто платит
    // ---------------------------------------------------------------------
    function paintStep3(root) {
        // PAYER_FROM_SETTINGS_V1 — сюда попадаем только со страховой: плательщик
        // уже выбран кнопкой в смете, здесь остаётся номер полиса. Список страховых
        // оставлен, чтобы можно было переключиться, не возвращаясь на шаг 1.
        const b2b = wiz.payMethod === 'b2b';
        // PAYER_COMPANY_ON_STEP2_V1 — список ровно того ТИПА, что выбран в смете
        // (страховая / корпоратив / государственный). Прежний payersFor() делил
        // грубо на «ДМС и всё остальное», и при типе «Государственный» в списке
        // оказывались ещё и корпоративные плательщики.
        const list = payersOfKind(wiz.payKind);
        const grid = h('div', { style: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', maxWidth: '780px' } });
        for (const p of list) {
            const active = String(wiz.payerId) === String(p.id);
            grid.appendChild(h('button', {
                type: 'button',
                onclick: () => setPayer(String(p.id)),
                style: {
                    textAlign: 'left', padding: '14px 16px', borderRadius: '12px', cursor: 'pointer',
                    fontFamily: 'inherit', background: 'var(--white, #fff)',
                    border: active ? '2px solid var(--primary-500)' : '1px solid var(--ink-100)',
                    boxShadow: active ? '0 0 0 3px var(--primary-50)' : 'none',
                },
            },
                h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)' } }, p.name),
                h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '3px' } }, payerKindRu(p.kind)),
            ));
        }

        const polInp = h('input', {
            type: 'text', placeholder: 'Номер полиса (с карты пациента)', value: wiz.policyNo,
            style: { width: '100%', maxWidth: '360px', padding: '11px 12px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13.5px' },
        });
        polInp.addEventListener('input', () => { wiz.policyNo = polInp.value; });

        root.appendChild(h('div', { class: 'card', style: { padding: '18px 20px' } },
            h('h3', { style: { margin: '0 0 6px', fontSize: '14px' } }, Icon(b2b ? 'Building' : 'Receipt', { size: 15 }),
                b2b ? ' Кто платит — организация (B2B)' : ' Кто платит — ДМС / страховая'),
            h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '14px' } }, b2b
                ? 'Счёт пойдёт на организацию по договору, а не пациенту.'
                : 'Укажите номер полиса. Счёт пойдёт на страховую; кассир оформит покрытие при приёме. Страховую можно сменить здесь же.'),
            list.length ? grid : h('div', {
                style: { background: 'var(--ink-25, #f8fafa)', borderRadius: '10px', padding: '20px 14px', textAlign: 'center', color: 'var(--ink-500)', fontSize: '13px' },
            }, 'Плательщики не заведены — добавьте их в Настройки → Компании-плательщики.'),
            // Полис — только у ДМС: у договора с организацией его нет.
            b2b ? null : h('div', { style: { marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('span', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-700)' } }, 'Полис'),
                polInp),
        ));
        root.appendChild(coverageCard());
    }

    // COVERAGE_SPLIT_V1 — «что покрывает плательщик». Услуги приходят сюда САМИ
    // из шага 1 — второй раз их никто не выбирает. По умолчанию покрыто всё;
    // снятая строка уходит в счёт пациента. На сохранении визит выставляется
    // ДВУМЯ счетами: покрытые услуги — на контрагента, остальные — на пациента.
    function coverageCard() {
        const payer = wiz.payers.find(p => String(p.id) === String(wiz.payerId));
        const payerName = payer ? payer.name : 'плательщик';
        const rows = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
        const totals = h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '12px' } });

        const paint2 = () => {
            clear(rows); clear(totals);
            for (const c of wiz.cart) {
                const on = isCovered(c);
                const chk = h('input', { type: 'checkbox', checked: on, style: { width: '16px', height: '16px', cursor: 'pointer' } });
                chk.addEventListener('change', () => { c.covered = chk.checked; paint2(); repaintRail(); });
                rows.appendChild(h('label', {
                    style: {
                        display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
                        padding: '9px 12px', borderRadius: '10px',
                        border: '1px solid ' + (on ? 'var(--primary-200, #b6e2d6)' : 'var(--ink-100)'),
                        background: on ? 'var(--primary-25, #f7fcfb)' : 'var(--white, #fff)',
                    },
                },
                    chk,
                    h('span', { style: { flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 600, color: 'var(--ink-900)' } },
                        c.svc.name, c.qty > 1 ? h('span', { class: 'muted', style: { marginLeft: '6px', fontWeight: 500 } }, '×' + c.qty) : null),
                    h('span', { class: 'num', style: { fontSize: '12.5px', fontWeight: 700, whiteSpace: 'nowrap', color: 'var(--ink-900)' } },
                        fmtPrice(cartLinePrice(c) * c.qty) + ' сум'),
                    h('span', {
                        style: {
                            fontSize: '11px', fontWeight: 700, padding: '2px 9px', borderRadius: '999px', whiteSpace: 'nowrap',
                            background: on ? 'var(--primary-50, #f2faf8)' : 'var(--ink-50, #eef1f2)',
                            color: on ? 'var(--primary-700)' : 'var(--ink-600)',
                        },
                    }, on ? payerName : 'Пациент'),
                ));
            }
            const tile = (label, sum, fg, bg) => h('div', {
                style: { flex: '1 1 200px', padding: '10px 12px', borderRadius: '10px', background: bg, color: fg },
            },
                h('div', { style: { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', opacity: '.85' } }, label),
                h('div', { class: 'num', style: { fontSize: '17px', fontWeight: 800, marginTop: '2px' } }, fmtPrice(sum) + ' сум'));
            totals.appendChild(tile('Покрывает ' + payerName, coveredTotal(), 'var(--primary-700)', 'var(--primary-50, #f2faf8)'));
            totals.appendChild(tile('Платит пациент', patientTotal(), 'var(--ink-900)', 'var(--ink-25, #f6f8f9)'));
        };
        paint2();

        return h('div', { class: 'card', style: { padding: '18px 20px', marginTop: '14px' } },
            h('h3', { style: { margin: '0 0 6px', fontSize: '14px' } }, Icon('Layers', { size: 15 }), ' Что покрывает плательщик'),
            h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '12px' } },
                'Услуги перенесены с первого шага. Отмеченные уйдут в счёт «' + payerName + '», снятые — в счёт пациента. Визит будет выставлен двумя счетами.'),
            wiz.cart.length ? rows : h('div', { class: 'muted', style: { fontSize: '13px' } }, 'В смете пока нет услуг.'),
            wiz.cart.length ? totals : null,
        );
    }

    // PAYER_FROM_SETTINGS_V1 — та же подпись, что в Настройки → Компании-плательщики
    // (столбец «Тип»), чтобы один плательщик не назывался в двух местах по-разному.
    function payerKindRu(kind) {
        const k = String(kind || '').toLowerCase();
        if (k === 'corporate' || k === 'b2b') return 'Корпоративный';
        if (k === 'state' || k === 'government') return 'Государственный';
        return 'Страховая';
    }

    // ---------------------------------------------------------------------
    // Step 4 — Подтверждение
    // ---------------------------------------------------------------------
    function paintStep4(root) {
        // STEP4_ACCURATE_V1 — Подтверждение отражает то, что реально сохранится
        // (DAY_VISIT_V1): врач и время у КАЖДОЙ строки; сводные строки «Врач» и
        // «Дата» считаются из строк смет, а не из глобальных полей визита.
        const source = wiz.sources.find(s => String(s.id) === String(wiz.sourceId));
        const payer  = wiz.payerId === 'self' ? null : wiz.payers.find(p => String(p.id) === wiz.payerId);
        const typeRu = { outpatient: 'Амбулаторный', emergency: 'Экстренный', inpatient: 'Стационар' }[wiz.visitType];

        const lineDocName = (c) => {
            const id = c.doctorId || (c.svc.requires_doctor ? wiz.doctorId : null);
            const d = id ? wiz.doctors.find(x => String(x.id) === String(id)) : null;
            return d ? (d.full_name || d.username || '') : '';
        };
        const docs = [...new Set(wiz.cart.map(lineDocName).filter(Boolean))];
        const docLine = docs.length === 0 ? 'Без врача' : docs.length === 1 ? docs[0] : docs.join(', ');
        // DATE_ONLY_V1 — день берём из ЛОКАЛЬНОЙ строки ('ГГГГ-ММ-ДДTчч:мм'), а не
        // через toISOString(): в UTC+5 полночь уехала бы на предыдущие сутки.
        const days = [...new Set(wiz.cart.map(c => String(c.when || wiz.when).slice(0, 10)))].sort();
        const fmtDay = (iso) => { const d = new Date(iso + 'T00:00:00'); return d.getDate() + ' ' + RU_M_GEN[d.getMonth()] + ' ' + d.getFullYear() + ' г.'; };
        const dateLine = days.map(fmtDay).join(' · ') + (days.length > 1 ? ' (визитов: ' + days.length + ')' : '');
        const lineWhen = (c) => {
            if (isLiveQueueDoc(c.doctorId)) return 'живая очередь';
            if (!c.when) return '';
            const d = new Date(c.when);
            // DATE_ONLY_V1 — у услуги без врача времени нет, показывать 00:00 нельзя
            if (c.dateOnly) return days.length > 1 ? d.getDate() + ' ' + RU_M_GEN[d.getMonth()] : 'без времени';
            const t = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
            return (days.length > 1 ? d.getDate() + ' ' + RU_M_GEN[d.getMonth()] + ', ' : '') + t;
        };

        const kv = (l, v) => h('div', { class: 'row', style: { padding: '7px 0', borderBottom: '1px solid var(--ink-50)', fontSize: '13px', gap: '12px' } },
            h('span', { class: 'muted', style: { flex: '0 0 170px' } }, l),
            h('span', { style: { fontWeight: 600, color: 'var(--ink-900)' } }, v || '—'));

        const invoiceCb = h('input', { type: 'checkbox', checked: wiz.raiseInvoice });
        invoiceCb.addEventListener('change', () => { wiz.raiseInvoice = invoiceCb.checked; });

        root.appendChild(h('div', { class: 'card', style: { padding: '18px 20px', maxWidth: '680px' } },
            h('h3', { style: { margin: '0 0 12px', fontSize: '14px' } }, Icon('Check', { size: 15 }), ' Подтверждение'),
            kv('Пациент', [patient.full_name, patient.mrn].filter(Boolean).join(' · ')),
            kv('Дата', dateLine),
            kv(docs.length > 1 ? 'Врачи' : 'Врач', docLine),
            kv('Тип визита', typeRu),
            ...(wiz.hasReferral ? [kv('Источник направления', source ? source.name : 'Без направления')] : []),
            // PAYER_WHO_V1 — способ оплаты здесь не показываем: его выбирает касса.
            // PAYER_FROM_SETTINGS_V1 — плательщик назван своим именем из настроек;
            // его тип идёт пояснением, а не вместо названия.
            kv('Кто платит', payer
                ? payer.name + ' · ' + payerKindRu(payer.kind)
                    + (wiz.payMethod === 'dms' && wiz.policyNo.trim() ? ' · полис ' + wiz.policyNo.trim() : '')
                : 'Пациент — оплата в кассе'),
            h('div', { style: { margin: '14px 0 6px', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-500)' } }, 'Услуги'),
            ...wiz.cart.map(c => {
                const dn = lineDocName(c);
                const sub = [dn, lineWhen(c)].filter(Boolean).join(' · ');
                return h('div', { class: 'row', style: { padding: '6px 0', borderBottom: '1px solid var(--ink-50)', fontSize: '13px', gap: '10px' } },
                    h('span', { style: { flex: 1, minWidth: 0 } },
                        h('span', null, c.svc.name),
                        sub ? h('span', { class: 'muted', style: { fontSize: '12px' } }, ' · ' + sub) : null),
                    h('span', { class: 'muted num' }, c.qty + ' ×'),
                    h('span', { class: 'num', style: { fontWeight: 600 } }, fmtPrice(cartLinePrice(c) * c.qty)),
                );
            }),
            discountAmount() > 0 ? h('div', { class: 'row', style: { padding: '8px 0 0', fontSize: '13px', gap: '10px' } },
                h('span', { class: 'muted', style: { flex: 1 } }, 'Скидка'),
                h('span', { class: 'num', style: { fontWeight: 700, color: 'var(--crit-600, #dc2626)' } }, '−' + fmtPrice(discountAmount()) + ' сум')) : null,
            h('div', { class: 'row', style: { padding: '10px 0 0', fontSize: '14px', gap: '10px' } },
                h('span', { style: { flex: 1, fontWeight: 700 } }, 'Итого'),
                h('span', { class: 'num', style: { fontWeight: 800, color: 'var(--primary-700)' } }, fmtPrice(grandTotal()) + ' сум')),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px', fontSize: '12.5px', color: 'var(--ink-700)', cursor: 'pointer' } },
                invoiceCb, 'Сразу выставить счёт — он появится в кассе («Приём оплат»)'),
        ));
    }

    // ---------------------------------------------------------------------
    // СМЕТА rail (right)
    // ---------------------------------------------------------------------
    // =====================================================================
    // WIZ_TEMPLATES_LOCAL_V1 — шаблоны сметы.
    //
    // Раньше их здесь не было, и комментарий в шапке этого файла объяснял это
    // тем, что «таблицы шаблонов локально нет». Она есть — service_templates,
    // миграция 027. Правила (что такое шаблон, что он хранит) живут в
    // service-templates.js и покрыты тестами; здесь только два окна.
    // =====================================================================
    function openSaveTemplate() {
        const ov = h('div', { class: 'modal', style: { zIndex: '170' } });
        const shut = () => ov.remove();
        ov.appendChild(h('div', { class: 'modal-backdrop', onclick: shut }));
        const nameIn = h('input', {
            type: 'text', placeholder: 'Название шаблона',
            style: { width: '100%', height: '38px', padding: '0 12px', marginTop: '10px', boxSizing: 'border-box',
                     border: '1px solid var(--ink-200)', borderRadius: '9px', fontSize: '13px', fontFamily: 'inherit' },
        });
        const doSave = async (btn) => {
            btn.disabled = true;
            // Сохраняем ВСЮ смету, а не visibleCart(): услуга без врача — это
            // незаконченная строка визита, но для шаблона врач и не нужен.
            const ids = wiz.cart.map(c => c.svc && c.svc.id).filter(Boolean);
            const { error } = await createTemplate(supabase, { name: nameIn.value, serviceIds: ids });
            if (error) { toast(error.message || String(error), 'fail'); btn.disabled = false; return; }
            toast('Шаблон сохранён — услуг: ' + ids.length, 'ok');
            shut();
        };
        nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(saveBtn); } });
        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: (e) => doSave(e.currentTarget) }, 'Сохранить');
        ov.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '400px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' }, h('h2', null, Icon('Folder', { size: 15 }), ' Сохранить как шаблон'),
                h('button', { class: 'modal-close', type: 'button', onclick: shut }, '×')),
            h('div', { class: 'modal-body', style: { display: 'block', padding: '14px' } },
                h('div', { class: 'muted', style: { fontSize: '12px' } },
                    'Шаблон сохранит только список услуг (' + wiz.cart.length + ') — врач и время выбираются при каждой записи.'),
                nameIn),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', type: 'button', onclick: shut }, 'Отмена'),
                h('span', { style: { flex: 1 } }),
                saveBtn)));
        document.body.appendChild(ov);
        setTimeout(() => nameIn.focus(), 50);
    }

    async function openTemplatePicker() {
        const ov = h('div', { class: 'modal', style: { zIndex: '170' } });
        const shut = () => ov.remove();
        ov.appendChild(h('div', { class: 'modal-backdrop', onclick: shut }));
        const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '52vh', overflowY: 'auto' } },
            h('div', { class: 'muted', style: { padding: '14px', textAlign: 'center' } }, 'Загрузка…'));
        ov.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '440px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' }, h('h2', null, Icon('Copy', { size: 15 }), ' Шаблоны'),
                h('button', { class: 'modal-close', type: 'button', onclick: shut }, '×')),
            h('div', { class: 'modal-body', style: { display: 'block', padding: '14px' } }, listEl),
            h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: shut }, 'Закрыть'))));
        document.body.appendChild(ov);

        const { data, error } = await listTemplates(supabase);
        clear(listEl);
        if (error) {
            listEl.appendChild(h('div', { style: { padding: '12px', textAlign: 'center', color: 'var(--crit-700)', fontSize: '12.5px' } },
                'Не удалось загрузить шаблоны: ' + (error.message || error)));
            return;
        }
        if (!data || !data.length) {
            listEl.appendChild(h('div', { class: 'muted', style: { padding: '16px', textAlign: 'center', fontSize: '12.5px' } },
                'Сохранённых шаблонов пока нет. Соберите смету и нажмите «Сохранить как шаблон».'));
            return;
        }
        for (const t of data) {
            const row = h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', border: '1px solid var(--ink-100)', borderRadius: '10px', padding: '9px 12px' } },
                h('button', {
                    type: 'button',
                    style: { flex: '1 1 auto', minWidth: 0, border: '0', background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left', padding: '0' },
                    onclick: () => { shut(); applyTemplate(t); },
                },
                    h('div', { style: { fontWeight: 700, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.name),
                    h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'услуг: ' + templateSize(t))),
                h('button', {
                    type: 'button', title: 'Убрать шаблон из списка',
                    style: { border: '0', background: 'none', cursor: 'pointer', color: 'var(--crit-600, #dc2626)', fontSize: '16px', flex: 'none', padding: '2px 6px' },
                    onclick: async (e) => {
                        e.stopPropagation();
                        const { error: dErr } = await retireTemplate(supabase, t.id);
                        if (dErr) { toast(dErr.message || String(dErr), 'fail'); return; }
                        row.remove(); toast('Шаблон убран', 'ok');
                    },
                }, '×'));
            listEl.appendChild(row);
        }
    }

    // Услуги шаблона добавляются в смету по одной — через тот же addToCart(),
    // что и клик по каталогу, поэтому все его правила (повторное добавление,
    // количество, «нужен врач») действуют без исключений.
    function applyTemplate(t) {
        const { services, missing } = resolveTemplate(t, wiz.services);
        const before = wiz.cart.length;
        for (const svc of services) addToCart(svc);
        const added = wiz.cart.length - before;
        // paint(), not repaintCatalog(): that one is scoped inside paintStep1 and
        // is unreachable from here. paint() re-renders the step AND the смета,
        // which is exactly what adding a batch of services needs.
        paint();
        // Три разных исхода — три разных сообщения: услуги удалены из каталога;
        // всё уже было в смете; добавлено столько-то.
        const bits = [];
        if (added) bits.push('добавлено услуг: ' + added);
        if (added < services.length) bits.push('уже в смете: ' + (services.length - added));
        if (missing) bits.push('не найдено в каталоге: ' + missing);
        toast('Шаблон «' + t.name + '» — ' + (bits.join(' · ') || 'добавлять нечего'), missing ? 'warn' : 'ok');
    }

    function estimateRail() {
        railEl = h('div', {
            style: {
                flex: '0 0 520px', maxWidth: '520px',   // PAY_DMS_V1 — смета шире (440 -> 520)
                background: 'var(--white, #fff)', border: '1px solid var(--ink-100)',
                borderRadius: '14px', padding: '20px 22px',
                display: 'flex', flexDirection: 'column', gap: '14px',
                alignSelf: 'flex-start', maxHeight: '100%', overflow: 'auto',
            },
        });
        repaintRail();
        return railEl;
    }

    function cartTotal() {
        // DOC_FIRST_V1 — врачебные услуги без врача ещё «не добавлены» и не считаются
        return visibleCart().reduce((s, c) => s + cartLinePrice(c) * c.qty, 0);
    }

    // WIZARD_DISCOUNT_V1 + DISCOUNT_ABS_V1 — скидка = лояльность (процент ИЛИ
    // сумма) + промокод (percent или amount), не больше суммы сметы. Сервер
    // повторно зажимает значение при выставлении счёта.
    //
    // Возвращает СУММУ в сумах в обоих режимах — единственная величина, которая
    // уходит дальше (в счёт, в чек, в печать).
    function loyaltyDiscount() {
        const sub = cartTotal();
        if (wiz.discountMode === 'abs') {
            // Сумму вводят руками: зажимаем сметой, иначе итог ушёл бы в минус.
            return Math.min(sub, Math.max(0, Number(wiz.discountAbs) || 0));
        }
        const pct = Math.min(100, Math.max(0, Number(wiz.discountPct) || 0));
        return sub * (pct / 100);
    }
    function discountAmount() {
        const sub = cartTotal();
        let d = loyaltyDiscount();
        if (wiz.promo) {
            d += wiz.promo.percent ? sub * (Number(wiz.promo.percent) / 100) : (Number(wiz.promo.amount) || 0);
        }
        return Math.min(sub, Math.round(d));
    }
    function grandTotal() { return Math.max(0, cartTotal() - discountAmount()); }

    function repaintRail() {
        if (!railEl) return;
        clear(railEl);
        // WIZ_TEMPLATES_LOCAL_V1 — «Сохранить как шаблон» стоит у заголовка сметы
        // и появляется, только когда в ней есть что сохранять. Шаблон хранит
        // ТОЛЬКО услуги: врач и время выбираются при каждой записи.
        railEl.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 800, letterSpacing: '0.07em', color: 'var(--ink-500)' } }, 'СМЕТА'),
            h('span', { style: { flex: 1 } }),
            wiz.cart.length
                ? h('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button',
                    style: { flex: 'none', whiteSpace: 'nowrap' },
                    title: 'Сохранить набор услуг как шаблон',
                    onclick: () => openSaveTemplate(),
                }, Icon('Folder', { size: 13 }), ' Сохранить как шаблон')
                : null));
        railEl.appendChild(h('div', { class: 'row', style: { gap: '10px' } },
            Avatar({ initials: initials(patient.full_name || '?'), color: avColor(patient.id) }),
            h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontSize: '15px', fontWeight: 700, color: 'var(--ink-900)' } }, patient.full_name || '—'),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [patient.mrn, patient.phone].filter(Boolean).join(' · ')),
            ),
        ));

        const shownCart = visibleCart();
        const pendingDoc = wiz.cart.length - shownCart.length;
        if (wiz.cart.length === 0) {
            railEl.appendChild(h('div', {
                style: { background: 'var(--ink-25, #f8fafa)', borderRadius: '10px', padding: '26px 12px', textAlign: 'center', color: 'var(--ink-400)', fontSize: '13px' },
            }, 'Услуги появятся здесь'));
        } else {
            const list = h('div', { style: { display: 'flex', flexDirection: 'column' } });
            for (const c of shownCart) {
                const stepBtn = (txt, fn) => h('button', {
                    type: 'button', onclick: fn,
                    style: {
                        width: '26px', height: '26px', borderRadius: '7px', cursor: 'pointer',
                        border: '1px solid var(--ink-200)', background: 'var(--white, #fff)',
                        color: 'var(--ink-700)', fontWeight: 700, lineHeight: 1,
                    },
                }, txt);
                // ONE_LINE_CART_V1 — одна строка на услугу: название · [кол-во
                // у процедур] · цена · ✕. Подпись «разово за визит» убрана
                // (SINGLE_PER_VISIT_V1 по-прежнему действует: без счётчика = 1).
                list.appendChild(h('div', { class: 'row', style: { gap: '8px', padding: '9px 0', borderBottom: '1px solid var(--ink-50)' } },
                    h('span', { style: { flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 600, color: 'var(--ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.svc.name),
                    ...(isMultiQty(c.svc) ? [
                        stepBtn('−', () => { c.qty = Math.max(1, c.qty - 1); repaintRail(); }),
                        h('span', { class: 'num', style: { fontSize: '14px', minWidth: '20px', textAlign: 'center' } }, String(c.qty)),
                        stepBtn('+', () => { c.qty += 1; repaintRail(); }),
                    ] : []),
                    h('span', { class: 'num', style: { fontSize: '14px', fontWeight: 700, whiteSpace: 'nowrap' } }, fmtPrice(cartLinePrice(c) * c.qty) + ' сум'),
                    h('button', {
                        type: 'button', title: 'Убрать',
                        onclick: () => { wiz.cart = wiz.cart.filter(x => x !== c); repaintRail(); if (wiz.step === 1) paint(); },
                        style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--crit-500, #ef4444)', display: 'flex' },
                    }, Icon('X', { size: 13 })),
                ));
            }
            railEl.appendChild(list);
            // DOC_PICK_IN_RAIL_V1 — услуги, ждущие врача, показываем СТРОКАМИ с
            // выбором врача прямо здесь.
            //
            // Раньше тут стояла одна серая надпись «ещё N услуга(и) появятся
            // после выбора врача»: услуга уже в смете, но не видна и не названа,
            // а выбрать врача можно было только найдя её в каталоге на 513
            // позиций. Для подставленной из заявки колл-центра это тупик —
            // регистратура не знает, что именно искать.
            if (pendingDoc > 0) {
                const wait = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px', padding: '9px 10px', background: 'var(--warn-50, #fffbeb)', border: '1px solid var(--warn-200, #fde68a)', borderRadius: '10px' } },
                    h('div', { style: { fontSize: '11.5px', fontWeight: 700, color: 'var(--warn-700, #a16207)' } },
                        'Выберите врача — ' + pendingDoc + ' услуг(и) ждут'));
                for (const c of wiz.cart.filter(x => x.svc.requires_doctor && !x.doctorId)) {
                    const pool = doctorsForService(c.svc.id);
                    const sel = h('select', {
                        style: { width: '100%', padding: '6px 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px', background: 'var(--white,#fff)' },
                    },
                        h('option', { value: '' }, pool.length ? '— выберите врача —' : 'нет врачей для этой услуги'),
                        ...pool.map(d => h('option', { value: String(d.id) }, (d.full_name || d.username || '') + (d.specialty ? ' · ' + d.specialty : ''))));
                    sel.addEventListener('change', () => {
                        if (!sel.value) return;
                        c.doctorId = Number(sel.value);
                        // Тот же путь, что и при выборе врача в каталоге: без
                        // слота врачебная услуга не уедет дальше шага 1.
                        if (!c.when && !isLiveQueueDoc(c.doctorId)) { try { autoPickSlot(c); } catch (_) {} }
                        repaintRail();
                        if (wiz.step === 1) paint();
                    });
                    wait.appendChild(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                        h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-900)', overflowWrap: 'anywhere' } },
                            c.svc.name,
                            c.fromCrm ? h('span', { style: { marginLeft: '6px', fontSize: '10px', fontWeight: 700, color: 'var(--primary-700)', background: 'var(--primary-50, #e8f3f2)', borderRadius: '999px', padding: '1px 7px' } }, 'из заявки') : null),
                        sel));
                }
                railEl.appendChild(wait);
            }
        }

        // ---- REFERRAL_TICK_V1 — «пациент по направлению»: галочка управляет
        // шагом «Направление» (снята по умолчанию — шаг пропускается) ----
        const refChk = h('input', {
            type: 'checkbox', checked: wiz.hasReferral,
            style: { width: '19px', height: '19px', accentColor: 'var(--primary-600)', cursor: 'pointer', flex: '0 0 auto' },
        });
        refChk.addEventListener('change', () => {
            wiz.hasReferral = refChk.checked;
            if (!wiz.hasReferral) {
                wiz.sourceId = '';                       // направление снято — источник сбрасываем
                wiz.sourceCat = '';                      // REFERRAL_TWO_STEP_V1 — и категорию вместе с ним
                // PAY_DMS_V1 — вперёд на следующий шаг МАРШРУТА (3 только при ДМС)
                if (wiz.step === 2) wiz.step = stepSeq().find(s => s > 2) || 4;
            }
            paint();
        });
        railEl.appendChild(h('label', {
            style: {
                display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
                padding: '11px 13px', borderRadius: '12px',
                border: wiz.hasReferral ? '2px solid var(--primary-400, #4bb39a)' : '1px dashed var(--ink-200)',
                background: wiz.hasReferral ? 'var(--primary-25, #f2faf8)' : 'var(--white, #fff)',
            },
        },
            refChk,
            h('span', { style: { minWidth: 0 } },
                h('span', { style: { display: 'block', fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)' } }, 'Пациент по направлению'),
                h('span', { class: 'muted', style: { display: 'block', fontSize: '11.5px', marginTop: '1px' } },
                    wiz.hasReferral ? 'шаг «Направление» включён' : 'без направления — шаг пропускается')),
        ));

        // ---- «Кто платит» + скидка + промокод (WIZARD_RAIL_PARITY_V1, как в easymed) ----
        // PAYER_TYPE_THEN_COMPANY_V1 — верхний ряд: ТИП плательщика; под ним, при
        // выборе типа, — компании этого типа. Это СТОРОНА-плательщик, а не способ
        // оплаты: наличные/карта/эквайринг подтверждает касса при приёме.
        // `wrap` — для названий компаний: они бывают длинные, и обрезать их
        // многоточием значит показать «Стра…» вместо имени плательщика. Пусть
        // переносятся; min-height держит кнопки одной высоты в ряду.
        // Рамка ВСЕГДА 1px — выделение рисуется внутренней тенью. Прежде выбранная
        // кнопка получала рамку 2px: коробка росла на пиксель с каждой стороны, и
        // весь ряд (а с переносом текста — и высота строки) дёргался в момент
        // клика. Толщина обводки не должна зависеть от выбора.
        const payBtn = (m, active, onPick, small, wrap) => h('button', {
            type: 'button', title: m.sub || m.label,
            onclick: onPick,
            style: {
                padding: small ? '6px 8px' : '7px 8px', borderRadius: '9px', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: small ? '11.5px' : '12px', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                minWidth: 0, boxSizing: 'border-box',
                ...(wrap
                    ? { whiteSpace: 'normal', textAlign: 'center', lineHeight: '1.25', minHeight: '38px', overflowWrap: 'anywhere' }
                    : { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minHeight: '34px' }),
                background: active ? 'var(--primary-50, #f2faf8)' : 'var(--white, #fff)',
                border: '1px solid ' + (active ? 'var(--primary-500)' : 'var(--ink-200)'),
                boxShadow: active ? 'inset 0 0 0 1px var(--primary-500)' : 'none',
                color: active ? 'var(--primary-700)' : 'var(--ink-700)',
            },
        }, m.icon ? Icon(m.icon, { size: 13 }) : null, m.label);

        // Типов немного (максимум четыре кнопки), но сетка всё равно переносит.
        const payRow = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: '6px' } },
            ...payTypeChoices().map(t => payBtn(t, wiz.payKind === t.id, () => setPayKind(t.id))));

        // PAYER_COMPANY_ON_STEP2_V1 — ряд компаний из СМЕТЫ убран: конкретную
        // компанию (и то, какие услуги она покрывает) выбирают на шаге «Кто
        // платит». Держать тот же выбор в двух местах — это два источника правды
        // и лишний шум в смете; здесь остаётся ТИП плательщика и строка-итог
        // ниже, показывающая, на кого в итоге пойдёт счёт.
        const _payer = wiz.payers.find(p => String(p.id) === String(wiz.payerId));
        const dmsHint = wiz.payKind === 'self'
            ? null
            : !_payer
                // Компания ещё не выбрана — её выбирают на шаге «Кто платит»,
                // и «Далее» без неё не пропустит (nextBlockReason).
                ? h('div', { style: { fontSize: '11.5px', color: 'var(--warn-700, #a16207)' } },
                    'компанию выберете на шаге «Кто платит»')
                // COVERAGE_SPLIT_V1 — итог: кто платит и сколько из сметы берёт
                // на себя. Смета обязана показывать, на кого пойдёт счёт, даже
                // когда сам выбор переехал на следующий шаг.
                : h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                    _payer.name + ' · покрывает ' + fmtPrice(coveredTotal()) + ' из ' + fmtPrice(cartTotal()) + ' сум');
        // Единственная кнопка «Пациент» без объяснения выглядит как поломка —
        // но сказать «не заведены», когда список просто не загрузился, ХУЖЕ: это
        // отправляет заводить то, что уже заведено. PAYER_LOAD_V2.
        const noPayersHint = wiz.payers.length ? null
            : wiz.payersError
                ? h('div', { style: { fontSize: '11.5px', color: 'var(--crit-700, #b91c1c)' } },
                    'Плательщики не загрузились: ' + wiz.payersError + '. Список в Настройки → Компании-плательщики цел — обновите страницу.')
                : h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                    'Плательщики не заведены — добавьте их в Настройки → Компании-плательщики.');

        // Скидка/итого обновляются без полного repaint, чтобы инпуты не теряли фокус.
        const discEl  = h('span', { class: 'num', style: { fontWeight: 700, fontSize: '14px', color: 'var(--crit-600, #dc2626)' } });
        const discRow = h('div', { class: 'row', style: { gap: '10px', display: 'none' } },
            h('span', { class: 'muted', style: { flex: 1, fontSize: '13.5px' } }, 'Скидка'),
            discEl);
        const totEl = h('span', { class: 'num', style: { fontWeight: 800, fontSize: '19px', color: 'var(--ink-900)' } });
        const refreshTotals = () => {
            const d = discountAmount();
            discRow.style.display = d > 0 ? '' : 'none';
            discEl.textContent = '−' + fmtPrice(d) + ' сум';
            totEl.textContent = fmtPrice(grandTotal()) + ' сум';
        };

        // DISCOUNT_ABS_V1 — поле скидки + переключатель «% / сум».
        const discLabelEl = h('span', { style: { flex: 1, fontSize: '13.5px', color: 'var(--ink-700)' } });
        const discInp = h('input', {
            type: 'number', min: '0', step: '1',
            style: { width: '116px', padding: '10px 12px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '14px', textAlign: 'right' },
        });
        const isAbs = () => wiz.discountMode === 'abs';
        // Значение и ограничения зависят от режима: процент ограничен сотней,
        // сумма — нет (её всё равно зажимает сметой loyaltyDiscount и сервер).
        const syncDiscInput = () => {
            discLabelEl.textContent = isAbs() ? 'Скидка (лояльность), сум' : 'Скидка (лояльность), %';
            discInp.max = isAbs() ? '' : '100';
            discInp.step = isAbs() ? '1000' : '1';
            const v = isAbs() ? wiz.discountAbs : wiz.discountPct;
            discInp.value = v ? String(v) : '0';
            discInp.title = isAbs()
                ? 'Скидка суммой: вычитается из сметы как есть (не больше самой сметы)'
                : 'Скидка процентом от суммы сметы';
        };
        discInp.addEventListener('input', () => {
            const n = Math.max(0, Number(discInp.value) || 0);
            if (isAbs()) wiz.discountAbs = n;
            else wiz.discountPct = Math.min(100, n);
            refreshTotals();
        });

        const modeBtn = (mode, label) => {
            const on = wiz.discountMode === mode;
            return h('button', {
                type: 'button',
                onclick: () => {
                    if (wiz.discountMode === mode) return;
                    wiz.discountMode = mode;
                    // Значения обоих режимов сохраняются, поэтому переключение
                    // ничего не теряет — но действует только выбранное.
                    syncDiscInput(); paintModes(); refreshTotals();
                },
                style: {
                    padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: '12px', fontWeight: 700, lineHeight: 1,
                    border: '1px solid ' + (on ? 'var(--primary-400, #4bb39a)' : 'var(--ink-200)'),
                    background: on ? 'var(--primary-50, #e8f3f2)' : 'var(--white, #fff)',
                    color: on ? 'var(--primary-700)' : 'var(--ink-500)',
                    borderRadius: mode === 'pct' ? '9px 0 0 9px' : '0 9px 9px 0',
                    marginLeft: mode === 'pct' ? '0' : '-1px',
                },
            }, label);
        };
        const modesEl = h('div', { style: { display: 'inline-flex' } });
        const paintModes = () => { clear(modesEl); modesEl.append(modeBtn('pct', '%'), modeBtn('abs', 'сум')); };
        paintModes();
        syncDiscInput();

        const promoInp = h('input', {
            type: 'text', placeholder: 'Промокод / карта / сертификат',
            value: wiz.promo ? wiz.promo.name : '',
            style: { flex: 1, minWidth: 0, padding: '11px 12px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13.5px' },
        });
        const promoBtn = h('button', {
            class: 'btn btn-outline btn-sm', type: 'button',
            onclick: async () => {
                const code = promoInp.value.trim();
                if (!code) { wiz.promo = null; refreshTotals(); return; }
                const { data, error } = await supabase.from('patient_discounts')
                    .select('id, name, kind, percent, amount').eq('active', 1);
                if (error) { toast('Не удалось проверить код: ' + error.message, 'fail'); return; }
                const hit = (data || []).find(d => (d.name || '').trim().toLowerCase() === code.toLowerCase());
                if (!hit) { toast('Код «' + code + '» не найден (Настройки → Скидки пациентов).', 'fail'); return; }
                wiz.promo = hit;
                toast('Применено: ' + hit.name + (hit.percent ? ' (−' + hit.percent + '%)' : hit.amount ? ' (−' + fmtPrice(hit.amount) + ' сум)' : ''), 'ok');
                refreshTotals();
            },
        }, 'Применить');

        // PROMO_TICK_V1 — промокод используется редко: по умолчанию поле
        // скрыто, вместо него маленькая галочка. Применённый код держит
        // блок раскрытым.
        if (wiz.promo) wiz.promoOpen = true;
        const promoRow = h('div', { class: 'row', style: { gap: '8px', display: wiz.promoOpen ? '' : 'none' } }, promoInp, promoBtn);
        const promoChk = h('input', {
            type: 'checkbox', checked: !!wiz.promoOpen,
            style: { width: '15px', height: '15px', accentColor: 'var(--primary-600)', cursor: 'pointer' },
        });
        promoChk.addEventListener('change', () => {
            wiz.promoOpen = promoChk.checked;
            promoRow.style.display = wiz.promoOpen ? '' : 'none';
            if (!wiz.promoOpen && wiz.promo) { wiz.promo = null; promoInp.value = ''; refreshTotals(); }   // снятие галочки снимает код
            if (wiz.promoOpen) promoInp.focus();
        });
        const promoTick = h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer', fontSize: '12px', color: 'var(--ink-500)' } },
            promoChk, 'Промокод / карта / сертификат');

        railEl.appendChild(h('div', { style: { borderTop: '1px solid var(--ink-100)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('div', { style: { fontSize: '14px', fontWeight: 800, color: 'var(--ink-900)' } }, 'Кто платит'),
            payRow,
            noPayersHint,
            dmsHint,
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
                discLabelEl, modesEl, discInp),
            promoTick,
            promoRow,
        ));

        railEl.appendChild(h('div', { style: { borderTop: '2px solid var(--ink-100)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            discRow,
            h('div', { class: 'row', style: { gap: '10px' } },
                h('span', { style: { flex: 1, fontWeight: 800, fontSize: '16px' } }, 'Итого'),
                totEl),
        ));
        refreshTotals();

        // Далее / Создать визит — зелёная CTA как в easymed
        // REFERRAL_TICK_V1 + PAY_DMS_V1 — единый маршрут шагов (stepSeq()).
        const seq = stepSeq();
        const NEXT_TITLES = { 2: 'Направление', 3: 'Кто платит', 4: 'Подтверждение' };
        const seqIdx = seq.indexOf(wiz.step);
        const nextStep = seqIdx >= 0 && seqIdx < seq.length - 1 ? seq[seqIdx + 1] : null;
        const nextLabel = nextStep ? 'Далее: ' + NEXT_TITLES[nextStep] : 'Сформировать счёт';   // WIZ_INVOICE_PRINT_V1
        const blocked = nextBlockReason();
        const nextBtn = h('button', {
            class: 'btn', type: 'button',
            disabled: !!blocked || wiz.creating,
            style: {
                width: '100%', justifyContent: 'center', padding: '14px', fontWeight: 800,
                background: blocked || wiz.creating ? 'var(--ink-100)' : '#16a34a',
                borderColor: blocked || wiz.creating ? 'var(--ink-100)' : '#16a34a',
                color: blocked || wiz.creating ? 'var(--ink-400)' : '#fff',
                borderRadius: '12px', fontSize: '15px',
            },
            onclick: () => { if (nextStep) { wiz.step = nextStep; paint(); } else { createVisit(); } },
        }, wiz.creating ? 'Создаём…' : nextLabel);
        // RAIL_STICKY_CTA_V1 — кнопка «Далее/Создать визит» прилипает к низу
        // СМЕТЫ: при длинной смете контент прокручивается, кнопка остаётся видна.
        const footer = h('div', {
            style: {
                position: 'sticky', bottom: '-21px', zIndex: 5,
                background: 'var(--white, #fff)',
                margin: '0 -22px -20px', padding: '10px 22px 20px',
                borderTop: '1px solid var(--ink-50)',
                display: 'flex', flexDirection: 'column', gap: '8px',
            },
        });
        footer.appendChild(nextBtn);
        footer.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', textAlign: 'center' } },
            blocked ? blocked : ('всё готово — услуг: ' + wiz.cart.length)));
        if (wiz.step > 1) {
            footer.appendChild(h('button', {
                class: 'btn btn-outline btn-sm', type: 'button',
                style: { width: '100%', justifyContent: 'center' },
                onclick: () => { const s = stepSeq(); const i = s.indexOf(wiz.step); wiz.step = i > 0 ? s[i - 1] : 1; paint(); },
            }, '‹ Назад'));
        }
        railEl.appendChild(footer);
    }

    function nextBlockReason() {
        if (wiz.step === 1) {
            if (wiz.cart.length === 0) return 'добавьте хотя бы одну услугу';
            // SCHED_V1 — врачебной услуге нужны врач и слот прямо в карточке услуги
            if (wiz.cart.some(c => c.svc.requires_doctor && !(c.doctorId && (c.when || isLiveQueueDoc(c.doctorId))))) return 'выберите врача и время для услуг, где нужен врач';
        }
        if (wiz.step === 2) {
            if (!wiz.when && !wiz.cart.some(c => c.when)) return 'укажите дату и время визита';
            // REFERRAL_TWO_STEP_V1 — источник выбран, а КТО направил — нет:
            // визит ушёл бы с пустым referral_source_id, то есть «по направлению»
            // в отчётах «Рефералы» никому бы не засчиталось. Не блокируем, если
            // в категории вообще некого выбрать — иначе выхода из шага нет.
            if (wiz.sourceCat && !wiz.sourceId && refSourcesIn(wiz.sources, wiz.sourceCat).length) {
                return 'выберите, кто направил пациента';
            }
        }
        // PAYER_TYPE_THEN_COMPANY_V1 — тип выбран, компания нет: счёт выставить
        // не на кого. Проверяем на КАЖДОМ шаге, а не только на третьем — с типом
        // «корпоративный»/«госпрограмма» третьего шага вообще нет, и без этой
        // проверки визит уходил бы в создание с payer_id = null, молча превращаясь
        // в самооплату.
        if (wiz.payKind !== 'self' && wiz.payerId === 'self') {
            return 'выберите компанию-плательщика в смете';
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // create: visit -> visit_services -> (invoice) -> (payer)
    // ---------------------------------------------------------------------
    async function createVisit() {
        if (wiz.creating) return;
        // re-validate the earlier steps before writing anything
        for (const st of [1, 2, 3]) {
            const prev = wiz.step;
            wiz.step = st;
            const blocked = nextBlockReason();
            wiz.step = prev;
            if (blocked) { toast(blocked, 'fail'); return; }
        }
        wiz.creating = true;
        repaintRail();
        try {
            const uid = currentUserId();
            const { data: branchRows } = await supabase.from('branches').select('id').eq('active', true).order('id').limit(1);
            const branchId = branchRows && branchRows[0] ? branchRows[0].id : null;

            // DAY_VISIT_V1 — визит = один календарный день (00:00–23:59).
            // Регистратор работает УСЛУГАМИ; каждая услуга ложится в визит
            // СВОЕЙ даты. Визит находит/создаёт сервер (ensure_visit) — число
            // визитов считается само и служит статистике.
            const lineIso = (c) => new Date(c.when || wiz.when).toISOString();
            // DATE_ONLY_V1 — группируем по ЛОКАЛЬНОМУ дню строки: toISOString()
            // в UTC+5 отправил бы полуночную услугу в предыдущий день.
            const lineDay = (c) => String(c.when || wiz.when).slice(0, 10);
            const byDay = new Map();   // 'YYYY-MM-DD' -> [cart lines]
            for (const c of wiz.cart) {
                const day = lineDay(c);
                if (!byDay.has(day)) byDay.set(day, []);
                byDay.get(day).push(c);
            }

            let invoicesOk = 0, invoiceFail = '';
            const aktJobs = [];                            // AKT_DOC_V1 — акты по счетам контрагентов
            let firstInvoice = null;                       // WIZ_INVOICE_PRINT_V1 — печатаем первый счёт
            const lineByVsId = new Map();                  // QUEUE_TICKET_V1 — vsId -> cart line
            // DISCOUNT_CARRY_V1 — скидка идёт на счета пациента по порядку дней:
            // сколько влезло в первый, остаток — в следующий (см. ниже).
            let discountLeft = discountAmount();
            for (const [day, lines] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
                // самый ранний слот дня — время визита; врач дня — первый врач строк.
                // DATE_ONLY_V1 — полуночные услуги без времени не должны перебивать
                // реальный слот записи: считаем по ним только если других нет.
                const timed = lines.filter(c => !c.dateOnly);
                const earliest = (timed.length ? timed : lines).map(lineIso).sort()[0];
                const dayDoc = (lines.find(c => c.doctorId) || {}).doctorId || wiz.doctorId || null;
                const { data: ev, error: evErr } = await supabase.rpc('ensure_visit', {
                    patient_id: patient.id, date: earliest,
                    doctor_id: dayDoc ? Number(dayDoc) : null,
                    visit_type: wiz.visitType,
                    referral_source_id: wiz.sourceId ? Number(wiz.sourceId) : null,
                    branch_id: branchId,
                    notes: wiz.notes.trim() || null,
                });
                if (evErr) throw new Error('Визит на ' + day + ': ' + (evErr.message || 'ensure_visit failed'));
                const visit = ev.visit;

                const vsIds = [];
                const coveredVsIds = [];   // COVERAGE_SPLIT_V1 — строки за счёт контрагента
                for (const c of lines) {
                    const row = {
                        visit_id: visit.id,
                        service_id: c.svc.id,
                        quantity: c.qty,
                        // The server re-prices authoritatively when the invoice is
                        // created; seeding the same number here keeps the patient
                        // card from briefly showing a different one.
                        unit_price: cartLinePrice(c),
                        total: cartLinePrice(c) * c.qty,
                        status: 'added',
                    };
                    // SCHED_V1 — врач и время строки из inline-планировщика; фолбэк —
                    // врач шага 2 для врачебных услуг (как раньше).
                    const lineDoc = c.doctorId || (c.svc.requires_doctor ? wiz.doctorId : null);
                    if (lineDoc) row.doctor_id = Number(lineDoc);
                    if (c.when) row.scheduled_at = new Date(c.when).toISOString();
                    if (uid != null) row.created_by = uid;
                    const res = await supabase.from('visit_services').insert(row).select().single();
                    if (res.error) throw new Error('Услуга «' + c.svc.name + '»: ' + (res.error.message || 'insert failed'));
                    vsIds.push(res.data.id);
                    lineByVsId.set(res.data.id, c);
                    if (isCovered(c)) coveredVsIds.push(res.data.id);
                }

                if (wiz.raiseInvoice && vsIds.length) {
                    // COVERAGE_SPLIT_V1 — визит делится на ДВА счёта: покрытые
                    // услуги уходят контрагенту (payer_id), остальные — пациенту.
                    // Скидка — только на счёт пациента: контрагент платит по
                    // договору, и «лояльность» к нему не относится.
                    const covered = new Set(coveredVsIds);
                    const patientIds = vsIds.filter(id => !covered.has(id));
                    const jobs = [
                        { ids: patientIds,   payer: null,                    label: 'пациенту' },
                        { ids: coveredVsIds, payer: Number(wiz.payerId) || null, label: 'плательщику' },
                    ].filter(j => j.ids.length && (j.payer === null || wiz.payKind !== 'self'));

                    for (const job of jobs) {
                        // WIZARD_DISCOUNT_V1 — сервер зажимает discount_amount в [0, subtotal].
                        const disc = job.payer === null ? discountLeft : 0;
                        const { data: iRes, error: iErr } = await supabase.rpc('create_invoice_for_visit',
                            { visit_id: visit.id, visit_service_ids: job.ids, discount_amount: disc, payer_id: job.payer });
                        if (iErr) { invoiceFail = ' Счёт (' + day + ', ' + job.label + ') не выставлен: ' + (iErr.message || iErr) + ' — можно выставить из визита.'; continue; }
                        invoicesOk++;
                        // DISCOUNT_CARRY_V1 — остаток скидки переходит на счёт
                        // СЛЕДУЮЩЕГО дня, а не сгорает.
                        //
                        // Раньше здесь стояло discountLeft = 0: вся скидка уходила
                        // в счёт первого дня, сервер зажимал её суммой ИМЕННО ЭТОГО
                        // счёта, а разница молча пропадала. Смета на три дня с
                        // «−200 000», где первый день стоит 50 000, теряла 150 000:
                        // дни 2–3 выставлялись без скидки. Со скидкой суммой это
                        // стало бы нормой, поэтому вычитаем ровно то, что сервер
                        // реально применил (invoice.discount_amount), и остаток
                        // несём дальше.
                        if (job.payer === null) {
                            const applied = Number(iRes && iRes.invoice && iRes.invoice.discount_amount) || 0;
                            discountLeft = Math.max(0, Math.round(discountLeft - applied));
                        }
                        // Печатаем счёт ПАЦИЕНТА: контрагенту чек на руки не нужен.
                        if (job.payer === null && !firstInvoice && iRes && iRes.invoice) firstInvoice = iRes.invoice;
                        // AKT_DOC_V1 — счёт контрагента в кассу не попадает: по нему
                        // не берут наличные, расчёт идёт по АКТУ выполненных работ.
                        // Собираем его данные здесь, пока состав дня под рукой.
                        if (job.payer !== null && iRes && iRes.invoice) {
                            aktJobs.push({
                                invoice: iRes.invoice,
                                payerId: job.payer,
                                lines: lines.filter(isCovered),
                                visitDate: day,
                            });
                        }
                    }
                }
            }

            // QUEUE_TICKET_V1 — номера очереди для всех зарегистрированных услуг:
            // per-врач (консультации), одна на пациента (лаборатория), врач/кабинет
            // (процедуры), per-аппарат (диагностика). Идемпотентно; сбой не
            // блокирует счёт (как в easymed).
            let queueRows = [];
            try {
                const qIds = [...lineByVsId.keys()];
                if (qIds.length) {
                    const { data: tickets, error: qErr } = await supabase.rpc('issue_queue_numbers', { p_ids: qIds });
                    if (qErr) console.warn('[wizard] queue numbers:', qErr.message || qErr);
                    else {
                        queueRows = (tickets || []).map(t => ({
                            service: (lineByVsId.get(t.visit_service_id) || { svc: {} }).svc.name || 'Услуга',
                            label: t.label || '', number: t.number, key: t.queue_key || '',
                        }));
                    }
                }
            } catch (e) { console.warn('[wizard] queue numbers:', e && e.message); }

            // WIZ_INVOICE_PRINT_V1 — сразу открываем печатную форму счёта
            // (бланк «Счёт» из Настройки → Документы; с блоком номеров очереди).
            if (firstInvoice) {
                try {
                    const invNo = firstInvoice.invoice_number || String(firstInvoice.id);
                    // PAYER_FROM_SETTINGS_V1 — на печатном счёте плательщик назван
                    // так же, как в настройках и в подтверждении мастера.
                    const _p = wiz.payers.find(p => String(p.id) === String(wiz.payerId));
                    const payLabel = _p
                        ? _p.name + ' · ' + payerKindRu(_p.kind)
                            + (wiz.payMethod === 'dms' && wiz.policyNo.trim() ? ' · полис ' + wiz.policyNo.trim() : '')
                        : 'Пациент — оплата в кассе';
                    // INVOICE_DOCTOR_V1 — врач в счёте: в каждой строке услуги
                    // (как в visit-modal: «Услуга · Врач»), а при одном враче на
                    // весь заказ — ещё и отдельной строкой в шапке.
                    const docName = (c) => {
                        const id = c.doctorId || (c.svc.requires_doctor ? wiz.doctorId : null);
                        const d = id ? wiz.doctors.find(x => String(x.id) === String(id)) : null;
                        return d ? (d.full_name || d.username || '') : '';
                    };
                    const orderDocs = [...new Set(wiz.cart.map(docName).filter(Boolean))];
                    printableSheet({ type: 'invoice', idLine: invNo, data: {
                        title: 'Амбулаторные услуги',
                        docNo: invNo,
                        issueDate: 'Дата ' + new Date().toLocaleDateString('ru-RU'),
                        status: 'UNPAID',
                        patient: [
                            ['ФИО', patient.full_name || '—'],
                            ['Карта №', patient.mrn || '—'],
                            ['Телефон', patient.phone || '—'],
                            ...(orderDocs.length === 1 ? [['Врач', orderDocs[0]]] : []),
                        ],
                        billing: [
                            ['Дата', new Date().toLocaleDateString('ru-RU')],
                            ['Оплата', payLabel],
                            // DISCOUNT_ABS_V1 — печатаем СУММУ скидки в обоих
                            // режимах (её пациент и сверяет с итогом), а процент
                            // добавляем как пояснение, когда скидка задана им.
                            ...(discountAmount() > 0 ? [['Скидка',
                                (wiz.discountMode === 'pct' && Number(wiz.discountPct) > 0 ? wiz.discountPct + '% · ' : '')
                                + '−' + fmtPrice(discountAmount()) + ' сум']] : []),
                            ...(wiz.promo ? [['Промокод', wiz.promo.name]] : []),
                        ],
                        // COVERAGE_SPLIT_V1 — в счёте ПАЦИЕНТА только его услуги.
                        // Раньше печатался весь заказ: пациент видел бы в своём
                        // счёте позиции, которые оплачивает страховая.
                        items: wiz.cart.filter(c => !isCovered(c)).map((c, i) => {
                            const dn = docName(c);
                            return { name: c.svc.name + (dn ? ' · ' + dn : ''), qty: c.qty, price: cartLinePrice(c), _alt: i % 2 === 1 };
                        }),
                        queue: queueRows,   // QUEUE_TICKET_V1
                        subtotal: patientTotal(), total: Math.max(0, patientTotal() - discountAmount()), paid: 0,
                    } });
                } catch (e) { console.warn('[wizard] invoice print:', e); }
            }

            // Payer choice lives on the patient (no per-invoice payer locally).
            // PAY_DMS_V1 — при ДМС сохраняем и номер полиса (mig 034).
            if (wiz.payerId !== 'self') {
                const patch = { payer_id: Number(wiz.payerId) };
                if (wiz.payMethod === 'dms' && wiz.policyNo.trim()) patch.insurance_policy_number = wiz.policyNo.trim();
                await supabase.from('patients').update(patch).eq('id', patient.id).select().single();
            }

            // AKT_DOC_V1 — по счёту контрагента печатается АКТ выполненных работ:
            // в кассу такой счёт не попадает (наличных по нему не берут), и
            // закрывающим документом для страховой/организации служит акт.
            for (const job of aktJobs) {
                try { printAkt(job); } catch (e) { console.warn('[wizard] akt print:', e); }
            }

            const dayWord = byDay.size > 1 ? ' (дней: ' + byDay.size + ')' : '';
            const cashInvoices = invoicesOk - aktJobs.length;
            const invMsg = invoiceFail || [
                cashInvoices > 0 ? ' Счёт пациента выставлен — виден в кассе.' : '',
                aktJobs.length ? ' Услуги плательщика — по акту, в кассу не идут.' : '',
            ].join('');
            toast('Услуги добавлены' + dayWord + '.' + invMsg, invoiceFail ? 'info' : 'ok');
            await closeCrmLines();   // CRM_SCHEDULE_V1
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast('Не удалось сохранить услуги: ' + (e && e.message || e), 'fail');
            wiz.creating = false;
            repaintRail();
        }
    }
}
