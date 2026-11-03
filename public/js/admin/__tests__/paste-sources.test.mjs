// PASTE_SOURCES_V1 (2026-11-02) — окно «Вставить результаты» кабинета врача
// (views/paste-sources.js): пять вкладок, разделы с галочками, ПОЛНЫЙ текст
// отмеченного, «не проверено» у анализа, «Филиал X» у результата другого
// здания, закрытая вкладка объяснена словами, файлы только открываются.
// Сервер подменён: проверяется окно, не выборка.
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import { installFakeDom, TOASTS } from './cabinet-harness.mjs';

installFakeDom();

const RPC_LOG = [];
let REPLY = null;   // { ok, status, payload } — ответ patient_doc_sources
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        RPC_LOG.push({ name, body });
        if (name === 'patient_doc_sources' && REPLY) return resp(REPLY.ok, REPLY.status, REPLY.payload);
        return resp(true, 200, { data: null });
    }
    return resp(true, 200, { data: null });
};

const PS = await import('../views/paste-sources.js');
const answer = (data) => { REPLY = { ok: true, status: 200, payload: { data } }; };
const tabBtn = (m, key) => m.overlay.querySelector('[data-paste-tab="' + key + '"]');

const FIXTURE = () => ({
    patient_id: 7,
    closed: ['files'],
    truncated: { consult: false, diag: false, labs: true, inpatient: false, files: false },
    groups: {
        consult: [{
            id: 'line:61', kind: 'consult', source: 'notes', visit_service_id: 61,
            title: 'Приём терапевта', doctor: 'Врач Тестов', at: '2026-10-05T07:00:00.000Z',
            sections: [
                { key: 'complaint', label: 'Жалобы', html: 'Кашель <b>3 дня</b>' },
                { key: 'hpi', label: 'Анамнез', html: 'Болеет неделю' },
                { key: 'therapy', label: 'Терапия', html: '<ul><li>Покой</li></ul><script>alert(1)</script>' },
            ],
        }],
        diag: [],
        labs: [{
            id: 'labs:50', kind: 'labs', source: 'lab', visit_id: 50, visit_service_id: null,
            title: 'Результаты анализов', doctor: '', at: '2026-10-05T05:00:00Z', unverified: true, origin: null,
            panels: [
                { visit_service_id: 63, title: 'Общий анализ крови', unverified: true, origin: null, rows: [
                    { parameter: 'HGB', value: '96', unit: 'г/л', reference_range: '120–160', flag: 'low' },
                    { parameter: 'WBC', value: '7.1', unit: '10⁹/л', reference_range: '4–9', flag: 'normal' },
                ] },
                { visit_service_id: 64, title: 'Глюкоза', unverified: false, origin: null, rows: [
                    { parameter: 'GLU', value: '5.1', unit: 'ммоль/л', reference_range: '3.9–6.1', flag: 'normal' },
                ] },
            ],
        }],
        inpatient: [{
            id: 'review:5', kind: 'inpatient', source: 'review', visit_service_id: null,
            doc_kind: 'primary', title: '', doctor: 'Врач Тестов', admission_no: 'A-1', at: '2026-10-06T08:00:00Z',
            sections: [{ key: 'complaints', label: 'Жалобы', html: '<p>Боль в животе</p>' }],
        }],
        files: null,
    },
});

test('docInsertHtml: заголовок и ПОЛНЫЙ текст отмеченных разделов, разметка очищена; ничего не отмечено — пусто', () => {
    const doc = FIXTURE().groups.consult[0];
    const html = PS.docInsertHtml(doc, ['complaint', 'therapy']);
    assert.ok(html.startsWith('<div><b>Приём терапевта</b> — ' + PS.docDay(doc.at) + ', Врач Тестов</div>'), html);
    assert.ok(html.includes('<div><b>Жалобы:</b></div>Кашель <b>3 дня</b>'), html);
    assert.ok(html.includes('<div><b>Терапия:</b></div><ul><li>Покой</li></ul>'), html);
    assert.ok(!html.includes('Болеет неделю'), 'неотмеченный раздел вставлен');
    assert.ok(!/<script|alert/i.test(html), 'разметка не очищена: ' + html);
    assert.equal(PS.docInsertHtml(doc, []), '');
});

