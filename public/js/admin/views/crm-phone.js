// CRM_PHONE_V1 (2026-10-17) — ТЕЛЕФОН ВНУТРИ EASYMED: КНОПКА В ВЕРХНЕЙ ПАНЕЛИ, ПАНЕЛЬ СПРАВА.
//
// Владелец: «there is a easyphone, I want it to be inside the easymed, not in
// separate adress» → на вопрос, где именно: «inside the CRM»; затем, по снимку
// экрана: «put the phone button next to reload button here» — кнопка в верхней
// панели рядом с «Обновить», то есть на каждом экране. Образец вида — его файл
// «EasyMed Telephony.html»: кнопка в шапке, выдвижная панель справа, наборник
// круглыми клавишами и журнал с поиском и сегментами под ним.
//
// ЧТО ЭТО. Рабочее место телефониста, которое до этого дня было ОТДЕЛЬНОЙ
// программой EasyPhone (phone/, порт 8020, EASYPHONE_V1): своя трубка, наборник,
// журнал, «Прослушать». Теперь — панель поверх любого экрана; доска CRM даёт ей
// имена заявок и открывает карточку (registerCrmPhoneHooks). Один вход вместо
// двух адресов; обновляется и чинится вместе со всем остальным.
//
// ЧЕСТНО О ТОМ, ЧТО ЭТО ТАКОЕ. Снаружи похоже на программный телефон, но звук
// идёт НЕ через компьютер: обе линии (onlinePBX, Binotel) сначала поднимают
// трубку оператора и только потом набирают пациента. Панель — НАБОРНИК и ЖУРНАЛ,
// а не трубка. Поэтому из образца НЕ взяты Mute / Speaker / Hold / Transfer /
// Accept / Decline и таймер разговора: кнопка, нажатие которой ничего не делает,
// читается как «не работает» (ROLES_SAVE_TRUTH_V1). Об этом сказано владельцу
// до начала работы, и он ответил «go on».
//
// ЖИЗНЬ ПАНЕЛИ. Состояние — в памяти модуля до перезагрузки страницы. Панель,
// вкладка на краю и пилюля живут на document.body и переходов между разделами
// не замечают: телефонист ходит по картотеке и кассе, а трубка остаётся под
// рукой — так и в образце. Журнал опрашивается раз в семь секунд, пока панель
// открыта или свёрнута при звонке. Выход из системы перезагружает страницу
// (signOutAndReload), и с ней уходит состояние.
//
// ПРАВА — три двери сервера (rpc/phone.js): видимость кнопки клиент считает сам
// (зеркало PHONE_ROLES, как раньше call-action.js), а что рисовать внутри — по
// флагам may_dial / may_log / may_hear из telephony_phone_me. Кнопка, которую
// сервер всё равно откажет, не рисуется; вместо неё — строка, где право выдают.
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { grantLevel, grantAllows, hasActorRole, isRouteAllowed } from '../permissions.js';
import { formatPhone } from '../phone-format.js';
import { askRecordingUntilReady, recordingMessage, RECORDING_WAITING, RECORDING_GAVE_UP, RECORDING_RETRY_EVERY_MS }
    from '../../shared/call-recording.js?v=crr1';   // CALL_RECORDING_REASONS_V1 — та же причина словами, что в карточке заявки
import { MIN_DIGITS, POLL_MS, DIAL_CARD_TTL_MS, digitsOf, tail9, cleanTyped, groupTyped, canDial, outcomeOf, talkLabel,
         timeLabel, groupCalls, filterCalls, justCalled, matchDialed, initialsOf, whoIs } from '../crm-phone-logic.js';
// CALL_RING_V1 — блок «Звонит»: какой живой звонок показать, как назвать, когда пискнуть.
import { pickRinging, ringLabel, ringWord, beepDue, audioContextOf, ringTone } from '../crm-ring-logic.js';

// Зеркало PHONE_ROLES сервера (rpc/phone.js): прежнее поведение для ролей, которым
// ключи ещё не настраивали. Список повторён, а не спрошен: кнопка решается ДО
// первого запроса. Сервер всё равно проверяет своё.
const PHONE_ROLES = ['admin', 'registrar', 'callcenter'];
const allowed = (key, need) => (grantLevel(key) === null ? hasActorRole(PHONE_ROLES) : grantAllows(key, need));

/** Видна ли кнопка «Телефон»: право набора ИЛИ право журнала. */
export function phoneWorkplaceVisible() {
    return allowed('crm.dial', 'edit') || allowed('crm.calls', 'view');
}

const BTN_ID = 'cph-topbtn-btn';
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'],
              ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
              ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
              ['*', ''], ['0', '+'], ['#', '']];
const GROUP_LABELS = { today: 'Сегодня', yesterday: 'Вчера', earlier: 'Ранее' };
const SEGS = [['all', 'Все'], ['in', 'Входящие'], ['out', 'Исходящие'], ['miss', 'Пропущенные']];
const DENY_DIAL = 'Звонить из программы можно тем, кому выдано право «Позвонить пациенту» («Настройки → Роли»).';
const DENY_LOG = 'Журнал звонков открыт тем, кому выдано право «Журнал звонков» («Настройки → Роли»).';
const DENY_HEAR = 'Слушать записи разговоров вашей роли не разрешено — право «Прослушать запись» в «Роли».';

// Состояние панели. Живёт до перезагрузки страницы.
const P = {
    ctx: null, btn: null, btnDot: null,
    mounted: false, open: false, min: false, pick: false,
    typed: '', me: null, calls: [], mayDial: false, mayLog: false, mayHear: false, logError: '',
    seg: 'all', query: '', card: null, expanded: null, holdUntil: 0, msg: '',
    timer: null, onKey: null, els: null,
    // CALL_RING_V1 — живые звонки (telephony_live раз в 2 секунды с момента, как
    // кнопка встала в верхнюю строку): что звонит сейчас, что оператор скрыл,
    // когда звонок увидели впервые (срок сигнала), о чём уже сказали toast,
    // звук и его контекст (рождается после первого жеста пользователя).
    live: [], liveSource: 'off', liveTimer: null, ringSig: '', ringHidden: new Set(), ringSeen: new Map(), ringToasted: new Set(),
    lastBeepAt: 0, muted: false, audio: null, audioArmed: false,
};
const LIVE_POLL_MS = 2000;
const MUTE_KEY = 'easymed.phone.mute';

