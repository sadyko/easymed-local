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

import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, field, checkField } from '../ui.js';
import { tr } from '../i18n.js';
import { isAdminActor } from '../admin-actor.js';
import {
    roleBadge, roleExplainer, syncLine, whenLabel, canSyncNow, addressValue,
    syncKeyLine, relayExplainer, publishLine, canRegenerateKey, KEY_LOSS_WARNING,
    branchRows, branchListNote, KEY_REISSUE_WARNING, LETTER_PERMANENCE_NOTE,
    pairedMessage, letterExplainer, becomeMainState, IDENTITY_UNKNOWN_NOTE,
} from '../branch-sync-logic.js';

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить действие.');
    return data;
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
    card.appendChild(h('div', { class: 'sys-info' },
        h('span', { class: 'sys-info-label' }, 'Роль этой установки'),
        h('span', { class: 'sys-info-value' }, Tag(badge.label, { kind: badge.kind })),
    ));
    card.appendChild(h('p', { class: 'muted bsync-note' }, roleExplainer(status)));

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
        card.appendChild(h('div', { class: 'bsync-block' },
            h('div', { class: 'sys-block-title' }, 'Эта установка — филиал'),
            h('div', { class: 'sys-info' },
                h('span', { class: 'sys-info-label' }, 'Этот филиал'),
                h('span', { class: 'sys-info-value' }, status.letter ? Tag(status.letter, { kind: 'info' }) : '—'),
            ),
            h('p', { class: 'muted bsync-note' },
                'Связь с главным филиалом разорвана, но буква осталась за этой установкой навсегда — она напечатана на карточках её пациентов. Введите ключ подключения с той же буквой, чтобы связать филиал заново.'),
        ));
        const back = letterExplainer(status);
        if (back) card.appendChild(h('p', { class: 'muted bsync-note' }, back.base, ' ', back.example));
    }

    // ...и установка, которая свою служебную запись прочитать не смогла. Буквы
    // она тоже не раздаёт — сервер отказывает кодом identity_missing, — но
    // лечится это не ключом подключения, а восстановлением базы, поэтому
    // состояние отдельное и фраза своя. Блок «подключиться к главному» ниже
    // остаётся: ключ БЕЗ буквы базу не трогает и связывает как прежде, так что
    // мёртвой кнопкой он здесь не становится.
    if (mainState === 'unknown') {
        card.appendChild(h('div', { class: 'bsync-block' },
            h('div', { class: 'sys-block-title' }, 'Установка не знает своего филиала'),
            h('p', { class: 'muted bsync-note' }, IDENTITY_UNKNOWN_NOTE),
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

    const keyInput = h('textarea', { rows: '3', placeholder: 'EMB2-…', class: 'bsync-key' });
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
    const urlInput = h('input', { type: 'text', value: addressValue(status), placeholder: '10.0.0.5:8000' });
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
        h('span', { class: 'sys-info-value' }, status.main_url || '—'),
        h('span', { class: 'sys-info-label' }, 'Группа филиалов'),
        h('span', { class: 'sys-info-value' }, status.group_id || '—'),
    ));
    if (!admin) return;

    paintBranchList(card);
    paintRelay(card, status, admin);
    paintSyncKey(card, status, admin);
    card.appendChild(unlinkBlock(card,
        'Филиалы перестанут получать справочник отсюда. Уже переданные услуги и панели у них останутся.'));
}

