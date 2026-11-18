// DOC_HISTORY_V1 — история изменений документа приёма: чистые правила, общие для
// сервера (что записать) и экрана (как показать и сравнить).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  docContentOf, docContentHash, docSnapshotOf, docSectionsChanged, docRevisionKind,
  DOC_REVISION_KINDS, DOC_REVISION_KIND_LABELS, sectionKeyOf, docSectionLabel, wordDiff, listItemsText, canSeeDocHistory, docSectionKeys,
} from './doc-history.js';

const NOTES = (extra = {}, history = []) => JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель' }, history, ...extra });
const SIGNED = { kind: 'signed', savedAt: '2026-11-01T08:00:00.000Z', by: 2, byName: 'Врач', fields: { chief_complaint: 'Кашель' } };
const SIGNED2 = { kind: 'signed', savedAt: '2026-11-01T10:00:00.000Z', by: 2, byName: 'Врач', fields: { chief_complaint: 'Кашель 2' } };
const DRAFT = { kind: 'draft', savedAt: '2026-11-01T09:00:00.000Z', fields: { chief_complaint: 'Кашель' } };
const IMG_A = 'data:image/jpeg;base64,' + 'A'.repeat(4000);
const IMG_B = 'data:image/jpeg;base64,' + 'B'.repeat(4000);

test('содержание документа: поля, назначения, диагнозы, услуги, тип, заметка медсестры и отпечатки снимков — без истории', () => {
  const c = docContentOf(NOTES({ prescriptions: [{ name: 'Амоксициллин' }], diagnoses: [{ code: 'J20.9' }], services: [{ name: 'ОАК' }],
    diagImages: [IMG_A], docType: 'diag', nurseNote: 'в/в', dxSplit: 1 }, [SIGNED, DRAFT]));
  assert.deepEqual(c.fields, { chief_complaint: 'Кашель' });
  assert.deepEqual(c.prescriptions, [{ name: 'Амоксициллин' }]);
  assert.deepEqual(c.diagnoses, [{ code: 'J20.9' }]);
  assert.deepEqual(c.services, [{ name: 'ОАК' }]);
  assert.equal(c.docType, 'diag');
  assert.equal(c.nurseNote, 'в/в');
  assert.equal(c.images.length, 1);
  assert.match(c.images[0], /^h[0-9a-z]+\.[0-9a-z]+$/, 'снимок — отпечаток, а не данные');
  assert.ok(!JSON.stringify(c).includes('AAAA'), 'данные снимка в содержании');
  assert.ok(!('history' in c), 'история черновиков — не содержание');
  // пустые поля — не содержание: '' и отсутствие — одно и то же
  assert.equal(docContentHash(docContentOf(NOTES({ current: { chief_complaint: 'Кашель', hpi: '' } }))), docContentHash(docContentOf(NOTES())));
  // строка без документа и текст медсестры
  assert.equal(docContentOf(null), null);
  assert.equal(docContentOf(''), null);
  assert.equal(docContentOf('Заметка').nurseNote, 'Заметка');
});

test('тот же документ — тот же отпечаток при другом порядке ключей и другой истории', () => {
  const a = JSON.stringify({ __service_workspace_v1: 1, history: [DRAFT], current: { hpi: 'x', chief_complaint: 'y' } });
  const b = JSON.stringify({ current: { chief_complaint: 'y', hpi: 'x' }, history: [SIGNED, DRAFT], __service_workspace_v1: 1 });
  assert.equal(docContentHash(docContentOf(a)), docContentHash(docContentOf(b)));
  assert.notEqual(docContentHash(docContentOf(a)), docContentHash(docContentOf(NOTES())));
});

test('снимок версии: содержание + подписи (кто и когда), снимки — только отпечатки', () => {
  const s = docSnapshotOf(NOTES({ diagImages: [IMG_A, IMG_B] }, [SIGNED, DRAFT, SIGNED2]));
  assert.equal(s.v, 1);
  assert.equal(s.images.length, 2);
  assert.deepEqual(s.signed.map((e) => e.at), [SIGNED.savedAt, SIGNED2.savedAt]);
  assert.equal(s.signed[0].byName, 'Врач');
  assert.ok(JSON.stringify(s).length < 600, 'снимок с двумя изображениями — не больше 600 символов: ' + JSON.stringify(s).length);
});

