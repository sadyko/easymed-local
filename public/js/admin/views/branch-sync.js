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
import { h, Icon, Tag, clear, toast, field } from '../ui.js';
import { tr } from '../i18n.js';
import { isAdminActor } from '../admin-actor.js';
import {
    roleBadge, roleExplainer, syncLine, whenLabel, canSyncNow, addressValue,
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

    const keyInput = h('textarea', { rows: '3', placeholder: 'EMB1-…', class: 'bsync-key' });
    const pairBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Подключить к главному');
    const pairStatus = h('p', { class: 'upd-action-status', role: 'status' });
    pairBtn.addEventListener('click', () => run(pairBtn, pairStatus, card,
        () => rpc('branch_sync_pair', { key: keyInput.value }), 'Филиал подключён к главному'));

    card.appendChild(h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Этот филиал подключается к главному'),
        h('p', { class: 'muted bsync-note' },
            'Вставьте ключ подключения, выданный на главном филиале.'),
        field('Ключ подключения', keyInput),
        h('div', { class: 'bsync-actions' }, pairBtn, pairStatus),
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

    const keyBox = h('textarea', { rows: '3', readonly: 'readonly', class: 'bsync-key' });
    const showBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Показать ключ подключения');
    const copyBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { display: 'none' } }, 'Копировать');
    const keyStatus = h('p', { class: 'upd-action-status', role: 'status' });

    showBtn.addEventListener('click', async () => {
        showBtn.disabled = true;
        keyStatus.textContent = '';
        try {
            const data = await rpc('branch_sync_make_key', {});
            keyBox.value = data.key;
            keyBox.style.display = '';
            copyBtn.style.display = '';
        } catch (e) {
            keyStatus.textContent = e.message;
        } finally {
            showBtn.disabled = false;
        }
    });
    copyBtn.addEventListener('click', async () => {
        try {
            // Буфер обмена может быть недоступен (нет https, отказ в правах) —
            // тогда просто выделяем текст, чтобы ключ можно было скопировать
            // руками. Ошибку копирования показывать не за что.
            await navigator.clipboard.writeText(keyBox.value);
            keyStatus.textContent = tr('Ключ скопирован');
        } catch {
            keyBox.select?.();
            keyStatus.textContent = tr('Скопируйте выделенный ключ');
        }
    });

    keyBox.style.display = 'none';
    card.appendChild(h('div', { class: 'bsync-block' },
        h('div', { class: 'sys-block-title' }, 'Ключ подключения'),
        h('p', { class: 'muted bsync-note' },
            'Введите этот ключ на каждом филиале, который должен получать справочник отсюда. Ключ не меняется — его можно показать снова в любой момент.'),
        keyBox,
        h('div', { class: 'bsync-actions' }, showBtn, copyBtn, keyStatus),
    ));
    card.appendChild(unlinkBlock(card,
        'Филиалы перестанут получать справочник отсюда. Уже переданные услуги и панели у них останутся.'));
}

// --- подключённый филиал ---------------------------------------------------
function paintSecondary(card, status, admin) {
    const line = syncLine(status);
    card.appendChild(h('div', { class: 'sys-info' },
        h('span', { class: 'sys-info-label' }, 'Главный филиал'),
        h('span', { class: 'sys-info-value' }, status.main_url || '—'),
        h('span', { class: 'sys-info-label' }, 'Группа филиалов'),
        h('span', { class: 'sys-info-value' }, status.group_id || '—'),
        h('span', { class: 'sys-info-label' }, 'Подключён'),
        h('span', { class: 'sys-info-value' }, whenLabel(status.paired_at)),
    ));

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