// --- список филиалов и их ПОСТОЯННЫЕ ключи (BRANCH_IDENTITY_V1) ------------
//
// Требование владельца дословно: «in the branch list should be only the branch
// name. and activation key (not one time generated)». Прежний блок «Показать
// ключ подключения» УДАЛЁН, и не только потому, что прятал ключ за нажатием:
// он выдавал ключ БЕЗ БУКВЫ филиала, а филиал, подключённый таким ключом,
// остаётся при букве A и начинает печатать A-номера рядом с главным филиалом,
// который печатает свои. Это ровно та коллизия, ради которой буква и заведена
// (см. server/services/branch-sync/identity.js). Ключ теперь выдаётся строке
// списка — то есть всегда вместе с буквой.
//
// Список грузится ОТДЕЛЬНЫМ вызовом и после отрисовки: он несёт ключи, поэтому
// закрыт ролью, тогда как branch_sync_status читают все, кому открыты
// настройки. Карточка не должна ждать его, чтобы показать роль установки.
function paintBranchList(card) {
    const listEl = h('div', { class: 'bsync-branches' },
        h('p', { class: 'muted bsync-note' }, 'Загружаем список филиалов…'));
    // Строка состояния ЖИВЁТ ВНЕ списка: она рассказывает про последнее действие
    // (например, что резервный канал этому филиалу выписать не удалось), а
    // список перерисовывается после каждого действия и стёр бы её собой.
    const actionStatus = h('p', { class: 'upd-action-status', role: 'status' });

    const nameInput = h('input', { type: 'text', placeholder: 'Чиланзар' });
    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' },
        Icon('Plus', { size: 14 }), ' ', 'Добавить филиал');

    card.appendChild(h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Филиалы клиники'),
        h('p', { class: 'muted bsync-note' },
            'Ключ филиала не меняется, и прочитать его здесь можно в любой момент. Так и задумано: филиальный компьютер переустанавливают и меняют, а код, показанный один раз, к этому дню уже потерян.'),
        h('p', { class: 'muted bsync-note' },
            'Ключ несёт и ключ шифрования группы. Передайте его лично, сообщением или на флешке — через сервер Easy-Med он не проходит.'),
        listEl,
        h('div', { class: 'bsync-block' },
            h('div', { class: 'sys-block-title' }, 'Добавить филиал'),
            field('Название филиала', nameInput),
            // ПРО НЕСМЕНЯЕМОСТЬ БУКВЫ — здесь, а не в справке: решение о новом
            // филиале принимается ровно в этом поле, а справку не открывают.
            h('p', { class: 'muted bsync-note' }, LETTER_PERMANENCE_NOTE),
            h('div', { class: 'bsync-actions' }, addBtn, actionStatus),
        ),
    ));

    addBtn.addEventListener('click', async () => {
        if (addBtn.disabled) return;
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
            clear(listEl);
            listEl.appendChild(h('p', { class: 'upd-error' },
                'Не удалось прочитать список филиалов. Обновите страницу.'));
            return;
        }
        clear(listEl);
        // Роль могла смениться в другой вкладке между отрисовкой карточки и
        // загрузкой списка: ключи показывает только главный филиал.
        const note = branchListNote(data);
        if (note) { listEl.appendChild(h('p', { class: 'muted bsync-note' }, note)); return; }
        const rows = branchRows(data);
        if (!rows.length) {
            listEl.appendChild(h('p', { class: 'muted bsync-note' }, 'Филиалов пока нет.'));
            return;
        }
        for (const row of rows) listEl.appendChild(branchEl(row, data.can_issue));
    }

    function branchEl(row, canIssue) {
        const head = h('div', { class: 'bsync-branch-head' },
            h('span', { class: 'bsync-branch-name' }, row.name),
            h('span', { class: 'muted bsync-note' }, 'Буква'),
            // Буква — Tag, а не текст: её ищут глазами среди имён, и она же
            // стоит первым символом каждого номера пациента этого здания.
            Tag(row.letterLabel, { kind: row.letter ? 'info' : '' }));

        const box = h('div', { class: 'bsync-branch' }, head);
        if (row.key) box.appendChild(keyBox(row.key));
        // ЧЕСТНОЕ СОСТОЯНИЕ ВМЕСТО ПУСТОЙ КЛЕТКИ: пустое поле на месте ключа
        // читается как «не загрузилось», а у каждого случая здесь есть точный
        // ответ (branch-sync-logic.js branchRows). У 'key_no_relay' ключ ЕСТЬ и
        // работает — объяснение идёт ПОД ним, а не вместо него.
        if (row.note) box.appendChild(h('p', { class: 'muted bsync-note' }, row.note));

        // ОДНА КНОПКА НА ДВА СОСТОЯНИЯ, потому что вызов один и тот же:
        // branch_sync_branch_key выдаёт букву, если её нет, и выписывает учётку
        // резервного канала, если её нет. Без второго состояния строка с ключом
        // без учётки не предлагала на экране НИЧЕГО — а приводят туда два
        // обычных пути, перевыпуск ключа синхронизации и заведение филиала без
        // интернета, и владелец раздавал бы ключи без резервного канала, не
        // зная об этом.
        const fixable = row.state === 'no_letter' || row.state === 'key_no_relay';
        if (fixable && canIssue) {
            const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' },
                row.state === 'no_letter' ? 'Выдать ключ' : 'Выдать доступ');
            btn.addEventListener('click', async () => {
                if (btn.disabled) return;
                btn.disabled = true;
                actionStatus.textContent = '';
                try {
                    const data = await rpc('branch_sync_branch_key', { branch_id: row.id });
                    toast(tr('Ключ выдан'), 'ok');
                    noteRelay(actionStatus, data);
                    await reload();
                    return;   // строка перерисована — кнопки больше нет
                } catch (e) {
                    actionStatus.textContent = e.message;
                }
                btn.disabled = false;
            });
            box.appendChild(h('div', { class: 'bsync-actions' }, btn));
        }
        return box;
    }
}

