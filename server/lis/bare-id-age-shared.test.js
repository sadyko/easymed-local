// LAB_TUBE_LABEL_V1 (ревью U11, L6) — срок голого номера один для приёма и для этикетки.
//
// Карточка очереди не печатает пробирку старше срока, после которого приём
// отказывает её голый номер («старше 7 дней», bareIdRefusal). Две копии числа
// разошлись бы при первой правке: карточка печатала бы этикетку, которую приём
// не примет. Поэтому число одно (public/js/shared/lab-label-age.js), а ingest.js и
// views/lab-tube.js его реэкспортируют.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BARE_ID_MAX_AGE_DAYS as fromIngest } from './ingest.js';
import { BARE_ID_MAX_AGE_DAYS as fromShared } from '../../public/js/shared/lab-label-age.js';
import { BARE_ID_MAX_AGE_DAYS as fromTube } from '../../public/js/admin/views/lab-tube.js';

test('срок голого номера — одно число: приём, общий модуль и этикетка пробирки', () => {
  assert.equal(fromShared, 7);
  assert.equal(fromIngest, fromShared);
  assert.equal(fromTube, fromShared);
});

test('приём и очередь лаборатории число не объявляют сами — берут из общего модуля', () => {
  for (const file of ['./ingest.js', '../../public/js/admin/views/lab-tube.js']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /(?:const|let|var)\s+BARE_ID_MAX_AGE_DAYS\s*=/, file + ' объявляет срок сам');
    assert.match(src, /import \{[^}]*BARE_ID_MAX_AGE_DAYS[^}]*\} from '[./]+(?:public\/js\/)?shared\/lab-label-age\.js'/, file + ' не берёт срок из shared/lab-label-age.js');
  }
});
