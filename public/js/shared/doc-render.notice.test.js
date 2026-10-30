// REFUND_ANY_V1 (2026-10-29) — ПОМЕТКА НАД ЛИСТОМ: «Услуга возвращена».
//
// Документы врача после возврата не удаляются (медицинская запись), но печать
// документа по строке, за которую пациенту вернули деньги, говорит это на
// бумаге. withNotice ставит пометку сразу после <body> любого бланка (и
// макетного, и обычного) — текст экранируется; пустая пометка — бланк как был.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml, withNotice } from './doc-render.js';

const S = {
  clinicName: 'Клиника', tagline: '', address: '', phone: '', email: '', web: '',
  accent: '#167873', accentSoft: '#effaf8', ink: '#0b1418', paperBg: '#fff',
  showWatermark: false, showStamp: false, showSignature: false, showQR: false,
  language: 'ru', paperSize: 'A4', fontPair: 'modern', cornerStyle: 'rounded', footerNote: '', legalNote: '', variant: {},
};

test('пометка — первой строкой тела листа, текст экранирован', () => {
  const html = buildSheetHtml({ type: 'custom', s: S, bodyHtml: '<p>тело</p>' });
  const marked = withNotice(html, 'Услуга возвращена <b>');
  const body = marked.slice(marked.search(/<body[^>]*>/i));
  assert.match(body, /^<body[^>]*><div data-print-notice="1"[^>]*>Услуга возвращена &lt;b&gt;<\/div>/);
  assert.equal((marked.match(/data-print-notice/g) || []).length, 1);
  assert.ok(marked.includes('<p>тело</p>'), 'бланк не тронут');
});

test('пустая пометка — бланк как был; без <body> — пометка в начале', () => {
  const html = buildSheetHtml({ type: 'custom', s: S, bodyHtml: '<p>тело</p>' });
  assert.equal(withNotice(html, ''), html);
  assert.equal(withNotice(html, null), html);
  assert.match(withNotice('<p>x</p>', 'Услуга возвращена'), /^<div data-print-notice="1"[^>]*>Услуга возвращена<\/div><p>x<\/p>$/);
});
