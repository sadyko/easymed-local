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
// SOFTPHONE_V1 (2026-10-29) — ТЕПЕРЬ И ТРУБКА. Владелец: «can we build a
// softphone in the easymed inside?». Переключатель «Принимать звонки в
// Easy-Med» входит в АТС внутренним номером оператора прямо из этой вкладки
// (softphone.js, JsSIP): входящий звонит здесь — «Принять» / «Отклонить»,
// разговор — таймер, «Микрофон выкл.», «Завершить»; «Позвонить» идёт через
// гарнитуру компьютера. Без переключателя всё по-старому. Эти кнопки теперь
// честные — они делают то, что написано. Удержания, перевода и тонового набора
// по-прежнему нет (решение владельца для первой версии). Раздел — внизу файла.
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
import { pickRinging, ringLabel, ringWord, beepDue, audioContextOf, ringTone, BEEP_EVERY_MS } from '../crm-ring-logic.js';
// SOFTPHONE_V1 — телефон Easy-Med: его состояние (softphone.js), браузер и слова причин (softphone-browser.js).
import { getSoftphone, reasonText, endText, listDevices, canChooseOutput, onDeviceChange, micTest, savedDevice, saveDevice, setOutputDevice }
    from '../softphone-browser.js';
import { SP } from '../softphone.js';
import { isActingNow } from '../act-as-client.js';

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
    // SOFTPHONE_V1 — телефон Easy-Med этой страницы и подписка на него; включали
    // ли его сами после загрузки (один раз за страницу); подпись строки
    // переключателя (та же картина — строку не перерисовываем). Звонок: кто звонит
    // (telephony_caller по номеру, до конца звонка), сигнал входящего, таймер
    // разговора и его элемент, обновление журнала после звонка, прошлое состояние.
    sp: null, spUnsub: null, spAutoTried: false, spRowSig: '',
    spWho: new Map(), spRing: null, spTick: null, spRefresh: null, spLast: 'off',
    // Правки ревью: хвост номера идущего звонка и «тишина» станции о нём после
    // конца; объявлен ли входящий читалке и её таймер; когда в последний раз
    // спрашивали «кто я» ради включения.
    spNum: '', spHush: null, spSaid: false, spSay: null, spMeTry: 0,
    // Задача 7 — гарнитура: отписка от «подключили/вынули» и проверка за 5 секунд
    // ({running, phase, n, reason}; переживает перерисовку «Моя трубка»), её
    // прерывание (AbortController) и пауза перед перечитыванием списка устройств.
    spDevUnsub: null, spTest: null, spTestAbort: null, spDevTimer: null,
    // Финальное ревью (I1, M3): включение идёт само (после загрузки, повтором,
    // после возврата из кэша), а не щелчком; уведомление о сбое уже было;
    // сколько раз повторяли и таймер повтора; с какого мига подключается и
    // таймер «подключается долго»; слушается ли pageshow.
    spAuto: false, spToasted: false, spTries: 0, spRetryTimer: null, spConnSince: 0, spSlowTimer: null, spShowArmed: false,
};
const ME_RETRY_MS = 30000;   // SOFTPHONE_V1 — «кто я» не ответил при загрузке: спросить снова не чаще
const HUSH_MS = 15000;       // SOFTPHONE_V1 — станция догоняет звонок с задержкой: столько молчим о нём после конца
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
// SOFTPHONE_V1 — звонок телефона Easy-Med — тоже «карточка»: свернуть — в пилюлю, клавиши не набирают.
const inCard = () => !!P.card || !!softCall();

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
    // SOFTPHONE_V1 — телефон Easy-Med слушаем с этой же минуты: входящий должен
    // открыть панель и тому, кто её ещё не открывал. Переключатель был включён на
    // этом компьютере — узнаём, можно ли, и включаем сами (loadMe → softAfterMe).
    // Не ответил — спросим снова после удачного опроса станции (softRetryMe).
    softWire();
    if (!P.me && P.sp.wanted()) { P.spMeTry = Date.now(); loadMe().then(() => { if (P.els) paintAll(); }).catch(() => {}); }
    // Финальное ревью (M3) — страница вернулась из кэша браузера (назад/вперёд):
    // pagehide выключил телефон с выбором сотрудника — включить снова. Один раз.
    if (!P.spShowArmed && typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
        P.spShowArmed = true;
        window.addEventListener('pageshow', onPageShow);
    }
    P.btnDot = h('span', { class: topDotClass(), 'aria-hidden': 'true' });
    P.btn = h('button', {
        id: BTN_ID, class: 'cph-topbtn' + (P.open ? ' on' : ''), type: 'button', 'data-crm-phone': '',
        'aria-pressed': P.open ? 'true' : 'false', title: 'Телефон: набор номера и журнал звонков',
        onclick: () => { if (P.open) closeDrawer(); else openDrawer(); },
    }, P.btnDot, Icon('Phone', { size: 15 }), h('span', { class: 'cph-topbtn-t' }, 'Телефон'));
    paintTopBtn();
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
        lastBeepAt: 0, muted: false, audio: null, audioArmed: false,
        sp: null, spUnsub: null, spAutoTried: false, spRowSig: '',
        spWho: new Map(), spRing: null, spTick: null, spRefresh: null, spLast: 'off',
        spNum: '', spHush: null, spSaid: false, spSay: null, spMeTry: 0,
        spDevUnsub: null, spTest: null, spTestAbort: null, spDevTimer: null,
        spAuto: false, spToasted: false, spTries: 0, spRetryTimer: null, spConnSince: 0, spSlowTimer: null, spShowArmed: false });
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
        onclick: () => {
            if (!P.mayDial) return;
            P.pick = !P.pick;
            paintPhone();
        } });
    els.body = h('div', { class: 'cph-body', 'data-cph-body': '' });
    // SOFTPHONE_V1 — строка телефона Easy-Med под строкой состояния (paintSoftRow).
    els.spRow = h('div', { class: 'cph-sp-row', 'data-cph-sp-row': '' });
    els.spRow.hidden = true;
    els.phone = h('section', { class: 'cph-phone' },
        h('div', { class: 'cph-head' }, els.status, els.ext, h('span', { class: 'grow' }),
            // CALL_RING_V1 — звук звонка: выключается здесь, выбор помнит этот браузер.
            (els.mute = h('button', { class: 'cph-ic' + (P.muted ? ' off' : ''), type: 'button', 'data-cph-mute': '', title: P.muted ? 'Включить звук' : 'Выключить звук',
                'aria-pressed': P.muted ? 'true' : 'false', onclick: toggleMute }, Icon('Bell', { size: 15 }))),
            h('button', { class: 'cph-ic', type: 'button', title: 'Свернуть', 'data-cph-min': '', onclick: minimize }, Icon('Minus', { size: 15 })),
            h('button', { class: 'cph-ic', type: 'button', title: 'Закрыть', 'data-cph-close': '', onclick: closeDrawer }, Icon('X', { size: 15 }))),
        els.spRow,
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
    // SOFTPHONE_V1 — читалка экрана: «Входящий звонок: …». Вне панели — закрытая
    // или свёрнутая панель скрыта от читалки (aria-hidden), а объявить надо.
    els.spLive = h('div', { class: 'cph-sr', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-cph-sp-live': '' });

    document.body.appendChild(els.drawer);
    document.body.appendChild(els.edge);
    document.body.appendChild(els.mini);
    document.body.appendChild(els.spLive);
    P.els = els;
    P.mounted = true;
    P.spRowSig = '';
    softWire();
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
    if (P.els) for (const k of ['drawer', 'edge', 'mini', 'spLive']) P.els[k].remove();
    if (P.ctx && P.ctx.shiftTarget) setClass(P.ctx.shiftTarget, 'crm-phone-shift', false);
    if (document.body) setClass(document.body, 'cph-open', false);
    if (P.btn) P.btn.remove();
    P.els = null;
    P.mounted = false;
    P.expanded = null;
    // SOFTPHONE_V1 — отписаться, но телефон НЕ останавливать: он живёт, пока жива страница.
    if (P.spUnsub) P.spUnsub();
    P.spUnsub = null;
    P.sp = null;
    stopSoftRing();
    stopSoftTick();
    if (P.spRefresh) clearTimeout(P.spRefresh);
    P.spRefresh = null;
    if (P.spSay) clearTimeout(P.spSay);
    P.spSay = null;
    stopDeviceWatch();
    cancelMicTest();   // проверка гарнитуры не держит микрофон без панели
    stopSoftRetry();
    stopSlowWatch();
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
    softAfterMe();   // SOFTPHONE_V1 — включить сам (флаг этого компьютера) или выключить, если теперь нельзя
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
    // SOFTPHONE_V1 — телефон Easy-Med включён: звоним через гарнитуру этого
    // компьютера, станция трубку оператора не поднимает. Идёт звонок — второго не
    // начинаем ни так, ни этак (иначе «Перезвонить» из журнала молча ушло бы на трубку).
    if (softCall()) { toast(tr('Сначала завершите текущий звонок.'), 'warn'); return; }
    // Телефон включён, но не готов (подключается, ошибка, другая вкладка) — по-старому
    // через трубку НЕ звоним (решение контролёра): оператор включил телефон, потому
    // что трубки у него может и не быть. Говорим, почему нельзя.
    if (softNotReady()) { toast(softNotReadyText(), 'warn'); return; }
    if (softState().state === SP.READY) {
        if (P.sp.call(phone)) { P.typed = ''; P.card = null; P.expanded = null; P.pick = false; }
        else P.msg = tr('Звонок не начался. Попробуйте ещё раз.');
        paintPhone(); paintChrome();
        return;
    }
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
    const liveRinging = !!(ring && ring.call.state === 'ringing');
    const sc = softCall();   // SOFTPHONE_V1 — звонок телефона Easy-Med важнее звонка станции
    const ringing = liveRinging || !!(sc && sc.state === SP.RINGING);
    if (P.min && sc) {
        P.els.miniText.textContent = softName(sc);
        P.els.miniSub.textContent = softLine(sc);
    } else if (P.min && liveRinging) {
        P.els.miniText.textContent = ringLabel(ring.call);
        P.els.miniSub.textContent = tr('Звонит');
    } else if (P.min && P.card) {
        P.els.miniText.textContent = P.card.name || formatPhone(P.card.digits);
        P.els.miniSub.textContent = P.card.phase === 'ringing' ? tr('Трубка звонит') : tr('Звонок завершён');
    }
    // SOFTPHONE_V1 — пока идёт звонок, панель, пилюля и вкладка — над модальными
    // окнами: «Принять» не должно прятаться под окном заявки. На невысоком окне
    // журнал уступает место карточке звонка целиком (admin-views.css, .cph-on-call).
    for (const el of [P.els.drawer, P.els.mini, P.els.edge]) setClass(el, 'cph-on-call', !!sc);
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
    const sc = softCall();
    if (sc) { cls = sc.state === SP.IN_CALL ? 'ok' : 'wait'; label = SP_STATUS[sc.state]; }   // SOFTPHONE_V1
    else if (ring && ring.call.state === 'ringing') { cls = 'wait'; label = 'Звонит'; }   // CALL_RING_V1
    else if (ring && ring.call.state === 'answered') { cls = 'ok'; label = 'Разговор идёт'; }
    else if (P.card && P.card.phase === 'ringing') { cls = 'wait'; label = 'Трубка звонит'; }
    else if (P.card) { cls = 'end'; label = 'Звонок завершён'; }
    // SOFTPHONE_V1 — телефон Easy-Med включён, но не готов: «Готов» здесь был бы неправдой.
    else if (SP_PILL[softState().state]) { [cls, label] = SP_PILL[softState().state]; }
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
    paintTopBtn();   // SOFTPHONE_V1 (финальное ревью, I1) — точка кнопки знает и о телефоне Easy-Med
    paintSoftRow();   // SOFTPHONE_V1
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
    // SOFTPHONE_V1 — кнопки звонка перерисовываются часто: фокус клавиатуры возвращается на ту же кнопку.
    keepFocus(() => {
        // «Моя трубка» рисуется заново или закрыта — прежняя подписка на гарнитуру не нужна.
        stopDeviceWatch();
        P.els.spTestBtn = null;
        P.els.spTestStatus = null;
        clear(P.els.body);
        P.els.spTimer = null;
        const sc = softCall();
        const ring = currentRing();
        // CALL_RING_V1 — входящий звонок важнее всего остального на этой половине панели.
        // SOFTPHONE_V1 — а звонок телефона Easy-Med важнее и блока «Звонит» станции:
        // это тот же звонок, только с кнопками, которые здесь действительно работают.
        const picking = !sc && !ring && P.pick && P.mayDial;
        if (!picking) cancelMicTest();   // ушли из «Моя трубка» (или её закрыл звонок) — проверку прервать
        if (sc) paintSoftCall(sc);
        else if (ring) paintRing(ring);
        else if (picking) paintPicker();
        else if (P.card) paintCard();
        else paintIdle();
        // SOFTPHONE_V1 (задача 7) — «Моя трубка» с гарнитурой длинная: журнал уступает ей место.
        setClass(P.els.drawer, 'cph-picking', !!picking);
        paintStatus();
    });
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
        ? h('button', { class: 'cph-call', type: 'button', 'data-cph-call': '', title: 'Позвонить', disabled: !canDial(P.typed) || softNotReady(), onclick: () => dial(P.typed) }, Icon('Phone', { size: 26 }))
        : h('span');
    const del = h('button', { class: 'cph-bk' + (P.typed ? '' : ' hide'), type: 'button', 'data-cph-del': '', title: 'Стереть', onclick: erase }, Icon('ChevronLeft', { size: 22 }));
    let hint = '';
    if (!P.mayDial && P.me) hint = DENY_DIAL;
    else if (P.typed && softNotReady()) hint = softNotReadyText();   // SOFTPHONE_V1 — включён, но не готов
    else if (canDial(P.typed) && softState().state === SP.READY) hint = 'Звонок пойдёт через гарнитуру этого компьютера';   // SOFTPHONE_V1
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
        // SOFTPHONE_V1 — телефон Easy-Med работает только на назначенном номере: ушли
        // с него — телефон выключается, и disable() снимает флаг компьютера, так что,
        // вернувшись на номер, переключатель включают снова сами. Включится сам он
        // лишь тогда, когда с загрузки страницы ждал нужного номера (флаг ещё стоит).
        softAfterMe();
        toast(ext ? trf('Готово: звонки будут поднимать трубку {ext}.', { ext }) : tr('Готово: номер не задан — программа подберёт живую трубку сама.'), 'ok');
        paintPhone();
    } }, 'Запомнить');
    const back = h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-ext-back': '', onclick: () => { P.pick = false; paintPhone(); } }, 'Назад');
    body.appendChild(h('div', { class: 'cph-pick', 'data-cph-pick': '' },
        h('label', { class: 'cph-label' }, 'Внутренний номер, на котором я работаю'),
        sel,
        h('p', { class: 'cph-hint' }, 'Звонок сначала поднимает эту трубку, потом набирает пациента. Выберите тот номер, на котором у вас включён телефон или приложение АТС.'),
        h('div', { class: 'cph-sum' }, save, back),
        // SOFTPHONE_V1 (задача 7) — гарнитура: только при включённом телефоне Easy-Med.
        softState().state !== SP.OFF && P.me && P.me.softphone_available ? paintHeadset() : null));
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
    softRetryMe();   // SOFTPHONE_V1 — сервер снова отвечает: «кто я», если при загрузке не вышло
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
    hushLive();   // SOFTPHONE_V1 — звонок телефона Easy-Med станция здесь не показывает
    const ring = currentRing();
    if (ring) {
        const u = ring.call.uuid;
        if (!P.ringSeen.has(u)) P.ringSeen.set(u, now);
        if (ring.call.state === 'ringing' && !P.open && !P.ringToasted.has(u)) {
            P.ringToasted.add(u);
            toast(trf('Звонит: {who}', { who: ringLabel(ring.call) }), 'info');
        }
        // SOFTPHONE_V1 — звонит телефон Easy-Med: сигнал подаёт он (startSoftRing), второй писк поверх не нужен.
        if (!softCall() && beepDue(ring.call, now, { muted: P.muted, foreign: ring.foreign, lastBeepAt: P.lastBeepAt, firstSeenAt: P.ringSeen.get(u) })) {
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

// ---------------------------------------------------------------------------
// SOFTPHONE_V1 — телефон Easy-Med: переключатель и состояние
// ---------------------------------------------------------------------------
//
// КОМУ. Строка видна тому, у кого есть право набора. Включить можно только на
// номере, который администратор назначил в карточке сотрудника
// (softphone_extension), и только пока в «Моя трубка» выбран именно он; от
// чужого имени — нельзя вовсе. Почему нельзя — строкой под переключателем, а не
// подсказкой под мышью: оператор у телефона мышью над ним не водит.
//
// ПАМЯТЬ. Переключатель помнит этот компьютер (флаг телефона в localStorage):
// был включён — после перезагрузки страницы телефон включается сам, один раз,
// если всё ещё можно. Снятие панели телефон не останавливает.
const SP_OFF = Object.freeze({ state: 'off', reason: '', message: '', code: '', extension: '', call: null, lastEnd: null });
const SP_CALL = new Set([SP.RINGING, SP.CALLING, SP.IN_CALL]);
const SP_WORDS = {
    ready: 'Телефон Easy-Med включён', connecting: 'Подключение к АТС…', other_tab: 'Телефон включён в другой вкладке',
    ringing: 'Входящий звонок', calling: 'Вызов…', in_call: 'Разговор идёт', error: 'Телефон не включился',
};
const SP_TONE = { ready: 'ready', ringing: 'ready', calling: 'ready', in_call: 'ready', connecting: 'wait', other_tab: 'wait', error: 'error' };
const SP_STATUS = { ringing: 'Звонит', calling: 'Вызов…', in_call: 'Разговор идёт' };   // пилюля состояния во время звонка
// Пилюля, когда телефон включён, но не готов: [стиль пилюли, слово]. Стили — те же, что у звонков станции.
// «Не включился» — коротко: длинное слово сжимало «вн. 108» рядом (финальное ревью).
const SP_PILL = { connecting: ['wait', 'Подключение…'], error: ['end', 'Не включился'], other_tab: ['off', 'В другой вкладке'] };
// Телефон работает в другой вкладке — здесь переключатель неактивен: он снял бы общий
// выбор сотрудника, а та вкладка работала бы дальше (финальное ревью, I2).
const SP_OTHER_TAB_HINT = 'Выключить телефон можно в той вкладке, где он работает.';
// Повтор включения после временного сбоя (финальное ревью, I1): паузы, не больше
// стольких раз за страницу; «подключается долго» — с этого срока.
const SP_RETRY_MS = [30000, 60000, 120000, 300000];
const SP_SLOW_MS = 20000;
const SP_ACTING = 'Принимать звонки от чужого имени нельзя — вернитесь к своей учётной записи.';
const SP_NO_NUMBER = 'Номер для телефона в Easy-Med назначает администратор в карточке сотрудника.';
const SP_PICK = 'Администратор назначил вам номер {n} — выберите его в «Моя трубка», чтобы принимать звонки в Easy-Med.';
const SP_LABEL = 'Принимать звонки в Easy-Med';
// Во время звонка переключатель неактивен: случайный щелчок не кладёт трубку пациенту.
const SP_BUSY = 'Выключить телефон можно после разговора.';
const SP_NOT_READY = 'Телефон Easy-Med не готов: {why}';
// Файл настройки компьютера (PC_SETUP_INSTALL_V1): public/setup/ отдаёт express.static.
const SP_SETUP_FILE = 'EasyMed-ustanovka.cmd';

/** Подписаться на телефон страницы — один раз (кнопка ставится заново при смене языка). */
function softWire() {
    if (P.sp) return;
    P.sp = getSoftphone();
    P.spUnsub = P.sp.subscribe(onSoftChange);
}
const softState = () => (P.sp ? P.sp.get() : SP_OFF);

/** Можно ли включить телефон Easy-Med; hint — почему нельзя (строкой на экране). */
function softAllowed() {
    // Без линии onlinePBX (softphone_available) телефона Easy-Med нет вовсе — ни строки, ни «Гарнитуры».
    if (!P.me || !P.mayDial || !P.me.softphone_available) return { ok: false, hint: '' };
    if (isActingNow()) return { ok: false, hint: tr(SP_ACTING) };
    const n = String(P.me.softphone_extension || '');
    if (!n) return { ok: false, hint: tr(SP_NO_NUMBER) };
    if (String(P.me.extension || '') !== n) return { ok: false, hint: trf(SP_PICK, { n }) };
    return { ok: true, hint: '' };
}

/** После «кто я» и смены трубки: нельзя — выключить; можно и флаг стоит — включить сам, один раз за страницу. */
function softAfterMe() {
    if (!P.sp || !P.me) return;
    const on = P.sp.get().state !== SP.OFF;
    if (!softAllowed().ok) { if (on) P.sp.disable(); return; }
    if (!on && !P.spAutoTried && P.sp.wanted()) {
        P.spAutoTried = true;
        P.spAuto = true;   // включение — само: сбой скажем уведомлением (softFailed)
        Promise.resolve(P.sp.enable()).catch(() => {});
    }
}

// Финальное ревью (M3) — страница вернулась из кэша браузера: включение «один
// раз за страницу» уже было, а pagehide телефон выключил — пробуем снова.
function onPageShow(e) {
    if (!e || e.persisted !== true) return;
    P.spAutoTried = false;
    softAfterMe();
}

// ── Финальное ревью (I1): телефон не должен быть выключен так, что никто не заметит ──
// Верхняя кнопка «Телефон» видна на любом экране: её точка говорит о телефоне
// Easy-Med, когда переключатель включён (ошибка — красная, другая вкладка —
// серая, подключается дольше SP_SLOW_MS — жёлтая; стили — как у пилюли).
function topTone() {
    const s = softState().state;
    if (s === SP.ERROR) return 'end';
    if (s === SP.OTHER_TAB) return 'off';
    if (s === SP.CONNECTING && P.spConnSince && Date.now() - P.spConnSince >= ((P.ctx && P.ctx.spSlowMs) || SP_SLOW_MS)) return 'wait';
    return '';
}
function topDotClass() {
    const tone = topTone();
    return 'cph-dot' + (P.me && P.me.line ? ' on' : '') + (tone ? ' ' + tone : '');
}
function paintTopBtn() {
    if (P.btnDot) P.btnDot.className = topDotClass();
    if (!P.btn) return;
    const word = topTone() ? SP_WORDS[softState().state] : '';
    P.btn.title = tr('Телефон: набор номера и журнал звонков') + (word ? ' — ' + tr(word) : '');
}
function stopSlowWatch() { if (P.spSlowTimer) clearTimeout(P.spSlowTimer); P.spSlowTimer = null; }
function watchSlow(state) {
    if (state !== SP.CONNECTING) { P.spConnSince = 0; stopSlowWatch(); return; }
    if (P.spConnSince) return;
    P.spConnSince = Date.now();
    stopSlowWatch();
    P.spSlowTimer = setTimeout(() => { P.spSlowTimer = null; paintTopBtn(); }, (P.ctx && P.ctx.spSlowMs) || SP_SLOW_MS);
    if (P.spSlowTimer && typeof P.spSlowTimer.unref === 'function') P.spSlowTimer.unref();
}

// Включение кончилось ошибкой. Включалось само (после загрузки, повтором) —
// одно уведомление на страницу: панель закрыта, иначе никто не узнает. Сбой
// временный (сеть, загрузка, АТС не ответила, до сервера не дошли) — повтор с
// паузой SP_RETRY_MS, не больше их числа за страницу; постоянный отказ (номер не
// назначен, микрофон, пароль) повтором не лечится.
function softFailed(s) {
    if (P.spAuto && !P.spToasted) {
        P.spToasted = true;
        toast(trf('Телефон Easy-Med не включился: {reason}', { reason: reasonText(s.reason, s.message) || tr(SP_WORDS.error) }), 'warn');
    }
    P.spAuto = false;
    if (softTransient(s) && P.spTries < softRetryDelays().length) scheduleSoftRetry();
}
function softTransient(s) {
    if (s.reason === 'network' || s.reason === 'load_failed') return true;
    return s.reason === 'server' && (s.code === 'station_unavailable' || s.code === 'unreachable');
}
const softRetryDelays = () => (P.ctx && P.ctx.spRetryMs) || SP_RETRY_MS;
function stopSoftRetry() { if (P.spRetryTimer) clearTimeout(P.spRetryTimer); P.spRetryTimer = null; }
function scheduleSoftRetry() {
    stopSoftRetry();
    P.spRetryTimer = setTimeout(() => {
        P.spRetryTimer = null;
        if (!P.sp || softState().state !== SP.ERROR || !P.sp.wanted() || !softAllowed().ok) return;
        P.spTries++;
        P.spAuto = true;
        Promise.resolve(P.sp.enable()).catch(() => {});
    }, softRetryDelays()[P.spTries]);
    if (P.spRetryTimer && typeof P.spRetryTimer.unref === 'function') P.spRetryTimer.unref();
}

/** Включён, но звонить ещё нельзя: подключается, ошибка, телефон в другой вкладке. */
function softNotReady() {
    const s = softState().state;
    return s !== SP.OFF && s !== SP.READY && !SP_CALL.has(s);
}
function softNotReadyText() {
    const s = softState();
    return trf(SP_NOT_READY, { why: reasonText(s.reason, s.message) || tr(SP_WORDS[s.state] || '') });
}

/** «Кто я» не ответил при загрузке, а флаг стоит: спросить снова (не чаще ME_RETRY_MS) — телефон включится сам. */
function softRetryMe() {
    if (P.me || !P.sp || !P.sp.wanted()) return;
    const now = Date.now();
    if (now - P.spMeTry < ((P.ctx && P.ctx.meRetryMs) || ME_RETRY_MS)) return;
    P.spMeTry = now;
    loadMe().then(() => { if (P.els) paintAll(); }).catch(() => {});
}

function softToggle() {
    if (!P.sp) return;
    const st = P.sp.get().state;
    // Щелчок — решение человека: повтор и его счёт — с нуля, уведомление не нужно.
    stopSoftRetry();
    P.spTries = 0;
    P.spAuto = false;
    if (SP_CALL.has(st)) { /* идёт звонок — выключать нельзя (переключатель неактивен) */ }
    else if (st === SP.OTHER_TAB) { /* телефон работает в другой вкладке — выключать там */ }
    else if (st !== SP.OFF) P.sp.disable();
    else if (softAllowed().ok) Promise.resolve(P.sp.enable()).catch(() => {});
    // Браузер уже перевернул флажок сам — рисуем правду, что бы ни ответил телефон.
    P.spRowSig = '';
    paintSoftRow();
}

// Телефон сменил состояние. Входящий звонит — панель открывается сама (даже
// закрытая: звонок важнее того, что оператор делал), спрашиваем, кто звонит, и
// подаём сигнал; разговор — таймер раз в секунду; звонок кончился — журнал через
// 4 секунды (как после «Позвонить»: строка звонка доезжает до станции не сразу).
function onSoftChange() {
    const s = softState();
    const was = P.spLast;
    P.spLast = s.state;
    const sc = softCall();
    if (sc) {
        cancelMicTest();   // звонок — проверка гарнитуры отдаёт микрофон и не играет поверх
        const digits = digitsOf(sc.call.number);
        lookupCaller(digits);
        P.spNum = tail9(digits);
        hushLive();   // тот же звонок станция показала бы блоком «Звонит» — он здесь лишний
    }
    if (sc && sc.state === SP.RINGING) {
        if (!P.open) openDrawer();
        startSoftRing();
        if (was !== SP.RINGING) ringStarted(digitsOf(sc.call.number));
    } else {
        stopSoftRing();
    }
    if (s.state === SP.IN_CALL) startSoftTick(); else stopSoftTick();
    if (SP_CALL.has(was) && !sc) softCallEnded();
    // Финальное ревью (I1): долгое подключение, сбой включения, выключили — повтора нет.
    watchSlow(s.state);
    if (s.state === SP.ERROR && was !== SP.ERROR) softFailed(s);
    if (s.state === SP.READY) P.spAuto = false;
    if (s.state === SP.OFF) stopSoftRetry();
    paintTopBtn();
    if (P.els) { paintPhone(); paintChrome(); }
}

// Строка под строкой состояния: переключатель, слово состояния, причина,
// ссылка на файл настройки компьютера, «почему нельзя», итог прошлого звонка.
function paintSoftRow() {
    const row = P.els && P.els.spRow;
    if (!row) return;
    const s = softState();
    const show = !!(P.me && P.mayDial && P.me.softphone_available);   // без линии onlinePBX строки нет
    const allow = softAllowed();
    const on = s.state !== SP.OFF;
    const busy = SP_CALL.has(s.state);
    const otherTab = s.state === SP.OTHER_TAB;
    const reason = show && on ? reasonText(s.reason, s.message) : '';
    const hint = !show ? '' : busy ? tr(SP_BUSY) : otherTab ? tr(SP_OTHER_TAB_HINT) : !on ? allow.hint : '';
    const end = show && !busy ? endText(s.lastEnd) : '';
    const word = on ? SP_WORDS[s.state] || '' : '';
    // Та же картина — не перерисовываем: переключатель не теряет фокус клавиатуры.
    // В подписи — слова уже переведёнными, вместе с подписью переключателя: язык
    // сменили — оболочка ставит кнопку заново (mountPhoneButton → paintChrome),
    // подпись другая, и строка перерисуется даже у выключенного телефона.
    const sig = [show, s.state, tr(SP_LABEL), tr(word), reason, allow.ok, hint, end].join('|');
    if (sig === P.spRowSig) return;
    P.spRowSig = sig;
    keepFocus(() => {
        clear(row);
        row.hidden = !show;
        if (!show) return;
        const described = [reason ? 'cph-sp-reason' : '', hint ? 'cph-sp-hint' : ''].filter(Boolean).join(' ');
        const sw = h('input', {
            type: 'checkbox', role: 'switch', class: 'cph-sp-sw', 'data-cph-sp-toggle': '',
            checked: on, disabled: busy || otherTab || (!allow.ok && !on), 'aria-describedby': described || null, onclick: softToggle,
        });
        sw.checked = on;
        put(row,
            h('div', { class: 'cph-sp-top' },
                h('label', { class: 'cph-sp-lbl' }, sw, h('span', null, SP_LABEL)),
                word ? h('span', { class: 'cph-sp-st ' + (SP_TONE[s.state] || ''), 'data-cph-sp-state': s.state }, word) : null),
            reason ? h('div', { class: 'cph-sp-reason' + (s.state === SP.ERROR ? '' : ' info'), id: 'cph-sp-reason', 'data-cph-sp-reason': s.reason }, reason) : null,
            on && s.reason === 'insecure'
                ? h('a', { class: 'cph-sp-setup', href: '/setup/' + SP_SETUP_FILE, download: SP_SETUP_FILE, 'data-cph-sp-setup': '' },
                    Icon('Download', { size: 13 }), 'Скачать файл настройки компьютера')
                : null,
            hint ? h('div', { class: 'cph-sp-hint', id: 'cph-sp-hint', 'data-cph-sp-hint': '' }, hint) : null,
            end ? h('div', { class: 'cph-sp-end', 'data-cph-sp-end': '' }, end) : null);
    });
}

// Фокус клавиатуры: перерисовка заменяет кнопки новыми — если фокус был в панели,
// он возвращается на кнопку с тем же data-cph-sp-*. «Принять» после ответа уже
// нет — тогда на «Завершить».
const SP_FOCUS = ['data-cph-sp-toggle', 'data-cph-sp-answer', 'data-cph-sp-decline', 'data-cph-sp-mute', 'data-cph-sp-hangup',
    'data-cph-sp-patient', 'data-cph-sp-lead', 'data-cph-sp-new', 'data-cph-sp-setup',
    'data-cph-sp-mic', 'data-cph-sp-out', 'data-cph-sp-test'];
function within(el, root) {
    for (let n = el; n; n = n.parentNode) if (n === root) return true;
    return false;
}
function keepFocus(paint) {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    const key = a && P.els && typeof a.hasAttribute === 'function' && within(a, P.els.drawer) ? SP_FOCUS.find((k) => a.hasAttribute(k)) : '';
    paint();
    if (!key || !P.els) return;
    const back = P.els.drawer.querySelector('[' + key + ']')
        || (key === 'data-cph-sp-answer' ? P.els.drawer.querySelector('[data-cph-sp-hangup]') : null);
    if (back && back !== a && typeof back.focus === 'function') back.focus();
}

// ---------------------------------------------------------------------------
// SOFTPHONE_V1 — звонок телефона Easy-Med: входящий, вызов, разговор
// ---------------------------------------------------------------------------
//
// Кнопки — те, что владелец взял в первую версию: «Принять» / «Отклонить»,
// таймер, «Микрофон выкл.», «Завершить», имя звонящего и «Открыть карту».
// Тонового набора, удержания и перевода нет — и кнопок для них нет.

/** Звонок телефона Easy-Med, если он идёт (звонит, вызов, разговор); иначе null. */
function softCall() {
    const s = softState();
    return s.call && SP_CALL.has(s.state) ? s : null;
}

/** Длительность разговора: мм:сс, с часа — ч:мм:сс. */
function clockOf(startedAt) {
    const t = startedAt ? Math.max(0, Math.floor((Date.now() - Number(startedAt)) / 1000)) : 0;
    const p2 = (n) => String(n).padStart(2, '0');
    const hh = Math.floor(t / 3600);
    return (hh ? hh + ':' : '') + p2(Math.floor((t % 3600) / 60)) + ':' + p2(t % 60);
}
/** Строка под именем: «Входящий звонок», «Вызов…» или время разговора. */
function softLine(s) {
    if (s.state === SP.RINGING) return tr('Входящий звонок');
    if (s.state === SP.CALLING) return tr('Вызов…');
    return clockOf(s.call.startedAt);
}

// Кто звонит — один запрос на номер, пока идёт звонок (повторное «звонит» о том
// же номере сервер не спрашивает). Ответ пришёл, а звонок уже кончился — молчим.
// Внутренние номера (короче MIN_DIGITS) — коллеги: их у сервера не спрашиваем.
// Сервер не ответил — это не «номер не знаком»: помечаем отдельно (failed).
function lookupCaller(digits) {
    // Без права набора сервер не скажет, чей номер (403): не спрашиваем — карточка покажет номер.
    if (!P.mayDial || !digits || digits.length < MIN_DIGITS || P.spWho.has(digits)) return;
    const seen = { done: false, failed: false, data: null };
    const map = P.spWho;
    map.set(digits, seen);
    Promise.resolve(supabase.rpc('telephony_caller', { number: digits }))
        .then((r) => { if (r && !r.error) seen.data = r.data || null; else seen.failed = true; })
        .catch(() => { seen.failed = true; })
        .finally(() => {
            seen.done = true;
            if (P.spWho !== map || !P.els || !softCall()) return;
            paintPhone();
            sayRing();   // имя пришло — объявить входящий читалке
        });
}
/** Пациент или заявка с этим номером: ответ сервера, пока его нет — то, что знает сама панель. */
function softWho(digits) {
    if (digits.length < MIN_DIGITS) return { name: '', patient: null, lead: null, internal: true };
    const seen = P.spWho.get(digits);
    const d = (seen && seen.data) || {};
    if (d.patient && d.patient.full_name) return { name: d.patient.full_name, patient: d.patient, lead: d.lead || null };
    if (d.lead && d.lead.full_name) return { name: d.lead.full_name, patient: null, lead: d.lead };
    const w = whoIs(digits, { leads: leadsOf(), calls: P.calls });
    if (w) return { name: w.name, patient: w.kind === 'patient' && w.patient_id ? { id: w.patient_id, full_name: w.name } : null, lead: w.kind === 'lead' ? w.lead : null };
    return { name: '', patient: null, lead: null, unknown: !!(seen && seen.done && !seen.failed) };
}
function softName(s) {
    const digits = digitsOf(s.call.number);
    const who = softWho(digits);
    if (who.internal) return digits || s.call.number || '—';
    return who.name || formatPhone(digits) || s.call.number || '—';
}

// Читалка экрана: входящий объявляется один раз — когда сервер назвал звонящего
// (или через 2 с без ответа); имя уже известно — сразу, после короткой паузы:
// область объявлений могла только что появиться вместе с панелью.
function ringStarted(digits) {
    P.spSaid = false;
    if (P.spSay) clearTimeout(P.spSay);
    const seen = P.spWho.get(digits);
    P.spSay = setTimeout(sayRing, seen && !seen.done ? 2000 : 150);
    if (P.spSay && typeof P.spSay.unref === 'function') P.spSay.unref();
}
function sayRing() {
    if (P.spSay) clearTimeout(P.spSay);
    P.spSay = null;
    const sc = softCall();
    if (P.spSaid || !sc || sc.state !== SP.RINGING || !P.els) return;
    P.spSaid = true;
    P.els.spLive.textContent = trf('Входящий звонок: {who}', { who: softName(sc) });
}

// Звонок телефона Easy-Med станция видит тоже и прислала бы его блоком «Звонит» —
// и во время звонка, и сразу после «Отклонить» / «Завершить» (её события
// запаздывают). Такие входящие с тем же номером прячем (ringHidden чистится сам,
// когда звонок уходит из ленты станции); после конца — ещё HUSH_MS, но только
// пока телефон готов: тогда настоящий перезвон зазвонит в нём самом. Связь с АТС
// пропала или телефон выключили — перезвон здесь не зазвонит, и станция
// показывает его как обычно.
function hushLive() {
    const hush = P.spHush && Date.now() < P.spHush.until && softState().state === SP.READY ? P.spHush.tail : '';
    const tails = [P.spNum, hush].filter(Boolean);
    if (!tails.length) return;
    for (const c of P.live) {
        if (c && c.direction === 'in' && tails.includes(tail9(c.number || c.caller))) P.ringHidden.add(c.uuid);
    }
}

function paintSoftCall(s) {
    const c = s.call;
    const digits = digitsOf(c.number);
    const who = softWho(digits);
    const ringing = s.state === SP.RINGING;
    const chips = [];
    if (who.patient && who.patient.mrn) chips.push(h('span', { class: 'cph-chip t' }, trf('Карта {mrn}', { mrn: who.patient.mrn })));
    if (who.lead) chips.push(h('span', { class: 'cph-chip' }, 'Заявка на доске'));
    if (who.unknown) chips.push(h('span', { class: 'cph-chip' }, 'Номер не знаком'));
    // Карта НЕ открывается сама (решение владельца, как у блока «Звонит») — кнопкой.
    const links = [];
    if (who.patient && P.ctx && typeof P.ctx.onNavigate === 'function' && isRouteAllowed('patient-card')) {
        links.push(h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-cph-sp-patient': '',
            onclick: () => P.ctx.onNavigate('patient-card', { id: who.patient.id, full_name: who.patient.full_name || '' }) }, Icon('User', { size: 13 }), 'Открыть карту'));
    }
    if (who.lead) {
        links.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-sp-lead': '', onclick: () => openLeadById(who.lead.id) },
            Icon('Headset', { size: 13 }), 'Открыть заявку'));
    }
    if (who.unknown && c.direction === 'in') {
        links.push(h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-sp-new': '', onclick: () => newLeadFor(c.number) },
            Icon('Plus', { size: 13 }), 'Новая заявка'));
    }
    // Круглая кнопка с подписью под ней — как клавиши наборника.
    const round = (attr, tone, icon, label, onclick, extra = {}) => h('button', { class: 'cph-sp-btn' + (tone ? ' ' + tone : ''), type: 'button', [attr]: '', onclick, ...extra },
        h('i', { 'aria-hidden': 'true' }, Icon(icon, { size: 24 })), h('span', null, label));
    const acts = ringing
        ? [round('data-cph-sp-answer', 'ok', 'Phone', 'Принять', () => P.sp.answer()),
            round('data-cph-sp-decline', 'crit', 'PhoneOff', 'Отклонить', () => P.sp.decline())]
        // «Микрофон выкл.» — кнопка-переключатель: подпись одна, нажата (aria-pressed) —
        // микрофон выключен; значок показывает, что сейчас: микрофон или перечёркнутый.
        // Только в разговоре: до ответа выключать нечего.
        : [round('data-cph-sp-mute', '', c.muted ? 'MicOff' : 'Mic', 'Микрофон выкл.', () => P.sp.setMuted(!c.muted),
            { 'aria-pressed': c.muted ? 'true' : 'false', disabled: s.state !== SP.IN_CALL }),
            round('data-cph-sp-hangup', 'crit', 'PhoneOff', 'Завершить', () => P.sp.hangup())];
    P.els.spTimer = h('div', { class: 'cph-tm cph-sp-tm ' + s.state, ...(ringing ? {} : { 'data-cph-sp-timer': '' }) }, softLine(s));
    const sub = who.internal ? 'Внутренний звонок' : who.name ? formatPhone(digits) : (c.direction === 'in' ? 'Входящий' : 'Исходящий');
    put(P.els.body, h('div', { class: 'cph-inc cph-sp', 'data-cph-sp-card': s.state },
        h('div', { class: 'cph-ava' + (ringing ? ' ring' : '') }, who.name ? initialsOf(who.name) : '#'),
        h('h2', { class: 'cph-inc-name' }, softName(s)),
        h('div', { class: 'cph-pn' }, sub),
        P.els.spTimer,
        c.muted && !ringing ? h('div', { class: 'cph-sp-muted', 'data-cph-sp-muted': '' }, Icon('MicOff', { size: 13 }), 'Микрофон выключен — собеседник вас не слышит.') : null,
        chips.length ? h('div', { class: 'cph-chips' }, ...chips) : null,
        h('div', { class: 'cph-sp-acts' }, ...acts),
        links.length ? h('div', { class: 'cph-sum' }, ...links) : null));
}

