// CLINIC_API_STEP7_V1 — правила подключений API: одни для экрана и сервера.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, KIND_INFO, READ_SCOPES, WRITE_SCOPES, SCOPES, SCOPE_INFO, EVENTS, EVENT_INFO, RATE_LIMITS, KEY_TTLS, KEY_TTL_LABEL,
  DEFAULTS, KEY_PREFIX, SECRET_PREFIX, KEY_ALPHABET, KEY_RE, SECRET_RE, API_MESSAGES,
  normalizeSlug, slugProblem, suggestSlug, apiBaseUrl, siteUrlProblem, webhookUrlProblem, normalizeIpList, ipListProblem,
  scopesProblem, eventsProblem, orderedScopes, normalizeConnection, connectionProblems, maskSecret, apiSourceKey,
  keyExpiresAt, keyExpiryState,
} from './api-connections.js';
import { PROFILE_MESSAGES } from './clinic-profile.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('словарь: три вида, 6 + 3 права, 7 событий (с booking.* для шага 8), лимиты и сроки', () => {
  assert.deepEqual(KINDS, ['site', 'symptex', 'partner']);
  assert.deepEqual(READ_SCOPES, ['clinic', 'branches', 'doctors', 'services', 'packages', 'slots']);
  assert.deepEqual(WRITE_SCOPES, ['requests', 'appointments', 'cancel']);
  assert.deepEqual(EVENTS, ['request.accepted', 'appointment.created', 'booking.confirmed', 'booking.offered_other_time',
    'booking.declined', 'appointment.cancelled', 'appointment.arrived']);
  assert.deepEqual(RATE_LIMITS, [30, 60, 120, 300]);
  assert.deepEqual(KEY_TTLS, ['never', '3m', '6m', '1y']);
  for (const k of KINDS) {
    const d = DEFAULTS[k];
    assert.equal(scopesProblem(d.scopes), '', k + ': права по умолчанию допустимы');
    assert.equal(eventsProblem(d.events), '');
    assert.ok(RATE_LIMITS.includes(d.rate_limit) && KEY_TTLS.includes(d.key_ttl));
  }
  assert.equal(DEFAULTS.partner.key_ttl, '1y');
});

test('ключ и секрет: узнаваемый префикс и 32 знака алфавита без похожих символов', () => {
  assert.equal(KEY_PREFIX, 'em_live_');
  assert.equal(SECRET_PREFIX, 'em_whsec_');
  assert.equal(KEY_ALPHABET.length, 57);
  for (const ch of '0O1lI') assert.ok(!KEY_ALPHABET.includes(ch), ch);
  assert.ok(KEY_RE.test('em_live_' + 'A'.repeat(32)));
  assert.ok(!KEY_RE.test('em_live_' + 'A'.repeat(31)));
  assert.ok(!KEY_RE.test('em_live_' + '0'.repeat(32)));
  assert.ok(SECRET_RE.test('em_whsec_' + 'b'.repeat(32)));
  assert.equal(maskSecret(KEY_PREFIX, 'a91c'), 'em_live_••••a91c');
  assert.equal(maskSecret(KEY_PREFIX, ''), '');
});

test('имя в адресе: нормализация, формат, служебные имена, предложение из названий', () => {
  assert.equal(normalizeSlug('  Shifo '), 'shifo');
  assert.equal(slugProblem('shifo'), '');
  assert.equal(slugProblem('klinika-demo'), '');
  assert.equal(slugProblem('ab'), API_MESSAGES.slugFormat);
  assert.equal(slugProblem('-shifo'), API_MESSAGES.slugFormat);
  assert.equal(slugProblem('shifo_24'), API_MESSAGES.slugFormat);
  assert.equal(slugProblem('api'), API_MESSAGES.slugReserved);
  assert.equal(slugProblem('docs'), API_MESSAGES.slugReserved);
  assert.equal(suggestSlug('Shifo Clinic', 'Shifo klinikasi'), 'shifo-clinic');
  assert.equal(suggestSlug('', 'O‘zbek Med'), 'ozbek-med');
  assert.equal(suggestSlug('Клиника Шифо'), '');
  assert.equal(apiBaseUrl('shifo'), 'https://api.easymed.uz/shifo/v1/');
  assert.equal(apiBaseUrl(''), '');
});

test('сайт — то же правило, что «Сайт» в «Компании»; вебхук — https и доменное имя в интернете', () => {
  assert.equal(siteUrlProblem('https://med24.uz'), '');
  assert.equal(siteUrlProblem('http://med24.uz'), PROFILE_MESSAGES.website);
  assert.equal(webhookUrlProblem(''), '');
  assert.equal(webhookUrlProblem('https://med24.uz/hooks/easymed'), '');
  assert.equal(webhookUrlProblem('http://med24.uz/hooks'), API_MESSAGES.httpRefused);
  for (const bad of ['https://10.0.0.5/hook', 'https://localhost/hook', 'https://printer.local/x', 'https://[::1]/x',
    'https://user:pw@med24.uz/x', 'https://med24', 'ftp://med24.uz']) {
    assert.equal(webhookUrlProblem(bad), API_MESSAGES.webhookUrl, bad);
  }
  assert.equal(webhookUrlProblem('https://med24.uz/' + 'x'.repeat(300)), API_MESSAGES.urlLong);
});

