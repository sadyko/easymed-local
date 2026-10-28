// DOC_RICH_FORMAT_V1 (2026-10-28) — подписанный документ кабинета с оформлением
// врача (список, таблица результата, цвет) уходит пациенту в Telegram таким же,
// как на бумаге, и без единого опасного тега.
//
// Тело документа (visit_documents.body) пишет браузер кабинета, а рисует его
// сервер: buildSheetHtml → варианты бланка → headless Chrome по file://. Здесь —
// тот же путь без Chrome: buildDocument → buildSheetHtml → stripAutoPrint, как
// в renderPdf. Варианты бланка обязаны работать без DOM — DOM здесь нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildSheetHtml } from '../../../public/js/shared/doc-render.js';
import { buildDocument } from './documents.js';
import { loadServerDocSettings, stripAutoPrint } from './render.js';

const LIST = '<ul><li>Живот мягкий</li><li>Печень у края</li></ul>';
const TABLE = '<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Результат</th></tr></thead><tbody><tr><td>HGB</td><td>140</td></tr></tbody></table>';
const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">ссылка</a> <img src=y onerror=alert(5)//';

function seed(body, docType = 'protocol') {
  const db = openDb(':memory:');
  migrate(db);
  const pid = Number(db.prepare("INSERT INTO patients (full_name, phone, mrn) VALUES ('Азизов Бахтиёр','+998 90 111 22 33','P-1')").run().lastInsertRowid);
  const id = Number(db.prepare('INSERT INTO visit_documents (patient_id, doc_type, title, body) VALUES (?,?,?,?)')
    .run(pid, docType, 'Протокол осмотра', JSON.stringify(body)).lastInsertRowid);
  return { db, pid, id };
}

function pdfHtml(db, ref, pid) {
  const doc = buildDocument(db, ref, pid);
  assert.ok(doc, 'документ не собран');
  return stripAutoPrint(buildSheetHtml({ type: doc.type, s: loadServerDocSettings(db), data: doc.data, title: doc.title, idLine: doc.idLine }));
}

test('протокол с оформлением: список, таблица и цвет — в листе для PDF; опасное вырезано', () => {
  assert.equal(typeof globalThis.document, 'undefined', 'тест должен идти без DOM');
  const { db, pid, id } = seed({
    __editor: true, patientName: 'Азизов Бахтиёр', service: 'Приём терапевта',
    exam: LIST + TABLE + XSS, conclusionText: '<span style="color: #b91c1c">Требуется контроль</span>',
    recsText: '<ol><li>Диета</li><li>Контроль через месяц</li></ol>', activeFields: ['physical_exam', 'recommendations_text', 'conclusion_text'],
  });
  const html = pdfHtml(db, 'doc:' + id, pid);
  assert.ok(html.includes('data-field="physical_exam">' + LIST + TABLE), 'осмотр без списка и таблицы');
  assert.ok(html.includes('<span style="color: #b91c1c">Требуется контроль</span>'), 'цвет потерян');
  assert.ok(html.includes('<ol><li>Диета</li><li>Контроль через месяц</li></ol>'), 'рекомендации без списка');
  assert.ok(!/<[^>]*alert\(/i.test(html) && !/alert\(2\)/.test(html) && !/javascript:/i.test(html), 'опасная разметка дошла до PDF');
  assert.ok(!/bk-add|data-add=/.test(html), 'режим редактора попал в выдачу пациенту');
});

test('заключение диагностики с оформленным описанием; прежний текстовый протокол — как был', () => {
  const diag = seed({ patientName: 'Азизов Бахтиёр', service: 'УЗИ почек', description: LIST, conclusion: 'Без патологии' }, 'diag');
  assert.ok(pdfHtml(diag.db, 'doc:' + diag.id, diag.pid).includes('data-field="instrumental_text">' + LIST), 'описание без списка');
  const old = seed({ patientName: 'Азизов Бахтиёр', exam: 'Живот <мягкий>\nПечень у края', activeFields: ['physical_exam'] });
  const html = pdfHtml(old.db, 'doc:' + old.id, old.pid);
  assert.ok(html.includes('<div class="sec-b" data-field="physical_exam">Живот &lt;мягкий&gt;\nПечень у края</div>'), 'прежний текст изменился');
});
