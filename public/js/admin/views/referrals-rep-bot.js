// REP_BOT_V1 (2026-10-30) — вкладка «Бот представителей» экрана «Реферирование»:
// третий бот клиники — медпредставитель заводит внешнего врача из Telegram
// (владелец: «make it possible that med representative adds doctor from
// telegram bot, make seperate bot for only med reps»). Устроена как вкладка
// «Telegram-бот» (referrals-bot.js): токен и выключатель, плитки, «Ожидают
// подтверждения», «Подключённые» — и список «Добавлены через бота». Только
// администратор — вкладку показывает referrals.js по actorIsAdmin().
//
// REP_BOT_CLAIMS_V1 (2026-11-20) — список «Заявки на закрепление»: представитель
// ввёл в боте номер врача, который в клинике уже есть, — второй карточки бот не
// заводит, а присылает заявку сюда. «Подтвердить» переносит врача к заявителю
// (даже от другого представителя — тот получает сообщение в боте),
// «Отклонить» оставляет как есть. Карточка показывается, только когда есть
// открытые заявки, — как «Ожидают подтверждения».
import { h, Icon, Tag, clear, toast, field, checkField } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { rpc, kpi, kpiRow, loadingEl, errorEl, nameCell, simpleTable } from './referrals-common.js';
import { dmy, subline } from '../referrals-logic.js';

