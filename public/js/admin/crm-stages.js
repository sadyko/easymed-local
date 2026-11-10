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
import { roleKey } from '../shared/crm-booked-stage.js';   // CRM_STAGE_ROLES_V1

// Сидовая колонка «Не пришёл» (миграция 077). Имя здесь — не поведение, а
// предпочтение: если клиника её не трогала, автоматика попадает именно туда.
// CRM_STAGE_ROLES_V1 — только для ответа сервера без ролей (старше экрана).
const SEED_NO_SHOW = 'no_show';

/**
 * Ключи ступеней из ответа crm_config_get. Чистая функция: тот же разбор и тот
 * же запасной вариант, что у доски (shapeConfig), поэтому ответ можно передать
 * сюда повторно, не запрашивая его второй раз.
 *
 * @returns {{open: string[], won: string, lost: string[], noShow: string|null}}
 */
export function stageKeysFrom(data) {
    const cfg = shapeConfig(data);
    const stages = cfg.stages;
    const lostKind = stages.filter((s) => s.kind === 'lost').map((s) => s.key);
    // Своей колонки «Не пришёл» нет — берём первую проигрышную: угадывать
    // другую ПО ИМЕНИ хуже, чем назвать единственное, что известно.
    // CRM_STAGE_ROLES_V1 — колонка с ролью «не пришёл» (null — роли нет); догадка выше —
    // только у сервера без ролей.
    const noShow = cfg.hasRoles ? roleKey(stages, 'no_show') : (lostKind.includes(SEED_NO_SHOW) ? SEED_NO_SHOW : (lostKind[0] || null));
    // CRM_NO_SHOW_ANY_COLUMN_V1 (3.23.0) — колонка «Не пришёл» бывает открытой: для работы с
    // воронкой она «Не пришёл», не живая (как у сервера, config.js openStageKeys / lostStageKeys).
    const open = stages.filter((s) => s.kind === 'open' && s.key !== noShow).map((s) => s.key);
    const lost = noShow && !lostKind.includes(noShow) ? [...lostKind, noShow] : lostKind;
    const won = stages.find((s) => s.kind === 'won');
    return {
        open,
        won: won ? won.key : FALLBACK_CONVERT_STAGE,
        lost,
        noShow,
    };
}

// Воронка правится на экране настроек и за одну сессию не меняется по десять
// раз, а спрашивают её фоновые действия (регистрация, подстановка, закрытие
// строк) — по одному запросу на каждое было бы расточительством. Сохранение
// настроек сбрасывает кеш само (invalidateCrmStages).
let cached = null;
let inflight = null;

/**
 * Ключи ступеней живой воронки. Ошибка сети — запасная воронка, не отказ.
 *
 * ЗАПАСНАЯ ВОРОНКА НЕ КЕШИРУЕТСЯ. Кеш здесь для НАСТРОЕННОЙ воронки: её правят
 * раз в месяц, а спрашивают все фоновые действия. Оседавший в нём запасной
 * вариант означал, что одна неудачная попытка — сервер ещё поднимается, сеть
 * моргнула — оставляла вкладку до перезагрузки с сидовыми восемью колонками. У
 * клиники со своей воронкой это значит, что её колонок не существует: заявки в
 * них не привязываются к новой карте и не подставляются в смету. Отказ
 * отвечает запасной воронкой ОДИН раз, а следующий спросивший спрашивает
 * заново.
 */
export async function crmStageKeys() {
    if (cached) return cached;
    if (!inflight) {
        inflight = (async () => {
            let data = null, failed = false;
            try {
                const { data: cfg, error } = await supabase.rpc('crm_config_get', {});
                if (error) failed = true; else data = cfg;
            } catch (e) { failed = true; /* запасная воронка — молча, как у доски */ }
            const keys = stageKeysFrom(data);
            inflight = null;
            if (!failed) cached = keys;
            return keys;
        })();
    }
    return inflight;
}

/** Воронку только что сохранили — следующий спросивший получит новую. */
export function invalidateCrmStages() { cached = null; inflight = null; }
