import { h, clear, field, Icon } from '../ui.js';
import { tr } from '../i18n.js';
import { supabase } from '../../supabase.js';

// LICENCE_CORE_V1 — Task 15: what EVERY clinic sees once its subscription has
// lapsed, before ANY module — including the free clinical core — is reachable.
//
// This screen takes precedence over the per-module locked-module.js sales
// screen (see admin.js's renderViewInner): a lapsed subscription blocks the
// whole app, not one unbought feature, so a free-core module like «Пациенты»
// must never fall through to locked-module.js's "nothing to sell" bare card.
//
// The rule that matters more than anything else in this file: a clinic that
// HAS paid, whose router died, must never be told it owes money. `reason` is
// the only thing that decides the heading — see ladder.js's own comment for
// why the server defaults to 'offline' (not 'unpaid') whenever it is unsure.
//
// h() already runs every literal text child through tr() (see ui.js); the one
// place this file changes text AFTER the initial render does it via
// .textContent, which bypasses h(), so that call sites tr() explicitly —
// matching the pattern in locked-module.js/services.js/settings-hub.js.
//
// No emojis, per the house rule — the lock icon comes from icons.js.

export async function renderActivation(root, lic) {
    clear(root);

    const reason = lic && lic.reason;

    // ENROLLMENT_SCREEN_V1 — a never-enrolled install is its own state, not a
    // flavour of lapse. Before this branch it fell into the offline heading:
    // a brand-new install was told its internet was broken and offered a
    // telephone-unlock field that cannot work (unlock needs the unlock_secret
    // only enrollment creates). First run gets its own screen instead.
    if (reason === 'not_enrolled') return renderEnrollment(root);

    const heading = reason === 'unpaid' ? 'Подписка не активна' : 'Нет связи с Easy-Med';

    // Populated below, once (if) the licence_status RPC answers with a
    // challenge. Starts empty rather than absent so the layout doesn't jump
    // when the code arrives a moment later.
    const codeWrap = h('div', { class: 'act-code-wrap' });

    // One shared region for both the success and the failure message — same
    // role="status" pattern as locked-module.js's `foot`: an implicit
    // aria-live="polite" region so a screen-reader user hears the outcome
    // regardless of where focus is, which overwriting the button's own
    // accessible name is not reliably announced.
    const statusEl = h('div', { class: 'act-status', role: 'status' });

    const input = h('input', {
        type: 'text', class: 'act-input', placeholder: 'XXXXX-XXXXX',
        autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    });

    // Guards its own re-entrancy the same way locked-module.js's cta does:
    // the native `disabled` attribute stops a real pointer click, but nothing
    // stops this handler firing again directly (a second click landing before
    // the browser reflects the attribute, or the Enter-key path below firing
    // while a click is already in flight) — so re-entry is checked explicitly.
    const doUnlock = async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        statusEl.className = 'act-status';
        statusEl.textContent = '';
        try {
            const { error } = await supabase.rpc('licence_unlock', { code: input.value });
            if (error) throw error;
            statusEl.className = 'act-status ok';
            statusEl.textContent = tr('Система разблокирована.');
            input.disabled = true;
            // A short delay so the success message is actually readable before
            // the reload wipes it — not a mechanism the unlock depends on.
            setTimeout(() => { try { location.reload(); } catch (e) {} }, 1200);
        } catch (e) {
            // The server's message is already a specific, Russian explanation —
            // "Код неверный…", "Слишком много попыток…", or, for a non-admin,
            // "Только администратор может активировать." (403 — see
            // server/services/rpc/licence.js). Showing it as-is is exactly what
            // makes a non-admin's rejection a clear explanation instead of a
            // raw error: they cannot activate, but they see WHY.
            statusEl.className = 'act-status error';
            statusEl.textContent = (e && e.message) || tr('Не удалось активировать.');
            btn.disabled = false;
        }
    };

    const btn = h('button', {
        type: 'button', class: 'btn btn-primary act-cta',
        onclick: doUnlock,
    }, 'Активировать');

    // Enter-to-submit convenience, kept OFF a real <form> element on purpose:
    // the fake-DOM test harness (see __tests__/locked-module.test.mjs, which
    // this file's own tests follow) drives every other RPC-backed control by
    // calling the button's own onclick directly, and a <form> submit event has
    // no equivalent in that harness. A keydown listener gets the same UX
    // without depending on browser form-submission machinery.
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault?.(); doUnlock(); } });

    root.appendChild(h('div', { class: 'card activation-screen' },
        h('div', { class: 'act-icon' }, Icon('Lock', { size: 26 })),
        h('h1', { class: 'act-title' }, heading),
        // Not decoration — a clinic watching its system lock is frightened
        // about its records, and saying plainly that the data is safe is what
        // prevents the panicked phone call.
        h('p', { class: 'act-reassure' },
            'Данные клиники на месте. Пока подписка не активна, можно только просматривать записи.'),
        codeWrap,
        field('Введите код разблокировки', input),
        btn,
        statusEl,
    ));

    // A locked clinic is very often offline — that may be WHY it locked — so a
    // failed fetch here is a normal, expected state, not an error to surface.
    // Everything above (heading, reassurance, the unlock form itself) already
    // renders regardless of whether this call ever succeeds.
    try {
        const { data, error } = await supabase.rpc('licence_status', {});
        if (error) throw error;
        if (data && data.challenge) {
            codeWrap.appendChild(h('p', { class: 'act-call' },
                'Позвоните менеджеру Easy-Med и назовите этот код:'));
            codeWrap.appendChild(h('div', { class: 'act-code' }, data.challenge));
        }
    } catch (e) {
        // No challenge to show. The unlock form above still works: the admin
        // may already have the code from an earlier call, or the manager may
        // read it out from their own panel.
    }
}