// Сигнал входящего — тот же двойной писк, что у блока «Звонит» (crm-ring-logic.js),
// каждые 2 секунды, пока звонит; колокольчик панели его выключает. Контекст звука
// обычно рождается с первым жестом (armAudio). После перезагрузки страницы с
// включённым телефоном жеста ещё не было — создаём сами: браузер может оставить
// контекст «приостановленным», и тогда писк зазвучит с первым щелчком по странице
// (armAudio его будит); панель при этом открыта и пульсирует — звонок виден.
function startSoftRing() {
    if (P.spRing) return;
    const beep = () => {
        if (P.muted) return;
        if (!P.audio) P.audio = audioContextOf(typeof window !== 'undefined' ? window : null);
        ringTone(P.audio);
    };
    beep();
    P.spRing = setInterval(beep, (P.ctx && P.ctx.spRingMs) || BEEP_EVERY_MS);
    if (P.spRing && typeof P.spRing.unref === 'function') P.spRing.unref();
}
function stopSoftRing() { if (P.spRing) clearInterval(P.spRing); P.spRing = null; }

// Таймер разговора: раз в секунду меняется только его строка (и пилюля), а не
// вся карточка — кнопки не мигают и не теряют фокус.
function startSoftTick() {
    if (P.spTick) return;
    P.spTick = setInterval(() => {
        const sc = softCall();
        if (!sc || !P.els) return;
        const line = softLine(sc);
        if (P.els.spTimer) P.els.spTimer.textContent = line;
        if (P.min) P.els.miniSub.textContent = line;
    }, (P.ctx && P.ctx.spTickMs) || 1000);
    if (P.spTick && typeof P.spTick.unref === 'function') P.spTick.unref();
}
function stopSoftTick() { if (P.spTick) clearInterval(P.spTick); P.spTick = null; }

