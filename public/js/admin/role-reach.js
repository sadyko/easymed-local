// ROLE_REACH_V1 (2026-09-06) — ЧТО РОЛЬ ВИДИТ, СЛОВАМИ.
//
// Владелец (выбрал это из трёх предложений): «tell me what a role can reach,
// in words. The hard part of roles isn't the ticks, it's knowing what a role
// ends up seeing».
//
// Экран прав показывает три десятка галочек. Из них не следует ответ на
// единственный вопрос, который человек задаёт себе, заводя лаборанта: КУДА
// этот лаборант попадёт, войдя в программу, и чего он НЕ увидит. Галочки — это
// ввод; здесь собирается вывод.
//
// ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА: ни одна строка описания не выводится из ключей
// самостоятельно. Каждый ответ спрашивается у НАСТОЯЩИХ ворот через
// previewRole() — тех самых isModuleAllowed()/patientTabLevel(), которыми
// пользуется боковое меню. Описание, посчитанное отдельно, разошлось бы с
// поведением при первой же правке ворот и врало бы уверенным голосом.
//
// ЧЕГО ЗДЕСЬ НЕТ. Права на ДАННЫЕ проверяет сервер (schema-registry.js), и они
// не выводятся из этих галочек. Поэтому итог честно говорит про экраны и
// кнопки, а не про «доступ» вообще: замок здесь не единственный, и обещать
// обратное на экране прав нельзя.

import {
    previewRole, isModuleAllowed, accessLevelFor, actorRoleCodes,
    patientTabLevel, patientTabCaps, canCreatePatient,
    PATIENT_CARD_TAB_IDS, PATIENT_TABS, INPATIENT_SCREEN_ROLES,
} from './permissions.js';
// ПЕРЕВОДЧИК ПРИХОДИТ АРГУМЕНТОМ, А НЕ ИМПОРТОМ. i18n.js трогает document на
// загрузке, и импорт превратил бы этот модуль в экранный — то есть непроверяемый
// в Node. Вид передаёт свой tr; по умолчанию слова остаются как есть.
//
// I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ: слова уровня и названия
// ролей попадают в {дырки}, а tr() ищет строку целиком и внутри собранного
// предложения ничего бы не нашёл.
const SELF = (x) => x;

/** Подписи уровня — теми же словами, что и переключатель в редакторе ролей. */
export const LEVEL_WORD = {
    viewer: 'только просмотр',
    editor: 'просмотр и изменение',
    admin:  'изменение и удаление',
};

/** Подписи уровня вкладки карты пациента. */
export const TAB_WORD = {
    none:   'закрыта',
    view:   'только просмотр',
    edit:   'просмотр и изменение',
    delete: 'изменение и удаление',
};

/**
 * Экраны, которые ключ открывает, но человек увидит их, только если ОН САМ
 * нужной роли: лист назначений ведёт врач, задачи и порционник — медсестра,
 * выписку оформляет старшая. Это не дубль правила, а его чтение: сам список
 * ролей берётся из permissions.js (INPATIENT_SCREEN_ROLES), а здесь только
 * человеческие названия ролей для этой подписи.
 */
const ROLE_WORD = {
    admin: 'администратор', registrar: 'регистратор', doctor: 'врач',
    nurse: 'медсестра', cashier: 'кассир', lab: 'лаборант', inventory: 'склад',
    callcenter: 'колл-центр', head_doctor: 'главный врач', senior_nurse: 'старшая медсестра',
};

/**
 * Куда попадёт сотрудник, войдя в программу.
 *
 * Правило повторяет admin.js firstAllowedView() (ROLE_HOME_V1): роль admin с
 * открытым дашбордом входит в «Дашборд», остальные — в первый доступный пункт
 * меню. Оно продублировано ЗДЕСЬ намеренно и прикрыто тестом, который читает
 * admin.js: вынести его в общий модуль значило бы тянуть оболочку в вид
 * настроек (круговая зависимость), а молча разойтись с ней — обещать не тот
 * экран. actorRoleCodes() внутри previewRole() отвечает именем ПРЕДПРОСМОТРЕННОЙ
 * роли (rememberRoles), так что «admin» здесь — та роль, что на экране.
 */
