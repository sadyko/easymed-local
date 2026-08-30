// BRANCH_SYNC_V1 — карточка «Синхронизация филиалов» на экране
// «Настройки → Филиалы» (settings-hub.js монтирует её над списком филиалов).
//
// Почему именно здесь, а не отдельным разделом: в этой системе «филиал» уже
// означает две разные вещи — строку в таблице branches (адрес внутри одной
// установки) и ОТДЕЛЬНУЮ установку Easy-Med в другом здании. Развести их по
// двум пунктам меню значило бы повторить ту самую путаницу «две плитки со
// словом компания», которую владелец просил убрать 2026-08-29. Список филиалов
// и связь между установками стоят на одном экране, друг под другом.
//
// Все решения о ТЕКСТЕ вынесены в ../branch-sync-logic.js и проверены тестом;
// здесь только рисование и вызовы RPC. Кнопок у не-администратора нет вовсе —
// вежливость, а не защита: каждый RPC заново проверяет роль на сервере.
//
// -------------------------------------------------------------------------
// BRANCH_LIST_V2 (2026-08-30) — СПИСОК ВМЕСТО СОЧИНЕНИЯ.
//
// Дословно от владельца: «can we remove the unnecessary information and make
// clear list of main branch, and and the list of branches keys etc, all the
// sloppy text that no one will read is unnecessary». Под каждым элементом
// управления стоял абзац; на экране главного филиала их набиралось около
// пятнадцати строк вокруг шести кнопок.
//
// ЧТО СТАЛО:
//   • филиалы — ТАБЛИЦА (имя · буква · ключ · действие), а не колода карточек
//     с объяснением под каждой. Видно все филиалы разом, а не два на экран;
//   • главный филиал — та же строка, но помеченная «Эта установка» и без
//     ключа: подключать установку к самой себе не к чему;
//   • «Добавить филиал» — поле и кнопка. Больше ничего;
//   • переключатель резервного канала, перевыпуск ключа и отвязка — подпись и
//     управление в одну строку;
//   • всё необратимое — в окне подтверждения, где принимается решение.
//
// ПОЧЕМУ ТАБЛИЦА, ХОТЯ ПРЕЖНИЙ КОММЕНТАРИЙ В CSS ЗАПРЕЩАЛ ЕЁ. Запрет был про
// то, что длинный ключ в узкой ячейке «копируется обрезанным». Это верно для
// текста, но не для поля ввода: <input readonly> прокручивается внутри ячейки,
// select() выделяет ЗНАЧЕНИЕ ЦЕЛИКОМ независимо от ширины, а кнопка копирует
// box.value, а не то, что видно. Обрезать нечего — а взамен видно весь список.

import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, field, checkField } from '../ui.js';
import { tr } from '../i18n.js';
import { fill } from '../updates-logic.js';
import { DASH } from '../system-logic.js';
import { isAdminActor } from '../admin-actor.js';
import {
    roleBadge, roleExplainer, syncLine, whenLabel, canSyncNow, addressValue,
    syncKeyLine, relayExplainer, publishLine, canRegenerateKey, KEY_LOSS_WARNING,
    branchRows, branchListNote, KEY_REISSUE_WARNING, KEY_REISSUE_QUESTION,
    LETTER_PERMANENCE_WARNING, ADD_BRANCH_QUESTION, ISSUE_KEY_QUESTION,
    UNLINK_WARNING_MAIN, UNLINK_WARNING_SECONDARY, UNLINK_QUESTION,
    UNLINKED_BRANCH_NOTE, pairedMessage, letterExplainer, becomeMainState,
    IDENTITY_UNKNOWN_NOTE,
} from '../branch-sync-logic.js';

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    // tr() ЗДЕСЬ, а не на экране: .message уходит прямо в textContent строки
    // состояния, минуя h() и его автоперевод. Сообщение самого сервера через
    // словарь экрана не проходит — известная дыра шире этого файла.
    if (error) throw new Error(error.message || tr('Не удалось выполнить действие.'));
    return data;
}