test('labInsertHtml: по таблице на анализ, только отмеченные показатели, отклонение — жирным, непроверенный подписан в документе', () => {
    const doc = FIXTURE().groups.labs[0];
    const html = PS.labInsertHtml(doc, ['0:0', '1:0']);
    assert.ok(html.startsWith('<div><b>Результаты анализов</b> — ' + PS.docDay(doc.at) + '</div>'), html);
    assert.ok(html.includes('<div><b>Общий анализ крови (не проверено)</b></div><table class="a4-restbl">'), html);
    assert.ok(html.includes('<td>HGB</td><td><b>96 г/л</b></td><td>120–160</td>'), html);
    assert.ok(!html.includes('WBC'), 'неотмеченный показатель вставлен');
    assert.ok(html.includes('<div><b>Глюкоза</b></div>'), html);
    assert.equal(PS.labInsertHtml(doc, ['0:1']).includes('Глюкоза'), false, 'анализ без отмеченных показателей вставлен');
    assert.equal(PS.labInsertHtml(doc, []), '');
});

test('docDay — местный день «дд.мм.гггг», дата без времени — тот же день; docTitle — имя рода стационара', () => {
    assert.equal(PS.docDay('2026-10-06'), '06.10.2026');
    const d = new Date('2026-10-05T07:00:00.000Z');
    const p2 = (n) => String(n).padStart(2, '0');
    assert.equal(PS.docDay('2026-10-05T07:00:00.000Z'), p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear());
    assert.equal(PS.docDay(''), '');
    assert.equal(PS.docTitle({ kind: 'inpatient', doc_kind: 'primary', title: '' }), 'Первичный осмотр и план лечения');
    assert.equal(PS.docTitle({ kind: 'inpatient', doc_kind: 'own_cardio', title: 'Осмотр кардиолога' }), 'Осмотр кардиолога');
    assert.equal(PS.docTitle({ kind: 'consult', title: 'Приём терапевта' }), 'Приём терапевта');
});

test('окно: спрашивает сервер про пациента без текущей строки; пять вкладок; снятый раздел не вставляется; поле по умолчанию — от вкладки; ничего не отмечено — отказ словами', async () => {
    answer(FIXTURE()); RPC_LOG.length = 0;
    const calls = [];
    const m = PS.openPasteSourcesModal({ patientId: 7, excludeVisitServiceId: 61, onInsert: (html, field) => calls.push({ html, field }) });
    await m.ready;
    assert.deepEqual(RPC_LOG.filter((c) => c.name === 'patient_doc_sources').map((c) => c.body), [{ patient_id: 7, exclude_visit_service_id: 61 }]);
    assert.deepEqual(m.overlay.querySelectorAll('[data-paste-tab]').map((t) => t.getAttribute('data-paste-tab')), ['consult', 'diag', 'labs', 'inpatient', 'files']);
    const card = m.overlay.querySelector('[data-paste-doc="line:61"]');
    assert.ok(card, 'документа консультации нет');
    card.querySelector('[data-paste-sec="hpi"]').dispatch('change');
    card.querySelector('[data-paste-insert="line:61"]').dispatch('click');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].field, 'physical_exam');
    assert.ok(calls[0].html.includes('<b>Жалобы:</b>') && calls[0].html.includes('<b>Терапия:</b>') && !calls[0].html.includes('Анамнез'), calls[0].html);
    for (const k of ['complaint', 'therapy']) card.querySelector('[data-paste-sec="' + k + '"]').dispatch('change');
    TOASTS.length = 0;
    card.querySelector('[data-paste-insert="line:61"]').dispatch('click');
    assert.equal(calls.length, 1, 'пустая вставка ушла в документ');
    assert.ok(TOASTS.includes('Выберите хотя бы один раздел'), TOASTS.join(' | '));
    m.close();
});

