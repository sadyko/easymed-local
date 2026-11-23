// AI_CHAT_V1 — экран «ИИ-помощник» (#commerce-ai): один переключатель «ИИ
// отвечает в чатах» для Telegram, Facebook и Instagram и честное состояние.
//
// Главный переключатель — «отвечает ли ИИ клинике». AI_OWN_KEY_V1 (2026-11-18): под
// ним — функции по одной и свой ключ OpenAI. Владелец: «first permission to use this
// block from settings.easymed.uz/cp, then key putting mirror should be opened with
// functions … Meta answering, analyzing call record and so on». Модуль по-прежнему
// подключает вендор; без него этот экран не открывается (locked-module.js).
//
// Всё, что мешает ИИ ответить, сказано словами прямо под переключателем:
// лимит месяца, неподключённый модуль, пустой список услуг (A8). Иначе
// включённый, но молчащий ИИ выглядит поломкой.
import { supabase } from '../../supabase.js';
import { h, PageHead, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { commerceToolLevel, actorIsAdmin } from '../permissions.js';
import { aiStateOf } from '../ai-chat-marks.js';

const BLOCKED_TEXT = {
    limit: 'Месячный лимит ИИ исчерпан — новые чаты получают операторы. Обратитесь к менеджеру Easy-Med.',
    no_module: 'Модуль «ИИ-помощник» не подключён. Обратитесь к менеджеру Easy-Med.',
    // AI_OWN_KEY_V1 — свой ключ OpenAI не принят или на счёте OpenAI нет денег.
    bad_key: 'OpenAI не принял ключ клиники или на его счёте нет средств — ИИ остановлен. Проверьте ключ ниже.',
};

// AI_OWN_KEY_V1 — функции ИИ по одной (ключи — каналы задач, server/services/ai/own-key.js).
const FEATURES = [
    { key: 'telegram', title: 'Ответы в Telegram', desc: 'Отвечает пациентам в Telegram-боте клиники.' },
    { key: 'meta_dm', title: 'Ответы в сообщениях Facebook и Instagram', desc: 'Отвечает в личных сообщениях страницы клиники.' },
    { key: 'meta_comment', title: 'Ответы на комментарии Facebook и Instagram', desc: 'Под комментарием — короткая фраза, сам ответ — в личные сообщения.' },
    // AI_CALLS_V1 — звук уходит в OpenAI напрямую, поэтому только со своим ключом клиники.
    { key: 'calls', title: 'Анализ записей звонков', needsKey: true,
      desc: 'Расшифровывает каждый отвеченный звонок, пишет краткое содержание и оценку оператора, заводит заявку, если пациент хотел записаться и не записался. Разбираются звонки после включения.' },
];

// A8: ИИ отвечает только тем, что клиника показывает на сайте. Ноль услуг —
// ИИ на любой вопрос о цене зовёт оператора, и владелец должен узнать это
// здесь, а не из жалоб.
// AI_CALLS_V1 — цвет оценки: от 80 — хорошо, от 50 — средне, ниже — плохо.
export const scoreClass = (n) => (Number(n) >= 80 ? 'is-good' : Number(n) >= 50 ? 'is-mid' : 'is-low');

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
        if (hasModule) {
            body.appendChild(featuresSection());
            body.appendChild(keySection());
            if (state && state.features && state.features.calls === true) body.appendChild(scoresSection());
        }
    };

    // AI_OWN_KEY_V1 — функции по одной. Выключенная функция не берёт новые сообщения;
    // остальные работают, пока включён главный переключатель.
    function featuresSection() {
        const f = (state && state.features) || {};
        const list = h('div', { class: 'ai-features' });
        const keySet = !!(state && state.own_key && state.own_key.set);
        for (const it of FEATURES) {
            // AI_CALLS_V1 — функция «со своим ключом» без ключа включиться не может (выключить — всегда).
            const locked = it.needsKey && !keySet && f[it.key] !== true;
            const cb = h('input', { type: 'checkbox', class: 'ai-switch-input', checked: f[it.key] === true || (f[it.key] !== false && !it.needsKey), disabled: !canEdit || locked, role: 'switch', 'data-ai-feature': it.key, 'aria-label': tr(it.title) });
            cb.addEventListener('change', () => saveFeature(it.key, cb.checked));
            list.appendChild(h('label', { class: 'ai-switch ai-feature' }, cb,
                h('span', { class: 'ai-switch-text' }, h('strong', null, it.title), h('span', { class: 'muted' }, it.desc),
                    locked ? h('span', { class: 'ai-feature-need' }, 'Нужен свой ключ OpenAI — ниже.') : null)));
        }
        return h('section', { class: 'ai-section', 'data-ai-features': '' }, h('h3', { class: 'ai-section-h' }, 'Функции'), list);
    }

    // AI_OWN_KEY_V1 — свой ключ OpenAI. Есть ключ — клиника спрашивает ChatGPT сама и
    // платит OpenAI напрямую; нет — отвечает сервер Easy-Med. Сам ключ на экран не
    // возвращается никогда: только последние 4 знака.
    function keySection() {
        const k = (state && state.own_key) || {};
        const admin = actorIsAdmin();
        const sec = h('section', { class: 'ai-section', 'data-ai-key': '' }, h('h3', { class: 'ai-section-h' }, 'Ключ OpenAI (ChatGPT)'));
        sec.appendChild(h('p', { class: 'muted ai-note' }, k.set
            ? trf('Ответы даёт ChatGPT по ключу клиники ···{tail}, модель {model}.', { tail: k.tail || '', model: k.model || '' })
            : tr('Ключа нет — ответы даёт сервер Easy-Med. Вставьте ключ OpenAI, чтобы ChatGPT отвечал от имени клиники за её счёт.')));
        if (!admin) { sec.appendChild(h('p', { class: 'muted ai-note' }, 'Ключ вводит и меняет только администратор.')); return sec; }
        const key = h('input', { type: 'password', class: 'input ai-key-input', placeholder: k.set ? tr('Новый ключ sk-…') : 'sk-…', autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('Ключ OpenAI'), 'data-ai-key-input': '' });
        const model = h('input', { type: 'text', class: 'input ai-model-input', value: k.set ? (k.model || '') : '', placeholder: k.default_model || 'gpt-4o-mini', 'aria-label': tr('Модель'), 'data-ai-model-input': '' });
        const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-ai-key-save': '' }, k.set ? 'Заменить ключ' : 'Сохранить ключ');
        saveBtn.addEventListener('click', async () => {
            if (saveBtn.disabled) return;
            saveBtn.disabled = true;
            const { data, error } = await supabase.rpc('ai_key_save', { key: key.value, model: model.value });
            saveBtn.disabled = false;
            if (error) { toast(tr(error.message || 'Не удалось сохранить.'), 'error'); return; }
            state = data || {}; paint();
            toast(state.key_check === 'offline' ? 'Ключ сохранён. Проверить его у OpenAI не удалось — нет связи; проверит первый ответ.' : 'Ключ принят OpenAI и сохранён.', state.key_check === 'offline' ? 'warn' : 'success');
        });
        const row = h('div', { class: 'ai-key-row' },
            h('label', { class: 'ai-key-field' }, h('span', { class: 'muted' }, 'Ключ'), key),
            h('label', { class: 'ai-key-field ai-key-model' }, h('span', { class: 'muted' }, 'Модель'), model),
            saveBtn);
        sec.appendChild(row);
        if (k.set) {
            const del = h('button', { type: 'button', class: 'btn btn-ghost', 'data-ai-key-clear': '' }, 'Удалить ключ');
            del.addEventListener('click', async () => {
                const { data, error } = await supabase.rpc('ai_key_clear', {});
                if (error) { toast(tr(error.message || 'Не удалось сохранить.'), 'error'); return; }
                state = data || {}; paint();
                toast('Ключ удалён — ответы снова даёт сервер Easy-Med.', 'success');
            });
            sec.appendChild(del);
        }
        sec.appendChild(h('p', { class: 'muted ai-note' }, 'Ключ хранится в базе клиники зашифрованным; на экране — только последние 4 знака.'));
        return sec;
    }

    // AI_CALLS_V1 — средняя оценка операторов за 30 дней (по разобранным звонкам).
    function scoresSection() {
        const sec = h('section', { class: 'ai-section', 'data-ai-scores': '' }, h('h3', { class: 'ai-section-h' }, 'Оценки операторов за 30 дней'));
        const holder = h('div', null, h('p', { class: 'muted ai-note' }, 'Загрузка…'));
        sec.appendChild(holder);
        (async () => {
            const { data, error } = await supabase.rpc('ai_call_scores', { days: 30 });
            clear(holder);
            if (error) { holder.appendChild(h('p', { class: 'ai-blocked' }, tr(error.message || ''))); return; }
            const ops = (data && data.operators) || [];
            if (!ops.length) { holder.appendChild(h('p', { class: 'muted ai-note' }, 'Разобранных звонков пока нет. Первые появятся через несколько минут после разговора.')); return; }
            const tb = h('tbody');
            for (const o of ops) {
                tb.appendChild(h('tr', null,
                    h('td', null, o.operator_name || (o.ext ? trf('Внутренний {ext}', { ext: o.ext }) : tr('Оператор не опознан'))),
                    h('td', { class: 'num' }, String(o.calls)),
                    h('td', { class: 'num' }, h('span', { class: 'ai-score ' + scoreClass(o.avg_score) }, String(o.avg_score) + '%')),
                    h('td', { class: 'num' }, String(o.missed_bookings || 0))));
            }
            holder.appendChild(h('table', { class: 'tbl' },
                h('thead', null, h('tr', null, h('th', null, 'Оператор'), h('th', { class: 'num' }, 'Звонков'), h('th', { class: 'num' }, 'Средняя оценка'), h('th', { class: 'num' }, 'Хотели записаться, не записаны'))),
                tb));
        })();
        return sec;
    }

    async function saveFeature(key, on) {
        const { data, error } = await supabase.rpc('ai_settings_save', { features: { [key]: on } });
        if (error) { toast(tr('Не удалось изменить переключатель.') + ' ' + tr(error.message || ''), 'error'); paint(); return; }
        state = data || {}; paint();
    }
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
