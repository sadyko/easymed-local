// EXTERNAL_LAB_V1 — подпись «Внешняя лаборатория».
//
// Владелец: «tick the "внешняя лаборатория" … for the lab services which is
// provided in the another clinic but result inputted in our system»; на вопрос,
// что отметка меняет: «nothing, as it is but labeled as external lab».
//
// Поэтому это ТОЛЬКО подпись: одна функция, которую зовут список услуг,
// очередь лаборатории, ввод результатов и вкладка «Лаборатория» карты
// пациента. Ни одно действие, цена или печать от отметки не зависят.
import { Tag } from './ui.js';

/** Отмечена ли услуга (строка services или её embed) как внешняя лаборатория. */
export function isExternalLab(svc) {
    return !!(svc && Number(svc.external_lab) === 1);
}

/** Бейдж «Внешняя лаборатория» или null, если отметки нет. */
export function externalLabTag(svc) {
    if (!isExternalLab(svc)) return null;
    const t = Tag('Внешняя лаборатория', { kind: 'purple' });
    t.setAttribute('data-external-lab', '1');
    t.style.marginLeft = '8px';
    return t;
}