// Что даёт доска CRM, когда она смонтирована: заявки (назвать набранный номер по
// имени) и способ открыть карточку заявки тем же окном, что открывает доска.
// Доска регистрирует их на каждой своей отрисовке (views/crm.js paint()).
const H = { leads: null, openLead: null, newLead: null };

/** Доска CRM отдаёт панели свои заявки, окно карточки и окно новой заявки с номером (CALL_RING_V1). */
export function registerCrmPhoneHooks({ leads = null, openLead = null, newLead = null } = {}) {
    H.leads = typeof leads === 'function' ? leads : null;
    H.openLead = typeof openLead === 'function' ? openLead : null;
    H.newLead = typeof newLead === 'function' ? newLead : null;
}

/** Класс на элементе — через className: поддельный DOM стенда classList не умеет. */
function setClass(el, name, on) {
    if (!el) return;
    const list = String(el.className || '').split(/\s+/).filter(Boolean).filter((c) => c !== name);
    if (on) list.push(name);
    el.className = list.join(' ');
}
/** append(), который пропускает null: родной Element.append вписал бы слово «null» текстом (NULL_IN_APPEND_V1). */
function put(parent, ...nodes) {
    for (const n of nodes.flat(Infinity)) if (n) parent.appendChild(n);
}
function hasAudio(el) {
    if (!el) return false;
    const stack = [...(el.children || [])];
    while (stack.length) {
        const n = stack.shift();
        if (n && n.tagName === 'AUDIO') return true;
        if (n && n.children) stack.push(...n.children);
    }
    return false;
}
// Пока оператор слушает запись или только что нажал «Прослушать», журнал
// перерисовывать НЕЛЬЗЯ: обновление стирало открытый плеер вместе со строкой,
// и это выглядело как «кнопка не работает».
const busyWithAudio = () => Date.now() < P.holdUntil || !!(P.els && hasAudio(P.els.list));
const leadsOf = () => (H.leads ? (H.leads() || []) : []);
const inCard = () => !!P.card;

// Открыть карточку заявки из панели: сначала перейти в CRM (чтобы за окном была
// доска, а не касса), потом — то же окно, что открывает сама доска.
function openLead(lead) {
    if (P.ctx && typeof P.ctx.onNavigate === 'function') P.ctx.onNavigate('crm');
    if (H.openLead) H.openLead(lead);
}

/**
 * Кнопка «Телефон» в верхней панели, рядом с «Обновить» (владелец, по снимку).
 * Идемпотентна — оболочка зовёт её после входа и при смене языка: прежняя
 * снимается, новая встаёт на то же место. Без права набора и журнала — null,
 * и прежняя кнопка снимается тоже (сменился пользователь).
 *
 *   onNavigate(view)   — переход оболочки (открыть CRM перед карточкой заявки);
 *   shiftTarget        — элемент, который уступает место панели (#view-root).
 */
export function mountPhoneButton(ctx = {}) {
    P.ctx = ctx;
    const old = typeof document.getElementById === 'function' ? document.getElementById(BTN_ID) : null;
    if (old) old.remove();
    if (!phoneWorkplaceVisible()) { stopLivePoll(); return null; }
    // CALL_RING_V1 — живые звонки спрашиваются с этого мига, а не с первого
    // открытия панели: звонок должен быть виден и тому, кто панель ещё не открывал.
    P.muted = readMuted();
    startLivePoll(ctx.livePollMs || LIVE_POLL_MS);
    armAudio();
    P.btnDot = h('span', { class: 'cph-dot' + (P.me && P.me.line ? ' on' : ''), 'aria-hidden': 'true' });
    P.btn = h('button', {
        id: BTN_ID, class: 'cph-topbtn' + (P.open ? ' on' : ''), type: 'button', 'data-crm-phone': '',
        'aria-pressed': P.open ? 'true' : 'false', title: 'Телефон: набор номера и журнал звонков',
        onclick: () => { if (P.open) closeDrawer(); else openDrawer(); },
    }, P.btnDot, Icon('Phone', { size: 15 }), h('span', { class: 'cph-topbtn-t' }, 'Телефон'));
    // Место — слева от «Обновить». В стенде верхней панели нет: кнопку ставит вызвавший.
    const reload = typeof document.getElementById === 'function' ? document.getElementById('topbar-reload') : null;
    if (reload && reload.parentNode) reload.parentNode.insertBefore(P.btn, reload);
    if (P.mounted) paintChrome();
    return P.btn;
}

/** Для стенда: снять панель и забыть состояние, как после перезагрузки страницы. */
export function resetCrmPhone() {
    teardown();
    stopLivePoll();
    H.leads = null; H.openLead = null; H.newLead = null;
    Object.assign(P, { ctx: null, btn: null, btnDot: null, open: false, min: false, pick: false, typed: '',
        me: null, calls: [], mayDial: false, mayLog: false, mayHear: false, logError: '', seg: 'all', query: '',
        card: null, expanded: null, holdUntil: 0, msg: '',
        live: [], liveSource: 'off', ringSig: '', outSig: '', ringHidden: new Set(), ringSeen: new Map(), ringToasted: new Set(),
        lastBeepAt: 0, muted: false, audio: null, audioArmed: false });
}

// ---------------------------------------------------------------------------
// Открыть · закрыть · свернуть
// ---------------------------------------------------------------------------
function openDrawer() {
    mount();
    P.open = true; P.min = false;
    paintAll();
    if (!P.me) loadMe().then(paintAll).catch((e) => { P.msg = (e && e.message) || String(e); paintPhone(); });
    loadCalls().catch(() => {});
}
function closeDrawer() { P.open = false; P.min = false; paintChrome(); }
// «Свернуть» при карточке звонка — пилюля внизу справа (звонок виден, экран
// свободен); в покое свернуть нечего — это «Закрыть».
function minimize() {
    if (inCard()) { P.min = true; P.open = false; } else { P.open = false; }
    paintChrome();
}