test('изменённые разделы: поле, свой раздел врача (заголовок — тот же раздел), списки, снимки (добавлено / убрано), заметка, тип', () => {
  const prev = docContentOf(NOTES({ current: { chief_complaint: 'Кашель', free_3: 'a', free_3__title: 'Раздел' }, diagImages: [IMG_A], prescriptions: [{ name: 'A' }] }));
  const next = docContentOf(NOTES({ current: { chief_complaint: 'Кашель сухой', free_3: 'a', free_3__title: 'Раздел 2' }, diagImages: [IMG_B], prescriptions: [{ name: 'B' }], docType: 'diag', nurseNote: 'x' }));
  const d = docSectionsChanged(prev, next);
  assert.deepEqual(d.sections, ['chief_complaint', 'free_3', 'prescriptions', 'images', 'nurseNote', 'docType']);
  assert.equal(d.imagesAdded, 1);
  assert.equal(d.imagesRemoved, 1);
  assert.deepEqual(docSectionsChanged(prev, prev).sections, []);
  assert.deepEqual(docSectionsChanged(null, docContentOf(NOTES())).sections, ['chief_complaint']);
  // один и тот же снимок дважды — счёт по количеству
  const two = docSectionsChanged(docContentOf(NOTES({ diagImages: [IMG_A] })), docContentOf(NOTES({ diagImages: [IMG_A, IMG_A] })));
  assert.equal(two.imagesAdded, 1);
  assert.equal(two.imagesRemoved, 0);
  assert.equal(sectionKeyOf('free_3__title'), 'free_3');
  assert.equal(sectionKeyOf('hpi'), 'hpi');
});

test('вид версии: черновик, подпись, исправление после подписи, переподпись без изменений, списки, медсестра; без изменений — нет версии', () => {
  const kind = (prev, next, via = 'cabinet') => docRevisionKind({ prevRaw: prev, nextRaw: next, via });
  assert.equal(kind(null, NOTES({}, [DRAFT])), 'draft', 'первый черновик');
  assert.equal(kind(NOTES({}, [DRAFT]), NOTES({}, [DRAFT, { ...DRAFT, savedAt: 'x' }])), null, 'тот же текст ещё раз — версии нет');
  assert.equal(kind(NOTES({}, [DRAFT]), NOTES({}, [SIGNED])), 'signed', 'подпись того же текста — версия «Подписан»');
  assert.equal(kind(NOTES({}, [SIGNED]), NOTES({ current: { chief_complaint: 'Кашель 2' } }, [SIGNED, DRAFT])), 'amended', 'черновик после подписи');
  assert.equal(kind(NOTES({}, [SIGNED]), NOTES({ current: { chief_complaint: 'Кашель 2' } }, [SIGNED, SIGNED2])), 'amended', 'переподпись с изменениями');
  assert.equal(kind(NOTES({}, [SIGNED]), NOTES({}, [SIGNED, SIGNED2])), 'signed', 'переподпись без изменений');
  assert.equal(kind(NOTES({}, [DRAFT]), NOTES({ prescriptions: [{ name: 'A' }] }, [DRAFT])), 'lists', 'только назначения');
  assert.equal(kind(NOTES({}, [DRAFT]), NOTES({ diagnoses: [{ code: 'J20.9' }], services: [{ name: 'ОАК' }] }, [DRAFT])), 'lists', 'диагнозы и услуги');
  assert.equal(kind(NOTES({}, [SIGNED]), NOTES({ prescriptions: [{ name: 'A' }] }, [SIGNED])), 'amended', 'назначение после подписи — исправление');
  assert.equal(kind(NOTES({}, [SIGNED]), NOTES({ nurseNote: 'в/в' }, [SIGNED]), 'nurse'), 'nurse', 'отметка медсестры — своим видом и после подписи');
  assert.equal(kind(NOTES({}, [DRAFT]), NOTES({ nurseNote: 'в/в' }, [DRAFT])), 'nurse', 'только заметка медсестры');
  assert.equal(kind(NOTES({ nurseNote: 'в/в' }, [SIGNED]), NOTES({ nurseNote: 'в/в' }, [SIGNED]), 'nurse'), null, 'та же заметка — версии нет');
  assert.equal(kind(null, null), null);
  assert.equal(kind('Заметка', 'Заметка, правка'), null, 'обе — не документ кабинета: не документ, версии нет');
  assert.deepEqual([...DOC_REVISION_KINDS].sort(), Object.keys(DOC_REVISION_KIND_LABELS).sort());
  assert.equal(DOC_REVISION_KIND_LABELS.amended, 'Исправлен после подписи');
});

test('подписи раздела: известные поля, свой раздел врача по заголовку, бланк диагностики', () => {
  assert.equal(docSectionLabel('chief_complaint'), 'Жалобы');
  assert.equal(docSectionLabel('prescriptions'), 'Назначения');
  assert.equal(docSectionLabel('free_3', { fields: { free_3__title: 'Неврологический статус' } }), 'Неврологический статус');
  assert.equal(docSectionLabel('free_4', { fields: {} }), 'Свой раздел');
  assert.equal(docSectionLabel('primary_diagnosis', { docType: 'diag' }), 'Заключение');
  assert.equal(docSectionLabel('instrumental_text', { docType: 'diag' }), 'Описание');
  assert.equal(docSectionLabel('something_new'), 'Раздел');
});

