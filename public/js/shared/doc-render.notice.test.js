// REFUND_ANY_V1 (2026-10-29) — ПОМЕТКА НАД ЛИСТОМ: «Услуга возвращена».
//
// Документы врача после возврата не удаляются (медицинская запись), но печать
// документа по строке, за которую пациенту вернули деньги, говорит это на
// бумаге. withNotice ставит пометку ПЕРВОЙ внутри листа (.sheet) — и
// макетного (<section class="sheet …">), и обычного (<div class="sheet">):
// вне листа она добавляла свою высоту к min-height листа, и печать выходила
// на лишнюю пустую страницу (ревью B4). Листа нет — сразу после <body>; нет и
// его — в начале. Текст экранируется; пустая пометка — бланк как был.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml, withNotice } from './doc-render.js';

const S = {
  clinicName: 'Клиника', tagline: '', address: '', phone: '', email: '', web: '',
  accent: '#167873', accentSoft: '#effaf8', ink: '#0b1418', paperBg: '#fff',
  showWatermark: false, showStamp: false, showSignature: false, showQR: false,
  language: 'ru', paperSize: 'A4', fontPair: 'modern', cornerStyle: 'rounded', footerNote: '', legalNote: '', variant: {},
};

// Пометка лежит ВНУТРИ первого листа: между его открывающим тегом и
// содержимым, а не перед ним.
function noticeInsideSheet(html) {
  const open = html.match(/<(div|section)\b[^>]*\bclass="sheet(?:\s[^"]*)?"[^>]*>/i);
  assert.ok(open, 'в бланке нет листа .sheet');
  const at = html.indexOf(open[0]) + open[0].length;
  return html.slice(at).startsWith('<div data-print-notice="1"');
}

test('пометка — первой внутри листа обычного бланка, текст экранирован', () => {
  const html = buildSheetHtml({ type: 'custom', s: S, bodyHtml: '<p>тело</p>' });
  const marked = withNotice(html, 'Услуга возвращена <b>');
  assert.match(marked, /<div class="sheet"[^>]*><div data-print-notice="1"[^>]*>Услуга возвращена &lt;b&gt;<\/div>/);
  assert.ok(noticeInsideSheet(marked), 'пометка не внутри листа');
  assert.ok(marked.search(/<body[^>]*>/i) < marked.indexOf('data-print-notice'), 'пометка до <body>');
  assert.equal((marked.match(/data-print-notice/g) || []).length, 1);
  assert.ok(marked.includes('<p>тело</p>'), 'бланк не тронут');
});

test('макетный бланк (<section class="sheet …">) — пометка первой внутри листа, одна', () => {
  const html = buildSheetHtml({ type: 'conclusion', s: S });
  assert.match(html, /<section class="sheet\b/, 'макет больше не рисует <section class="sheet"> — проверьте тест');
  const marked = withNotice(html, 'Услуга возвращена');
  assert.ok(noticeInsideSheet(marked), 'пометка не внутри листа макета');
  assert.equal((marked.match(/data-print-notice/g) || []).length, 1);
  // Тело листа (с пометкой внутри) — то же самое, что было, плюс пометка.
  assert.equal(marked.replace(/<div data-print-notice="1"[^>]*>Услуга возвращена<\/div>/, ''), html);
});

test('пустая пометка — бланк как был; без листа — после <body>; без <body> — в начале', () => {
  const html = buildSheetHtml({ type: 'custom', s: S, bodyHtml: '<p>тело</p>' });
  assert.equal(withNotice(html, ''), html);
  assert.equal(withNotice(html, null), html);
  assert.match(withNotice('<html><body class="x"><p>x</p></body></html>', 'Услуга возвращена'),
    /^<html><body class="x"><div data-print-notice="1"[^>]*>Услуга возвращена<\/div><p>x<\/p><\/body><\/html>$/);
  assert.match(withNotice('<p>x</p>', 'Услуга возвращена'), /^<div data-print-notice="1"[^>]*>Услуга возвращена<\/div><p>x<\/p>$/);
});