// ENROLLMENT_SCREEN_V1 — first run: the admin types the EM- code the vendor
// read out, licence_enroll redeems it and writes this install's identity.
//
// Deliberately NOT the unlock form with different labels, even though the two
// read alike: no telephone challenge is fetched or shown (licence_status does
// answer one for a not-enrolled install, but redeeming it needs an
// unlock_secret that does not exist yet — showing a code the manager can do
// nothing with would script a doomed phone call), and no «данные на месте»
// reassurance (that line is about a LAPSE; a first run has no data to worry
// about). The code goes to the server exactly as typed — normalisation lives
// in one place, control-plane-side (mirrored by control/enroll.js), so the
// screen can never disagree with it.
// BRANCH_KEY_ACTIVATES_V1 — код активации, вложенный в ключ филиала.
//
// Ключ EMB2 — это base64url от JSON; поле `e` кладёт туда ГЛАВНАЯ клиника,
// получив код у control plane своим install_token (branch-sync/relay.js →
// /cp/v1/branch). Разбор здесь намеренно МИНИМАЛЬНЫЙ: достать одно поле, а не
// повторять серверный decodeKey. Если поля нет (ключ выписан офлайн или старой
// версией), возвращаем null — и экран честно просит код отдельно.
function enrollCodeFromBranchKey(raw) {
    const str = String(raw || '').trim();
    if (!str.startsWith('EMB2-')) return null;
    try {
        const b64 = str.slice(5).replace(/-/g, '+').replace(/_/g, '/');
        const json = decodeURIComponent(escape(atob(b64)));
        const body = JSON.parse(json);
        const code = body && typeof body.e === 'string' ? body.e.trim() : '';
        return code || null;
    } catch (e) { return null; }
}

function renderEnrollment(root) {
    // INSTALL_KIND_V1 — экран сначала спрашивает, ЧТО ставят, и только потом
    // просит строку.
    //
    // Раньше поле было одно и подписано «код активации». Установщик филиала,
    // у которого на руках ключ главной клиники, вводил его — и получал
    // «Код неверный. Проверьте и введите ещё раз.», потому что код уже погашен
    // на другой установке. Сообщение верное и совершенно бесполезное: человек
    // перевводит ту же строку, снова упирается и решает, что система сломана.
    // Сервер тут ни при чём — он намеренно отвечает одинаково на любой негодный
    // код, чтобы по ответам нельзя было перебирать живые. Значит развести пути
    // должен ЭКРАН, до отправки.
    let kind = 'clinic';   // 'clinic' | 'branch'

    const card = h('div', { class: 'card activation-screen' });
    root.appendChild(card);

    function paint() {
        clear(card);
        const isBranch = kind === 'branch';
        const { input, btn, statusEl } = buildEnrollForm(() => renderBranchStep(root), {
            branch: isBranch,
        });

        const pick = (id, label) => h('button', {
            type: 'button', class: kind === id ? 'on' : '',
            onclick: () => { if (kind !== id) { kind = id; paint(); } },
        }, label);

        card.appendChild(h('div', { class: 'act-icon' }, Icon(isBranch ? 'Building' : 'Lock', { size: 26 })));
        card.appendChild(h('h1', { class: 'act-title' }, 'Активация Easy-Med'));
        card.appendChild(h('div', { class: 'segmented act-kind' },
            pick('clinic', 'Клиника'), pick('branch', 'Филиал')));
        card.appendChild(h('p', { class: 'act-reassure' }, isBranch
            ? 'Вставьте ключ филиала, выданный главной клиникой. Код активации уже внутри него — отдельный код не нужен.'
            : 'Введите код активации, полученный от менеджера Easy-Med.'));
        card.appendChild(field(isBranch ? 'Ключ филиала' : 'Код активации', input));
        card.appendChild(btn);
        card.appendChild(statusEl);
    }

    paint();
}
// Шаг 2: присоединить филиал к главной клинике. Пропускаемый — главной клинике
// присоединяться не к чему, и заставлять её что-то вводить было бы неправдой.
// Ключ, которым активировались: шаг 2 подставит его сам, чтобы не заставлять
// вводить одну и ту же строку дважды.
let pendingBranchKey = null;

