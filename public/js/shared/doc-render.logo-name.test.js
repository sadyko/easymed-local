// CLINIC_PROFILE_V1 — логотип не прячет название (спецификация «Правила, без которых не строим»).
//
// Правило LOGO_WORDMARK_V1 считало загруженный логотип надписью и прятало
// рядом с ним название. Квадратный логотип шага 3 — знак без надписи: с ним
// большинство бланков A4 печаталось бы без названия клиники. Теперь шапка
// печатает название всегда.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml } from './doc-render.js';

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
const S = {
  clinicName: 'Клиника Шифо', tagline: '', address: 'Ташкент', phone: '', email: '', web: '',
  accent: '#167873', accentSoft: '#effaf8', ink: '#0b1418', paperBg: '#fff',
  showWatermark: false, showStamp: false, showSignature: false, showQR: false,
  language: 'ru', paperSize: 'A4', fontPair: 'modern', cornerStyle: 'rounded', footerNote: '', legalNote: '', variant: {},
};
// Видимый текст между тегами, а не alt картинки.
const nameShown = (html) => />\s*Клиника Шифо\s*</.test(html);

test('шапка бланка (квитанция, свой бланк): с логотипом название печатается рядом', () => {
  const html = buildSheetHtml({ type: 'custom', s: { ...S, logoUrl: LOGO }, bodyHtml: '<p>тело</p>' });
  assert.ok(html.includes(LOGO), 'логотип на месте');
  assert.ok(nameShown(html), 'название пропало рядом с логотипом');
});

test('двухъярусная шапка (выписка, договор стационара): с логотипом название печатается рядом', () => {
  for (const args of [
    { type: 'custom', bodyHtml: '<p>тело</p>', head: { title: 'Выписка' } },
    { type: 'inpatient_contract', data: null },
  ]) {
    const html = buildSheetHtml({ ...args, s: { ...S, logoUrl: LOGO } });
    assert.ok(html.includes(LOGO), args.type + ': логотип');
    assert.ok(nameShown(html), args.type + ': название');
  }
});

test('логотип из печатной копии (logoDataUrl) — тоже рядом с названием; alt пустой — название напечатано', () => {
  const html = buildSheetHtml({ type: 'custom', s: { ...S, logoDataUrl: LOGO }, bodyHtml: '<p>тело</p>' });
  assert.ok(html.includes(LOGO));
  assert.ok(nameShown(html));
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt=""/, 'название рядом — читалке не нужно повторять его в alt');
});

test('без логотипа — как было: знак клиники и название', () => {
  const html = buildSheetHtml({ type: 'custom', s: S, bodyHtml: '<p>тело</p>' });
  assert.ok(nameShown(html));
});