function softCallEnded() {
    P.spWho = new Map();   // следующий звонок с этого номера спросит заново: карту могли завести
    // Станция ещё покажет этот звонок («звонит», «разговор идёт») — молчим о нём.
    P.spHush = P.spNum ? { tail: P.spNum, until: Date.now() + ((P.ctx && P.ctx.spHushMs) || HUSH_MS) } : null;
    P.spNum = '';
    hushLive();
    if (P.spSay) clearTimeout(P.spSay);
    P.spSay = null;
    if (P.els) P.els.spLive.textContent = '';   // следующий входящий объявится заново
    if (P.min && !inCard()) P.min = false;   // пилюле больше нечего показывать
    if (P.spRefresh) clearTimeout(P.spRefresh);
    P.spRefresh = setTimeout(() => { P.spRefresh = null; loadCalls().catch(() => {}); }, (P.ctx && P.ctx.spRefreshMs) || 4000);
    if (P.spRefresh && typeof P.spRefresh.unref === 'function') P.spRefresh.unref();
}

// ---------------------------------------------------------------------------
// SOFTPHONE_V1 (задача 7) — гарнитура в «Моя трубка»: микрофон, динамик, проверка
// ---------------------------------------------------------------------------
//
// Раздел виден, только когда телефон Easy-Med включён: подписи устройств браузер
// отдаёт после разрешения микрофона, а его уже спросило включение. Выбор помнит
// этот компьютер (softphone-browser.js saveDevice). Микрофон — со следующего
// звонка (идущий звонок свой поток не меняет), динамик — сразу, и для звука
// собеседника. Гарнитуру подключили или вынули — списки обновляются сами, пока
// «Моя трубка» открыта. Браузер для стендов — P.ctx.devEnv.
const DEV_MISSING = {
    in: 'Выбранный микрофон не найден — звонок пойдёт через микрофон по умолчанию.',
    out: 'Выбранный динамик не найден — звук пойдёт в динамик по умолчанию.',
};
// Записи браузера «по умолчанию»: выбранная раньше, она не «пропала», даже если
// в списке её нет (повторяет настоящее устройство и потому скрыта).
const DEV_PSEUDO = new Set(['default', 'communications']);
const devEnv = () => (P.ctx && P.ctx.devEnv) || undefined;
function stopDeviceWatch() {
    if (P.spDevUnsub) P.spDevUnsub();
    P.spDevUnsub = null;
    if (P.spDevTimer) clearTimeout(P.spDevTimer);
    P.spDevTimer = null;
}

