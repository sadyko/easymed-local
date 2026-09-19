// CRM_LINKS_V1 (2026-09-20) — КЛЮЧИ СТУПЕНЕЙ ВОРОНКИ ДЛЯ ТЕХ, КТО С НЕЙ
// РАБОТАЕТ, А НЕ РИСУЕТ ЕЁ.
//
// Миграция 077 сделала колонки канбана данными: «добавить колонку "Ждёт
// оплаты" больше не значит выпустить релиз». Но код ВОКРУГ доски продолжал
// носить копию сидового списка из восьми ключей — привязка заявок при
// регистрации, подстановка услуг в смету, ночная автоматика «Не пришёл».
// Клиника заводила свою колонку, и её заявки переставали существовать для всей
// этой автоматики: молча, без единой ошибки на экране.
//
// Правило одно: ступень определяется ВИДОМ (kind), а не именем.
//   open — заявка ещё живая;
//   won  — конверсия (ровно одна, это ограничение схемы);
//   lost — заявка потеряна.
// Скрытые колонки СЧИТАЮТСЯ: is_active решает, предлагает ли ДОСКА колонку, а
// не перестали ли быть живыми лежащие в ней заявки.
//
// Почему отдельный модуль, а не crm-settings-logic.js: тот намеренно чистый —
// без DOM, без сети, без часов (его тест импортирует модуль статически). Здесь
// же есть сеть. Разбор ответа остаётся там, у общего словаря воронки.
import { supabase } from '../supabase.js';
import { shapeConfig, FALLBACK_CONVERT_STAGE } from './crm-settings-logic.js?v=crmcfg1';

// Сидовая колонка «Не пришёл» (миграция 077). Имя здесь — не поведение, а
// предпочтение: если клиника её не трогала, автоматика попадает именно туда.
const SEED_NO_SHOW = 'no_show';

/**
 * Ключи ступеней из ответа crm_config_get. Чистая функция: тот же разбор и тот
 * же запасной вариант, что у доски (shapeConfig), поэтому ответ можно передать
 * сюда повторно, не запрашивая его второй раз.
 *
 * @returns {{open: string[], won: string, lost: string[], noShow: string|null}}
 */
export function stageKeysFrom(data) {
    const stages = shapeConfig(data).stages;
    const open = stages.filter((s) => s.kind === 'open').map((s) => s.key);
    const lost = stages.filter((s) => s.kind === 'lost').map((s) => s.key);
    const won = stages.find((s) => s.kind === 'won');
    return {
        open,
        won: won ? won.key : FALLBACK_CONVERT_STAGE,
        lost,
        // Своей колонки «Не пришёл» нет — берём первую проигрышную: угадывать
        // другую ПО ИМЕНИ хуже, чем назвать единственное, что известно.
        noShow: lost.includes(SEED_NO_SHOW) ? SEED_NO_SHOW : (lost[0] || null),
    };
}

// Воронка правится на экране настроек и за одну сессию не меняется по десять
// раз, а спрашивают её фоновые действия (регистрация, подстановка, закрытие
// строк) — по одному запросу на каждое было бы расточительством. Сохранение
// настроек сбрасывает кеш само (invalidateCrmStages).
let cached = null;
let inflight = null;

/** Ключи ступеней живой воронки. Ошибка сети — запасная воронка, не отказ. */
export async function crmStageKeys() {
    if (cached) return cached;
    if (!inflight) {
        inflight = (async () => {
            let data = null;
            try {
                const { data: cfg, error } = await supabase.rpc('crm_config_get', {});
                if (!error) data = cfg;
            } catch (e) { /* запасная воронка — молча, как у доски */ }
            cached = stageKeysFrom(data);
            inflight = null;
            return cached;
        })();
    }
    return inflight;
}

/** Воронку только что сохранили — следующий спросивший получит новую. */
export function invalidateCrmStages() { cached = null; inflight = null; }
