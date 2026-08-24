// ROLES_EDITOR_V2 — Настройки → «Роли» (docs/plans/2026-08-24-lab-panels-and-roles.md,
// задача 2). Матрица доступа по ролям: для каждой штатной роли отмечаем, какие
// разделы она видит и что в них может делать. Одна строка на роль в
// `role_permissions` (permissions = JSON { sections:[navId],
// levels:{navId:'viewer'|'editor'|'admin'} }), которую при входе читают
// admin.js applyActorPermissions() и admin/permissions.js. Администратор всегда
// с полным доступом и здесь не редактируется — запереть себя нельзя.
//
// Экран управляет КЛИЕНТСКИМ интерфейсом (боковое меню и кнопки
// изменить/удалить); доступ к самим данным сервер проверяет отдельно по базовой
// роли (server/db/schema-registry.js). Об этом сказано прямо на экране: замок
// здесь не единственный.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ. Экран жил внутри settings-hub.js — файла, где уже
// лежат и сетка «Настроек», и универсальный редактор справочников. Правка
// прав задевала бы файл, который параллельно правят другие задачи, а в проекте
// конвенция — один файл на экран (88 файлов в views/). settings-hub.js теперь
// только монтирует этот экран и передаёт возврат назад.
//
// ЧТО БЫЛО СЛОМАНО В V1 (всё перечислено в плане, каждое проверено по коду):
//   1. Экран был на АНГЛИЙСКОМ внутри русского приложения. Теперь каждая
//      строка идёт через tr() и имеет запись ru/uz/en в i18n-strings.js.
//   2. У выпадающего списка уровня не было подписи. Теперь есть заголовок
//      колонки «Что можно делать» и aria-label на каждом списке.
//   3. Заблокированный список молчал о причине. Теперь рядом стоит строка
//      «Сначала отметьте раздел», и список ссылается на неё aria-describedby.
//   4. При ошибке загрузки экран показывал ПУСТУЮ матрицу — на экране прав это
//      читается как «у роли нет доступа», то есть опасная ложь. Теперь у
//      загрузки три честных состояния: загрузка, ошибка с кнопкой повтора,
//      данные. Пустая матрица рисуется только когда сервер действительно
//      ответил, и отдельная строка отличает «роль ещё не настроена» от «не
//      загрузилось».
//   5. Одна и та же кнопка «Сохранить» переносилась в карточку каждой роли.
//      Теперь кнопка создаётся вместе с карточкой, а на время запроса
//      блокируется вся форма (переключение ролей в том числе).
//   6. Переключение роли молча теряло отмеченные галочки. Теперь спрашиваем.
//   7. Инлайновые стили переехали в блок .roles-ed в public/css/admin-views.css
//      (тот же приём, что .tel-set у телефонии).

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast } from '../ui.js';
// h() прогоняет текстовые дети и placeholder/aria-label через tr() сам; всё,
// что собирается конкатенацией или ставится после отрисовки, зовёт tr() явно
// (тот же приём, что в telephony-settings.js и locked-module.js).
import { tr } from '../i18n.js';
import { NAV_MODULES } from '../permissions.js';   // ROLE_KEYS_V2 — единый список выдаваемых модулей

// ROLE_KEYS_V2 — матрица строится из permissions.js NAV_MODULES, того же
// списка, который читают сами ворота бокового меню. Когда-то это была вторая
// копия списка, и она разошлась: экран предлагал «Doctor's room» и писал ключ
// `doctor-room`, который никто не проверяет (кабинет закрыт ключом
// `consultation»), — отмеченная галочка не давала ничего.
const ROLE_MODULES = NAV_MODULES;

// Редактируемые штатные роли (админ всегда с полным доступом — отдельно).
const ROLE_LIST = [
    { key: 'registrar',  label: 'Регистратор' },
    { key: 'doctor',     label: 'Врач' },
    { key: 'cashier',    label: 'Кассир' },
    { key: 'lab',        label: 'Лаборант' },
    { key: 'nurse',      label: 'Медсестра' },
    { key: 'inventory',  label: 'Склад' },
    { key: 'callcenter', label: 'Колл-центр' },   // CALLCENTER_ROLE_V1
];

