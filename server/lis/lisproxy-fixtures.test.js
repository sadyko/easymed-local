// LIS_PROXY_V1 — КАЖДАЯ запись harness\fixtures.json (тела, снятые с настоящего
// lisproxyd.exe 2026-10-09) через настоящее приложение: статус, ответ, строка
// журнала, бланк — по «expect» фикстуры и дизайну
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 10). Клиника —
// seedLisProxyClinic: № 123 Биохимия (GLU) на bs200, № 555 ОАК (WBC, HGB) на
// bc780x, № 777 B12 (214) на lumo; № 900001 — открытый свежий заказ другого
// пациента. Каждая запись — со свежей базой, кроме серии BC-780 (две подряд).
// Ответ apiResultSave — ровно «Ok» на любой исход (Р23, LIS-API.md §2); «{}» в
// expect фикстур — это ORDER_NOT_FOUND (Р26: {} или «Order not found»).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROXY_QUIET_PREFIX, PROXY_NOT_TUBE } from './lisproxy-form.js';
import { ORDER_NOT_FOUND, replyText } from './lisproxy.js';
import { NOT_FOUND } from '../routes/lisproxy.js';
import { FIXTURES, freshDb, seedLisProxyClinic, startProxyApp, post, rows, lastRow, tray, blank } from '../test-helpers/lisproxy-clinic.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';   // LIS_PROXY_V1 — стенд получает listen от теста

const NOTHING = replyText(ORDER_NOT_FOUND);

async function run(ids, check) {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db, { listen });
  try {
    const out = [];
    for (const [group, id] of ids) {
      const f = FIXTURES[group].find((x) => x.id === id);
      const res = await post(app.url, f.body);
      out.push({ status: res.status, text: await res.text(), row: lastRow(db), body: f.body });
    }
    await check(db, out, app);
  } finally { await app.close(); db.close(); }
}

const EXPECT = {
  results: {
    bs200_glu: (db, [r]) => {
      assert.deepEqual([r.row.status, r.row.visit_service_id], ['applied', 123]);
      assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    },
    bs200_patient_number_as_barcode: (db, [r]) => {
      assert.deepEqual([r.row.status, r.row.visit_service_id], ['unmatched', null]);
      assert.ok(r.row.detail.startsWith(PROXY_NOT_TUBE + ': PATNUM9'));
    },
    bs200_bare_digits: (db, [r]) => {
      assert.deepEqual([r.row.status, r.row.visit_service_id], ['unmatched', null]);
      assert.deepEqual(blank(db, 900001), {}, 'открытый свежий заказ № 900001 другого пациента не тронут');
    },
    bc780_wbc: (db, [r]) => {
      assert.equal(r.row.visit_service_id, 555);
      assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63' });
    },
    bc780_hgb: (db, [r]) => {
      assert.equal(r.row.visit_service_id, 555);
      assert.deepEqual(blank(db, 555), { 'Гемоглобин': '132' });
    },
    bc780_junk_IS_empty: (db, [r]) => quiet(db, r),
    bc20_take_mode: (db, [r]) => quiet(db, r),
    bc20_test_mode: (db, [r]) => quiet(db, r),
    bc20_pv1_dept_as_barcode: (db, [r]) => {
      assert.equal(r.row.status, 'unmatched');
      assert.match(r.row.detail, /Therapy\^\^12 — проверьте тип анализатора в LIS Proxy/);
    },
    bc20_loinc_as_barcode: (db, [r]) => assert.equal(r.row.status, 'unmatched'),
    bc20_empty_barcode: (db, [r]) => assert.match(r.row.detail, /\(пусто\)/),
    lumo_truncated_barcode: (db, [r]) => {
      assert.deepEqual([r.row.status, r.row.sample_id], ['applied', 'LAB-000777']);
      assert.deepEqual(blank(db, 777), { 'Витамин B12': '28.4' });
    },
    lumo_numeric_id: (db, [r]) => assert.deepEqual([r.row.status, r.row.visit_service_id], ['unmatched', null]),
  },
  orders: {
    bs200_order: (db, [r]) => assert.deepEqual(JSON.parse(r.text),
      { 0: { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'GLU' } }),
    // Панель № 123 кормит BS-200 — у AutoLumo тот же номер ничего не получает; номер восстановлен.
    lumo_order_truncated: (db, [r]) => { assert.equal(r.text, NOTHING); assert.equal(r.row.sample_id, 'LAB-000123'); },
  },
};
function quiet(db, r) {
  assert.ok(r.row.detail.startsWith(PROXY_QUIET_PREFIX), r.row.detail);
  assert.ok(r.row.resolved_at);
  assert.deepEqual(tray(db), []);
}

for (const group of ['results', 'orders', 'lists', 'unknown']) {
  for (const f of FIXTURES[group]) {
    test(`фикстура ${group}/${f.id}: 200, строка журнала с телом как пришло — ${f.expect}`, async () => {
      await run([[group, f.id]], async (db, out) => {
        const [r] = out;
        assert.equal(r.status, 200, 'на любой исход — 200');
        assert.equal(rows(db).length, 1, 'одна строка журнала');
        assert.equal(r.row.source_body, r.body, 'тело — байт в байт');
        if (group === 'results') {
          assert.equal(r.text, 'Ok', 'apiResultSave — ровно «Ok» на любой исход (иначе прокси не шлёт остальные тесты пробы)');
        } else {
          assert.equal(r.row.kind, 'query');
          assert.ok(r.row.resolved_at, 'запрос — не в лотке');
          assert.equal(r.row.reply_body, r.text, 'в журнале — ответ, как ушёл');
          if (!(EXPECT[group] && EXPECT[group][f.id])) assert.equal(r.text, NOTHING);
        }
        const check = EXPECT[group] && EXPECT[group][f.id];
        if (check) await check(db, out);
      });
    });
  }
}

test('фикстуры BC-780 подряд: WBC, мусор IS, HGB — серия принята, лоток пуст', async () => {
  await run([['results', 'bc780_wbc'], ['results', 'bc780_junk_IS_empty'], ['results', 'bc780_hgb']], async (db, out) => {
    assert.deepEqual(out.map((o) => o.text), ['Ok', 'Ok', 'Ok']);
    assert.equal(out[2].row.status, 'applied');
    assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63', 'Гемоглобин': '132' });
    assert.deepEqual(tray(db), []);
  });
});

test('фикстуры auth: без ключа и с неверным ключом — тот же 404, что у неизвестного адреса; ничего не записано', async () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db, { listen });
  try {
    const body = FIXTURES.results[0].body;
    for (const url of [app.base + '/api/lisproxy', app.base + '/api/lisproxy?key=WRONG']) {
      const res = await post(url, body);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), JSON.stringify(NOT_FOUND));
    }
    assert.deepEqual(rows(db), []);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM lab_devices WHERE last_seen_at IS NOT NULL").get().c, 0);
  } finally { await app.close(); db.close(); }
});

test('фикстуры покрыты все: в файле нет группы без теста', () => {
  assert.deepEqual(Object.keys(FIXTURES).filter((k) => k !== '_about').sort(), ['auth', 'lists', 'orders', 'results', 'unknown']);
  assert.deepEqual(FIXTURES.auth.map((a) => a.id), ['no_key', 'wrong_key']);
});