function paintHeadset() {
    const env = devEnv();
    const mic = h('select', { class: 'cph-select', id: 'cph-sp-mic', 'data-cph-sp-mic': '', onchange: () => saveDevice('in', mic.value) });
    const out = canChooseOutput(env)
        ? h('select', { class: 'cph-select', id: 'cph-sp-out', 'data-cph-sp-out': '', onchange: () => { saveDevice('out', out.value); setOutputDevice(out.value); } })
        : null;   // браузер без выбора динамика (Firefox) — и поля нет
    const micNote = h('div', { class: 'cph-sp-note', 'data-cph-sp-dev-note': 'in' });
    const outNote = out ? h('div', { class: 'cph-sp-note', 'data-cph-sp-dev-note': 'out' }) : null;
    micNote.hidden = true;
    if (outNote) outNote.hidden = true;
    P.els.spTestBtn = h('button', { class: 'btn btn-sm', type: 'button', 'data-cph-sp-test': '', onclick: runMicTest },
        Icon('Mic', { size: 13 }), 'Проверить гарнитуру');
    P.els.spTestStatus = h('div', { class: 'cph-sp-test-st', role: 'status', 'data-cph-sp-test-status': '' });
    paintMicTest();
    // Список без перемен (Chrome шлёт devicechange пачкой) не перерисовываем:
    // открытый выпадающий список иначе закрылся бы под рукой.
    let shown = null;
    const fill = async () => {
        const { inputs, outputs } = await listDevices(env);
        const sig = JSON.stringify([inputs, out ? outputs : []]);
        if (sig === shown) return;
        shown = sig;
        fillDevices(mic, inputs, 'in', micNote);
        if (out) fillDevices(out, outputs, 'out', outNote);
    };
    fill().catch(() => {});
    stopDeviceWatch();
    P.spDevUnsub = onDeviceChange(() => {
        if (P.spDevTimer) clearTimeout(P.spDevTimer);
        P.spDevTimer = setTimeout(() => { P.spDevTimer = null; fill().catch(() => {}); }, (P.ctx && P.ctx.devDebounceMs) || 300);
        if (P.spDevTimer && typeof P.spDevTimer.unref === 'function') P.spDevTimer.unref();
    }, env);
    return h('div', { class: 'cph-sp-dev', 'data-cph-sp-devices': '' },
        h('h4', { class: 'cph-sp-dev-h' }, Icon('Headset', { size: 15 }), 'Гарнитура'),
        // «Запомнить» выше — для внутреннего номера; гарнитура сохраняется без неё.
        h('p', { class: 'cph-hint' }, 'Выбор гарнитуры сохраняется сразу.'),
        h('label', { class: 'cph-label', for: 'cph-sp-mic' }, 'Микрофон'), mic, micNote,
        h('p', { class: 'cph-hint' }, 'Новый микрофон будет в следующем звонке.'),
        out ? [h('label', { class: 'cph-label', for: 'cph-sp-out' }, 'Динамик'), out, outNote] : null,
        h('div', { class: 'cph-sum' }, P.els.spTestBtn),
        P.els.spTestStatus);
}