/** Резервный канал филиалу выписать не удалось — сказать это, но не пугать. */
function noteRelay(statusEl, data) {
    const relay = data && data.relay;
    statusEl.textContent = relay && relay.ok === false && relay.message ? relay.message : '';
}

/** Ключ целиком, выделяемый, с кнопкой «Копировать». Никаких «показать один раз». */
function keyBox(key) {
    // aria-label, а не подпись рядом: подписью служит имя филиала строкой выше,
    // но программе чтения с экрана нужно имя у самого поля — h() прогоняет
    // aria-label через tr(), поэтому оно переводится вместе со всем остальным.
    const box = h('textarea', {
        rows: '3', readonly: 'readonly', class: 'bsync-key', 'aria-label': 'Ключ подключения',
    });
    box.value = key;
    // Без значка: в icons.js нет ничего, что читалось бы как «копировать», а
    // подставить похожий (лист, слои) значит подписать кнопку неправдой. Слово
    // здесь короче любого объяснения.
    const copyBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Копировать');
    const copyStatus = h('p', { class: 'upd-action-status', role: 'status' });
    copyBtn.addEventListener('click', async () => {
        try {
            // Буфер обмена может быть недоступен (нет https, отказ в правах) —
            // тогда просто выделяем текст, чтобы ключ можно было скопировать
            // руками. Ошибку копирования показывать не за что.
            await navigator.clipboard.writeText(box.value);
            copyStatus.textContent = tr('Ключ скопирован');
        } catch {
            box.select?.();
            copyStatus.textContent = tr('Скопируйте выделенный ключ');
        }
    });
    return h('div', null, box, h('div', { class: 'bsync-actions' }, copyBtn, copyStatus));
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
        box.appendChild(h('p', { class: 'muted bsync-note' }, syncKeyLine(status).text));
        card.appendChild(box);
        return;
    }

    box.appendChild(h('p', { class: 'muted bsync-note' }, relayExplainer(status)));

    if (!admin) {
        box.appendChild(h('p', { class: 'muted bsync-note' },
            status.relay_enabled ? 'Резервный канал включён.' : 'Резервный канал выключен.'));
        card.appendChild(box);
        return;
    }

    const toggle = h('input', { type: 'checkbox' });
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

    const line = publishLine(status);
    if (line) box.appendChild(h('p', { class: 'muted bsync-note' }, line));

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
        box.appendChild(h('div', { class: 'bsync-actions' }, pubBtn, pubStatus));
    }

    box.appendChild(h('p', { class: 'muted bsync-note' }, KEY_LOSS_WARNING));
    card.appendChild(box);
}

