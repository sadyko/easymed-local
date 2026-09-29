// REFERRAL_BILL_V1 (2026-09-29) — АКТ ПО СЧЁТУ ПЛАТЕЛЬЩИКА ОДНОЙ СБОРКОЙ
// (payer-act.js) у мастера визита и у кассы.
//
// Решение владельца «Card's payer, can split»: касса выставляет строки «Ждут
// счёта» плательщику из карты и печатает АКТ — тот же, что печатает мастер
// визита по счёту плательщика (AKT_DOC_V1). Сборка вынесена из замыкания
// мастера, а не скопирована; здесь — что она собирает, и что мастер ею
// пользуется, а своей копии не держит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actSheet, printInvoiceAct, isDmsPayer } from '../views/payer-act.js';
import { buildSheetHtml } from '../../shared/doc-render.js';
import { dateNumeric } from '../../shared/date-words.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', 'views', f), 'utf8');

test('isDmsPayer: страховая (и пустой вид) — по полису; организация и госпрограмма — по договору', () => {
  assert.equal(isDmsPayer({ kind: 'insurance' }), true);
  assert.equal(isDmsPayer({ kind: 'DMS' }), true);
  assert.equal(isDmsPayer({ kind: '' }), true);
  assert.equal(isDmsPayer({ kind: 'corporate' }), false);
  assert.equal(isDmsPayer({ kind: 'government' }), false);
});

test('actSheet: бланк «act» — шапка, пациент, плательщик, полис или договор, строки и талоны как переданы', () => {
  const items = [{ name: 'Анализ крови · Иванов', qty: 1, price: 40000 }];
  const queue = [{ service: 'Анализ крови', label: 'Лаборатория', number: 12 }];
  const dms = actSheet({ invoice: { id: 7, invoice_number: 'INV-A-26-00007' }, payer: { name: 'Esado', kind: 'insurance' },
    patient: { full_name: 'Рахимов Жасур', mrn: 'A-15' }, visitDay: '2026-09-29', policyNo: ' POL-77 ', items, queue });
  assert.equal(dms.type, 'act');
  assert.equal(dms.idLine, 'АКТ INV-A-26-00007');
  assert.equal(dms.data.docNo, 'АКТ INV-A-26-00007');
  assert.equal(dms.data.coverage, 'По полису ДМС');
  assert.equal(dms.data.issueDate, 'Дата ' + dateNumeric(new Date()));
  assert.deepEqual(dms.data.patient, [['ФИО', 'Рахимов Жасур'], ['Карта №', 'A-15'], ['Дата услуг', '29.09.2026']]);
  assert.deepEqual(dms.data.payer, [['Организация', 'Esado'], ['Полис', 'POL-77'], ['Покрытие', '100% от суммы акта']]);
  assert.equal(dms.data.items, items);
  assert.equal(dms.data.queue, queue);
  const corp = actSheet({ invoice: { id: 8, invoice_number: 'INV-A-26-00008' }, payer: { name: 'Cenergo', kind: 'corporate' }, patient: {}, visitDay: '2026-09-29' });
  assert.equal(corp.data.coverage, 'По договору');
  assert.deepEqual(corp.data.payer[1], ['Договор', 'счёт INV-A-26-00008']);
  // Бланк собирается — это и есть акт, который печатают мастер и касса.
  const html = buildSheetHtml({ type: 'act', s: { clinicName: 'Novo' }, data: dms.data });
  assert.match(html, /Акт оказанных медицинских услуг/);
  assert.match(html, /Esado/);
  assert.match(html, /40\s?000/);
});

test('printInvoiceAct (касса): строки — позиции счёта сервера с исполнителем и скидкой строки, талоны — по строкам этого счёта', async () => {
  const seen = [];
  const supabase = {
    from(table) {
      const q = { table, filters: [] };
      const b = {
        select() { return b; },
        in(col, val) { q.filters.push([col, val]); return b; },
        then(res) {
          seen.push(q);
          const data = table === 'visit_services'
            ? [{ id: 401, invoice_item_id: 911, services: { name: 'Анализ крови' }, doctor_id: { full_name: 'Иванов Врач', role: 'doctor' } },
               { id: 402, invoice_item_id: 912, services: { name: 'УЗИ' }, doctor_id: null }]
            : [];
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return b;
    },
    rpc(name, args) {
      seen.push({ rpc: name, args });
      return Promise.resolve({ data: (args.p_ids || []).map((id) => ({ visit_service_id: id, label: 'Лаборатория', number: 12, queue_key: 'lab' })), error: null });
    },
  };
  const sheets = [];
  await printInvoiceAct({
    supabase, printableSheet: (x) => sheets.push(x),
    invoice: { id: 91, invoice_number: 'INV-A-26-00091', payer_id: 5 },
    items: [
      { id: 911, description: 'Анализ крови', quantity: 1, unit_price: 40000, total: 40000, discount_amount: 0 },
      { id: 912, description: 'УЗИ', quantity: 2, unit_price: 50000, total: 100000, discount_amount: 20000 },
    ],
    payer: { name: 'Esado', kind: 'insurance' }, patient: { full_name: 'Рахимов Жасур', mrn: 'A-15' }, visitDay: '2026-09-29', policyNo: 'POL-77',
  });
  assert.equal(sheets.length, 1, 'акт напечатан один раз');
  const d = sheets[0].data;
  assert.equal(sheets[0].type, 'act');
  assert.deepEqual(d.items.map((it) => [it.name, it.qty, it.price, it.disc]),
    [['Анализ крови · Иванов Врач', 1, 40000, 0], ['УЗИ', 2, 50000, 20]], 'исполнитель у строки, скидка строки — в процентах');
  assert.deepEqual(d.queue.map((q) => [q.service, q.number]), [['Анализ крови', 12], ['УЗИ', 12]]);
  assert.deepEqual(seen.find((x) => x.table === 'visit_services').filters, [['invoice_item_id', [911, 912]]], 'строки — только этого счёта');
  assert.deepEqual(d.payer[1], ['Полис', 'POL-77']);
});

test('мастер визита печатает акт общей сборкой и своей копии бланка не держит', () => {
  const wiz = read('visit-wizard.js');
  const at = wiz.indexOf('function printAkt(');
  assert.ok(at > 0);
  const fn = wiz.slice(at, wiz.indexOf('\n    }\n', at));
  assert.match(fn, /printableSheet\(actSheet\(\{/, 'мастер зовёт actSheet');
  assert.ok(!wiz.includes('Акт оказанных медицинских услуг'), 'в мастере осталась копия бланка акта');
  assert.ok(!/const isDmsPayer\s*=/.test(wiz), 'в мастере осталась копия isDmsPayer');
  assert.match(wiz, /import \{ actSheet, isDmsPayer \} from '\.\/payer-act\.js\?v=act1'/);
  const desk = read('cashier-desk.js');
  assert.match(desk, /import \{ printInvoiceAct \} from '\.\/payer-act\.js\?v=act1'/, 'касса печатает тот же акт');
});