/**
 * Готовая фраза из {template, params}: СНАЧАЛА перевод, ПОТОМ подстановка.
 *
 * Порядок здесь — весь смысл. tr() ищет в словаре строку целиком, поэтому
 * дырка {date} должна быть ещё на месте, когда фразу ищут: подставив дату
 * раньше, мы получили бы строку, которой в словаре нет и быть не может. Ровно
 * так «Ключ синхронизации есть. Создан 12.08.2026.» и оставалась русской на
 * узбекском экране.
 */
function say(line) {
    return line ? fill(tr(line.template), line.params) : '';
}

/**
 * Окно подтверждения: предупреждение, пустая строка, вопрос.
 *
 * window.confirm НЕ прогоняет текст через tr() сам — в отличие от h(), который
 * делает это с каждым текстовым узлом. Без явного tr() эти окна остались бы
 * по-русски в узбекской клинике, а это единственное место, где теперь живут
 * все предупреждения экрана.
 */
function confirmAction(warning, question, params = null) {
    const q = params ? fill(tr(question), params) : tr(question);
    return window.confirm(`${tr(warning)}\n\n${q}`);
}

export async function renderBranchSyncCard(container) {
    const card = h('div', { class: 'card upd-card sys-card bsync-card' });
    container.appendChild(card);
    await paint(card);
    return card;
}

async function paint(card) {
    clear(card);
    card.appendChild(h('div', { class: 'sys-card-head' }, Icon('Building', { size: 16 }),
        h('span', null, 'Синхронизация филиалов')));

    let status;
    try {
        status = await rpc('branch_sync_status');
    } catch (e) {
        // Честное пустое состояние вместо молчаливо пустой карточки: экран,
        // который не смог узнать своё состояние, обязан это сказать.
        card.appendChild(h('p', { class: 'upd-error' },
            'Не удалось прочитать состояние связи филиалов. Обновите страницу.'));
        return;
    }

    const admin = isAdminActor();
    const badge = roleBadge(status);
    // Роль и то, что она значит, — ОДНОЙ СТРОКОЙ: метка и короткая подпись
    // рядом, а не метка и абзац под ней.
    card.appendChild(h('div', { class: 'sys-info' },
        h('span', { class: 'sys-info-label' }, 'Роль этой установки'),
        h('span', { class: 'sys-info-value bsync-role' },
            Tag(badge.label, { kind: badge.kind }),
            h('span', { class: 'muted bsync-note' }, roleExplainer(status))),
    ));

    if (status.role === 'main') paintMain(card, status, admin);
    else if (status.role === 'secondary') paintSecondary(card, status, admin);
    else paintUnlinked(card, status, admin);
}