test('сравнение по словам: убранное, добавленное, общее; пробелы сохраняются; очень длинный текст — без зависания', () => {
  const parts = wordDiff('Кашель сухой, ночью', 'Кашель влажный, ночью и днём');
  assert.deepEqual(parts.filter((p) => p.op === 'del').map((p) => p.text.trim()), ['сухой,']);
  assert.deepEqual(parts.filter((p) => p.op === 'ins').map((p) => p.text.trim()).join(' '), 'влажный, и днём');
  assert.equal(parts.filter((p) => p.op !== 'ins').map((p) => p.text).join(''), 'Кашель сухой, ночью');
  assert.equal(parts.filter((p) => p.op !== 'del').map((p) => p.text).join(''), 'Кашель влажный, ночью и днём');
  assert.deepEqual(wordDiff('', ''), []);
  assert.deepEqual(wordDiff('а', 'а'), [{ op: 'eq', text: 'а' }]);
  const long = Array.from({ length: 6000 }, (_, i) => 'слово' + i).join(' ');
  const t0 = Date.now();
  const big = wordDiff(long, long.replace('слово3000', 'другое'));
  assert.ok(Date.now() - t0 < 2000, 'длинный текст сравнивается дольше 2 с');
  assert.equal(big.filter((p) => p.op !== 'ins').map((p) => p.text).join(''), long);
  // совсем разные длинные тексты — таблица слов больше предела: по строкам, без зависания
  const x = Array.from({ length: 3000 }, (_, i) => 'икс' + i).join(' ') + '\nобщая строка\n' + Array.from({ length: 3000 }, (_, i) => 'игрек' + i).join(' ');
  const y = Array.from({ length: 3000 }, (_, i) => 'зет' + i).join(' ') + '\nобщая строка\n' + Array.from({ length: 3000 }, (_, i) => 'дабл' + i).join(' ');
  const t1 = Date.now();
  const far = wordDiff(x, y);
  assert.ok(Date.now() - t1 < 2000, 'совсем разные длинные тексты сравниваются дольше 2 с');
  assert.equal(far.filter((p) => p.op !== 'ins').map((p) => p.text).join(''), x);
  assert.equal(far.filter((p) => p.op !== 'del').map((p) => p.text).join(''), y);
  assert.ok(far.some((p) => p.op === 'eq' && p.text.includes('общая строка')), 'общая строка найдена сравнением по строкам');
});

test('разделы снимка по порядку листа: поля, свой раздел врача один раз, непустые списки, снимки, заметка медсестры', () => {
  const s = docSnapshotOf(NOTES({ current: { hpi: 'x', chief_complaint: 'y', free_2: 'z', free_2__title: 'Т' }, prescriptions: [{ name: 'A' }], diagnoses: [], diagImages: [IMG_A], nurseNote: 'н' }));
  assert.deepEqual(docSectionKeys(s), ['chief_complaint', 'hpi', 'free_2', 'prescriptions', 'images', 'nurseNote']);
  assert.deepEqual(docSectionKeys(null), []);
});

test('кто видит историю: врач строки, главный врач (надстройка), администратор (и дополнительной ролью); прочие — нет', () => {
  assert.equal(canSeeDocHistory({ id: 3, role: 'doctor', extra_roles: [] }, 3), true, 'врач строки');
  assert.equal(canSeeDocHistory({ id: 4, role: 'doctor', extra_roles: [] }, 3), false, 'другой врач');
  assert.equal(canSeeDocHistory({ id: 5, role: 'doctor', extra_roles: ['head_doctor'] }, 3), true, 'главный врач');
  assert.equal(canSeeDocHistory({ id: 1, role: 'admin' }, 3), true, 'администратор');
  assert.equal(canSeeDocHistory({ id: 8, role: 'doctor', extra_roles: ['admin'] }, 3), true, 'врач-администратор');
  assert.equal(canSeeDocHistory({ id: 6, role: 'nurse', extra_roles: [] }, 3), false, 'медсестра');
  assert.equal(canSeeDocHistory({ id: 7, role: 'registrar' }, 3), false, 'регистратура');
  assert.equal(canSeeDocHistory({ id: 3, role: 'doctor' }, null), false, 'строка без исполнителя — не «своя»');
  assert.equal(canSeeDocHistory(null, 3), false);
});

test('строки списков для сравнения: назначение, диагноз (вид — через перевод экрана), услуга — текстом', () => {
  assert.deepEqual(listItemsText('prescriptions', [{ name: 'Амоксициллин', dose: '500 мг', freq: '3 р/д', dur: '7 дней', notes: '', nurse: '' }]), ['Амоксициллин · 500 мг · 3 р/д · 7 дней']);
  assert.deepEqual(listItemsText('diagnoses', [{ code: 'J20.9', name: 'Острый бронхит', type: 'main' }]), ['J20.9 Острый бронхит (Основной)']);
  assert.deepEqual(listItemsText('diagnoses', [{ code: 'J20.9', name: 'Острый бронхит', type: 'main' }], (s) => '<' + s + '>'), ['J20.9 Острый бронхит (<Основной>)']);
  assert.deepEqual(listItemsText('services', [{ name: 'ОАК', price: 40000 }]), ['ОАК']);
  assert.deepEqual(listItemsText('services', null), []);
});
