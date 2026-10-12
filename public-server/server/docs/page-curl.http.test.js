// API_DOCS_V1 — СТРАЖ «КОМАНДА СО СТРАНИЦЫ ДАЁТ ОТВЕТ СО СТРАНИЦЫ». Из готовой
// страницы /docs (ru, uz, en) достаются блоки примеров: команда curl и ответ
// под ней. Команда разбирается обратно и уходит на настоящий сервер партнёров
// (стенд, случайный порт 127.0.0.1, мир клиники «Шифо»), по порядку страницы, с
// шагами клиники между ними; ответ сервера обязан совпасть с показанным.
import test from 'node:test';
import assert from 'node:assert/strict';
import { docsStand, exampleRequest, sendExample, trimmed, resolve, CLINIC_STEPS } from '../test-helpers/docs-run.js';
import { renderDocs, DOCS_PAGE_LANGS } from './render.js';
import { EXAMPLES, SAMPLE } from './content.js';

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Команда curl страницы → { method, url, headers, body }. */
export function parseCurl(text) {
  const flat = text.replace(/ \\\n\s*/g, ' ');
  const m = /^curl(?: -X ([A-Z]+))? "([^"]+)"/.exec(flat);
  assert.ok(m, 'не команда curl: ' + text.slice(0, 80));
  const d = /-d '([\s\S]*)'$/.exec(flat);
  return { method: m[1] || 'GET', url: m[2], headers: [...flat.matchAll(/-H "([^"]+)"/g)].map((x) => x[1]),
    body: d ? JSON.parse(d[1].replace(/'\\''/g, "'")) : undefined };
}

/** Блоки примеров страницы по порядку: id, команда (или строка «МЕТОД путь»), код и тело ответа. */
function pageExamples(html) {
  return [...html.matchAll(/<div class="ex" data-example="([\w-]+)">([\s\S]*?)<\/div>/g)].map(([, id, inner]) => {
    const pres = [...inner.matchAll(/<pre tabindex="0"><code>([\s\S]*?)<\/code><\/pre>/g)].map((x) => unescape(x[1]));
    const status = /· (\d{3})<\/p>/.exec(inner);
    const line = /<p class="ex-h">[^<]*<code>([A-Z]+) ([^<]+)<\/code><\/p>/.exec(inner);
    const curl = pres[0] && pres[0].startsWith('curl') ? pres[0] : null;
    return { id, curl, line: line ? { method: line[1], path: unescape(line[2]) } : null,
      status: status ? Number(status[1]) : null, body: status ? JSON.parse(pres[pres.length - 1]) : null };
  });
}

const swap = (v, map) => JSON.parse(Object.entries(map).reduce((s, [a, b]) => s.split(a).join(b), JSON.stringify(v)));

test('разбор команды: метод, адрес, заголовки и тело с апострофом', () => {
  const c = parseCurl('curl -X POST "https://x/y" \\\n  -H "A: b" \\\n  -d \'{\n  "n": "O\'\\\'\'g"\n}\'');
  assert.deepEqual(c, { method: 'POST', url: 'https://x/y', headers: ['A: b'], body: { n: "O'g" } });
});

for (const lang of DOCS_PAGE_LANGS) {
  test('страница ' + lang + ': каждая команда curl на настоящем сервере даёт показанный под ней ответ', async (t) => {
    const base = SAMPLE.base;
    const blocks = pageExamples(renderDocs({ lang, base }));
    assert.deepEqual([...new Set(blocks.map((b) => b.id))].sort(), EXAMPLES.map((x) => x.id).sort(), 'каждый пример — на странице');
    const s = await docsStand();
    t.after(s.close);
    const realOf = {};    // номер страницы → настоящий
    const pageOf = {};    // настоящий → номер страницы
    let ran = 0;
    for (const b of blocks) {
      if (b.status === null) continue;   // «Начало работы»: только команда, ответ — в разделе адреса
      const ex = EXAMPLES.find((x) => x.id === b.id);
      if (CLINIC_STEPS[ex.id]) CLINIC_STEPS[ex.id](s, Object.fromEntries(Object.entries(SAMPLE.ids).map(([k, v]) => [k, realOf[v]])));
      let req;
      if (b.curl) {
        const c = parseCurl(b.curl);
        const prefix = base + '/' + SAMPLE.slug + '/v1';
        assert.ok(c.url.startsWith(prefix), c.url);
        assert.ok(c.headers.includes('Authorization: Bearer ' + SAMPLE.keyVar), 'ключ в команде — только переменная');
        if (c.body !== undefined) assert.ok(c.headers.includes('Content-Type: application/json'));
        const want = exampleRequest(ex, lang, SAMPLE.ids);
        assert.deepEqual({ method: c.method, path: c.url.slice(prefix.length), body: c.body }, { method: want.method, path: want.path, body: want.body },
          ex.id + ': команда — запрос примера');
        req = { method: c.method, path: swap(c.url.slice(prefix.length), realOf), body: c.body, wrongKey: false };
      } else {
        assert.ok(b.line, ex.id + ': нет строки запроса');
        req = { method: b.line.method, path: swap(b.line.path, realOf), body: resolve(ex.body, lang, {}), wrongKey: ex.key === 'wrong' };
      }
      const r = await sendExample(s, req);
      if (ex.saveAs && r.body.request_id) { realOf[SAMPLE.ids[ex.saveAs]] = r.body.request_id; pageOf[r.body.request_id] = SAMPLE.ids[ex.saveAs]; }
      assert.equal(r.status, b.status, ex.id + ': код ответа');
      assert.deepEqual(trimmed(swap(r.body, { ...pageOf, [SAMPLE.base]: base }), ex.trim), b.body, ex.id + ': тело ответа');
      ran += 1;
    }
    assert.equal(ran, EXAMPLES.length);
  });
}