// --- ещё не связаны --------------------------------------------------------
function paintUnlinked(card, status, admin) {
    if (!admin) {
        card.appendChild(h('p', { class: 'muted bsync-note' },
            'Связать филиалы может только администратор клиники.'));
        return;
    }

    // ОТВЯЗАННЫЙ ФИЛИАЛ — не то же самое, что новая установка, и экран обязан
    // это различать. «Отвязать» стирает файл пары и НЕ трогает принятую букву:
    // она уже напечатана на карточках. Поэтому здесь стоит установка, которая
    // выглядит несвязанной и при этом навсегда остаётся филиалом C — и кнопка
    // «Сделать главным филиалом» ей откажет (rpc identity_is_branch), сколько бы
    // раз её ни нажали. Вместо кнопки здесь объяснение, а самой кнопки ниже нет.
    const mainState = becomeMainState(status);
    if (mainState === 'branch') {
        const letters = letterExplainer(status);
        card.appendChild(h('div', { class: 'bsync-block' },
            h('div', { class: 'sys-block-title' }, 'Эта установка — филиал'),
            h('div', { class: 'sys-info' },
                h('span', { class: 'sys-info-label' }, 'Этот филиал'),
                h('span', { class: 'sys-info-value bsync-role' },
                    status.letter ? Tag(status.letter, { kind: 'info' }) : DASH,
                    letters ? h('span', { class: 'muted bsync-note' }, say(letters)) : null),
            ),
            h('p', { class: 'muted bsync-note' }, UNLINKED_BRANCH_NOTE),
        ));
    }

    // ...и установка, которая свою служебную запись прочитать не смогла. Буквы
    // она тоже не раздаёт — сервер отказывает кодом identity_missing, — но
    // лечится это не ключом подключения, а восстановлением базы, поэтому
    // состояние отдельное и фраза своя. Блок «подключиться к главному» ниже
    // остаётся: ключ БЕЗ буквы базу не трогает и связывает как прежде, так что
    // мёртвой кнопкой он здесь не становится.
    //
    // upd-error, а не muted: это единственное состояние экрана, где сломана
    // регистратура, и выглядеть оно обязано как поломка, а не как сноска.
    if (mainState === 'unknown') {
        card.appendChild(h('div', { class: 'bsync-block' },
            h('div', { class: 'sys-block-title' }, 'Установка не знает своего филиала'),
            h('p', { class: 'upd-error bsync-note' }, IDENTITY_UNKNOWN_NOTE),
        ));
    }

    // БЛОК «ЭТОТ ФИЛИАЛ — ГЛАВНЫЙ» РИСУЕТСЯ ТОЛЬКО ТАМ, ГДЕ ОН СРАБОТАЕТ. Оба
    // состояния выше — это установка, которой branch_sync_make_key откажет
    // всегда, а кнопка, которую показали и которая всегда отказывает, хуже
    // отсутствующей: владелец нажимает, читает отказ и идёт искать свою ошибку
    // там, где её нет.
    //
    // ЦЕЛИКОМ, А НЕ ОДНОЙ КНОПКОЙ: поле «Адрес этого компьютера» существует
    // ровно ради неё и без неё предлагает заполнить то, что никуда не поедет.
    if (mainState === 'allowed') paintMakeMain(card, status);

    const keyInput = h('textarea', {
        rows: '3', placeholder: 'EMB2-…', class: 'bsync-key bsync-key-in',
        spellcheck: 'false', translate: 'no', 'aria-label': 'Ключ подключения',
    });
    const pairBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Подключить к главному');
    const pairStatus = h('p', { class: 'upd-action-status', role: 'status' });
    // НЕ через run(): тот говорит заготовленное «Готово», а здесь подтвердить надо
    // БУКВОЙ. Владелец только что ввёл длинный ключ, выпущенный на другой машине, и
    // буква — единственное, что он может сверить глазами (branchSyncPair её для
    // этого и возвращает).
    pairBtn.addEventListener('click', async () => {
        if (pairBtn.disabled) return;
        pairBtn.disabled = true;
        pairStatus.textContent = '';
        try {
            const data = await rpc('branch_sync_pair', { key: keyInput.value });
            // Обе половины через tr() по отдельности: tr() ищет в словаре строку
            // целиком, поэтому склеенная с буквой фраза не переводится нигде.
            const done = pairedMessage(data);
            toast(done.letter ? `${tr(done.base)}. ${tr('Этот филиал')} — ${done.letter}` : tr(done.base), 'ok');
            await paint(card);
        } catch (e) {
            pairBtn.disabled = false;
            pairStatus.textContent = e.message;
        }
    });

    card.appendChild(h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Этот филиал подключается к главному'),
        h('p', { class: 'muted bsync-note' },
            'Вставьте ключ подключения, выданный на главном филиале.'),
        field('Ключ подключения', keyInput),
        h('div', { class: 'bsync-actions' }, pairBtn, pairStatus),
    ));
}

// «Сделать главным филиалом» — блок целиком, потому что и показывают его
// целиком или никак: поле адреса без кнопки нечего заполнять.
function paintMakeMain(card, status) {
    const urlInput = h('input', {
        type: 'text', value: addressValue(status), placeholder: '10.0.0.5:8000',
        autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Адрес этого компьютера',
    });
    const mainBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Сделать главным филиалом');
    const mainStatus = h('p', { class: 'upd-action-status', role: 'status' });
    mainBtn.addEventListener('click', () => run(mainBtn, mainStatus, card,
        () => rpc('branch_sync_make_key', { url: urlInput.value }), 'Филиал назначен главным'));

    card.appendChild(h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Этот филиал — главный'),
        h('p', { class: 'muted bsync-note' },
            'Справочник будет раздаваться отсюда. Укажите адрес, по которому этот компьютер виден остальным филиалам.'),
        field('Адрес этого компьютера', urlInput),
        h('div', { class: 'bsync-actions' }, mainBtn, mainStatus),
    ));
}

