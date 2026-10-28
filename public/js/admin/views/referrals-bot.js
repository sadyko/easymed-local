// REFERRALS_CRM_V1 (2026-10-26) — вкладка «Telegram-бот» экрана «Реферирование»:
// второй бот, для врачей-источников (не пациентский). Снимок владельца: карточка
// «Бот для врачей-источников» с токеном и выключателем «Бот включён — отвечает
// врачам и отправляет уведомления», два абзаца «Как подключить бота» и «Как
// подключиться врачу», плитки охвата и список «Подключённые». Только
// администратор — вкладку показывает referrals.js по actorIsAdmin().
import { h, Icon, Tag, clear, toast, field, checkField } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { rpc, kpi, kpiRow, loadingEl, errorEl, nameCell, simpleTable } from './referrals-common.js';
import { dmy, subline } from '../referrals-logic.js';

export async function renderReferralsBot(host) {
    const state = { s: null, stats: null, links: null, error: null, busy: false };
    const refs = { body: h('div') };
    clear(host);
    host.appendChild(refs.body);
    await load();

    async function load() {
        state.error = null;
        try {
            const [s, stats, links] = await Promise.all([rpc('doctor_bot_settings_get'), rpc('doctor_bot_stats'), rpc('doctor_bot_links_list')]);
            state.s = s; state.stats = stats; state.links = links;
        } catch (e) { state.error = (e && e.message) || String(e); }
        paint();
    }
    async function reloadStats() {
        try { state.stats = await rpc('doctor_bot_stats'); state.links = await rpc('doctor_bot_links_list'); } catch (e) { /* плитки остаются прежними */ }
        paint();
    }

    function paint() {
        clear(refs.body);
        if (state.error) { refs.body.appendChild(errorEl(state.error)); return; }
        if (!state.s) { refs.body.appendChild(loadingEl()); return; }
        refs.body.appendChild(tokenCard());
        const t = state.stats || {};
        refs.body.appendChild(kpiRow(
            kpi(String(t.doctors_active ?? '…'), 'Активных врачей'),
            kpi(String(t.with_phone ?? '…'), 'С телефоном в базе'),
            kpi(String(t.connected ?? '…'), 'Подключили бота', { accent: 'ok' }),
            // FIX_318_V1 (M2) — подключения, которые ждут администратора.
            kpi(String(t.pending ?? '…'), 'Ждут подтверждения', { accent: t.pending > 0 ? 'warn' : '' }),
            kpi(String(t.without_phone ?? '…'), 'Без телефона — не смогут подключиться', { accent: t.without_phone > 0 ? 'warn' : '' }),
            kpi(String(t.notifications_30d ?? '…'), 'Уведомлений за 30 дней'),
            kpi(String(t.viewed_30d ?? '…'), 'Из них просмотрено'),
        ));
        const pending = pendingCard();
        if (pending) refs.body.appendChild(pending);
        refs.body.appendChild(linksCard());
    }

    // FIX_318_V1 (M2, ревью 3.18.0) — ПОДКЛЮЧЕНИЕ — ТОЛЬКО С СОГЛАСИЯ КЛИНИКИ.
    // Врач прислал номер из Telegram — подключение ждёт здесь; администратор
    // сверяет врача (имя, номер в справочнике, последние цифры присланного
    // номера) и подтверждает или отклоняет. До подтверждения бот ему ничего не
    // присылает (server/services/doctor-bot/notify.js).
    function pendingCard() {
        const pending = (state.links || []).filter((l) => l.status === 'pending');
        if (!pending.length) return null;
        const act = (l, name, okText) => async (ev) => {
            const btn = ev && ev.currentTarget;
            if (btn) btn.disabled = true;
            try { await rpc(name, { id: l.id }); toast(okText, 'success'); await reloadStats(); }
            catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'error'); if (btn) btn.disabled = false; }
        };
        const columns = [
            { label: 'Врач', value: (l) => nameCell(l.source_name, subline(['№ ' + (l.source_code || ''), l.source_phone])) },
            { label: 'Номер из Telegram', value: (l) => (l.phone_tail ? '…' + l.phone_tail : '—') },
            { label: 'Telegram', value: (l) => subline([l.tg_name, l.tg_username ? '@' + l.tg_username : '']) || '—' },
            { label: 'Отправил номер', value: (l) => dmy(l.linked_at) },
            { label: '', value: (l) => h('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } },
                h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-bot-confirm': l.id,
                    onclick: act(l, 'doctor_bot_link_confirm', 'Подключение подтверждено — врач будет получать уведомления.') }, tr('Подтвердить')),
                h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-bot-reject': l.id,
                    onclick: async (ev) => {
                        if (!window.confirm(tr('Отклонить подключение? Врач не будет получать уведомления, пока не отправит номер снова и вы не подтвердите.'))) return;
                        await act(l, 'doctor_bot_link_reject', 'Подключение отклонено.')(ev);
                    } }, tr('Отклонить'))) },
        ];
        return h('div', { class: 'card', style: { marginBottom: '16px' }, 'data-bot-pending': '' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Clock', { size: 16 }), ' ', tr('Ожидают подтверждения')),
                h('span', { class: 'muted' }, String(pending.length))),
            h('p', { class: 'muted', style: { margin: '0', padding: '12px 18px 0', fontSize: '13.5px' } },
                'Врач прислал номер из Telegram. Сверьте имя и последние цифры номера и подтвердите — до подтверждения бот ему ничего не присылает.'),
            simpleTable(columns, pending));
    }

    function statusTag() {
        const s = state.s;
        if (!s.has_token) return Tag(tr('Не настроен'), {});
        if (s.last_check_status === 'ok') return Tag(trf('Подключён @{bot}', { bot: s.bot_username || tr('бот') }), { kind: 'ok' });
        if (s.last_check_status === 'error') return Tag(tr('Ошибка'), { kind: 'crit' });
        return Tag(tr('Токен сохранён'), { kind: 'warn' });
    }

    function tokenCard() {
        const s = state.s;
        const card = h('div', { style: { padding: '18px' } });
        const input = h('input', {
            type: 'password', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' }, 'data-bot-token': '',
            placeholder: s.has_token ? 'Введите новый токен, чтобы заменить' : '123456789:AA… — токен от @BotFather',
        });
        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-bot-save': '',
            onclick: async () => {
                const v = input.value.trim();
                if (!v) return toast('Введите токен.', 'warn');
                await run(saveBtn, async () => {
                    const res = await rpc('doctor_bot_settings_save', { bot_token: v });
                    state.s = res; input.value = '';
                    if (res.check_error) toast(trf('Токен сохранён, но Telegram его не принял: {msg}', { msg: res.check_error }), 'error');
                    else if (res.auto_enabled) toast(trf('Готово! Бот @{bot} включён и отвечает врачам.', { bot: res.bot_username || '' }), 'success');
                    else toast('Токен сохранён.', 'success');
                    paint();
                });
            } }, Icon('Check', { size: 13 }), ' ', tr('Сохранить токен'));
        card.appendChild(field(
            s.has_token ? trf('Сохранённый токен: …{hint} (заменить)', { hint: s.token_hint }) : tr('Токен из @BotFather'),
            h('div', { class: 'row', style: { gap: '8px' } }, h('div', { style: { flex: '1' } }, input), saveBtn)));

        const enabled = h('input', { type: 'checkbox', checked: !!s.enabled, disabled: !s.has_token, 'data-bot-enabled': '',
            onchange: async () => {
                enabled.disabled = true;
                try {
                    state.s = await rpc('doctor_bot_settings_save', { enabled: enabled.checked });
                    toast(state.s.enabled ? 'Бот включён — врачи могут подключаться.' : 'Бот выключен.', 'success');
                    paint();
                } catch (e) {
                    enabled.checked = !enabled.checked;   // не сохранилось — не врём галочкой
                    toast((e && e.message) || tr('Не удалось сохранить.'), 'error');
                } finally { enabled.disabled = !state.s.has_token; }
            } });
        card.appendChild(checkField('Бот включён — отвечает врачам и отправляет уведомления', enabled));

        card.appendChild(h('p', { style: { margin: '12px 0 6px', fontSize: '13.5px' } },
            h('b', null, 'Как подключить бота.'), ' ',
            'Создайте бота в @BotFather (команда /newbot), скопируйте токен и вставьте сюда — связь проверится и бот включится сам. Это должен быть ДРУГОЙ бот, не пациентский.'));
        card.appendChild(h('p', { style: { margin: '0', fontSize: '13.5px' } },
            h('b', null, 'Как подключиться врачу.'), ' ',
            'Врач открывает бота, нажимает «Start» и отправляет свой номер кнопкой. Номер должен совпадать с телефоном врача во вкладке «Врачи-источники». После этого, когда направленный им пациент придёт (визит отмечен «пришёл»), бот пришлёт ФИО пациента и список услуг — без цен. Сообщение уходит через 2 минуты после последней добавленной услуги, о каждом визите один раз; о визитах до подключения врача бот не пишет.'));
        // FIX_318_V1 (M2) — подтверждение администратором и «о каком визите пишет».
        card.appendChild(h('p', { style: { margin: '6px 0 0', fontSize: '13.5px' } },
            'Подключение начинает работать после вашего подтверждения (список «Ожидают подтверждения» ниже). Номер, указанный у двух врачей, не подключается. Бот пишет только о визитах, в которых этот врач указан направившим, и замолкает, если врача выключить или сменить ему номер.'));

        const actions = h('div', { class: 'row', style: { gap: '8px', marginTop: '14px', flexWrap: 'wrap' } });
        const testBtn = h('button', { class: 'btn', type: 'button', disabled: !s.has_token,
            onclick: async () => {
                await run(testBtn, async () => {
                    const res = await rpc('doctor_bot_test_connection');
                    state.s = res.settings;
                    if (res.ok) toast(trf('Связь есть: @{bot}', { bot: (res.bot && res.bot.username) || tr('бот') }), 'success');
                    else toast(res.error, 'error');
                    paint();
                });
            } }, Icon('Refresh', { size: 13 }), ' ', tr('Проверить связь'));
        actions.appendChild(testBtn);
        if (s.bot_username) {
            const link = 'https://t.me/' + s.bot_username;
            actions.appendChild(h('span', { class: 'muted', style: { fontSize: '13.5px', alignSelf: 'center' } },
                tr('Ссылка для врачей: '), h('a', { href: link, target: '_blank', rel: 'noopener' }, link)));
        }
        actions.appendChild(h('span', { class: 'grow' }));
        if (s.has_token) {
            const clearBtn = h('button', { class: 'btn btn-danger', type: 'button',
                onclick: async () => {
                    if (!window.confirm(tr('Удалить токен? Бот будет выключен, и врачи перестанут получать уведомления.'))) return;
                    await run(clearBtn, async () => {
                        state.s = await rpc('doctor_bot_token_clear');
                        toast('Токен удалён, бот выключен.', 'info');
                        paint();
                    });
                } }, tr('Удалить токен'));
            actions.appendChild(clearBtn);
        }
        card.appendChild(actions);

        return h('div', { class: 'card', style: { marginBottom: '16px' } },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Bot', { size: 16 }), ' ', tr('Бот для врачей-источников')),
                statusTag()),
            card);
    }

    function linksCard() {
        const links = (state.links || []).filter((l) => l.status === 'confirmed');   // FIX_318_V1 (M2) — ждущие — в своей карточке
        const columns = [
            { label: 'Врач', value: (l) => nameCell(l.source_name, subline(['№ ' + (l.source_code || ''), l.source_phone])) },
            { label: 'Telegram', value: (l) => subline([l.tg_name, l.tg_username ? '@' + l.tg_username : '']) || '—' },
            { label: 'Подключён', value: (l) => dmy(l.linked_at) },
            { label: 'Последнее уведомление', value: (l) => (l.last_notified_at ? dmy(l.last_notified_at) : '—') },
            { label: '', value: (l) => h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-bot-revoke': l.id,
                onclick: async () => {
                    if (!window.confirm(tr('Отключить этого врача от бота? Уведомления ему перестанут приходить, пока он не отправит номер снова.'))) return;
                    try { await rpc('doctor_bot_link_revoke', { id: l.id }); toast('Врач отключён от бота.', 'success'); await reloadStats(); }
                    catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'error'); }
                } }, tr('Отключить')) },
        ];
        return h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Link', { size: 16 }), ' ', tr('Подключённые')),
                h('span', { class: 'muted' }, String(links.length))),
            simpleTable(columns, links, { emptyText: tr('Пока никто не подключился.') }));
    }

    async function run(btn, fn) {
        if (state.busy) return;
        state.busy = true;
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try { await fn(); }
        catch (e) { toast((e && e.message) || tr('Не удалось выполнить операцию.'), 'error'); }
        finally { state.busy = false; try { btn.disabled = false; btn.textContent = label; } catch (_) { /* перерисовано */ } }
    }
}