// ---------------------------------------------------------------------------
// Монтаж и снятие
// ---------------------------------------------------------------------------
function mount() {
    if (P.mounted) return;
    const els = {};
    els.statusDot = h('i', { 'aria-hidden': 'true' });
    els.statusText = h('span', null);
    els.status = h('span', { class: 'cph-st ok', 'data-cph-status': '' }, els.statusDot, els.statusText);
    els.ext = h('button', { class: 'cph-ext', type: 'button', 'data-cph-ext': '', title: 'Моя трубка: выбрать внутренний номер',
        onclick: () => { if (!P.mayDial) return; P.pick = !P.pick; paintPhone(); } });
    els.body = h('div', { class: 'cph-body', 'data-cph-body': '' });
    els.phone = h('section', { class: 'cph-phone' },
        h('div', { class: 'cph-head' }, els.status, els.ext, h('span', { class: 'grow' }),
            // CALL_RING_V1 — звук звонка: выключается здесь, выбор помнит этот браузер.
            (els.mute = h('button', { class: 'cph-ic' + (P.muted ? ' off' : ''), type: 'button', 'data-cph-mute': '', title: P.muted ? 'Включить звук' : 'Выключить звук',
                'aria-pressed': P.muted ? 'true' : 'false', onclick: toggleMute }, Icon('Bell', { size: 15 }))),
            h('button', { class: 'cph-ic', type: 'button', title: 'Свернуть', 'data-cph-min': '', onclick: minimize }, Icon('Minus', { size: 15 })),
            h('button', { class: 'cph-ic', type: 'button', title: 'Закрыть', 'data-cph-close': '', onclick: closeDrawer }, Icon('X', { size: 15 }))),
        els.body);

    els.cnt = h('span', { class: 'cph-cnt', 'data-cph-cnt': '' });
    // type="text", а не "search": у поисковых полей h() откладывает 'input' до паузы
    // в наборе (SEARCH_DEBOUNCE_V1) ради запроса к серверу, а здесь фильтр
    // локальный, и буква должна отзываться сразу.
    els.search = h('input', { class: 'cph-q', type: 'text', placeholder: 'Имя или номер', value: P.query, 'data-cph-q': '', autocomplete: 'off' });
    els.search.addEventListener('input', () => { P.query = els.search.value; P.expanded = null; paintList(); });
    els.segBtns = SEGS.map(([k, label]) => h('button', { type: 'button', 'data-cph-seg': k, class: P.seg === k ? 'on' : '',
        'aria-pressed': P.seg === k ? 'true' : 'false',
        onclick: () => { P.seg = k; P.expanded = null; paintSeg(); paintList(); } }, label));
    els.seg = h('div', { class: 'cph-seg', role: 'group' }, ...els.segBtns);
    els.live = h('div', { class: 'cph-live', 'data-cph-live': '' });
    els.live.hidden = true;
    els.list = h('div', { class: 'cph-list', 'data-cph-list': '' });
    els.hist = h('section', { class: 'cph-hist' },
        h('div', { class: 'cph-hsh' },
            h('div', { class: 'cph-hsh-row' }, h('h3', null, 'Недавние звонки'), els.cnt),
            h('label', { class: 'cph-srch' }, Icon('Search', { size: 15 }), els.search),
            els.seg),
        els.live, els.list);

    els.drawer = h('aside', { class: 'cph-drawer cph-closed', 'data-cph-drawer': '', 'aria-label': 'Телефон' }, els.phone, els.hist);
    els.edge = h('button', { class: 'cph-edge', type: 'button', 'data-cph-edge': '', title: 'Телефон', onclick: openDrawer },
        Icon('Phone', { size: 18 }), h('span', null, 'Телефон'));
    els.edge.hidden = true;
    els.miniText = h('div', { class: 'cph-mini-t' });
    els.miniSub = h('div', { class: 'cph-mini-s' });
    els.mini = h('button', { class: 'cph-mini', type: 'button', 'data-cph-mini': '', onclick: openDrawer },
        Icon('Phone', { size: 16 }), h('div', null, els.miniText, els.miniSub));
    els.mini.hidden = true;

    document.body.appendChild(els.drawer);
    document.body.appendChild(els.edge);
    document.body.appendChild(els.mini);
    P.els = els;
    P.mounted = true;
    P.onKey = onKey;
    document.addEventListener('keydown', P.onKey);
    P.timer = setInterval(tick, POLL_MS);
    // Под Node (стенд) таймер не должен держать процесс; в браузере unref нет.
    if (P.timer && typeof P.timer.unref === 'function') P.timer.unref();
}

function teardown() {
    if (P.timer) clearInterval(P.timer);
    P.timer = null;
    if (P.onKey) document.removeEventListener('keydown', P.onKey);
    P.onKey = null;
    if (P.els) for (const k of ['drawer', 'edge', 'mini']) P.els[k].remove();
    if (P.ctx && P.ctx.shiftTarget) setClass(P.ctx.shiftTarget, 'crm-phone-shift', false);
    if (document.body) setClass(document.body, 'cph-open', false);
    if (P.btn) P.btn.remove();
    P.els = null;
    P.mounted = false;
    P.expanded = null;
}

// Раз в семь секунд: карточка звонка без ответа журнала пережила свой срок —
// убрать; панель видна (или свёрнута при звонке) — обновить журнал, если никто
// не слушает запись.
function tick() {
    if (P.card && P.card.phase === 'ringing' && Date.now() - P.card.since > DIAL_CARD_TTL_MS) {
        P.card = null; P.min = false;
        paintPhone(); paintChrome();
    }
    if (!(P.open || P.min)) return;
    if (busyWithAudio()) return;
    loadCalls().catch(() => {});
}

// ---------------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------------
async function loadMe() {
    const { data, error } = await supabase.rpc('telephony_phone_me', {});
    if (error) throw error;
    P.me = data || {};
    P.mayDial = !!P.me.may_dial;
    P.mayLog = !!P.me.may_log;
    P.mayHear = !!P.me.may_hear;
}