// Варианты списка: «По умолчанию» (или запись браузера 'default') и устройства;
// выбранное раньше — отмечено; его больше нет — заметка и «по умолчанию».
function fillDevices(sel, list, kind, note) {
    const saved = savedDevice(kind);
    const hasDefault = list.some((d) => d.id === 'default');
    clear(sel);
    if (!hasDefault) sel.appendChild(h('option', { value: '' }, 'По умолчанию'));
    for (const d of list) sel.appendChild(h('option', { value: d.id }, d.label));
    const found = !saved || DEV_PSEUDO.has(saved) || list.some((d) => d.id === saved);
    let value = found && saved ? saved : (hasDefault ? 'default' : '');
    // Сохранённого 'default'/'communications' в списке нет (повторял устройство) —
    // «По умолчанию», а не пустое поле с несуществующим вариантом.
    if (![...sel.children].some((o) => o.getAttribute('value') === value)) value = '';
    for (const o of [...sel.children]) if (o.getAttribute('value') === value) o.setAttribute('selected', '');
    sel.value = value;
    note.textContent = found ? '' : tr(DEV_MISSING[kind]);
    note.hidden = found;
}

// Ошибки проверки — свои слова: причины включения телефона («…и включите
// телефон снова») здесь звали бы не туда.
const MIC_TEST_ERRORS = {
    mic_denied: 'Браузер не дал доступ к микрофону. Разрешите его значком слева от адреса страницы и нажмите «Проверить гарнитуру» ещё раз.',
    no_mic: 'Микрофон не найден. Подключите гарнитуру или выберите другой микрофон и повторите проверку.',
    mic_error: 'Не удалось записать с микрофона. Выберите другой микрофон и повторите проверку.',
    busy: 'Проверить гарнитуру можно после разговора.',
};

