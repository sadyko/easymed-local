// AI_CHAT_V1 — экран «ИИ-помощник» (#commerce-ai): один переключатель «ИИ
// отвечает в чатах» для Telegram, Facebook и Instagram и честное состояние.
//
// Почему один переключатель, а не по каналу: владелец решает «отвечает ли ИИ
// клинике», а не «в каком мессенджере» — три галочки удваивали бы вопросы
// регистратуры («а почему в Instagram молчит?») без пользы.
//
// Всё, что мешает ИИ ответить, сказано словами прямо под переключателем:
// лимит месяца, неподключённый модуль, пустой список услуг (A8). Иначе
// включённый, но молчащий ИИ выглядит поломкой.
import { supabase } from '../../supabase.js';
import { h, PageHead, clear, toast } from '../ui.js';
import { tr } from '../i18n.js';
import { commerceToolLevel } from '../permissions.js';
import { aiStateOf } from '../ai-chat-marks.js';

const BLOCKED_TEXT = {
    limit: 'Месячный лимит ИИ исчерпан — новые чаты получают операторы. Обратитесь к менеджеру Easy-Med.',
    no_module: 'Модуль «ИИ-помощник» не подключён. Обратитесь к менеджеру Easy-Med.',
};

// A8: ИИ отвечает только тем, что клиника показывает на сайте. Ноль услуг —
// ИИ на любой вопрос о цене зовёт оператора, и владелец должен узнать это
// здесь, а не из жалоб.
const NO_SERVICES_TEXT = 'ИИ не знает ни одной услуги: отметьте услуги для показа на сайте в «Настройки → Услуги для сайта и партнёров»';

export async function renderAiAssistant(container) {
    clear(container);
    const root = h('div', { class: 'fade-in ai-ed', 'data-ai-assistant': '' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'ИИ-помощник',
        subtitle: 'Сам отвечает пациентам в Telegram, Facebook и Instagram: услуги, цены, врачи, адреса. Медицинские вопросы передаёт операторам.',
    }));
    const body = h('div', { class: 'card ai-card' });
    root.appendChild(body);

    const canEdit = commerceToolLevel('commerce_ai') === 'edit';
    let state = null;
    const paint = () => {
        clear(body);
        const on = !!(state && state.enabled);
        const hasModule = !!(state && state.has_module);
        const st = aiStateOf(state);
        const sw = h('input', { type: 'checkbox', class: 'ai-switch-input', checked: on, disabled: !canEdit || (!hasModule && !on), role: 'switch', 'aria-label': tr('ИИ отвечает в чатах') });
        sw.addEventListener('change', () => save(sw.checked));
        body.appendChild(h('label', { class: 'ai-switch' }, sw,
            h('span', { class: 'ai-switch-text' },
                h('strong', null, 'ИИ отвечает в чатах'),
                // Переключатель — настройка (enabled), подпись — что на деле:
                // включённый, но остановленный ИИ не отвечает (aiStateOf).
                h('span', { class: 'ai-state ' + st.cls, 'data-ai-state': st.key }, st.text))));
        // Модуля нет — говорим это, даже если сервер ещё не записал blocked:
        // выключенный переключатель без причины читается как поломка.
        const blocked = state && state.blocked && BLOCKED_TEXT[state.blocked] ? state.blocked : (!hasModule ? 'no_module' : '');
        if (blocked) body.appendChild(h('p', { class: 'ai-blocked', role: 'alert' }, BLOCKED_TEXT[blocked]));
        const facts = state && state.facts;
        if (facts && Number(facts.services) === 0) {
            body.appendChild(h('p', { class: 'ai-warn', role: 'alert', 'data-ai-no-services': '' }, NO_SERVICES_TEXT));
        }
        if (!canEdit) body.appendChild(h('p', { class: 'muted ai-note' }, 'Включает и выключает тот, у кого в «Ролях» строка «ИИ-помощник» на уровне «Изменение».'));
        body.appendChild(h('p', { class: 'muted ai-note' },
            'Когда ИИ не может ответить сам, он пишет пациенту «Сейчас подключу сотрудника клиники» и отмечает чат «Нужен оператор». В чате, где написал оператор, ИИ молчит 12 часов.'));
    };
    async function load() {
        const { data, error } = await supabase.rpc('ai_settings_get', {});
        if (error) { body.appendChild(h('p', { class: 'ai-blocked', role: 'alert' }, tr('Не удалось загрузить настройки ИИ.') + ' ' + tr(error.message || ''))); return; }
        state = data || {}; paint();
    }
    async function save(on) {
        const { data, error } = await supabase.rpc('ai_settings_save', { enabled: on });
        // 402 module_missing и прочие отказы — фразой сервера: она уже говорит,
        // к кому идти. Переключатель возвращается в прежнее положение.
        if (error) { toast(tr('Не удалось изменить переключатель.') + ' ' + tr(error.message || ''), 'error'); paint(); return; }
        state = data || {}; paint();
        toast(on ? 'ИИ отвечает в чатах.' : 'ИИ выключен — отвечают операторы.', 'success');
    }
    await load();
}