async function loadCalls() {
    if (!P.els) return;
    if (P.me && !P.mayLog) { paintList(); paintLive(); return; }   // журнал закрыт — не спрашиваем
    const { data, error } = await supabase.rpc('telephony_call_log', { limit: 60 });
    if (!P.els) return;   // пока ждали ответ, панель сняли
    if (error) { P.logError = error.message || String(error); paintList(); return; }
    P.logError = '';
    P.calls = Array.isArray(data && data.calls) ? data.calls : [];
    if (data && typeof data.may_hear === 'boolean') P.mayHear = data.may_hear;
    if (data && typeof data.may_dial === 'boolean') P.mayDial = data.may_dial;
    // Наш набранный звонок доехал до журнала — карточка «трубка звонит» становится результатом.
    if (P.card && P.card.phase === 'ringing') {
        const m = matchDialed(P.calls, P.card);
        if (m) { P.card = { ...P.card, phase: 'done', call: m }; paintPhone(); paintChrome(); }
    }
    paintList();
    paintLive();
}

// ---------------------------------------------------------------------------
// Набор
// ---------------------------------------------------------------------------
function press(k) {
    if (P.typed.length >= 16) return;
    P.typed = cleanTyped(P.typed + k);
    P.msg = '';
    paintPhone();
}
function erase() { P.typed = P.typed.slice(0, -1); paintPhone(); }
function onKey(e) {
    if (!P.open || inCard() || P.pick) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (e.key === 'Backspace') { e.preventDefault(); erase(); }
    else if (e.key === 'Enter') { if (P.mayDial && canDial(P.typed)) dial(P.typed); }
    else if (/^[0-9*#+]$/.test(e.key)) { e.preventDefault(); press(e.key); }
}

/**
 * Позвонить. Команда уходит в telephony_dial — тот же разъём, что был у кнопки
 * «Позвонить» и у EasyPhone; отказы приходят готовой фразой с сервера, здесь их
 * не переписывают. Своей строки в журнал не пишем: звонок приедет сам, вебхуком
 * или опросом, и карточка узнает его по номеру и времени (matchDialed).
 */
async function dial(number) {
    const phone = cleanTyped(number);
    if (!P.mayDial || !canDial(phone) || !P.els) return;
    P.msg = '';
    const btn = P.els.body.querySelector('[data-cph-call]');
    if (btn) btn.setAttribute('disabled', '');
    const { error } = await supabase.rpc('telephony_dial', { phone });
    if (!P.els) return;
    if (error) { P.msg = error.message || tr('Телефония ответила ошибкой. Попробуйте ещё раз через минуту.'); paintPhone(); return; }
    const digits = digitsOf(phone);
    const who = whoIs(digits, { leads: leadsOf(), calls: P.calls });
    P.card = { phase: 'ringing', digits, phone, name: who ? who.name : '', who, since: Date.now(), ext: (P.me && P.me.extension) || '' };
    P.typed = '';
    P.expanded = null;
    P.pick = false;
    paintPhone(); paintChrome();
    setTimeout(() => { loadCalls().catch(() => {}); }, 4000);
}
function dismissCard() { P.card = null; P.min = false; paintPhone(); paintChrome(); }

// ---------------------------------------------------------------------------
// Отрисовка
// ---------------------------------------------------------------------------
function paintAll() { paintChrome(); paintPhone(); paintSeg(); paintList(); paintLive(); }

function paintChrome() {
    if (!P.els) return;
    const show = P.open;
    setClass(P.els.drawer, 'cph-closed', !show);
    P.els.drawer.setAttribute('aria-hidden', show ? 'false' : 'true');
    P.els.edge.hidden = show || P.min;
    P.els.mini.hidden = !P.min;
    const ring = currentRing();
    const ringing = !!(ring && ring.call.state === 'ringing');
    if (P.min && ringing) {
        P.els.miniText.textContent = ringLabel(ring.call);
        P.els.miniSub.textContent = tr('Звонит');
    } else if (P.min && P.card) {
        P.els.miniText.textContent = P.card.name || formatPhone(P.card.digits);
        P.els.miniSub.textContent = P.card.phase === 'ringing' ? tr('Трубка звонит') : tr('Звонок завершён');
    }
    // CALL_RING_V1 — закрытая панель: вкладка на краю и кнопка в верхней строке пульсируют.
    setClass(P.els.edge, 'ring', ringing);
    if (P.btn) setClass(P.btn, 'ring', ringing);
    if (P.ctx && P.ctx.shiftTarget) setClass(P.ctx.shiftTarget, 'crm-phone-shift', show);
    // И верхняя панель уступает место: иначе переключатель языка и меню учётной
    // записи прятались бы за открытой панелью (в образце сдвигается вся колонка).
    if (document.body) setClass(document.body, 'cph-open', show);
    if (P.btn) { P.btn.setAttribute('aria-pressed', show ? 'true' : 'false'); setClass(P.btn, 'on', show); }
    paintStatus();
}

function paintStatus() {
    if (!P.els) return;
    let cls = 'ok', label = 'Готов';
    const ring = currentRing();
    if (ring && ring.call.state === 'ringing') { cls = 'wait'; label = 'Звонит'; }   // CALL_RING_V1
    else if (ring && ring.call.state === 'answered') { cls = 'ok'; label = 'Разговор идёт'; }
    else if (P.card && P.card.phase === 'ringing') { cls = 'wait'; label = 'Трубка звонит'; }
    else if (P.card) { cls = 'end'; label = 'Звонок завершён'; }
    else if (P.me && !P.me.line) { cls = 'off'; label = 'Линия не настроена'; }
    P.els.status.className = 'cph-st ' + cls;
    P.els.statusText.textContent = tr(label);
    if (P.els.mute) {
        setClass(P.els.mute, 'off', P.muted);
        P.els.mute.title = tr(P.muted ? 'Включить звук' : 'Выключить звук');
        P.els.mute.setAttribute('aria-pressed', P.muted ? 'true' : 'false');
    }
    // В строке — только номер трубки: рядом с пилюлей состояния и двумя кнопками
    // места на имя нет (первая проверка в браузере срезала его до «вн. 107…»),
    // а имя оператора и так стоит в верхней панели. Имя — в подсказке под мышью.
    if (P.me) {
        P.els.ext.textContent = P.me.extension ? trf('вн. {ext}', { ext: P.me.extension }) : tr('трубка не выбрана');
        P.els.ext.title = (P.me.full_name ? P.me.full_name + ' — ' : '') + tr('Моя трубка: выбрать внутренний номер');
        if (P.mayDial) P.els.ext.removeAttribute('disabled'); else P.els.ext.setAttribute('disabled', '');
    } else {
        P.els.ext.textContent = '…';
    }
    if (P.btnDot) P.btnDot.className = 'cph-dot' + (P.me && P.me.line ? ' on' : '');
}

function paintSeg() {
    if (!P.els) return;
    for (const b of P.els.segBtns) {
        const on = b.getAttribute('data-cph-seg') === P.seg;
        b.className = on ? 'on' : '';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
}

function paintPhone() {
    if (!P.els) return;
    clear(P.els.body);
    const ring = currentRing();
    // CALL_RING_V1 — входящий звонок важнее всего остального на этой половине панели.
    if (ring) paintRing(ring);
    else if (P.pick && P.mayDial) paintPicker();
    else if (P.card) paintCard();
    else paintIdle();
    paintStatus();
}

function paintIdle() {
    const body = P.els.body;
    const who = whoIs(P.typed, { leads: leadsOf(), calls: P.calls });
    const pad = h('div', { class: 'cph-pad' });
    for (const [k, sub] of KEYS) {
        pad.appendChild(h('button', {
            class: 'cph-k', type: 'button', 'data-k': k, 'aria-label': trf('Цифра {n}', { n: k }),
            onclick: () => press(k),
            // Долгое нажатие на ноль даёт «+» — привычка любого телефона, и без
            // неё международный номер набрать нечем.
            oncontextmenu: (ev) => { if (k === '0') { ev.preventDefault(); press('+'); } },
        }, h('b', null, k), h('small', null, sub)));
    }
    const call = P.mayDial
        ? h('button', { class: 'cph-call', type: 'button', 'data-cph-call': '', title: 'Позвонить', disabled: !canDial(P.typed), onclick: () => dial(P.typed) }, Icon('Phone', { size: 26 }))
        : h('span');
    const del = h('button', { class: 'cph-bk' + (P.typed ? '' : ' hide'), type: 'button', 'data-cph-del': '', title: 'Стереть', onclick: erase }, Icon('ChevronLeft', { size: 22 }));
    let hint = '';
    if (!P.mayDial && P.me) hint = DENY_DIAL;
    else if (canDial(P.typed)) hint = 'Сначала зазвонит ваша трубка — снимите её, и пойдёт вызов пациенту';
    else if (P.typed) hint = 'Наберите номер целиком';
    put(body,
        h('div', { class: 'cph-disp' },
            h('div', { class: 'cph-num' + (P.typed ? '' : ' ph0'), 'data-cph-num': '' }, P.typed ? groupTyped(P.typed) : 'Наберите номер или выберите из журнала'),
            h('div', { class: 'cph-who', 'data-cph-who': '' }, who ? [Icon(who.kind === 'lead' ? 'Headset' : 'User', { size: 13 }), who.name] : null)),
        pad,
        h('div', { class: 'cph-crow' }, h('span'), call, del),
        h('div', { class: 'cph-hint', 'data-cph-hint': '' }, hint),
        P.msg ? h('div', { class: 'cph-msg-bad', 'data-cph-msg': '' }, P.msg) : null);
}

function paintCard() {
    const c = P.card;
    const body = P.els.body;
    const head = [
        h('div', { class: 'cph-ava' + (c.phase === 'ringing' ? ' ring' : '') }, c.name ? initialsOf(c.name) : '#'),
        h('h2', { class: 'cph-inc-name' }, c.name || formatPhone(c.digits)),
        h('div', { class: 'cph-pn' }, c.name ? formatPhone(c.digits) : 'Исходящий'),
    ];
    if (c.phase === 'ringing') {
        body.appendChild(h('div', { class: 'cph-inc', 'data-cph-card': 'ringing' }, ...head,
            h('div', { class: 'cph-tm' }, outLiveText(c) || (c.ext
                ? trf('Сначала зазвонит трубка {ext} — снимите её, и пойдёт вызов пациенту', { ext: c.ext })
                : 'Сначала зазвонит ваша трубка — снимите её, и пойдёт вызов пациенту')),
            h('div', { class: 'cph-sum' }, h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-hide': '', onclick: dismissCard }, 'Скрыть'))));
        return;
    }
    const o = outcomeOf(c.call);
    const actions = [];
    if (P.mayDial) actions.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-redial': '', onclick: () => { P.card = null; dial(c.phone); } }, Icon('Phone', { size: 13 }), 'Позвонить ещё'));
    if (o.answered && P.mayHear) actions.push(listenButton(c.call));
    if (c.who && c.who.kind === 'lead') {
        actions.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-open-lead': '', onclick: () => openLead(c.who.lead) }, Icon('Headset', { size: 13 }), 'Открыть заявку'));
    }
    actions.push(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-cph-hide': '', onclick: dismissCard }, 'Скрыть'));
    body.appendChild(h('div', { class: 'cph-inc', 'data-cph-card': 'done' }, ...head,
        h('div', { class: 'cph-tm ' + o.kind }, o.answered ? trf('Разговор {dur}', { dur: talkLabel(c.call.billsec) }) : o.word),
        h('div', { class: 'cph-sum' }, ...actions)));
}

// «Моя трубка» — то же, что было картой в EasyPhone: список от станции, иначе
// виденные в журнале; «не выбран» — программа подберёт живую трубку сама
// (AUTO_EXTENSION_V1). Пишет только себе.
function paintPicker() {
    const body = P.els.body;
    const current = (P.me && P.me.extension) || '';
    const sel = h('select', { class: 'cph-select', 'data-cph-ext-select': '' },
        h('option', { value: '' }, 'не выбран — программа подберёт сама'));
    const fill = (list) => {
        for (const n of list) {
            const o = h('option', { value: String(n) }, String(n));
            if (String(n) === String(current)) o.setAttribute('selected', '');
            sel.appendChild(o);
        }
    };
    const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-cph-ext-save': '', onclick: async () => {
        save.setAttribute('disabled', '');
        const ext = String(sel.value || '');
        const { error } = await supabase.rpc('telephony_my_extension', { extension: ext });
        save.removeAttribute('disabled');
        if (error) { toast(error.message || String(error), 'fail'); return; }
        if (P.me) P.me.extension = ext;
        P.pick = false;
        toast(ext ? trf('Готово: звонки будут поднимать трубку {ext}.', { ext }) : tr('Готово: номер не задан — программа подберёт живую трубку сама.'), 'ok');
        paintPhone();
    } }, 'Запомнить');
    const back = h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-ext-back': '', onclick: () => { P.pick = false; paintPhone(); } }, 'Назад');
    body.appendChild(h('div', { class: 'cph-pick', 'data-cph-pick': '' },
        h('label', { class: 'cph-label' }, 'Внутренний номер, на котором я работаю'),
        sel,
        h('p', { class: 'cph-hint' }, 'Звонок сначала поднимает эту трубку, потом набирает пациента. Выберите тот номер, на котором у вас включён телефон или приложение АТС.'),
        h('div', { class: 'cph-sum' }, save, back)));
    (async () => {
        let list = [];
        try { const { data } = await supabase.rpc('telephony_extensions', {}); list = (data && data.extensions) || []; }
        catch (e) { /* станция молчит — не беда, ниже есть журнал */ }
        if (!list.length) list = (P.me && P.me.seen_extensions) || [];
        if (current && !list.map(String).includes(String(current))) list = [current, ...list];
        if (sel.isConnected === false) return;   // пока ждали, выбор закрыли
        fill(list);
    })();
}

function listenButton(call) {
    const label = h('span', null, 'Прослушать');
    const btn = h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-listen': String(call.id), onclick: async (ev) => {
        ev.stopPropagation();
        P.holdUntil = Date.now() + 60000;
        btn.setAttribute('disabled', '');
        label.textContent = tr('Ищем запись…');
        try {
            // CALL_RECORDING_REASONS_V1 — причину называем словами, каждую своей
            // (shared/call-recording.js); «готовится» спрашиваем снова каждые 10
            // секунд, не больше 6 раз, и перестаём, как только кнопка ушла из
            // документа (журнал перерисовали, панель закрыли).
            const r = await askRecordingUntilReady(async () => {
                const { data, error } = await supabase.rpc('telephony_call_recording', { call_id: call.id });
                if (error) throw error;
                return data || {};
            }, {
                alive: () => btn.isConnected !== false,
                onWait: (n, max) => {
                    P.holdUntil = Date.now() + RECORDING_RETRY_EVERY_MS + 60000;
                    if (n === 1) toast(recordingMessage('not_ready'), 'info');
                    label.textContent = trf(RECORDING_WAITING, { n, max });
                },
            });
            if (r.reason === 'gone') return;
            if (!r.url) { toast(r.gave_up ? RECORDING_GAVE_UP : recordingMessage(r.reason), 'warn'); return; }
            btn.replaceWith(h('audio', { class: 'cph-audio', controls: true, autoplay: true, preload: 'none', src: r.url }));
        } catch (e) {
            toast((e && e.message) || String(e), 'fail');
        } finally {
            btn.removeAttribute('disabled');
            label.textContent = tr('Прослушать');
        }
    } }, Icon('Headset', { size: 13 }), label);
    return btn;
}

function paintList() {
    if (!P.els) return;
    const list = P.els.list;
    clear(list);
    const empty = (icon, title, text) => h('div', { class: 'cph-empty', 'data-cph-empty': '' }, h('i', null, Icon(icon, { size: 20 })), h('b', null, title), h('span', null, text));
    if (P.me && !P.mayLog) { P.els.cnt.textContent = ''; list.appendChild(empty('Lock', 'Журнал закрыт', DENY_LOG)); return; }
    if (P.logError) { P.els.cnt.textContent = ''; list.appendChild(empty('Warning', 'Журнал закрыт', trf('Журнал звонков недоступен: {msg}', { msg: P.logError }))); return; }
    const rows = filterCalls(P.calls, { seg: P.seg, query: P.query });
    P.els.cnt.textContent = trf('{n} из {m}', { n: rows.length, m: P.calls.length });
    if (!rows.length) {
        list.appendChild(P.query || P.seg !== 'all'
            ? empty('Search', 'Ничего не найдено', 'Попробуйте другое имя или номер.')
            : empty('Phone', 'Звонков пока нет', 'Сюда попадают входящие и исходящие звонки клиники.'));
        return;
    }
    let deniedNote = false;
    for (const g of groupCalls(rows)) {
        list.appendChild(h('div', { class: 'cph-grp' }, GROUP_LABELS[g.key]));
        for (const c of g.rows) {
            list.appendChild(rowEl(c));
            if (P.expanded === c.id) list.appendChild(detailsEl(c));
            if (Number(c.billsec) > 0 && !P.mayHear) deniedNote = true;
        }
    }
    // ROLES_SAVE_TRUTH_V1 — почему у разговоров нет «Прослушать»: одной строкой под
    // журналом, а не молчанием. Пустое место у разговора читалось как «не работает».
    if (deniedNote) list.appendChild(h('p', { class: 'cph-note', 'data-cph-rec-note': '' }, DENY_HEAR));
}

function rowEl(c) {
    const o = outcomeOf(c);
    const num = digitsOf(c.external_number);
    const name = c.patient_name ? c.patient_name + (c.patient_mrn ? ' · ' + c.patient_mrn : '') : formatPhone(c.external_number);
    const sub = c.patient_name ? formatPhone(c.external_number) : (o.out ? 'Исходящий' : 'Входящий');
    const cb = P.mayDial && num.length >= MIN_DIGITS
        ? h('button', { class: 'cph-cbk', type: 'button', 'data-cph-cb': num, title: 'Перезвонить',
            onclick: (ev) => { ev.stopPropagation(); dial(num); } }, Icon('Phone', { size: 14 }))
        : h('span');
    return h('div', {
        class: 'cph-rw' + (P.expanded === c.id ? ' open' : ''), 'data-cph-row': String(c.id), role: 'button', tabindex: '0',
        onclick: () => { P.expanded = P.expanded === c.id ? null : c.id; paintList(); },
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); P.expanded = P.expanded === c.id ? null : c.id; paintList(); } },
    },
        h('span', { class: 'cph-dir ' + o.kind, 'aria-hidden': 'true' }, Icon(o.icon, { size: 15 })),
        h('div', { class: 'cph-rw-main' },
            h('div', { class: 'cph-n' + (o.kind === 'miss' ? ' miss' : '') }, name),
            h('div', { class: 'cph-s' }, h('span', null, sub), h('span', { class: 'cph-sep', 'aria-hidden': 'true' }, '·'), h('em', { class: o.kind }, o.word))),
        h('div', { class: 'cph-tt' }, timeLabel(c.started_at), h('b', null, talkLabel(c.billsec))),
        cb);
}