function renderBranchStep(root) {
    clear(root);
    const statusEl = h('div', { class: 'act-status', role: 'status' });
    const keyInput = h('input', {
        type: 'text', class: 'act-input', placeholder: 'BR-...',
        autocomplete: 'off', spellcheck: 'false',
        value: pendingBranchKey || '',
    });
    const done = () => { try { location.reload(); } catch (e) {} };

    const joinBtn = h('button', {
        type: 'button', class: 'btn btn-primary act-cta',
        onclick: async () => {
            const key = String(keyInput.value || '').trim();
            if (!key) { keyInput.focus(); return; }
            joinBtn.disabled = true;
            statusEl.className = 'act-status';
            statusEl.textContent = '';
            try {
                const { error } = await supabase.rpc('branch_sync_pair', { key });
                if (error) throw error;
                statusEl.className = 'act-status ok';
                statusEl.textContent = tr('Филиал подключён. Справочник подтянется от главной клиники.');
                setTimeout(done, 1400);
            } catch (e) {
                statusEl.className = 'act-status error';
                statusEl.textContent = (e && e.message) || tr('Не удалось подключить филиал.');
                joinBtn.disabled = false;
            }
        },
    }, 'Подключить филиал');

    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault?.(); joinBtn.click(); } });

    root.appendChild(h('div', { class: 'card activation-screen' },
        h('div', { class: 'act-icon' }, Icon('Building', { size: 26 })),
        h('h1', { class: 'act-title' }, 'Система активирована'),
        h('p', { class: 'act-reassure' },
            'Если это филиал — введите ключ филиала, выданный главной клиникой. Если это главная клиника, пропустите шаг.'),
        field('Ключ филиала', keyInput),
        joinBtn,
        h('button', {
            type: 'button', class: 'btn btn-outline act-cta', style: { marginTop: '8px' },
            onclick: done,
        }, 'Это главная клиника — пропустить'),
        statusEl,
    ));
}

// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) — the
// EM- code entry itself (input + button + status, wired to licence_enroll),
// extracted so the Settings → «Система» subscription card
// (views/system-subscription.js) reuses THIS flow instead of keeping a copy
// that would drift from it — the plan's own "extract the shared piece rather
// than copy it". Behavior is renderEnrollment's, unchanged: the code goes to
// the server exactly as typed (normalisation lives control-plane-side, so no
// screen can disagree with it), the server's Russian sentence is shown as-is
// on failure, and success reloads — the whole app must re-read its licence.
export function buildEnrollForm(onEnrolled, { branch = false } = {}) {
    const statusEl = h('div', { class: 'act-status', role: 'status' });

    const input = h('input', {
        type: 'text', class: 'act-input',
        placeholder: branch ? 'EMB2-…' : 'EM-XXXX-XXXX',
        autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    });

    // Same explicit re-entrancy guard as doUnlock above, for the same two
    // race paths (double click, Enter during an in-flight click). Kept as a
    // sibling of doUnlock rather than merged with it: the two flows share a
    // shape but not a fate — different RPC, different success action,
    // different fallback text.
    const doEnroll = async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        statusEl.className = 'act-status';
        statusEl.textContent = '';
        try {
            // BRANCH_KEY_ACTIVATES_V1 — в это поле можно вставить и ключ филиала:
            // код активации лежит внутри него. Установщику филиала так хватает
            // ОДНОЙ строки вместо двух из двух разных мест. Ключ запоминаем,
            // чтобы сразу после активации связать филиал, не прося ввести его
            // второй раз.
            // INSTALL_KIND_V1 — что можно проверить здесь, здесь и проверяем.
            // Сервер на любой негодный код отвечает одинаково (и правильно
            // делает: иначе по ответам можно было бы перебирать живые коды),
            // поэтому «в этом ключе нет кода активации» способен сказать
            // только экран — по самому ключу, никуда его не отправляя.
            // В RPC уходит ровно то, что набрали: нормализация — дело сервера.
            const typed = String(input.value || '');
            const embedded = enrollCodeFromBranchKey(typed);
            const refuse = (msg) => {
                statusEl.className = 'act-status error';
                statusEl.textContent = tr(msg);
                btn.disabled = false;
            };
            if (branch) {
                if (!typed.trim().startsWith('EMB2-')) {
                    return refuse('Это не похоже на ключ филиала. Ключ выдаёт главная клиника: «Настройки → Помещения → Филиалы».');
                }
                if (!embedded) {
                    // Ключ выписан без связи с Easy-Med: связать филиал им можно,
                    // активировать — нет. Называем оба выхода, а не «код неверный».
                    return refuse('В этом ключе нет кода активации — его выдали без связи с Easy-Med. Попросите главную клинику выдать ключ заново при интернете, либо активируйте филиал его собственным кодом на вкладке «Клиника».');
                }
            }
            if (embedded) pendingBranchKey = typed.trim();
            const { error } = await supabase.rpc('licence_enroll', { code: embedded || typed });
            if (error) throw error;
            statusEl.className = 'act-status ok';
            statusEl.textContent = tr('Система активирована.');
            input.disabled = true;
            // Same readable-before-reload delay as the unlock path: the reload
            // is what swaps this screen for the real app now that
            // licence_status will answer unlocked.
            // BRANCH_FIRST_RUN_V1 — раньше здесь была только перезагрузка, и установщик
            // филиала оставался с активированной, но ОДИНОКОЙ базой: чтобы подтянуть
            // справочник главного филиала, он должен был сам догадаться зайти в
            // «Настройки → Филиалы». Теперь второй шаг предлагается сразу, и его можно
            // пропустить, если это главная клиника, а не филиал.
            // Сообщение «Система активирована» должно быть видно, а не мелькнуть:
            // шаг 2 показывается через ту же паузу, что раньше вела к перезагрузке.
            if (typeof onEnrolled === 'function') { setTimeout(onEnrolled, 1200); return; }
            setTimeout(() => { try { location.reload(); } catch (e) {} }, 1200);
        } catch (e) {
            // The server's message is already the specific, Russian sentence
            // (licence_enroll maps every transport reason — wrong code, rate
            // limit, no internet, vendor error — in services/rpc/licence.js).
            statusEl.className = 'act-status error';
            statusEl.textContent = (e && e.message) || tr('Не удалось активировать.');
            // INSTALL_KIND_V1 — «Код неверный» правда и, для того кто ставит
            // филиал кодом главной клиники, совершенно бесполезная правда: код
            // уже погашен на другой установке, и перевод той же строки не
            // поможет. Подсказка идёт ОТДЕЛЬНОЙ строкой, а не подмешивается в
            // ответ сервера — сервер отвечает за свои слова, мы за свои.
            // Тот же приём на вкладке филиала, но причина другая и она
            // единственная правдоподобная: ключ уже активировали на другой
            // машине. Код внутри ключа гасится при первом использовании —
            // сервер отвечает так же, как на выдуманный код, и различить их
            // может только человек, знающий, куда этот ключ уже вставляли.
            if (/неверн/i.test(String((e && e.message) || ''))) {
                statusEl.appendChild(h('div', { class: 'act-hint' }, tr(branch
                    ? 'Похоже, этим ключом уже активировали другую установку: код внутри ключа срабатывает один раз. Попросите главную клинику завести филиал заново и выдать новый ключ.'
                    : 'Ставите филиал? Переключитесь на «Филиал»: код главной клиники второй раз не подойдёт.')));
            }
            btn.disabled = false;
        }
    };

    const btn = h('button', {
        type: 'button', class: 'btn btn-primary act-cta',
        onclick: doEnroll,
    }, 'Активировать');

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault?.(); doEnroll(); } });

    return { input, btn, statusEl };
}
