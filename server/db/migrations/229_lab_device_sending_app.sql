-- LIS_DISCOVERY_FIX_V1 (2026-09-29) — ПРИБОР УЗНАЁТСЯ ПО АДРЕСУ И ПО ТОМУ, КАК
-- ОН СЕБЯ НАЗВАЛ.
--
-- Ревью 2026-09-29 доказало на настоящем ensureDevice (discover.js):
--   S5  человек поправил модель найденного прибора — и следующая проба заводила
--       дубль: строка искалась по УГАДАННОЙ модели, а модель уже не та;
--   S4  два переадресатора на одном ПК: второй прибор (модель не угадать)
--       приписывался к строке первого «по адресу» и не появлялся никогда.
-- Модель и название правит человек, поэтому различать по ним нельзя. Различаем
-- по тому, чего человек не правит: как прибор назвал себя сам (MSH-3).
--
-- sending_app — MSH-3 (компонент 1) первого сообщения прибора. NULL — прибор
-- ещё не называл себя. Пишет только сервер (discover.js); в реестре схемы
-- колонка только на чтение.
ALTER TABLE lab_devices ADD COLUMN sending_app TEXT;

-- Бэкфилл: имя из первого сообщения каждой строки — самого раннего (меньший id)
-- из тех, что начинаются с «MSH|»; мусор перед ним пропускается. Один проход.
-- Разбор тот же, что у hl7.js для MSH-3, в пределах сегмента MSH (первые 1020
-- знаков после «MSH|», до конца строки CR или LF): пропустить MSH-2 до
-- следующей «|», взять поле до следующей «|», отрезать по «^», обрезать пробелы.
--
-- Пишется ТОЛЬКО имя, адрес — нет (решение владельца 2026-09-29). Иначе строка
-- без адреса и найденная строка того же прибора оказались бы на одном адресе с
-- одним именем, и пробы молча перешли бы от одной к другой. Адрес строка без
-- адреса узнаёт при первой пробе, которую примет.
--
-- Только там, где имени нет (NULL или ''), и только непустое имя. Повторный
-- накат ничего не меняет: условие уже не выполняется.
UPDATE lab_devices
   SET sending_app = x.app
  FROM (SELECT device_id,
               trim(CASE WHEN instr(f3, '^') > 0 THEN substr(f3, 1, instr(f3, '^') - 1) ELSE f3 END) AS app
          FROM (SELECT device_id,
                       CASE WHEN instr(r2, '|') > 0 THEN substr(r2, 1, instr(r2, '|') - 1) ELSE r2 END AS f3
                  FROM (SELECT device_id,
                               CASE WHEN instr(seg, '|') > 0 THEN substr(seg, instr(seg, '|') + 1) ELSE '' END AS r2
                          FROM (SELECT device_id,
                                       CASE WHEN instr(s1, char(10)) > 0 THEN substr(s1, 1, instr(s1, char(10)) - 1) ELSE s1 END AS seg
                                  FROM (SELECT m.device_id,
                                               CASE WHEN instr(h, char(13)) > 0 THEN substr(h, 1, instr(h, char(13)) - 1) ELSE h END AS s1
                                          FROM (SELECT m.device_id, substr(m.raw, 5, 1020) AS h
                                                  FROM lab_device_messages AS m
                                                  JOIN (SELECT device_id, MIN(id) AS id
                                                          FROM lab_device_messages
                                                         WHERE device_id IS NOT NULL
                                                           AND substr(raw, 1, 4) = 'MSH|'
                                                         GROUP BY device_id) AS f ON f.id = m.id) AS m))))) AS x
 WHERE x.device_id = lab_devices.id
   AND x.app <> ''
   AND (lab_devices.sending_app IS NULL OR lab_devices.sending_app = '');