function detailsEl(c) {
    const o = outcomeOf(c);
    const who = c.operator_name || c.internal_number || '';
    const actions = [];
    if (o.answered && P.mayHear) actions.push(listenButton(c));
    const owner = whoIs(c.external_number, { leads: leadsOf(), calls: [] });
    if (owner && owner.kind === 'lead') {
        actions.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-open-lead': '',
            onclick: (ev) => { ev.stopPropagation(); openLead(owner.lead); } }, Icon('Headset', { size: 13 }), 'Открыть заявку'));
    }
    if (c.patient_id && P.ctx && typeof P.ctx.onNavigate === 'function' && isRouteAllowed('patient-card')) {
        actions.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-open-patient': '',
            onclick: (ev) => { ev.stopPropagation(); P.ctx.onNavigate('patient-card', { id: c.patient_id, full_name: c.patient_name || '' }); } },
            Icon('User', { size: 13 }), 'Карта пациента'));
    }
    return h('div', { class: 'cph-x', 'data-cph-details': String(c.id) },
        h('div', { class: 'cph-x-row' },
            h('span', { class: 'muted' }, who ? trf('Оператор: {who}', { who }) : 'Оператор не опознан'),
            h('span', { class: 'muted' }, o.answered ? trf('Разговор {dur}', { dur: talkLabel(c.billsec) }) : 'Разговора не было — записывать нечего.')),
        actions.length ? h('div', { class: 'cph-sum' }, ...actions) : null);
}