export async function renderReferralsRepBot(host) {
    const state = { s: null, stats: null, links: null, added: null, claims: null, error: null, busy: false };
    const refs = { body: h('div') };
    // REP_BOT_TAB_FIX_V1 (2026-11-18) — эти три константы стоят ДО первого
    // `await load()`: load() → paint() → pendingCard()/linksCard() берут их
    // сразу. Раньше они были объявлены ниже вызова, и вкладка всякий раз
    // падала «Cannot access 'repCell' before initialization» (снимок владельца):
    // функции поднимаются, const — нет.
    const act = (l, name, okText) => async (ev) => {
        const btn = ev && ev.currentTarget;
        if (btn) btn.disabled = true;
        try { await rpc(name, { id: l.id }); toast(okText, 'success'); await reloadLists(); }
        catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'error'); if (btn) btn.disabled = false; }
    };
    const repCell = (l) => nameCell(l.rep_name, subline([l.rep_phone]));
    const tgCell = (l) => subline([l.tg_name, l.tg_username ? '@' + l.tg_username : '']) || '—';
    clear(host);
    host.appendChild(refs.body);
    await load();

    async function load() {
        state.error = null;
        try {
            const [s, stats, links, added, claims] = await Promise.all([
                rpc('rep_bot_settings_get'), rpc('rep_bot_stats'), rpc('rep_bot_links_list'), rpc('rep_bot_additions_list'),
                rpc('rep_bot_claims_list')]);
            Object.assign(state, { s, stats, links, added, claims });
        } catch (e) { state.error = (e && e.message) || String(e); }
        paint();
    }
    async function reloadLists() {
        try {
            const [stats, links, added, claims] = await Promise.all([rpc('rep_bot_stats'), rpc('rep_bot_links_list'),
                rpc('rep_bot_additions_list'), rpc('rep_bot_claims_list')]);
            Object.assign(state, { stats, links, added, claims });
        } catch (e) { /* плитки остаются прежними */ }
        paint();
    }

    function paint() {
        clear(refs.body);
        if (state.error) { refs.body.appendChild(errorEl(state.error)); return; }
        if (!state.s) { refs.body.appendChild(loadingEl()); return; }
        refs.body.appendChild(tokenCard());
        const t = state.stats || {};
        refs.body.appendChild(kpiRow(
            kpi(String(t.reps_active ?? '…'), 'Медпредставителей'),
            kpi(String(t.connected ?? '…'), 'Подключили бота', { accent: 'ok' }),
            kpi(String(t.pending ?? '…'), 'Ждут подтверждения', { accent: t.pending > 0 ? 'warn' : '' }),
            kpi(String(t.without_phone ?? '…'), 'Без телефона — не смогут подключиться', { accent: t.without_phone > 0 ? 'warn' : '' }),
            kpi(String(t.added_30d ?? '…'), 'Врачей добавлено за 30 дней'),
        ));
        const pending = pendingCard();
        if (pending) refs.body.appendChild(pending);
        const claims = claimsCard();
        if (claims) refs.body.appendChild(claims);
        refs.body.appendChild(linksCard());
        refs.body.appendChild(addedCard());
    }

    // Подтверждение — единственное, что даёт чату Telegram право заводить
    // врачей в справочник: до него бот на всё отвечает «заявка у клиники».
    function pendingCard() {
        const pending = (state.links || []).filter((l) => l.status === 'pending');
        if (!pending.length) return null;
        const columns = [
            { label: 'Представитель', value: repCell },
            { label: 'Номер из Telegram', value: (l) => (l.phone_tail ? '…' + l.phone_tail : '—') },
            { label: 'Telegram', value: tgCell },
            { label: 'Отправил номер', value: (l) => dmy(l.linked_at) },
            { label: '', value: (l) => h('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } },
                h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-repbot-confirm': l.id,
                    onclick: act(l, 'rep_bot_link_confirm', 'Подключение подтверждено — представитель может добавлять врачей.') }, tr('Подтвердить')),
                h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-repbot-reject': l.id,
                    onclick: async (ev) => {
                        if (!window.confirm(tr('Отклонить подключение? Представитель не сможет добавлять врачей, пока не отправит номер снова и вы не подтвердите.'))) return;
                        await act(l, 'rep_bot_link_reject', 'Подключение отклонено.')(ev);
                    } }, tr('Отклонить'))) },
        ];
        return h('div', { class: 'card', style: { marginBottom: '16px' }, 'data-repbot-pending': '' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Clock', { size: 16 }), ' ', tr('Ожидают подтверждения')),
                h('span', { class: 'muted' }, String(pending.length))),
            h('p', { class: 'muted', style: { margin: '0', padding: '12px 18px 0', fontSize: '13.5px' } },
                tr('Представитель прислал номер из Telegram. Сверьте имя и последние цифры номера и подтвердите — до подтверждения бот не даёт ему добавлять врачей.')),
            simpleTable(columns, pending));
    }

    // REP_BOT_CLAIMS_V1 — решение по заявке. Ошибка (заявку уже решили, или
    // сервер закрыл её как void: заявителя уволили, врач стал врачом клиники) —
    // сообщение сервера и перерисовка: закрытая заявка из списка уходит.
    // Объявление функции, не const: paint() зовёт claimsCard() ещё из первого
    // `await load()` (см. REP_BOT_TAB_FIX_V1 выше), а функции поднимаются.
    function decide(c, decision, okText) {
        return async (ev) => {
            const btn = ev && ev.currentTarget;
            if (btn) btn.disabled = true;
            try { await rpc('rep_bot_claim_decide', { id: c.id, decision }); toast(okText, 'success'); }
            catch (e) { toast((e && e.message) || tr('Не удалось сохранить.'), 'error'); }
            await reloadLists();
        };
    }

    function claimsCard() {
        const claims = state.claims || [];
        if (!claims.length) return null;
        const columns = [
            { label: 'Врач', value: (c) => nameCell(c.source_name, subline(['№ ' + (c.source_code || ''), c.source_phone])) },
            { label: 'Заявитель', value: (c) => nameCell(c.requester_name || '—',
                c.entered_name ? trf('В анкете: {name}', { name: c.entered_name }) : '') },
            { label: 'Сейчас закреплён', value: (c) => (c.current_rep_name ? c.current_rep_name : h('span', { class: 'muted' }, tr('не закреплён'))) },
            { label: 'Заявка', value: (c) => dmy(c.created_at) },
            { label: '', value: (c) => h('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } },
                h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-repbot-claim-approve': c.id,
                    onclick: async (ev) => {
                        // Перенос от другого представителя — с вопросом: тот потеряет врача.
                        if (c.current_rep_id && c.current_rep_id !== c.requester_id
                            && !window.confirm(trf('Врач перейдёт от {from} к {to}. Прежний представитель получит сообщение в боте. Подтвердить?',
                                { from: c.current_rep_name || '—', to: c.requester_name || '—' }))) return;
                        await decide(c, 'approve', tr('Заявка подтверждена — врач закреплён за представителем.'))(ev);
                    } }, tr('Подтвердить')),
                h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-repbot-claim-reject': c.id,
                    onclick: async (ev) => {
                        if (!window.confirm(tr('Отклонить заявку? Врач останется за тем, за кем закреплён сейчас.'))) return;
                        await decide(c, 'reject', tr('Заявка отклонена.'))(ev);
                    } }, tr('Отклонить'))) },
        ];
        return h('div', { class: 'card', style: { marginBottom: '16px' }, 'data-repbot-claims': '' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('User', { size: 16 }), ' ', tr('Заявки на закрепление')),
                h('span', { class: 'muted' }, String(claims.length))),
            h('p', { class: 'muted', style: { margin: '0', padding: '12px 18px 0', fontSize: '13.5px' } },
                tr('Представитель ввёл в боте номер врача, который в клинике уже есть. Второго врача бот не заводит: подтвердите — и врач перейдёт к заявителю, отклоните — останется как есть. Данные врача заявка не меняет.')),
            simpleTable(columns, claims));
    }

    function linksCard() {
        const links = (state.links || []).filter((l) => l.status === 'confirmed');
        const columns = [
            { label: 'Представитель', value: repCell },
            { label: 'Telegram', value: tgCell },
            { label: 'Подключён', value: (l) => dmy(l.confirmed_at || l.linked_at) },
            { label: 'Добавил врачей', value: (l) => String(l.added || 0) },
            { label: '', value: (l) => h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-repbot-revoke': l.id,
                onclick: async (ev) => {
                    if (!window.confirm(tr('Отключить этого представителя от бота? Добавлять врачей он не сможет, пока не отправит номер снова и вы не подтвердите.'))) return;
                    await act(l, 'rep_bot_link_revoke', 'Представитель отключён от бота.')(ev);
                } }, tr('Отключить')) },
        ];
        return h('div', { class: 'card', style: { marginBottom: '16px' } },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Link', { size: 16 }), ' ', tr('Подключённые')),
                h('span', { class: 'muted' }, String(links.length))),
            simpleTable(columns, links, { emptyText: tr('Пока никто не подключился.') }));
    }

    function addedCard() {
        const rows = state.added || [];
        const columns = [
            { label: 'Врач', value: (a) => nameCell(a.source_name, subline(['№ ' + (a.source_code || ''), a.source_phone])) },
            { label: 'Специальность', value: (a) => a.specialty || '—' },
            { label: 'Место работы', value: (a) => a.workplace || '—' },
            { label: 'Добавил', value: (a) => a.rep_name || '—' },
            { label: 'Когда', value: (a) => dmy(a.created_at) },
            { label: 'Активен', value: (a) => (a.active ? Tag(tr('Да'), { kind: 'ok' }) : Tag(tr('Нет'), {})) },
        ];
        return h('div', { class: 'card', 'data-repbot-added': '' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Stethoscope', { size: 16 }), ' ', tr('Добавлены через бота')),
                h('span', { class: 'muted' }, String(rows.length))),
            h('p', { class: 'muted', style: { margin: '0', padding: '12px 18px 0', fontSize: '13.5px' } },
                tr('Последние 50. Врач сразу попадает во вкладку «Врачи-источники», закреплённым за представителем; категорию и вознаграждение задайте там.')),
            simpleTable(columns, rows, { emptyText: tr('Через бота пока никого не добавили.') }));
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
            type: 'password', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' }, 'data-repbot-token': '',
            placeholder: s.has_token ? tr('Введите новый токен, чтобы заменить') : tr('123456789:AA… — токен от @BotFather'),
        });
        const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-repbot-save': '',
            onclick: async () => {
                const v = input.value.trim();
                if (!v) return toast(tr('Введите токен.'), 'warn');
                await run(saveBtn, async () => {
                    const res = await rpc('rep_bot_settings_save', { bot_token: v });
                    state.s = res; input.value = '';
                    if (res.check_error) toast(trf('Токен сохранён, но Telegram его не принял: {msg}', { msg: res.check_error }), 'error');
                    else if (res.auto_enabled) toast(trf('Готово! Бот @{bot} включён и отвечает представителям.', { bot: res.bot_username || '' }), 'success');
                    else toast(tr('Токен сохранён.'), 'success');
                    paint();
                });
            } }, Icon('Check', { size: 13 }), ' ', tr('Сохранить токен'));
        card.appendChild(field(
            s.has_token ? trf('Сохранённый токен: …{hint} (заменить)', { hint: s.token_hint }) : tr('Токен из @BotFather'),
            h('div', { class: 'row', style: { gap: '8px' } }, h('div', { style: { flex: '1' } }, input), saveBtn)));

        const enabled = h('input', { type: 'checkbox', checked: !!s.enabled, disabled: !s.has_token, 'data-repbot-enabled': '',
            onchange: async () => {
                enabled.disabled = true;
                try {
                    state.s = await rpc('rep_bot_settings_save', { enabled: enabled.checked });
                    toast(state.s.enabled ? tr('Бот включён — представители могут подключаться.') : tr('Бот выключен.'), 'success');
                    paint();
                } catch (e) {
                    enabled.checked = !enabled.checked;   // не сохранилось — не врём галочкой
                    toast((e && e.message) || tr('Не удалось сохранить.'), 'error');
                } finally { enabled.disabled = !state.s.has_token; }
            } });
        card.appendChild(checkField(tr('Бот включён — представители добавляют врачей из Telegram'), enabled));

        card.appendChild(h('p', { style: { margin: '12px 0 6px', fontSize: '13.5px' } },
            h('b', null, tr('Как подключить бота.')), ' ',
            tr('Создайте бота в @BotFather (команда /newbot), скопируйте токен и вставьте сюда — связь проверится и бот включится сам. Это должен быть ОТДЕЛЬНЫЙ бот: не пациентский и не бот для врачей.')));
        card.appendChild(h('p', { style: { margin: '0 0 6px', fontSize: '13.5px' } },
            h('b', null, tr('Как подключиться представителю.')), ' ',
            tr('У сотрудника должна быть роль «Медпредставитель» и его номер в карточке сотрудника. Он открывает бота, нажимает «Start» и отправляет свой номер кнопкой; вы подтверждаете подключение ниже.')));
        card.appendChild(h('p', { style: { margin: '0', fontSize: '13.5px' } },
            h('b', null, tr('Что умеет бот.')), ' ',
            tr('«Добавить врача» — ФИО, телефон, специальность из списка клиники, место работы, район, тип оплаты (и номер карты при выплате на карту), всё обязательно; врач появляется во «Врачах-источниках», закреплённым за этим представителем. Если врач с таким номером уже есть, бот присылает заявку на закрепление — она появится здесь. «Мои врачи» — список врачей представителя.')));

        const actions = h('div', { class: 'row', style: { gap: '8px', marginTop: '14px', flexWrap: 'wrap' } });
        const testBtn = h('button', { class: 'btn', type: 'button', disabled: !s.has_token,
            onclick: async () => {
                await run(testBtn, async () => {
                    const res = await rpc('rep_bot_test_connection');
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
                tr('Ссылка для представителей: '), h('a', { href: link, target: '_blank', rel: 'noopener' }, link)));
        }
        actions.appendChild(h('span', { class: 'grow' }));
        if (s.has_token) {
            const clearBtn = h('button', { class: 'btn btn-danger', type: 'button',
                onclick: async () => {
                    if (!window.confirm(tr('Удалить токен? Бот будет выключен, и представители не смогут добавлять врачей.'))) return;
                    await run(clearBtn, async () => {
                        state.s = await rpc('rep_bot_token_clear');
                        toast(tr('Токен удалён, бот выключен.'), 'info');
                        paint();
                    });
                } }, tr('Удалить токен'));
            actions.appendChild(clearBtn);
        }
        card.appendChild(actions);

        return h('div', { class: 'card', style: { marginBottom: '16px' } },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Bot', { size: 16 }), ' ', tr('Бот для медпредставителей')),
                statusTag()),
            card);
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