/** Строка под «Проверить гарнитуру»: вступление — только до первой проверки, потом — её итог. */
function micTestLine() {
    const t = P.spTest;
    if (!t) return tr('Запишем 5 секунд вашего голоса и сразу проиграем — так проверяются и микрофон, и динамик.');
    if (t.phase === 'recording') return trf('Говорите… {n} с', { n: t.n });
    if (t.phase === 'playing') return tr('Слушайте запись…');
    if (t.phase === 'done') return tr('Готово. Если себя не слышно — выберите другой микрофон или динамик.');
    if (t.phase === 'cancelled') return tr('Проверка прервана.');
    if (t.reason === 'insecure') return reasonText('insecure');   // файл настройки компьютера — те же слова, что у включения
    return tr(MIC_TEST_ERRORS[t.reason] || MIC_TEST_ERRORS.mic_error);
}
function paintMicTest() {
    if (!P.els) return;
    if (P.els.spTestStatus) P.els.spTestStatus.textContent = micTestLine();
    const b = P.els.spTestBtn;
    if (!b) return;
    // Пока идёт проверка или звонок — вторую не начинаем: микрофон звонка не трогаем.
    if ((P.spTest && P.spTest.running) || softCall()) b.setAttribute('disabled', '');
    else b.removeAttribute('disabled');
}
function runMicTest() {
    if ((P.spTest && P.spTest.running) || softCall()) return;
    const ms = (P.ctx && P.ctx.micTestMs) || 5000;
    const before = P.spTest;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    P.spTestAbort = ac;
    P.spTest = { running: true, phase: 'recording', n: Math.max(1, Math.ceil(ms / 1000)), reason: '' };
    paintMicTest();
    Promise.resolve(micTest(ms, (phase, x) => {
        P.spTest = { running: phase === 'recording' || phase === 'playing', phase, n: phase === 'recording' ? x : 0, reason: phase === 'error' ? x : '' };
        paintMicTest();
    }, { ...(devEnv() || {}), ...(ac ? { signal: ac.signal } : {}) })).catch(() => {}).finally(() => {
        if (P.spTestAbort === ac) P.spTestAbort = null;
        if (P.spTest && P.spTest.running) P.spTest = before;   // проверка не началась (уже идёт другая) — строка как до неё
        paintMicTest();
    });
}
/**
 * Прервать проверку гарнитуры (ревью задачи 7): пришёл звонок, ушли из «Моя
 * трубка», сняли панель. Микрофон закрывается, запись не играет поверх звонка.
 */
function cancelMicTest() {
    const ac = P.spTestAbort;
    P.spTestAbort = null;
    if (ac) { try { ac.abort(); } catch { /* уже прервана */ } }
}