test('окно: анализы — «не проверено», обрезанная группа названа, вставка в «Лабораторные»; стационар — имя рода и № госпитализации; пустая и закрытая вкладки — словами', async () => {
    answer(FIXTURE());
    const calls = [];
    const m = PS.openPasteSourcesModal({ patientId: 7, onInsert: (html, field) => calls.push({ html, field }) });
    await m.ready;
    tabBtn(m, 'labs').dispatch('click');
    const lab = m.overlay.querySelector('[data-paste-doc="labs:50"]');
    assert.ok(lab && lab.textContent.includes('не проверено'), 'нет пометки «не проверено»');
    assert.ok(m.overlay.textContent.includes('Показаны последние 1. Остальные — в карте пациента.'), 'обрезанная группа не названа');
    lab.querySelector('[data-paste-row="0:1"]').dispatch('change');
    lab.querySelector('[data-paste-insert="labs:50"]').dispatch('click');
    assert.equal(calls.at(-1).field, 'labs_text');
    assert.ok(calls.at(-1).html.includes('HGB') && !calls.at(-1).html.includes('WBC'), calls.at(-1).html);
    tabBtn(m, 'inpatient').dispatch('click');
    const rev = m.overlay.querySelector('[data-paste-doc="review:5"]');
    assert.ok(rev.textContent.includes('Первичный осмотр и план лечения') && rev.textContent.includes('Госпитализация № A-1'), rev.textContent);
    rev.querySelector('[data-paste-insert="review:5"]').dispatch('click');
    assert.equal(calls.at(-1).field, 'hpi');
    assert.ok(calls.at(-1).html.startsWith('<div><b>Первичный осмотр и план лечения</b>'), calls.at(-1).html);
    tabBtn(m, 'diag').dispatch('click');
    assert.ok(m.overlay.textContent.includes('Документов этого вида у пациента пока нет.'));
    tabBtn(m, 'files').dispatch('click');
    assert.ok(m.overlay.textContent.includes('Этот раздел закрыт для вашей роли.'));
    m.close();
});

