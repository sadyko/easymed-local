// ADMISSION_NUMBER_V2 — номер истории болезни «2026/00051».
//
// Владелец: «make numeration properly like this 2026/00051». Раньше номер был
// «ADM-» + id строки: сквозной на всю жизнь базы и ничего не говорящий. Теперь —
// год и пятизначный счётчик, который начинается заново каждый январь: так
// нумеруют истории в стационарах, и так выглядит № на бланке 003.
//
// Счётчик берётся из УЖЕ ВЫДАННЫХ номеров этого года (а не из id и не из
// отдельной таблицы): удалённых заявок нет (их отменяют), поэтому дыр не
// бывает, а два здания с общей базой не разойдутся. Старые «ADM-…» остаются
// как есть — они уже напечатаны на бумагах.
export function nextAdmissionNo(db, atIso = null) {
  const year = String(atIso || new Date().toISOString()).slice(0, 4);
  const row = db.prepare(`
    SELECT admission_no FROM admissions
     WHERE admission_no LIKE ?
     ORDER BY CAST(substr(admission_no, 6) AS INTEGER) DESC
     LIMIT 1`).get(year + '/%');
  const last = row && /^\d{4}\/\d+$/.test(row.admission_no) ? parseInt(row.admission_no.slice(5), 10) : 0;
  return year + '/' + String(last + 1).padStart(5, '0');
}
