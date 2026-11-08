// AI_CHAT_V1 — общее у двух чатов («Чат с пациентами» и «Чат Facebook и
// Instagram»): чип «Отвечает ИИ / Отвечают операторы» в шапке и отметки
// «Нужен оператор» в списке. Живёт отдельным модулем, а не в одном из экранов:
// иначе экран Meta тянул бы за собой весь экран Telegram.
import { supabase } from '../supabase.js';
import { h } from './ui.js';
import { tr } from './i18n.js';
import { commerceToolLevel } from './permissions.js';

// Чип запрашивается один раз при открытии экрана и только у того, кому строка
// «ИИ-помощник» открыта: остальным сервер ответил бы отказом, а отказ в шапке
// чата — шум. Любой сбой — чипа просто нет, чат работает как раньше.
export function aiStatusChip() {
    if (commerceToolLevel('commerce_ai') === 'none') return null;
    const chip = h('span', { class: 'ai-state', hidden: true, 'data-ai-status': '' });
    (async () => {
        try {
            const { data, error } = await supabase.rpc('ai_settings_get', {});
            if (error || !data || typeof data !== 'object') return;
            const on = !!data.enabled;
            chip.className = 'ai-state ' + (on ? 'is-on' : 'is-off');
            chip.textContent = on ? tr('Отвечает ИИ') : tr('Отвечают операторы');
            chip.hidden = false;
        } catch (_) { /* без чипа */ }
    })();
    return chip;
}

// Отметки «Нужен оператор» одного канала ('telegram' | 'meta_dm' |
// 'meta_comment') — множество 'channel:chat_key'. Список чатов перечитывается
// каждые 10–15 секунд, а отметка — событие редкое: ответ сервера держим 30 с,
// чаще не спрашиваем. Отказ, сбой или ответ не той формы — пустое множество,
// без падения, и в кэш не попадает: следующая загрузка спросит снова.
export const AI_FLAGS_TTL_MS = 30000;
let flagsCache = null;   // { at, data } — последний удачный ответ ai_flags

/** Для тестов: забыть закэшированные отметки. */
export function __resetAiFlagsCache() { flagsCache = null; }

export async function loadAiFlags(channels, now = Date.now()) {
    const want = new Set([].concat(channels));
    const pick = (data) => new Set(data.filter((f) => f && want.has(f.channel)).map((f) => f.channel + ':' + String(f.chat_key)));
    if (flagsCache && now - flagsCache.at < AI_FLAGS_TTL_MS) return pick(flagsCache.data);
    try {
        const { data, error } = await supabase.rpc('ai_flags', {});
        if (error || !Array.isArray(data)) return new Set();
        flagsCache = { at: now, data };
        return pick(data);
    } catch (_) { return new Set(); }
}