test('разрешённые IP: по одному в строке, IPv4 / IPv6 / CIDR, не больше 20', () => {
  assert.equal(normalizeIpList(' 203.0.113.7, 203.0.113.0/24\n\n2001:db8::1 '), '203.0.113.7\n203.0.113.0/24\n2001:db8::1');
  assert.equal(ipListProblem(''), '');
  assert.equal(ipListProblem('203.0.113.7\n2001:db8::/32'), '');
  assert.equal(ipListProblem('203.0.113.300'), API_MESSAGES.ipFormat);
  assert.equal(ipListProblem('med24.uz'), API_MESSAGES.ipFormat);
  assert.equal(ipListProblem('1:2::3::4'), API_MESSAGES.ipFormat);
  assert.equal(ipListProblem(Array.from({ length: 21 }, (_, i) => '203.0.113.' + i).join('\n')), API_MESSAGES.ipTooMany);
});

test('права: хотя бы одно; запись требует свободного времени; отмена — записи; события — из словаря', () => {
  assert.equal(scopesProblem([]), API_MESSAGES.scopesEmpty);
  assert.equal(scopesProblem(['clinic', 'robots']), API_MESSAGES.scopesUnknown);
  assert.equal(scopesProblem(['clinic', 'clinic']), API_MESSAGES.scopesUnknown);
  assert.equal(scopesProblem(['clinic', 'appointments']), API_MESSAGES.appointmentsNeedSlots);
  assert.equal(scopesProblem(['clinic', 'slots', 'cancel']), API_MESSAGES.cancelNeedsAppointments);
  assert.deepEqual(orderedScopes(['requests', 'clinic', 'slots']), ['clinic', 'slots', 'requests']);
  assert.equal(eventsProblem(['booking.declined']), '');
  assert.equal(eventsProblem(['payment.done']), API_MESSAGES.eventsUnknown);
});

test('подключение: нормализация и проверка целиком и по частям', () => {
  const v = normalizeConnection({ kind: ' partner ', name: ' med24.uz ', site_url: ' HTTPS://med24.uz ', contact: '  Отдел партнёров ',
    scopes: ['clinic'], webhook_url: '', webhook_events: [], rate_limit: '60', key_ttl: '1y', ip_allow: '203.0.113.7,', active: true });
  assert.deepEqual(v, { kind: 'partner', name: 'med24.uz', contact: 'Отдел партнёров', site_url: 'https://med24.uz', webhook_url: '',
    scopes: ['clinic'], webhook_events: [], rate_limit: 60, key_ttl: '1y', ip_allow: '203.0.113.7', active: 1 });
  assert.deepEqual(connectionProblems(v), {});
  assert.deepEqual(Object.keys(connectionProblems({ ...v, name: '', rate_limit: 50, key_ttl: '2y', active: 2 })).sort(),
    ['active', 'key_ttl', 'name', 'rate_limit']);
  assert.deepEqual(connectionProblems({ name: 'x' }, { partial: true }), {});
  assert.deepEqual(Object.keys(connectionProblems({ kind: 'robot' })), ['kind', 'name', 'scopes']);
});

test('источник CRM подключения: api_<латиница>, свободный, до 32 знаков', () => {
  assert.equal(apiSourceKey('med24.uz', 'partner', []), 'api_med24_uz');
  assert.equal(apiSourceKey('Symptex', 'symptex', []), 'api_symptex');
  assert.equal(apiSourceKey('Клиники рядом', 'partner', []), 'api_partner');
  assert.equal(apiSourceKey('med24.uz', 'partner', ['api_med24_uz']), 'api_med24_uz_2');
  assert.ok(apiSourceKey('x'.repeat(80), 'partner', []).length <= 32);
  assert.match(apiSourceKey('x'.repeat(80), 'partner', []), /^[a-z0-9_]{1,32}$/);
});

test('срок ключа: дата от выдачи; конец месяца не перескакивает; метки «истекает» и «истёк»', () => {
  assert.equal(keyExpiresAt('2026-10-10T09:00:00Z', 'never'), null);
  assert.equal(keyExpiresAt('2026-10-10T09:00:00Z', '3m'), '2027-01-10T09:00:00Z');
  assert.equal(keyExpiresAt('2026-08-31T09:00:00Z', '6m'), '2027-02-28T09:00:00Z');
  assert.equal(keyExpiresAt('2026-10-10T09:00:00Z', '1y'), '2027-10-10T09:00:00Z');
  const now = Date.parse('2026-10-10T00:00:00Z');
  assert.equal(keyExpiryState(null, now), 'none');
  assert.equal(keyExpiryState('2026-12-01T00:00:00Z', now), 'ok');
  assert.equal(keyExpiryState('2026-10-20T00:00:00Z', now), 'soon');
  assert.equal(keyExpiryState('2026-10-09T00:00:00Z', now), 'expired');
});

test('каждая подпись, описание и сообщение модуля переведены на ru / uz / en', () => {
  const texts = [
    ...Object.values(API_MESSAGES),
    ...Object.values(KIND_INFO).flatMap((x) => [x.label, x.desc]),
    ...Object.values(SCOPE_INFO).flatMap((x) => [x.label, x.desc]),
    ...Object.values(EVENT_INFO).flatMap((x) => [x.label, x.desc]),
    ...Object.values(KEY_TTL_LABEL), '{n} в минуту',
  ];
  for (const t of texts) {
    const e = STRINGS[t];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + t);
  }
});
