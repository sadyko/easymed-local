// lab-devices.test.mjs — что экран говорит о СВЯЗИ с прибором.
//
// Связь по MLLP не постоянная: прибор соединяется, отдаёт пробу, получает ACK и
// разъединяется. Наблюдать «подключён ли он сейчас» нечего — между пробами
// соединения нет ни у работающего прибора, ни у выключенного. Поэтому лампочки
// «онлайн» здесь нет: она врала бы в обе стороны. Единственный честный признак —
// когда от прибора в последний раз что-то пришло, и эти пороги пиннятся тут.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveness } from './lab-devices-live.js';

const NOW = Date.parse('2026-09-10T18:00:00Z');
const agoMin = (m) => new Date(NOW - m * 60000).toISOString();

test('прибор, от которого ничего не приходило, назван честно — а не «молчит»', () => {
  // Это случай заведённого руками прибора, которого может не существовать
  // вовсе. «Молчит» подразумевало бы, что он когда-то говорил.
  const s = liveness(null, NOW);
  assert.equal(s.kind, 'idle');
  assert.equal(s.key, 'ни одного сообщения');
});

test('сообщение за последние пять минут — «на связи»', () => {
  assert.equal(liveness(agoMin(0), NOW).kind, 'success');
  assert.equal(liveness(agoMin(4), NOW).kind, 'success');
});

test('на шестой минуте прибор уже не «на связи» — окно короткое намеренно', () => {
  const s = liveness(agoMin(6), NOW);
  assert.equal(s.kind, 'warn');
  assert.equal(s.params.n, 6, 'человеку нужно число минут, а не слово «давно»');
});

test('часы и сутки читаются по-разному: минуты, часы, дата', () => {
  assert.equal(liveness(agoMin(90), NOW).key, 'молчит {n} ч');
  assert.equal(liveness(agoMin(90), NOW).params.n, 1, '90 минут — это ОДИН полный час, а не два');
  assert.equal(liveness(agoMin(60 * 30), NOW).key, 'не отвечает с {when}');
});

test('битая или будущая метка времени не притворяется связью', () => {
  // Часы прибора могут уехать вперёд. Показать «на связи» по метке из будущего
  // означало бы поверить прибору больше, чем собственным часам.
  assert.equal(liveness('не дата', NOW).kind, 'idle');
  assert.equal(liveness(new Date(NOW + 60000).toISOString(), NOW).kind, 'idle');
});