// --- главный филиал --------------------------------------------------------
function paintMain(card, status, admin) {
    card.appendChild(h('div', { class: 'sys-info' },
        h('span', { class: 'sys-info-label' }, 'Адрес для филиалов'),
        h('span', { class: 'sys-info-value' }, status.main_url || DASH),
        h('span', { class: 'sys-info-label' }, 'Группа филиалов'),
        h('span', { class: 'sys-info-value' }, status.group_id || DASH),
    ));
    if (!admin) return;

    paintBranchList(card);
    paintRelay(card, status, admin);
    paintSyncKey(card, status, admin);
    card.appendChild(unlinkBlock(card, UNLINK_WARNING_MAIN));
}

// --- список филиалов и их ПОСТОЯННЫЕ ключи (BRANCH_IDENTITY_V1) ------------
//
// Требование владельца дословно: «in the branch list should be only the branch
// name. and activation key (not one time generated)». Ключ выдаётся СТРОКЕ
// списка — то есть всегда вместе с буквой филиала. Ключ без буквы подключил бы
// филиал, который остался бы при букве A и начал печатать A-номера рядом с
// главным филиалом, печатающим свои: ровно та коллизия, ради которой буква и
// заведена (см. server/services/branch-sync/identity.js).
//
// Список грузится ОТДЕЛЬНЫМ вызовом и после отрисовки: он несёт ключи, поэтому
// закрыт ролью, тогда как branch_sync_status читают все, кому открыты
// настройки. Карточка не должна ждать его, чтобы показать роль установки.
function paintBranchList(card) {
    const tbody = h('tbody');
    const table = h('table', { class: 'tbl bsync-tbl' },
        // scope="col" — без него программа чтения не связывает клетку с её
        // колонкой, и «EMB2-…» читается без слова «ключ».
        h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, 'Филиал'),
            h('th', { scope: 'col', class: 'bsync-th-letter' }, 'Буква'),
            h('th', { scope: 'col' }, 'Ключ подключения'),
            h('th', { scope: 'col', class: 'bsync-th-act' }, 'Действие'))),
        tbody);
    // overflow-x на обёртке, а не на карточке: четыре колонки с ключом внутри
    // на узком экране должны прокручиваться сами, а не растягивать страницу.
    const listEl = h('div', { class: 'bsync-tblwrap' }, table);
    // Строка состояния ЖИВЁТ ВНЕ таблицы: она рассказывает про последнее действие
    // (например, что резервный канал этому филиалу выписать не удалось), а
    // таблица перерисовывается после каждого действия и стёрла бы её собой.
    const actionStatus = h('p', { class: 'upd-action-status', role: 'status' });

    // aria-label ПРИ ВИДИМОЙ ПОДПИСИ: ui.js field() рисует <label> соседом, без
    // for, поэтому программно они не связаны и поле остаётся безымянным.
    const nameInput = h('input', {
        type: 'text', placeholder: 'Чиланзар', autocomplete: 'off',
        'aria-label': 'Название филиала',
    });
    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' },
        Icon('Plus', { size: 14 }), ' ', 'Добавить филиал');

    fillRow(tbody, h('span', { class: 'muted' }, 'Загружаем список филиалов…'));

    card.appendChild(h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Филиалы клиники'),
        listEl,
        // ПОЛЕ И КНОПКА, И БОЛЬШЕ НИЧЕГО. Три строки про несменяемость буквы
        // стояли здесь, под названием филиала, — то есть тогда, когда решение
        // ещё не принято: имя набирают и правят, а букву тратит нажатие.
        // Теперь фраза встречает нажатие, в окне подтверждения.
        h('div', { class: 'bsync-add' },
            field('Название филиала', nameInput),
            addBtn),
        actionStatus,
    ));

    addBtn.addEventListener('click', async () => {
        if (addBtn.disabled) return;
        const name = nameInput.value.trim();
        // Пустое имя НЕ спрашиваем: отказ выдаёт сервер, теми же словами, что и
        // раньше. Окно «Добавить филиал «»?» было бы вопросом ни о чём.
        if (name && !confirmAction(LETTER_PERMANENCE_WARNING, ADD_BRANCH_QUESTION, { name })) return;
        addBtn.disabled = true;
        actionStatus.textContent = '';
        try {
            const data = await rpc('branch_sync_add_branch', { name: nameInput.value });
            nameInput.value = '';
            toast(tr('Филиал добавлен'), 'ok');
            // Резервный канал мог не выписаться (нет интернета, клиника не
            // активирована) — филиал при этом заведён и по прямой связи работает.
            // Это СОСТОЯНИЕ, а не отказ, поэтому оно идёт строкой, а не красным
            // тостом поверх удачного действия.
            noteRelay(actionStatus, data);
            await reload();
        } catch (e) {
            actionStatus.textContent = e.message;
        }
        addBtn.disabled = false;
    });

    // Не await: карточка уже нарисована, и список догружается в неё сам —
    // ровно так же, как settings-hub.js догружает саму карточку.
    reload();

    async function reload() {
        let data;
        try {
            data = await rpc('branch_sync_branches');
        } catch (e) {
            fillRow(tbody, h('span', { class: 'upd-error' },
                'Не удалось прочитать список филиалов. Обновите страницу.'));
            return;
        }
        // Роль могла смениться в другой вкладке между отрисовкой карточки и
        // загрузкой списка: ключи показывает только главный филиал.
        const note = branchListNote(data);
        if (note) { fillRow(tbody, h('span', { class: 'muted' }, note)); return; }
        const rows = branchRows(data);
        if (!rows.length) { fillRow(tbody, h('span', { class: 'muted' }, 'Филиалов пока нет.')); return; }
        clear(tbody);
        for (const row of rows) tbody.appendChild(branchTr(row));
    }

    /** Одна ячейка во всю ширину — загрузка, пустота и отказ выглядят одинаково ровно. */
    function fillRow(body, node) {
        clear(body);
        body.appendChild(h('tr', null, h('td', { colspan: '4' }, node)));
    }

    function branchTr(row) {
        const nameCell = h('td', null,
            h('span', { class: 'bsync-branch-name' }, row.name),
            // ГЛАВНЫЙ ФИЛИАЛ ОТМЕЧЕН, А НЕ ОБЪЯСНЁН: метка рядом с именем
            // вместо предложения «это и есть эта установка» под строкой.
            row.selfTag ? Tag(row.selfTag) : null);

        // Буква — Tag, а не текст: её ищут глазами среди имён, и она же
        // стоит первым символом каждого номера пациента этого здания.
        const letterCell = h('td', null, Tag(row.letterLabel, { kind: row.letter ? 'info' : '' }));

        // ЧЕСТНОЕ СОСТОЯНИЕ ВМЕСТО ПУСТОЙ КЛЕТКИ: пустое поле на месте ключа
        // читается как «не загрузилось», а у каждого случая здесь есть точный
        // ответ (branch-sync-logic.js branchRows) — теперь в пару слов.
        const keyCell = h('td', { class: 'bsync-td-key' }, row.key
            ? keyBox(row.key, row.name)
            : h('span', { class: 'muted' }, row.keyStatus || DASH));

        const actCell = h('td', { class: 'bsync-td-act' },
            row.warnTag ? Tag(row.warnTag, { kind: 'warn' }) : null,
            row.action ? actionBtn(row) : null);

        return h('tr', { class: row.state === 'self' ? 'bsync-tr-self' : null },
            nameCell, letterCell, keyCell, actCell);
    }

    /**
     * Кнопка строки. ОДИН вызов на два состояния: branch_sync_branch_key выдаёт
     * букву, если её нет, и выписывает учётку резервного канала, если её нет.
     * Спрашиваем только там, где нажатие ТРАТИТ БУКВУ безвозвратно — учётку
     * можно выписывать сколько угодно раз, и окно на неё приучало бы закрывать
     * окна не читая.
     */
    function actionBtn(row) {
        const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, row.action.label);
        btn.addEventListener('click', async () => {
            if (btn.disabled) return;
            if (row.action.confirmLetter
                && !confirmAction(LETTER_PERMANENCE_WARNING, ISSUE_KEY_QUESTION, { name: row.name })) return;
            btn.disabled = true;
            actionStatus.textContent = '';
            try {
                const data = await rpc('branch_sync_branch_key', { branch_id: row.id });
                toast(tr(row.action.done), 'ok');
                noteRelay(actionStatus, data);
                await reload();
                return;   // строка перерисована — кнопки больше нет
            } catch (e) {
                actionStatus.textContent = e.message;
            }
            btn.disabled = false;
        });
        return btn;
    }
}

