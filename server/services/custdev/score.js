// CUSTDEV_V1 — три оценки -> одна колонка канбана.
//
// Живёт ОТДЕЛЬНО от RPC и без обращений к базе, потому что это единственное
// место, где записано само правило, а правило должно проверяться таблицей
// комбинаций, а не фикстурой с визитами и счетами.
//
// Считается на СЕРВЕРЕ: браузер может прислать что угодно, а колонка карточки
// обязана следовать из оценок при любом клиенте.

export class ScoreError extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

// 'unrated' сюда не входит намеренно: сохранить можно только решённое.
// «Не знаю» у оператора уже есть — это 'na'.
const DECIDED = ['good', 'bad', 'na'];

const LABEL = { registrar: 'Регистратура', cashier: 'Касса', doctor: 'Врач' };

/**
 * Проверяет три оценки и выводит статус карточки.
 *
 * @param {{registrar:string, cashier:string, doctor:string, comment?:string}} args
 * @returns {{status:string, comment:string}}
 * @throws {ScoreError} с текстом, который можно показать оператору как есть
 */
export function rateOutcome({ registrar, cashier, doctor, comment } = {}) {
  const scores = { registrar, cashier, doctor };

  for (const key of ['registrar', 'cashier', 'doctor']) {
    if (!DECIDED.includes(scores[key])) {
      throw new ScoreError(`Оцените пункт «${LABEL[key]}» или отметьте его как «Не применимо».`);
    }
  }

  const applicable = Object.values(scores).filter((v) => v !== 'na');
  if (applicable.length === 0) {
    // Иначе «ноль жалоб» дало бы «Доволен» по карточке, где никого не спросили.
    throw new ScoreError('Хотя бы один пункт должен быть оценён — три «Не применимо» оценкой не являются.');
  }

  const bad = applicable.filter((v) => v === 'bad').length;
  const text = String(comment || '').trim();

  // Жалоба без причины клинике бесполезна, а оператор держит человека на линии
  // именно сейчас — второй раз спросить будет уже не у кого.
  if (bad > 0 && !text) {
    throw new ScoreError('Отметьте в комментарии, что именно не устроило пациента.');
  }

  const status = bad === 0 ? 'satisfied' : bad === 1 ? 'partial' : 'unsatisfied';
  return { status, comment: text };
}
