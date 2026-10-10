// SERVICES_PACKAGES_V1 — строка визита в тесте — так, как её заводит дверь
// /api/db (routes/db.js): строке из пакета сервер ставит цену без скидки и
// цену в пакете (domain/package-lines.js stampPackageLines). Тест, вставляющий
// строку пакета голым SQL, получил бы строку без записанной цены — обычную.
import { stampPackageLines } from '../services/domain/package-lines.js';

/** Вставляет строку visit_services (объект колонка → значение) с ценой пакета; возвращает id. */
export function insertVisitLine(db, values) {
  const row = { ...values };
  stampPackageLines(db, row);
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO visit_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