/** Резервный канал филиалу выписать не удалось — сказать это, но не пугать. */
function noteRelay(statusEl, data) {
    const relay = data && data.relay;
    statusEl.textContent = relay && relay.ok === false && relay.message ? relay.message : '';
}

/**
 * Ключ целиком, выделяемый, с кнопкой «Копировать». Никаких «показать один раз».
 *
 * <input>, А НЕ <textarea> В ТРИ СТРОКИ, и это то, что превратило колоду
 * карточек в таблицу. Ключ прокручивается внутри ячейки, но копируется ВСЕГДА
 * ЦЕЛИКОМ: кнопка берёт box.value, а не видимый кусок, и select() выделяет всё
 * значение независимо от ширины поля. Обрезать нечего.
 */
function keyBox(key, branchName) {
    // aria-label С ИМЕНЕМ ФИЛИАЛА: подписью служит имя в соседней ячейке, но
    // программе чтения с экрана нужно имя у самого поля, и «Ключ подключения»
    // пять раз подряд в списке из пяти филиалов не различает ничего.
    // fill() ПОСЛЕ tr(): h() прогоняет aria-label через tr() ещё раз, а уже
    // подставленная строка в словаре не найдётся и пройдёт насквозь.
    const box = h('input', {
        type: 'text', readonly: 'readonly', class: 'bsync-key',
        spellcheck: 'false', translate: 'no',
        'aria-label': fill(tr('Ключ подключения филиала {name}'), { name: branchName }),
    });
    box.value = key;
    // Клик по полю выделяет ключ целиком — так его забирают руками, когда
    // буфер обмена недоступен (нет https, отказано в правах).
    box.addEventListener('focus', () => { box.select?.(); });
    // Без значка: в icons.js нет ничего, что читалось бы как «копировать», а
    // подставить похожий (лист, слои) значит подписать кнопку неправдой. Слово
    // здесь короче любого объяснения.
    const copyBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Копировать');
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(box.value);
            // Тостом, а не строкой под каждой кнопкой: строк было бы столько
            // же, сколько филиалов, и все пустые.
            toast(tr('Ключ скопирован'), 'ok');
        } catch {
            box.select?.();
            toast(tr('Скопируйте выделенный ключ'), 'info');
        }
    });
    return h('div', { class: 'bsync-keyrow' }, box, copyBtn);
}

