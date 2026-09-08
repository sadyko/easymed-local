-- REFERRAL_SOURCE_CODE_V1 — у каждого источника направления свой номер,
-- 0001, 0002, … Короткая ручка, по которой партнёра называют в разговоре и
-- находят в ведомости, вместо «тот внешний врач, кажется, Дильшод».
--
-- Номер ВЫДАЁТСЯ ТРИГГЕРОМ, а не кодом приложения, и это не украшение:
-- источники заводятся через общий /api/db (форма в «Настройках»), у которого
-- серверного обработчика на вставку нет вовсе, и заводить их вправе не только
-- admin, но и регистратор. Любая проверка «на экране» означала бы источник без
-- номера ровно там, где им пользуются чаще всего — в регистратуре.
--
-- Счётчик отдельной строкой, а не COUNT(*) и не MAX(id): удалённый источник не
-- должен возвращать свой номер следующему. Тот же довод, по которому счета
-- считают invoice_counters, а не строки таблицы (services/rpc/billing.js).
ALTER TABLE referral_sources ADD COLUMN code TEXT;

CREATE TABLE referral_source_counter (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  next_seq INTEGER NOT NULL DEFAULT 1
);
INSERT INTO referral_source_counter (id, next_seq) VALUES (1, 1);

-- Уже заведённым источникам номера раздаются В ПОРЯДКЕ ЗАВЕДЕНИЯ: кто в
-- регистре давно, у того номер меньше.
UPDATE referral_sources
   SET code = printf('%04d', (SELECT COUNT(*) FROM referral_sources r2 WHERE r2.id <= referral_sources.id))
 WHERE code IS NULL OR code = '';

-- Счётчик встаёт ЗА последним выданным номером, а не на количество строк:
-- если номера когда-нибудь окажутся с пропусками, следующий всё равно обязан
-- быть свободным.
UPDATE referral_source_counter
   SET next_seq = (SELECT COALESCE(MAX(CAST(code AS INTEGER)), 0) + 1 FROM referral_sources);

-- Номер уникален. Индекс допускает несколько NULL — это и нужно: между самой
-- вставкой и срабатыванием триггера ниже строка секунду живёт без номера.
CREATE UNIQUE INDEX idx_referral_sources_code ON referral_sources(code);

-- printf('%04d') дополняет НУЛЯМИ ДО четырёх знаков, но не обрезает: 9999-й
-- источник получит 9999, а десятитысячный — 10000. Клиника с десятью тысячами
-- партнёров маловероятна, но упереться в формат и перестать заводить
-- источников она не должна.
CREATE TRIGGER referral_sources_assign_code
AFTER INSERT ON referral_sources
FOR EACH ROW WHEN NEW.code IS NULL OR NEW.code = ''
BEGIN
  UPDATE referral_sources
     SET code = printf('%04d', (SELECT next_seq FROM referral_source_counter WHERE id = 1))
   WHERE id = NEW.id;
  UPDATE referral_source_counter SET next_seq = next_seq + 1 WHERE id = 1;
END;