// --- ключ синхронизации и его перевыпуск -----------------------------------
function paintSyncKey(card, status, admin) {
    if (!canRegenerateKey(status, admin)) return;
    const key = syncKeyLine(status);

    const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Перевыпустить ключ синхронизации');
    const btnStatus = h('p', { class: 'upd-action-status', role: 'status' });
    btn.addEventListener('click', async () => {
        // Спрашиваем ДО вызова и говорим ровно то, что произойдёт: перевыпуск
        // рвёт связь со всеми филиалами, и восстановить старый ключ не может
        // никто, включая Easy-Med.
        // window.confirm НЕ прогоняет текст через tr() сам — в отличие от h(),
        // который делает это с каждым текстовым узлом. Без явного tr() это
        // единственное окно на экране осталось бы по-русски в узбекской клинике.
        const ok = window.confirm(
            tr(KEY_REISSUE_WARNING) + '\n\n'
            + tr('Старый ключ восстановить невозможно — Easy-Med его не хранит.') + '\n\n'
            + tr('Перевыпустить ключ синхронизации?'));
        if (!ok) return;
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
        h('p', { class: 'muted bsync-note' }, key.text),
        // ТО ЖЕ ПРЕДУПРЕЖДЕНИЕ, что и в окне подтверждения, одной строкой на
        // два места: разошёдшись, они бы рассказывали разное об одном действии.
        h('p', { class: 'muted bsync-note' }, KEY_REISSUE_WARNING),
        h('div', { class: 'bsync-actions' }, btn, btnStatus),
    ));
}

// --- подключённый филиал ---------------------------------------------------
function paintSecondary(card, status, admin) {
    const line = syncLine(status);
    card.appendChild(h('div', { class: 'sys-info' },
        // БУКВА ПЕРВОЙ, и она стоит здесь ПОСТОЯННО, а не всплывает
        // уведомлением после подключения: вопрос «что за буква в номере»
        // задаёт регистратура спустя месяцы после того, как тост погас.
        h('span', { class: 'sys-info-label' }, 'Этот филиал'),
        h('span', { class: 'sys-info-value' }, status.letter ? Tag(status.letter, { kind: 'info' }) : '—'),
        h('span', { class: 'sys-info-label' }, 'Главный филиал'),
        h('span', { class: 'sys-info-value' }, status.main_url || '—'),
        h('span', { class: 'sys-info-label' }, 'Группа филиалов'),
        h('span', { class: 'sys-info-value' }, status.group_id || '—'),
        h('span', { class: 'sys-info-label' }, 'Подключён'),
        h('span', { class: 'sys-info-value' }, whenLabel(status.paired_at)),
    ));
    const letters = letterExplainer(status);
    // Двумя текстовыми узлами: h() прогоняет каждый через tr() по отдельности,
    // так что переводится фраза, а пример с буквой просто дописывается.
    if (letters) card.appendChild(h('p', { class: 'muted bsync-note' }, letters.base, ' ', letters.example));

    card.appendChild(h('p', {
        class: line.tone === 'warn' ? 'bsync-line bsync-line-warn' : 'bsync-line',
        role: 'status',
    },
    Icon(line.tone === 'warn' ? 'Warning' : (line.tone === 'ok' ? 'Check' : 'Clock'), { size: 14 }),
    ' ', line.text));

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

    card.appendChild(h('div', { class: 'bsync-actions' }, syncBtn, syncStatus));
    card.appendChild(h('p', { class: 'muted bsync-note' },
        'Синхронизация переносит только справочник: сведения о клинике, услуги с ценами и лабораторные панели. Пациенты, визиты, анализы и оплаты остаются в своём филиале.'));
    paintRelay(card, status, admin);
    card.appendChild(unlinkBlock(card,
        'Филиал перестанет получать справочник. Услуги и панели, которые уже приехали, останутся на месте.'));
}

function unlinkBlock(card, note) {
    const btn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Отвязать');
    const status = h('p', { class: 'upd-action-status', role: 'status' });
    btn.addEventListener('click', () => run(btn, status, card, () => rpc('branch_sync_unpair'), 'Связь разорвана'));
    return h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Отвязать филиал'),
        h('p', { class: 'muted bsync-note' }, note),
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