// PASTE_SOURCES_V1 — здание как у карты пациента (BRANCH_ORIGIN_V1): результат
// другого здания виден и подписан «Филиал X» — в окне и в тексте вставки.
test('другое здание: анализ и измерения соседнего филиала подписаны «Филиал X» в окне и во вставке; своё — без пометки', async () => {
    const data = FIXTURE();
    data.groups.labs.push({
        id: 'labs:52', kind: 'labs', source: 'lab', visit_id: 52, visit_service_id: null,
        title: 'Результаты анализов', doctor: '', at: '2026-10-21T05:00:00Z', unverified: false, origin: 'B',
        panels: [{ visit_service_id: 66, title: 'Ферритин', unverified: false, origin: 'B', rows: [
            { parameter: 'FER', value: '12', unit: 'нг/мл', reference_range: '15–150', flag: 'low' }] }],
    });
    data.groups.labs[0].panels[1].origin = 'C';   // свой визит, результат одного анализа приехал из C
    data.groups.diag = [{ id: 'line:65', kind: 'diag', source: 'lab', visit_service_id: 65, title: 'ЭхоКГ', doctor: 'Врач Второй',
        at: '2026-10-21T09:00:00Z', origin: 'B', sections: [{ key: 'measurements', label: 'Измерения', html: '<table class="a4-restbl"><tbody><tr><td>ФВ</td><td>58 %</td><td></td></tr></tbody></table>' }] }];
    answer(data);
    const calls = [];
    const m = PS.openPasteSourcesModal({ patientId: 7, onInsert: (html, field) => calls.push({ html, field }) });
    await m.ready;
    tabBtn(m, 'labs').dispatch('click');
    const other = m.overlay.querySelector('[data-paste-doc="labs:52"]');
    assert.ok(other && other.textContent.includes('Филиал B'), 'у анализа соседнего здания нет пометки филиала');
    const own = m.overlay.querySelector('[data-paste-doc="labs:50"]');
    assert.ok(!own.textContent.includes('Филиал B'), 'у своего анализа пометка чужого филиала');
    assert.ok(own.querySelector('[data-paste-panel="64"]').textContent.includes('Филиал C'), 'у анализа, приехавшего из C, нет пометки');
    assert.ok(!own.querySelector('[data-paste-panel="63"]').textContent.includes('Филиал'), 'у своего анализа пометка филиала');
    other.querySelector('[data-paste-insert="labs:52"]').dispatch('click');
    assert.ok(calls.at(-1).html.startsWith('<div><b>Результаты анализов</b> — ' + PS.docDay('2026-10-21T05:00:00Z') + ', Филиал B</div>'), calls.at(-1).html);
    assert.ok(calls.at(-1).html.includes('<div><b>Ферритин</b></div>'), 'филиал повторён у анализа: ' + calls.at(-1).html);
    own.querySelector('[data-paste-insert="labs:50"]').dispatch('click');
    assert.ok(calls.at(-1).html.includes('<div><b>Глюкоза (Филиал C)</b></div>') && !calls.at(-1).html.includes('Филиал B'), calls.at(-1).html);
    tabBtn(m, 'diag').dispatch('click');
    const echo = m.overlay.querySelector('[data-paste-doc="line:65"]');
    assert.ok(echo && echo.textContent.includes('Филиал B'), 'у измерений соседнего здания нет пометки');
    echo.querySelector('[data-paste-insert="line:65"]').dispatch('click');
    assert.ok(calls.at(-1).html.startsWith('<div><b>ЭхоКГ</b> — ' + PS.docDay('2026-10-21T09:00:00Z') + ', Врач Второй, Филиал B</div>'), calls.at(-1).html);
    m.close();
});

test('окно: сервер отказал — причина словами (шаблон, потом значения), а не пустой список', async () => {
    REPLY = { ok: false, status: 403, payload: { error: { code: 'forbidden',
        message: 'Вкладка «{tab}» закрыта для вашей роли. Доступ открывает администратор клиники: «Настройки» → «Роли» → «Карта пациента — вкладки».',
        params: { tab: 'Документы' } } } };
    const m = PS.openPasteSourcesModal({ patientId: 7, onInsert: () => {} });
    await m.ready;
    assert.ok(m.overlay.textContent.includes('Не удалось загрузить документы пациента: Вкладка «Документы» закрыта для вашей роли.'), m.overlay.textContent);
    m.close();
});

test('файлы: только «Открыть», без вставки; файла нет на этом компьютере — так и сказано', async () => {
    const data = FIXTURE();
    data.closed = [];
    data.groups.files = [{ id: 'file:9', kind: 'files', source: 'file', document_id: 9, visit_service_id: null, title: 'Направление', file_name: 'k1.pdf',
        file_path: 'patients/7/docs/k1.pdf', file_available: false, doctor: 'Регистратор', at: '2026-10-05T07:00:00Z' }];
    answer(data);
    const m = PS.openPasteSourcesModal({ patientId: 7, onInsert: () => { throw new Error('файл не вставляется'); } });
    await m.ready;
    tabBtn(m, 'files').dispatch('click');
    const row = m.overlay.querySelector('[data-paste-doc="file:9"]');
    assert.ok(row && row.textContent.includes('Направление'));
    assert.equal(row.querySelector('[data-paste-insert="file:9"]'), null, 'у файла есть «Вставить»');
    TOASTS.length = 0;
    row.querySelector('[data-paste-open="file:9"]').dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(TOASTS.some((t) => t.startsWith('Файл лежит на том компьютере, где его загрузили')), TOASTS.join(' | '));
    m.close();
});