// --- резервный канал через сервер Easy-Med (BRANCH_SYNC_RELAY_V1) ----------
//
// Один блок на обе роли, потому что переключатель один; отличается то, на что
// владелец соглашается — главный филиал ОТДАЁТ копию наружу, подключённый
// только берёт уже лежащую. Тексты разведены в relayExplainer().
function paintRelay(card, status, admin) {
    const box = h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Резервный канал через сервер Easy-Med'));

    if (!status.relay_ready) {
        // Честное «недоступно» вместо переключателя, который ничего не делает.
        box.appendChild(h('p', { class: 'muted bsync-note' }, say(syncKeyLine(status))));
        card.appendChild(box);
        return;
    }

    if (!admin) {
        box.appendChild(h('p', { class: 'muted bsync-note' },
            status.relay_enabled ? 'Резервный канал включён.' : 'Резервный канал выключен.'));
        card.appendChild(box);
        return;
    }

    const toggle = h('input', {
        type: 'checkbox',
        'aria-label': 'Использовать сервер Easy-Med, когда прямая связь недоступна',
    });
    toggle.checked = !!status.relay_enabled;
    const toggleStatus = h('p', { class: 'upd-action-status', role: 'status' });
    toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        toggleStatus.textContent = '';
        try {
            await rpc('branch_sync_relay_set', { enabled: toggle.checked });
            await paint(card);
            return;
        } catch (e) {
            // Возврат галочки на место: экран не должен показывать включённым
            // то, что сервер не принял.
            toggle.checked = !toggle.checked;
            toggleStatus.textContent = e.message;
        }
        toggle.disabled = false;
    });
    box.appendChild(checkField('Использовать сервер Easy-Med, когда прямая связь недоступна', toggle));
    // Одна строка под переключателем вместо трёх над ним. Что он делает,
    // написано на нём самом; здесь — только то, чего на нём нет.
    box.appendChild(h('p', { class: 'muted bsync-note bsync-hint' }, relayExplainer(status)));

    // Кнопка и строка о последней выгрузке — В ОДНУ СТРОКУ, а не абзацем над
    // кнопкой: это одно и то же дело, «когда отправлялось» и «отправить».
    const line = publishLine(status);
    if (status.role === 'main' && status.relay_enabled) {
        const pubBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Отправить копию сейчас');
        const pubStatus = h('p', { class: 'upd-action-status', role: 'status' });
        pubBtn.addEventListener('click', async () => {
            pubBtn.disabled = true;
            pubStatus.textContent = tr('Отправляем копию на сервер…');
            try {
                const data = await rpc('branch_sync_relay_publish');
                // ok:false здесь не исключение: отсутствие интернета для этой
                // клиники норма, и звучать оно должно как состояние.
                toast(data && data.ok ? tr('Копия отправлена') : (data && data.message) || tr('Не удалось отправить копию'),
                    data && data.ok ? 'ok' : 'fail');
            } catch (e) {
                toast(e.message, 'fail');
            }
            await paint(card);
        });
        box.appendChild(h('div', { class: 'bsync-actions' },
            pubBtn,
            line ? h('span', { class: 'muted bsync-note' }, say(line)) : null,
            pubStatus));
    } else if (line) {
        box.appendChild(h('p', { class: 'muted bsync-note' }, say(line)));
    }

    // KEY_LOSS_WARNING ЗДЕСЬ БОЛЬШЕ НЕТ. Он стоял абзацем под этим блоком на
    // каждой отрисовке и переехал в окно подтверждения перевыпуска — туда, где
    // ключ и теряют нарочно (см. paintSyncKey).
    card.appendChild(box);
}