// «Только что звонили» — честное имя полосы «Сейчас звонят» из EasyPhone: входящий
// без ответа моложе двух минут. События «звонит сейчас» ни одна линия не присылает.
function paintLive() {
    if (!P.els) return;
    const el = P.els.live;
    clear(el);
    const c = P.mayLog || !P.me ? justCalled(P.calls) : null;
    el.hidden = !c;
    if (!c) return;
    const who = c.patient_name || formatPhone(c.external_number);
    put(el,
        h('span', { class: 'cph-live-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'cph-live-t' }, trf('Только что звонили: {who}', { who })),
        P.mayDial ? h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-live-cb': '', onclick: () => dial(digitsOf(c.external_number)) }, Icon('Phone', { size: 13 }), 'Перезвонить') : null);
}

// ---------------------------------------------------------------------------
// CALL_RING_V1 — «Звонит»: живые звонки станции
// ---------------------------------------------------------------------------
function readMuted() { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } }
function toggleMute() {
    P.muted = !P.muted;
    try { localStorage.setItem(MUTE_KEY, P.muted ? '1' : '0'); } catch { /* приватный режим */ }
    paintStatus();
}
// Контекст звука рождается ПОСЛЕ первого жеста пользователя — иначе браузер его не включит.
function armAudio() {
    if (P.audioArmed || typeof document.addEventListener !== 'function') return;
    P.audioArmed = true;
    const wake = () => {
        if (!P.audio) P.audio = audioContextOf(typeof window !== 'undefined' ? window : null);
        else if (P.audio.state === 'suspended' && typeof P.audio.resume === 'function') P.audio.resume().catch(() => {});
    };
    for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, wake, { passive: true });
}
function startLivePoll(ms) {
    if (P.liveTimer) return;
    const tick = () => { pollLive().catch(() => {}); };
    P.liveTimer = setInterval(tick, ms);
    if (P.liveTimer && typeof P.liveTimer.unref === 'function') P.liveTimer.unref();
    tick();
}
function stopLivePoll() { if (P.liveTimer) clearInterval(P.liveTimer); P.liveTimer = null; }
async function pollLive() {
    const { data, error } = await supabase.rpc('telephony_live', {});
    if (error) return;
    P.live = Array.isArray(data && data.calls) ? data.calls : [];
    P.liveSource = (data && data.source) || 'off';
    onLiveChanged();
}
function currentRing() { return pickRinging(P.live, { hidden: P.ringHidden, ext: (P.me && P.me.extension) || '' }); }

// После каждого опроса: забыть ушедшие звонки, сказать о новом (toast при закрытой
// панели), пискнуть, перерисовать — но только если что-то изменилось.
function onLiveChanged() {
    const now = Date.now();
    const alive = new Set(P.live.map((c) => c.uuid));
    for (const k of [...P.ringSeen.keys()]) if (!alive.has(k)) P.ringSeen.delete(k);
    for (const k of [...P.ringHidden]) if (!alive.has(k)) P.ringHidden.delete(k);
    for (const k of [...P.ringToasted]) if (!alive.has(k)) P.ringToasted.delete(k);
    const ring = currentRing();
    if (ring) {
        const u = ring.call.uuid;
        if (!P.ringSeen.has(u)) P.ringSeen.set(u, now);
        if (ring.call.state === 'ringing' && !P.open && !P.ringToasted.has(u)) {
            P.ringToasted.add(u);
            toast(trf('Звонит: {who}', { who: ringLabel(ring.call) }), 'info');
        }
        if (beepDue(ring.call, now, { muted: P.muted, foreign: ring.foreign, lastBeepAt: P.lastBeepAt, firstSeenAt: P.ringSeen.get(u) })) {
            if (ringTone(P.audio)) P.lastBeepAt = now;
        }
    }
    const sig = ring ? ring.call.uuid + ':' + ring.call.state + ':' + ring.others + ':' + ring.foreign : '';
    const outSig = P.card ? outLiveText(P.card) : '';
    if (sig !== P.ringSig || outSig !== (P.outSig || '')) {
        P.ringSig = sig;
        P.outSig = outSig;
        if (P.els) { paintPhone(); paintChrome(); }
        else if (P.btn) setClass(P.btn, 'ring', !!(ring && ring.call.state === 'ringing'));
    }
}

/** Наш исходящий набор глазами станции: соединяет / разговор идёт; '' — станция ещё молчит. */
function outLiveText(card) {
    if (!card || !card.digits) return '';
    const t = tail9(card.digits);
    const c = P.live.find((x) => x && x.direction === 'out' && tail9(x.number) === t && x.state !== 'ended');
    if (!c) return '';
    return c.state === 'answered' ? tr('Разговор идёт') : tr('Станция соединяет…');
}

/** Сделать с доской CRM; если её хуки ещё не зарегистрированы (раздел не открывали) — открыть CRM и дождаться. */
function withBoard(fn, tries = 12) {
    if (H.leads && H.openLead) { fn(); return; }
    if (P.ctx && typeof P.ctx.onNavigate === 'function') P.ctx.onNavigate('crm');
    let n = 0;
    const t = setInterval(() => {
        n++;
        if (H.leads && H.openLead) { clearInterval(t); fn(); }
        else if (n >= tries) { clearInterval(t); toast(tr('Доска CRM не открылась — откройте раздел CRM и повторите.'), 'warn'); }
    }, 300);
    if (t && typeof t.unref === 'function') t.unref();
}
function openLeadById(id) {
    withBoard(() => {
        const row = leadsOf().find((r) => r && String(r.id) === String(id));
        if (row) { openLead(row); return; }
        if (P.ctx && typeof P.ctx.onNavigate === 'function') P.ctx.onNavigate('crm');
        toast(tr('Заявки нет на доске — откройте её в CRM.'), 'warn');
    });
}
function newLeadFor(number) {
    withBoard(() => {
        if (P.ctx && typeof P.ctx.onNavigate === 'function') P.ctx.onNavigate('crm');
        if (H.newLead) H.newLead({ phone: formatPhone(number) });
    });
}
function hideRing(uuid) {
    P.ringHidden.add(uuid);
    onLiveChanged();
    // Скрытый звонок мог быть единственным: подпись «ничего» та же, что была до
    // него, и onLiveChanged перерисовки не увидит — рисуем явно.
    if (P.els) { paintPhone(); paintChrome(); }
}

// Блок «Звонит» — по образцу владельца: аватар с кольцами, имя, номер, состояние,
// плашки и кнопки. Карта НЕ открывается сама — решение владельца: кнопка
// «Открыть карту».
function paintRing({ call: c, others, foreign }) {
    const body = P.els.body;
    const known = !!(c.patient || c.lead);
    const name = ringLabel(c);
    const chips = [];
    if (c.patient && c.patient.mrn) chips.push(h('span', { class: 'cph-chip t' }, trf('Карта {mrn}', { mrn: c.patient.mrn })));
    if (c.lead) chips.push(h('span', { class: 'cph-chip' }, 'Заявка на доске'));
    if (!known) chips.push(h('span', { class: 'cph-chip' }, 'Номер не знаком'));
    if (foreign) chips.push(h('span', { class: 'cph-chip' }, trf('на трубке {ext}', { ext: c.callee })));
    const actions = [];
    if (c.patient && P.ctx && typeof P.ctx.onNavigate === 'function' && isRouteAllowed('patient-card')) {
        actions.push(h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-cph-ring-patient': '',
            onclick: () => P.ctx.onNavigate('patient-card', { id: c.patient.id, full_name: c.patient.full_name || '' }) }, Icon('User', { size: 13 }), 'Открыть карту'));
    }
    if (c.lead) {
        actions.push(h('button', { class: 'btn btn-sm' + (c.patient ? '' : ' btn-primary'), type: 'button', 'data-cph-ring-lead': '',
            onclick: () => openLeadById(c.lead.id) }, Icon('Headset', { size: 13 }), 'Открыть заявку'));
    }
    if (!known) {
        actions.push(h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-cph-ring-new': '',
            onclick: () => newLeadFor(c.number) }, Icon('Plus', { size: 13 }), 'Новая заявка'));
    }
    if (c.state === 'ended' && P.mayDial && digitsOf(c.number).length >= MIN_DIGITS) {
        actions.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-cb': digitsOf(c.number),
            onclick: () => { hideRing(c.uuid); dial(digitsOf(c.number)); } }, Icon('Phone', { size: 13 }), 'Перезвонить'));
    }
    actions.push(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-cph-ring-hide': '', onclick: () => hideRing(c.uuid) }, 'Скрыть'));
    put(body, h('div', { class: 'cph-inc cph-ring', 'data-cph-ring': c.state },
        h('div', { class: 'cph-ava' + (c.state === 'ringing' ? ' ring' : '') }, known ? initialsOf(name) : '#'),
        h('h2', { class: 'cph-inc-name' }, name),
        known ? h('div', { class: 'cph-pn' }, formatPhone(c.number)) : null,
        h('div', { class: 'cph-tm ' + (c.state === 'ended' ? 'miss' : c.state) }, ringWord(c)),
        chips.length ? h('div', { class: 'cph-chips' }, ...chips) : null,
        others ? h('div', { class: 'cph-hint' }, trf('и ещё {n}', { n: others })) : null,
        h('div', { class: 'cph-sum' }, ...actions)));
}