export function landingScreen(navIds) {
    if (actorRoleCodes().includes('admin') && isModuleAllowed('dashboard')) return { id: 'dashboard', kind: 'nav' };
    for (const id of navIds) if (isModuleAllowed(id)) return { id, kind: 'nav' };
    return null;
}

/**
 * Полное описание доступа роли.
 *
 * @param roleRow   строка роли: { name, permissions: { sections, levels, patient_tabs } }
 * @param navIds    идентификаторы пунктов меню В ПОРЯДКЕ МЕНЮ
 * @param labelOf   (navId) => подпись пункта меню на языке интерфейса
 */
export function roleReach(roleRow, navIds, labelOf, translate) {
    const label = (id) => (labelOf ? labelOf(id) : id);
    const tr = translate || SELF;
    return previewRole(roleRow, () => {
        const opens = [], closed = [], conditional = [];
        for (const id of navIds) {
            if (!isModuleAllowed(id)) { closed.push({ id, label: label(id) }); continue; }
            const need = INPATIENT_SCREEN_ROLES[id];
            const entry = { id, label: label(id), level: accessLevelFor(id) };
            if (need && need.length) {
                entry.roles = need.map((r) => tr(ROLE_WORD[r] || r));
                conditional.push(entry);
            } else {
                opens.push(entry);
            }
        }

        // Вкладки карты пациента перечисляются ТОЛЬКО когда они ограничены:
        // список из шести строк «полный доступ» ничего не сообщает и прячет
        // единственную важную строку среди пяти неважных.
        const tabs = [];
        for (const id of PATIENT_CARD_TAB_IDS) {
            const lvl = patientTabLevel(id);
            const caps = patientTabCaps(id);
            const full = caps.del ? 'delete' : (caps.edit ? 'edit' : 'view');
            if (lvl !== full) {
                const t = PATIENT_TABS.find((x) => x.id === id);
                tabs.push({ id, label: (t && t.label) || id, level: lvl });
            }
        }

        const landing = landingScreen(navIds);
        return {
            name: (roleRow && roleRow.name) || '',
            opens,
            conditional,
            closed,
            tabs,
            canCreatePatient: canCreatePatient(),
            landing: landing ? { ...landing, label: label(landing.id) } : null,
        };
    });
}

/**
 * То же самое — готовыми предложениями, {в дырках} значения.
 * Вид переводит шаблон и подставляет: строки собираются на экране, а не здесь.
 */
export function reachSentences(reach, translate) {
    const tr = translate || SELF;
    const out = [];
    if (!reach.opens.length && !reach.conditional.length) {
        out.push({ tone: 'crit', template: 'Роль не открывает ни одного раздела — сотрудник не сможет работать.' });
        return out;
    }
    out.push(reach.landing
        ? { tone: 'plain', template: 'После входа открывается: {screen}.', params: { screen: reach.landing.label } }
        : { tone: 'crit', template: 'Открывать после входа нечего — сотрудник упрётся в пустой экран.' });

    out.push({
        tone: 'ok',
        template: 'Открыто разделов: {n} — {list}.',
        params: {
            n: reach.opens.length,
            list: reach.opens.map((m) => m.label + ' (' + tr(LEVEL_WORD[m.level] || m.level) + ')').join(', '),
        },
    });

    for (const c of reach.conditional) {
        out.push({
            tone: 'warn',
            template: '{screen} откроется только сотруднику с ролью: {roles}.',
            params: { screen: c.label, roles: c.roles.join(', ') },
        });
    }

    if (reach.closed.length) {
        out.push({
            tone: 'plain',
            template: 'Закрыто разделов: {n} — {list}.',
            params: { n: reach.closed.length, list: reach.closed.map((m) => m.label).join(', ') },
        });
    }

    for (const t of reach.tabs) {
        out.push({
            tone: t.level === 'none' ? 'warn' : 'plain',
            template: 'Карта пациента, вкладка «{tab}»: {level}.',
            params: { tab: tr(t.label), level: tr(TAB_WORD[t.level] || t.level) },
        });
    }

    if (!reach.canCreatePatient) {
        out.push({ tone: 'plain', template: 'Заводить новых пациентов эта роль не может.' });
    }
    return out;
}