// --- ключ синхронизации и его перевыпуск -----------------------------------
function paintSyncKey(card, status, admin) {
    if (!canRegenerateKey(status, admin)) return;

    const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Перевыпустить ключ синхронизации');
    const btnStatus = h('p', { class: 'upd-action-status', role: 'status' });
    btn.addEventListener('click', async () => {
        // ОБА ПРЕДУПРЕЖДЕНИЯ ЗДЕСЬ, И ТОЛЬКО ЗДЕСЬ: перевыпуск рвёт связь со
        // всеми филиалами, и восстановить старый ключ не может никто, включая
        // Easy-Med. Раньше первое дублировалось абзацем на экране, а второе
        // стояло абзацем под резервным каналом; разойдясь, они рассказывали бы
        // разное об одном действии.
        if (!window.confirm(
            `${tr(KEY_REISSUE_WARNING)}\n\n${tr(KEY_LOSS_WARNING)}\n\n${tr(KEY_REISSUE_QUESTION)}`)) return;
        btn.disabled = true;
        btnStatus.textContent = '';
        try {
            await rpc('branch_sync_regenerate_key');
            toast(tr('Ключ синхронизации перевыпущен'), 'ok');
            await paint(card);
        } catch (e) {
            btn.disabled = false;
            btnStatus.textContent = e.message;
        }
    });

    card.appendChild(h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Ключ синхронизации'),
        h('div', { class: 'bsync-actions' },
            h('span', { class: 'muted bsync-note' }, say(syncKeyLine(status))),
            btn, btnStatus),
    ));
}