// Уровни названы тем, что человек МОЖЕТ ДЕЛАТЬ, а не системной ролью:
// «Viewer/Editor/Admin» ничего не говорит заведующей, которая заводит
// лаборанта. Ключи в базе не менялись — поменялись только слова на экране.
const ROLE_LEVELS = [
    ['viewer', 'Только просмотр'],
    ['editor', 'Просмотр и изменение'],
    ['admin',  'Изменение и удаление'],
];
const DEFAULT_LEVEL = 'editor';

const roleLabel = (key) => (ROLE_LIST.find(r => r.key === key) || { label: key }).label;

// window.confirm обёрнут: в тестовой фейковой DOM диалогов нет, и отсутствие
// диалога не должно молча означать «нет» (тот же приём, что в crm-settings.js).
// Вопрос — цельная строка из словаря: tr() ищет по исходной строке целиком,
// поэтому собранный конкатенацией вопрос перевода бы не нашёл.
function askDiscard() {
    const text = tr('Права этой роли изменены, но не сохранены. Перейти дальше? Изменения пропадут.');
    return (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm(text) : true;
}

// Снимок состояния галочек — по нему и только по нему решается «есть
// несохранённое». Сравниваем не с сырым ответом сервера, а с НОРМАЛИЗОВАННЫМ
// снимком того же вида: у роли, сохранённой до появления уровней, уровня в
// JSON нет, и наивное сравнение объявляло бы такую роль изменённой сразу
// после загрузки — предупреждение, которое всегда врёт, перестают читать.
function snapshot(sections, levels) {
    const keys = [...sections].sort();
    return JSON.stringify({ s: keys, l: keys.map(k => levels[k] || DEFAULT_LEVEL) });
}

export async function renderRolesEditor(container, { onBack } = {}) {
    // roles-ed — область действия стилей экрана (см. блок в admin-views.css).
    const root = h('div', { class: 'fade-in roles-ed' });
    const state = {
        selected: ROLE_LIST[0].key,
        controls: {},     // moduleKey -> { chk, level }
        baseline: null,   // снимок на момент загрузки; null = данных нет
        busy: false,      // идёт сохранение — форма и переключатель заперты
    };

    const roleBtns   = h('div', { class: 'segmented roles-tabs', role: 'group', 'aria-label': 'Выберите роль' });
    const matrixWrap = h('div');

    const backBtn = h('button', {
        class: 'btn btn-outline btn-sm roles-back', type: 'button',
        onclick: () => { if (guard()) onBack && onBack(); },
    }, Icon('ChevronLeft', { size: 14 }), ' ', 'Назад в настройки');
    root.appendChild(backBtn);

    root.appendChild(PageHead({
        title: 'Роли и права',
        subtitle: 'Кто что видит и может менять. У администратора всегда полный доступ.',
    }));

    root.appendChild(h('div', { class: 'card roles-note' },
        h('span', { class: 'roles-note-ico' }, Icon('Help', { size: 15 })),
        h('div', { class: 'muted roles-note-txt' },
            'Здесь вы выбираете, какие разделы видит сотрудник. Доступ к данным дополнительно проверяет сервер — это не единственный замок.'),
    ));

    root.appendChild(roleBtns);
    root.appendChild(matrixWrap);
    container.appendChild(root);

    for (const r of ROLE_LIST) {
        const b = h('button', { class: 'segmented-btn', type: 'button', onclick: () => selectRole(r.key) }, r.label);
        b.dataset.role = r.key;
        roleBtns.appendChild(b);
    }

    await selectRole(state.selected);
    return root;

    // -------------------------------------------------------------------------

    // Единственная точка, где решается «можно ли уйти». Ею закрыты и
    // переключение роли, и «Назад в настройки»: правило рекомендаций —
    // предупреждать перед УХОДОМ с несохранёнными изменениями, а не только
    // перед сменой вкладки.
    function guard() {
        if (state.busy) return false;
        if (!isDirty()) return true;
        return askDiscard();
    }

    function isDirty() {
        if (state.baseline == null) return false;   // ошибка/загрузка — терять нечего
        return current() !== state.baseline;
    }

    function current() {
        const sections = [];
        const levels = {};
        for (const [key, ctl] of Object.entries(state.controls)) {
            if (ctl.chk.checked) { sections.push(key); levels[key] = ctl.level.value || DEFAULT_LEVEL; }
        }
        return snapshot(sections, levels);
    }

    function paintActive() {
        for (const b of roleBtns.children) {
            const on = b.dataset.role === state.selected;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    async function selectRole(key) {
        if (key !== state.selected && !guard()) return;
        state.selected = key;
        state.baseline = null;
        state.controls = {};
        paintActive();

        clear(matrixWrap);
        // Строка загрузки заканчивается многоточием — правило рекомендаций и
        // единственный способ отличить «ещё грузится» от «пусто».
        matrixWrap.appendChild(h('div', { class: 'roles-state', role: 'status' }, 'Загрузка…'));

        let perms = null;   // null = не загрузилось; {} = сервер ответил
        let failure = null;
        try {
            const { data, error } = await supabase.from('role_permissions')
                .select('permissions').eq('role', key).maybeSingle();
            if (error) throw new Error(error.message || String(error));
            let p = data && data.permissions;
            if (typeof p === 'string') p = JSON.parse(p);
            perms = (p && Array.isArray(p.sections))
                ? { sections: p.sections, levels: p.levels || {}, configured: true }
                : { sections: [], levels: {}, configured: false };
        } catch (e) {
            failure = (e && e.message) || String(e);
        }
        if (key !== state.selected) return;   // пока грузили, переключились — ответ устарел
        if (failure) paintError(failure); else paintMatrix(perms);
    }

    // Экран прав НИКОГДА не показывает пустую матрицу вместо ошибки: пустая
    // матрица здесь читается как «у роли нет доступа» и толкает администратора
    // сохранить эту ложь поверх настоящих прав.
    function paintError(message) {
        clear(matrixWrap);
        matrixWrap.appendChild(h('div', { class: 'card roles-error', role: 'alert' },
            h('div', { class: 'roles-error-head' },
                h('span', { class: 'roles-error-ico' }, Icon('Warning', { size: 16 })),
                h('strong', null, 'Не удалось загрузить права роли.'),
            ),
            h('p', { class: 'roles-error-why' }, String(message || '')),
            h('p', { class: 'roles-error-next' },
                'Права не показаны — это не значит, что их нет. Повторите загрузку, прежде чем что-то сохранять.'),
            h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => selectRole(state.selected),
            }, Icon('Refresh', { size: 14 }), ' ', 'Повторить загрузку'),
        ));
    }

    function paintMatrix(perms) {
        clear(matrixWrap);
        state.controls = {};
        const granted = new Set(perms.sections || []);
        const levels  = perms.levels || {};

        // Кнопка создаётся ВМЕСТЕ с карточкой. В V1 существовал один узел
        // saveBtn, который переносился в карточку каждой роли: он оставался
        // жив после clear() и уносил с собой состояние прошлого рендера.
        const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Сохранить роль');
        saveBtn.addEventListener('click', () => save(saveBtn));

        const card = h('div', { class: 'card roles-card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Shield', { size: 16 }), ' ', 'Разделы и уровень доступа', ' · ', roleLabel(state.selected)),
                saveBtn,
            ),
        );

        if (!perms.configured) {
            card.appendChild(h('p', { class: 'roles-unset' },
                'У этой роли ещё нет сохранённых настроек. Отметьте разделы и сохраните.'));
        }

        for (const grp of ROLE_MODULES) {
            // Заголовок группы несёт подпись колонки уровня: одна видимая
            // подпись на группу вместо двадцати повторов над каждым списком.
            card.appendChild(h('div', { class: 'roles-group' },
                h('span', { class: 'roles-group-name' }, grp.group),
                h('span', { class: 'roles-group-lvl' }, 'Что можно делать'),
            ));
            for (const it of grp.items) card.appendChild(moduleRow(it, granted, levels));
        }

        matrixWrap.appendChild(card);
        state.baseline = current();
    }

    function moduleRow(it, granted, levels) {
        const chk = h('input', { type: 'checkbox', checked: granted.has(it.key) });
        const lvl = h('select', { class: 'roles-lvl' },
            ...ROLE_LEVELS.map(([v, l]) => h('option', { value: v, selected: (levels[it.key] || DEFAULT_LEVEL) === v }, l)));
        // Подпись у списка своя, с названием раздела: двадцать одинаковых
        // «Уровень доступа» подряд в скринридере неразличимы. Собирается
        // конкатенацией, поэтому tr() зовём сами.
        lvl.setAttribute('aria-label', tr('Уровень доступа') + ': ' + tr(it.label));

        const whyId = 'roles-why-' + it.key;
        const why = h('span', { class: 'roles-why', id: whyId }, 'Сначала отметьте раздел');
        lvl.setAttribute('aria-describedby', whyId);

        const sync = () => {
            lvl.disabled = !chk.checked;
            // Причина блокировки видима, а не только «клик не работает».
            why.className = chk.checked ? 'roles-why is-hidden' : 'roles-why';
        };
        sync();
        chk.addEventListener('change', sync);
        state.controls[it.key] = { chk, level: lvl };

        return h('div', { class: 'roles-row' },
            // Галочка и её подпись — одна общая мишень: попасть можно и по
            // названию раздела, и по описанию.
            h('label', { class: 'roles-pick' },
                chk,
                h('span', { class: 'roles-pick-txt' },
                    h('span', { class: 'roles-mod' }, it.label),
                    it.desc ? h('span', { class: 'roles-desc' }, it.desc) : null,
                ),
            ),
            h('div', { class: 'roles-lvl-cell' }, lvl, why),
        );
    }

    async function save(saveBtn) {
        if (state.busy) return;
        const sections = [];
        const levels = {};
        for (const [key, ctl] of Object.entries(state.controls)) {
            if (ctl.chk.checked) { sections.push(key); levels[key] = ctl.level.value || DEFAULT_LEVEL; }
        }
        const permissions = JSON.stringify({ sections, levels });
        const role = state.selected;

        // Кнопка остаётся активной ДО начала запроса и запирается на время
        // него: без этого двойной клик записывал права дважды.
        setBusy(true, saveBtn);
        try {
            const { error } = await supabase.from('role_permissions')
                .update({ permissions }).eq('role', role).select().single();
            if (error) throw new Error(error.message || String(error));
            state.baseline = snapshot(sections, levels);
            toast(tr('Права сохранены — сотрудники увидят их при следующем входе.') + ' · ' + tr(roleLabel(role)), 'ok');
        } catch (e) {
            // В сообщении есть следующий шаг, а не только беда.
            toast(tr('Не удалось сохранить права. Проверьте связь с сервером и повторите.') + ' ' + ((e && e.message) || ''), 'fail');
        } finally {
            setBusy(false, saveBtn);
        }
    }

    function setBusy(on, saveBtn) {
        state.busy = on;
        saveBtn.disabled = on;
        saveBtn.textContent = on ? tr('Сохранение…') : tr('Сохранить роль');
        // Переключатель ролей и выход тоже заперты: уйти в середине записи
        // значит не узнать, чем она кончилась. Кнопки именно ГАСНУТ, а не
        // молча перестают работать — иначе экран выглядит зависшим.
        for (const b of roleBtns.children) b.disabled = on;
        backBtn.disabled = on;
        // И сами галочки: отмеченное во время запроса не попало бы в него, но
        // попало бы в новый снимок «сохранено» — экран считал бы себя чистым,
        // а на сервере этой галочки не было бы.
        for (const ctl of Object.values(state.controls)) {
            ctl.chk.disabled = on;
            // Уровень запирается и по своему обычному правилу — «раздел не отмечен».
            ctl.level.disabled = on || !ctl.chk.checked;
        }
        matrixWrap.setAttribute('aria-busy', on ? 'true' : 'false');
    }
}