// --- подключённый филиал ---------------------------------------------------
function paintSecondary(card, status, admin) {
    const line = syncLine(status, tr);
    const letters = letterExplainer(status);
    card.appendChild(h('div', { class: 'sys-info' },
        // БУКВА ПЕРВОЙ, и она стоит здесь ПОСТОЯННО, а не всплывает
        // уведомлением после подключения: вопрос «что за буква в номере»
        // задаёт регистратура спустя месяцы после того, как тост погас.
        // Пример номера — рядом с ней, в той же ячейке: отдельным абзацем под
        // таблицей он был ещё одной строкой, которую пролистывают.
        h('span', { class: 'sys-info-label' }, 'Этот филиал'),
        h('span', { class: 'sys-info-value bsync-role' },
            status.letter ? Tag(status.letter, { kind: 'info' }) : DASH,
            letters ? h('span', { class: 'muted bsync-note' }, say(letters)) : null),
        h('span', { class: 'sys-info-label' }, 'Главный филиал'),
        h('span', { class: 'sys-info-value' }, status.main_url || DASH),
        h('span', { class: 'sys-info-label' }, 'Группа филиалов'),
        h('span', { class: 'sys-info-value' }, status.group_id || DASH),
        h('span', { class: 'sys-info-label' }, 'Подключён'),
        h('span', { class: 'sys-info-value' }, whenLabel(status.paired_at)),
    ));

    card.appendChild(h('p', {
        class: line.tone === 'warn' ? 'bsync-line bsync-line-warn' : 'bsync-line',
        role: 'status',
    },
    Icon(line.tone === 'warn' ? 'Warning' : (line.tone === 'ok' ? 'Check' : 'Clock'), { size: 14 }),
    ' ', say(line)));

    if (!admin) {
        card.appendChild(h('p', { class: 'muted bsync-note' },
            'Запускать синхронизацию может только администратор клиники.'));
        return;
    }

    const syncBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' },
        Icon('Refresh', { size: 14 }), ' ', 'Синхронизировать сейчас');
    const syncStatus = h('p', { class: 'upd-action-status', role: 'status' });
    syncBtn.disabled = !canSyncNow(status, admin);
    syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        syncStatus.textContent = tr('Связываемся с главным филиалом…');
        try {
            const data = await rpc('branch_sync_now');
            // ok:false здесь — НЕ исключение: недоступный главный филиал это
            // норма. Текст берётся тот же, что уйдёт в журнал попыток, чтобы
            // кнопка и строка состояния не рассказывали разное.
            toast(data && data.ok ? tr('Справочник обновлён') : (data && data.message) || tr('Не удалось синхронизироваться'),
                data && data.ok ? 'ok' : 'fail');
        } catch (e) {
            toast(e.message, 'fail');
        }
        await paint(card);
    });

    // Абзаца «Синхронизация переносит только справочник: …» здесь больше нет:
    // он дословно повторял подпись под ролью установки («Пациенты, визиты и
    // деньги остаются здесь»), стоявшую двумя блоками выше на том же экране.
    card.appendChild(h('div', { class: 'bsync-actions' }, syncBtn, syncStatus));
    paintRelay(card, status, admin);
    card.appendChild(unlinkBlock(card, UNLINK_WARNING_SECONDARY));
}

/**
 * Отвязка: подпись и кнопка, а последствие — в окне.
 *
 * Отвязка была единственным необратимым действием этого экрана БЕЗ вопроса
 * перед ним: последствие стояло абзацем рядом с кнопкой, то есть там, где его
 * пролистывают. Теперь оно там, где его надо прочитать.
 */
function unlinkBlock(card, warning) {
    const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Отвязать');
    const status = h('p', { class: 'upd-action-status', role: 'status' });
    btn.addEventListener('click', () => {
        if (!confirmAction(warning, UNLINK_QUESTION)) return;
        run(btn, status, card, () => rpc('branch_sync_unpair'), 'Связь разорвана');
    });
    return h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Отвязать филиал'),
        h('div', { class: 'bsync-actions' }, btn, status));
}

// Одна форма для всех «нажали — сходили — перерисовали»: кнопка блокируется на
// время запроса (двойной клик по «Сделать главным» не должен выпускать ключ
// дважды) и РАЗБЛОКИРУЕТСЯ при ошибке — офлайн-клиника обязана иметь право
// попробовать ещё раз.
async function run(btn, statusEl, card, fn, okMessage) {
    if (btn.disabled) return;
    btn.disabled = true;
    statusEl.textContent = '';
    try {
        await fn();
        toast(tr(okMessage), 'ok');
        await paint(card);
    } catch (e) {
        btn.disabled = false;
        statusEl.textContent = e.message;
    }
}
