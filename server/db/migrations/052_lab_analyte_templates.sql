-- LAB_ANALYTE_LIBRARY_V1 — a read-only dictionary of laboratory PARAMETERS,
-- so building a panel does not mean typing every indicator by hand.
--
-- Why this exists alongside 050/051: those catalogue whole STUDIES, and only 9 of
-- the 1002 carry an indicator list. Importing any of the other 993 gives a panel
-- with no parameters, which put the clinic straight back to manual entry. A
-- parameter like «Гемоглобин» is also reused across many panels, so it belongs in
-- a dictionary of its own rather than being owned by one template.
--
-- Source: 190 parameters distilled from the 300 analyte rows on the
-- production easymed.uz laboratory. Curated, not copied — 12 rows were not
-- parameters at all (reference-range labels and age bands saved as indicators),
-- 98 were duplicates across panels, and the age variants the server modelled as
-- separate analytes ("СвободныйТ4 (2-11лет)", "(12-19лет)", "(20-100лет)") were
-- collapsed into one parameter, because an age band belongs in a range, not a name.
--
-- REFERENCE RANGES ARE ABSENT BY DESIGN, and this table has no columns to hold
-- them. They depend on the analyser, method and population each laboratory uses,
-- so one clinic's numbers are wrong in another and a wrong range on a patient's
-- report is a clinical error. The clinic enters its own in Настройки → Лаборатория,
-- which supports общие / М / Ж bounds plus named age- and sex-specific диапазоны.
-- 052.test.js pins that guarantee.
--
-- Categories (the same 16 the panel catalogue uses):
--    64  Гематология
--    41  Общеклинические исследования
--    36  Биохимия
--    16  Коагулология
--    11  Серология и инфекции
--     7  Аутоиммунная диагностика
--     7  Гормоны
--     5  Иммунология и аллергология
--     2  Микробиология
--     1  Онкомаркеры

CREATE TABLE lab_analyte_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE,          -- stable slug, so a re-seed does not duplicate
  name          TEXT NOT NULL,
  category      TEXT,                 -- «Гематология», «Биохимия», …
  unit          TEXT,
  value_type    TEXT NOT NULL DEFAULT 'numeric' CHECK (value_type IN ('numeric','text','select')),
  value_options TEXT,                 -- comma-separated, for value_type = 'select'
  decimals      INTEGER NOT NULL DEFAULT 0,
  group_label   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_lab_analyte_templates_cat ON lab_analyte_templates(category);

-- ── 190 parameters ──────────────────────────────────────────────────
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('antistreptolizin-o-aso', 'Антистрептолизин О (ASO)', 'Аутоиммунная диагностика', NULL, 'text', NULL, 1, NULL, 1);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('antistreptolizin-o-aslo', 'Антистрептолизин-О (асло)', 'Аутоиммунная диагностика', 'IU/mL', 'numeric', NULL, 1, NULL, 2);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('aslo', 'АСЛО', 'Аутоиммунная диагностика', 'Ед/мл', 'text', NULL, 1, NULL, 3);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('at-tpo-antitela-k-tireoperoksidaze', 'АТ-ТПО Антитела к ТиреоПероксидазе', 'Аутоиммунная диагностика', 'МЕ/мл', 'numeric', NULL, 1, NULL, 4);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('revmatoidnyy-faktor-rf', 'Ревматоидный фактор (РФ)', 'Аутоиммунная диагностика', 'IU/mL', 'numeric', NULL, 1, NULL, 5);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('revmatoidnyy-faktor-rf-2', 'Ревматоидный Фактор (RF)', 'Аутоиммунная диагностика', NULL, 'text', NULL, 1, NULL, 6);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('rf', 'РФ', 'Аутоиммунная диагностика', 'МЕ/мл', 'text', NULL, 1, NULL, 7);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('alaninaminotransferaza', 'Аланинаминотрансфераза', 'Биохимия', 'мг/Л', 'numeric', NULL, 1, NULL, 8);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('alt', 'АЛТ', 'Биохимия', 'Ед/л', 'numeric', NULL, 0, NULL, 9);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('alt-alaninaminotransferaza', 'АЛТ (аланинаминотрансфераза)', 'Биохимия', 'Ед/л', 'numeric', NULL, 1, NULL, 10);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('aspartataminotransferaza', 'Аспартатаминотрансфераза', 'Биохимия', 'мг/Л', 'numeric', NULL, 1, NULL, 11);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ast', 'АСТ', 'Биохимия', 'Ед/л', 'numeric', NULL, 0, NULL, 12);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ast-aspartataminotransferaza', 'АСТ (аспартатаминотрансфераза)', 'Биохимия', 'Ед/л', 'numeric', NULL, 1, NULL, 13);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('bilirubin', 'Билирубин', 'Биохимия', NULL, 'text', NULL, 1, NULL, 14);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('vitamin-d', 'Витамин Д', 'Биохимия', 'нмоль/л', 'numeric', NULL, 1, NULL, 15);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('glyukoza', 'Глюкоза', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 16);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('glyukoza-glu', 'Глюкоза (GLU)', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 17);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gomotsistein', 'ГОМОЦИСТЕИН', 'Биохимия', 'мкмол/л', 'numeric', NULL, 1, NULL, 18);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('zheleza-fe', 'Железа (Fe)', 'Биохимия', 'мкмол/л', 'numeric', NULL, 1, NULL, 19);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('zhelezo', 'Железо', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 20);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kaltsiy', 'Кальций', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 21);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kaltsiy-sa', 'Кальций (Са)', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 22);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kreatinin', 'Креатинин', 'Биохимия', 'мкмоль/л', 'numeric', NULL, 0, NULL, 23);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kreatinin-krea', 'Креатинин (KREA)', 'Биохимия', 'мкмолъ/л', 'numeric', NULL, 1, NULL, 24);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('magniy-mg', 'Магний (Mg)', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 25);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('natriy', 'Натрий', 'Биохимия', 'ммол/л', 'numeric', NULL, 1, NULL, 26);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('obschiy-belok', 'Общий белок', 'Биохимия', 'г/л', 'numeric', NULL, 0, NULL, 27);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('obschiy-belok-tp', 'Общий белок (TP)', 'Биохимия', 'г/л', 'numeric', NULL, 1, NULL, 28);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('s-reaktivnyy-belok', 'С реактивный белок', 'Биохимия', 'мг/л', 'text', NULL, 1, NULL, 29);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('s-reaktivnyy-belok-crp', 'С Реактивный Белок (CRP)', 'Биохимия', 'U/mL', 'numeric', NULL, 1, NULL, 30);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('s-reaktivniy-belok-srb', 'С-реактивний белок (СРБ)', 'Биохимия', 'IU/mL', 'numeric', NULL, 1, NULL, 31);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tbil-bilirubin-obschiy', 'Тбил Билирубин общий', 'Биохимия', 'мкмоль/л', 'numeric', NULL, 1, NULL, 32);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('triglitseridy', 'триглицериды', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 33);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('triglitseridy-tg', 'триглицериды (TG)', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 34);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ferritin', 'Ферритин', 'Биохимия', 'мкг/л', 'numeric', NULL, 1, NULL, 35);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('folievaya-kislota-folik-acid', 'Фолиевая кислота(Folik Acid)', 'Биохимия', 'ng/ml', 'numeric', NULL, 1, NULL, 36);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('holesterin-ts', 'Холестерин (ТС)', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 37);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('holesterin-obschiy', 'Холестерин общий', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 38);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('holesterin-obschiy-tc', 'Холестерин общий (TC)', 'Биохимия', 'ммоль/л', 'numeric', NULL, 1, NULL, 39);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('d-bil-pryamoy-bilirubin', 'D-Bil прямой билирубин', 'Биохимия', 'мкмоль/л', 'numeric', NULL, 1, NULL, 40);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('dbil-pryamoy-bilirubin', 'Dбил прямой билирубин', 'Биохимия', 'мкмоль/л', 'numeric', NULL, 1, NULL, 41);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('potassium-kaliy', 'potassium Калий', 'Биохимия', 'ммол/л', 'numeric', NULL, 1, NULL, 42);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('t-bil-total-bilirubin-obschiy-bilirubin', 'T-BIL (Total Bilirubin) общий билирубин', 'Биохимия', 'мкмоль/л', 'numeric', NULL, 1, NULL, 43);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('bazofily', 'Базофилы', 'Гематология', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 44);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gematokrit', 'Гематокрит', 'Гематология', '%', 'numeric', NULL, 1, NULL, 45);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gematokrit-hct', 'Гематокрит HCT', 'Гематология', '%', 'numeric', NULL, 1, NULL, 46);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gemoglobin', 'Гемоглобин', 'Гематология', 'г/л', 'numeric', NULL, 0, NULL, 47);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('glikirovannyy-gemoglobin', 'Гликированный гемоглобин', 'Гематология', '%', 'numeric', NULL, 1, NULL, 48);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gruppa-krovi', 'Группа Крови', 'Гематология', NULL, 'select', 'O(I), A(II), B(III), AB(IV)', 1, NULL, 49);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kontsentratsiya-gemoglobina-hgb', 'Концентрация гемоглобина HGB', 'Гематология', 'G/L', 'numeric', NULL, 1, NULL, 50);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('leykotsity', 'Лейкоциты', 'Гематология', '10⁹/л', 'numeric', NULL, 1, NULL, 51);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('leykotsitywbc', 'ЛейкоцитыWBC', 'Гематология', 'x10*9/L', 'numeric', NULL, 1, NULL, 52);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('limfotsity', 'Лимфоциты', 'Гематология', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 53);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('limfotsity-lim', 'Лимфоциты Lim#', 'Гематология', 'g/l', 'numeric', NULL, 1, NULL, 54);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('monotsity', 'Моноциты', 'Гематология', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 55);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('monotsity-mid', 'Моноциты Mid#', 'Гематология', 'g/l', 'numeric', NULL, 1, NULL, 56);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('neytrofily', 'Нейтрофилы', 'Гематология', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 57);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('obschee-kolichestvo-trombotsitov-plt', 'Общее количество тромбоцитов PLT', 'Гематология', 'g/l', 'numeric', NULL, 1, NULL, 58);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('obschee-kolichestvo-eritrotsitov-rbc', 'Общее количество эритроцитов RBC', 'Гематология', 'L', 'numeric', NULL, 1, NULL, 59);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('otnositelnoe-kolichestvo-krupnyh-trombotsitov-p-lcr', 'Относительное количество крупных тромбоцитов P-LCR', 'Гематология', '%', 'numeric', NULL, 1, NULL, 60);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('otnositelnoe-kolichestvo-limfotsitovlim', 'Относительное количество лимфоцитовLim%', 'Гематология', '%', 'numeric', NULL, 1, NULL, 61);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('otnositelnoe-kolichestvo-monotsitovmid', 'Относительное количество моноцитовMid%', 'Гематология', '%', 'numeric', NULL, 1, NULL, 62);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('rezus', 'Резус', 'Гематология', NULL, 'select', 'Rh+, Rh-', 1, NULL, 63);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('rezus-faktor', 'Резус-фактор', 'Гематология', NULL, 'select', 'Rh+ (положительный), Rh- (отрицательный)', 1, NULL, 64);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('sgustki-leykotsitov', 'Сгустки лейкоцитов', 'Гематология', NULL, 'text', NULL, 1, NULL, 65);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('skorost-osedaniya-eritrotsitov-soe', 'Скорость оседания эритроцитов (СОЭ)', 'Гематология', 'mm/h', 'numeric', NULL, 1, NULL, 66);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('soe', 'СОЭ', 'Гематология', 'мм/ч', 'numeric', NULL, 0, NULL, 67);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('srednee-kontsentratsiya-gemoglobina-v-eritrotsite-mchc', 'Среднее концентрация гемоглобина в эритроците MCHC', 'Гематология', 'g/l', 'numeric', NULL, 1, NULL, 68);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('srednee-soderzhanie-gemoglobina-v-eritrotsite-mch', 'Среднее содержание гемоглобина в эритроците MCH', 'Гематология', 'pg', 'numeric', NULL, 1, NULL, 69);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('sredniy-obem-trombotsita-mpv', 'Средний объем тромбоцита MPV', 'Гематология', 'f/l', 'numeric', NULL, 1, NULL, 70);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('sredniy-obem-eritrotsita-mcv', 'Средний объем эритроцита MCV', 'Гематология', 'fl', 'numeric', NULL, 1, NULL, 71);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('trombokrit-pct', 'Тромбокрит PCT', 'Гематология', '%', 'numeric', NULL, 1, NULL, 72);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('trombotsity', 'Тромбоциты', 'Гематология', '10⁹/л', 'numeric', NULL, 0, NULL, 73);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('shirina-raspredeleniya-trombotsitov-pdw', 'Ширина распределения тромбоцитов PDW', 'Гематология', NULL, 'numeric', NULL, 1, NULL, 74);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('shirina-raspredeleniya-eritrotsitov-po-obemu-koeffitsient-va', 'Ширина распределения эритроцитов по объему коэффициент вариации RDW-CV', 'Гематология', '%', 'numeric', NULL, 1, NULL, 75);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('shirina-raspredeleniya-eritrotsitov-po-obemu-standartov-otkl', 'Ширина распределения эритроцитов по объему стандартов отклонения RDW-SD', 'Гематология', 'f/l', 'numeric', NULL, 1, NULL, 76);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('eozinofily', 'Эозинофилы', 'Гематология', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 77);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('eritrotsity', 'Эритроциты', 'Гематология', '10¹²/л', 'numeric', NULL, 2, NULL, 78);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('eritrotsity-izmenennye', 'Эритроциты измененные', 'Гематология', NULL, 'text', NULL, 1, NULL, 79);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('eritrotsity-ne-izmenennye', 'Эритроциты не измененные', 'Гематология', NULL, 'numeric', NULL, 1, NULL, 80);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('aly-abs-kol-vo-atip-h-limf-v', 'ALY#-Абс.кол-во.атип-х.лимф-в', 'Гематология', NULL, 'numeric', NULL, 1, NULL, 81);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('aly-s-soder-atip-h-limf-v', 'ALY%-%-с содер.атип-х.лимф-в', 'Гематология', NULL, 'numeric', NULL, 1, NULL, 82);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('bas-bazofily', 'BAS% Базофилы', 'Гематология', '%', 'numeric', NULL, 1, NULL, 83);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('coe-skorost-osedaniya-eritrotsitov', 'COE Скорость оседания эритроцитов', 'Гематология', 'мм/ч', 'numeric', NULL, 1, NULL, 84);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('eos-eozinofily', 'EOS% Эозинофилы', 'Гематология', '%', 'numeric', NULL, 1, NULL, 85);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gran', 'Gran#', 'Гематология', 'g/l', 'numeric', NULL, 1, NULL, 86);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('hct-gemotokrit', 'HCT Гемотокрит', 'Гематология', '%', 'numeric', NULL, 1, NULL, 87);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('hgb-gemoglobin', 'HGB Гемоглобин', 'Гематология', 'g/l', 'numeric', NULL, 1, NULL, 88);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('lic-abs-kol-vo-krup-nezrel-kl-k', 'LIC#-Абс.кол-во.круп.незрел.кл-к', 'Гематология', NULL, 'numeric', NULL, 1, NULL, 89);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('lic-s-soder-krup-nezr-h-kl-k', 'LIC%-%-с содер.круп.незр-х.кл-к', 'Гематология', NULL, 'numeric', NULL, 1, NULL, 90);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('lym-limfotsity', 'LYM% Лимфоциты', 'Гематология', '%', 'numeric', NULL, 1, NULL, 91);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mch', 'MCH', 'Гематология', 'пг', 'numeric', NULL, 1, NULL, 92);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mch-sr-sod-gem-v-er', 'MCH Ср.сод.гем.в эр.', 'Гематология', 'pg', 'numeric', NULL, 1, NULL, 93);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mchc', 'MCHC', 'Гематология', 'г/л', 'numeric', NULL, 0, NULL, 94);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mchc-sr-konts-gem-v-er', 'MCHC Ср.конц.гем.в эр.', 'Гематология', 'g/l', 'numeric', NULL, 1, NULL, 95);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mcv', 'MCV', 'Гематология', 'фл', 'numeric', NULL, 1, NULL, 96);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mcv-sr-obem-er', 'MCV Ср.объём эр.', 'Гематология', 'fl', 'numeric', NULL, 1, NULL, 97);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mon-monotsity', 'MON% Моноциты', 'Гематология', '%', 'numeric', NULL, 1, NULL, 98);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mpv-sredniy-obem-trombotsitov', 'MPV Средний объём тромбоцитов', 'Гематология', 'fl', 'numeric', NULL, 1, NULL, 99);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('neu-neytrofily', 'NEU% Нейтрофилы', 'Гематология', '%', 'numeric', NULL, 1, NULL, 100);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('pct-trombokrit', 'PCT Тромбокрит', 'Гематология', '%', 'numeric', NULL, 1, NULL, 101);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('pdw-shir-rasp-tromb-po-obemu', 'PDW шир. расп. тромб.по объёму', 'Гематология', NULL, 'numeric', NULL, 1, NULL, 102);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('plt-trombotsity', 'PLT Тромбоциты', 'Гематология', '*10*9/L', 'numeric', NULL, 1, NULL, 103);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('rbc-eritrotsity', 'RBC Эритроциты', 'Гематология', '10*12/L', 'numeric', NULL, 1, NULL, 104);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('rdw-cv-shir-rasp-gem-v-er', 'RDW-CV шир. расп. гем.в эр.', 'Гематология', '%', 'numeric', NULL, 1, NULL, 105);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('rdw-sd-shir-rasp-er-po-obemu', 'RDW-SD шир. расп. эр.по объёму', 'Гематология', 'fl', 'numeric', NULL, 1, NULL, 106);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('wbc-leykotsity', 'WBC% Лейкоциты', 'Гематология', '*10*9/L', 'numeric', NULL, 1, NULL, 107);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('insulin', 'Инсулин', 'Гормоны', 'мк/Ед/мл', 'numeric', NULL, 1, NULL, 108);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('progesteron', 'Прогестерон', 'Гормоны', 'гл', 'numeric', NULL, 1, NULL, 109);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('svobodnyy-t4', 'Свободный Т4', 'Гормоны', NULL, 'numeric', NULL, 1, NULL, 110);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('t3-svobodnyy', 'Т3 свободный', 'Гормоны', 'пмоль/л', 'numeric', NULL, 1, NULL, 111);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ttg', 'ТТГ', 'Гормоны', 'mlU/L', 'numeric', NULL, 1, NULL, 112);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ttg-tireotropnyy-gormon-pokolenie', 'ТТГ Тиреотропный гормон( ||| поколение)', 'Гормоны', 'mlU/L', 'numeric', NULL, 1, NULL, 113);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('t3svobodnyy', 'T3свободный', 'Гормоны', 'пмоль/л', 'numeric', NULL, 1, NULL, 114);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('v-p-g-igg-ifa', 'В.П.Г IgG (ИФА)', 'Иммунология и аллергология', NULL, 'numeric', NULL, 1, NULL, 115);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('rubella-igg-ifa', 'Рубелла IgG (ИФА)', 'Иммунология и аллергология', NULL, 'numeric', NULL, 1, NULL, 116);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('toksoplazma-igg-ifa', 'Токсоплазма IgG (ИФА)', 'Иммунология и аллергология', NULL, 'numeric', NULL, 1, NULL, 117);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tsitomegalovirus-ts-m-v-igg-ifa', 'цитомегаловирус Ц.М.В IgG (ИФА)', 'Иммунология и аллергология', NULL, 'numeric', NULL, 1, NULL, 118);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mycoplasma-igg-ifa', 'Mycoplasma IgG (ИФА)', 'Иммунология и аллергология', NULL, 'numeric', NULL, 1, NULL, 119);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('aktivirovannoe-chastichnoe-tromboplastinovoe-vremya-achtv', 'активированное частичное тромбопластиновое время АЧТВ', 'Коагулология', 'секунд', 'numeric', NULL, 1, NULL, 120);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('achtv-aktivirovannoe-chastichnoe-tromboplastinovoe-vremya', 'АЧТВ(Активированное частичное тромбопластиновое время', 'Коагулология', 'сек', 'numeric', NULL, 1, NULL, 121);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('vremya-svertyvaniya-krovi-vsk', 'Время свёртывания крови ВСК', 'Коагулология', 'мин- сек', 'numeric', NULL, 1, NULL, 122);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('vsk', 'ВСК', 'Коагулология', 'мм/час', 'text', NULL, 1, NULL, 123);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('vsk-vremya-sver-krovi', 'ВСК (время свер. крови)', 'Коагулология', NULL, 'text', NULL, 1, NULL, 124);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('d-dimer', 'Д-димер', 'Коагулология', 'ng/ml', 'numeric', NULL, 1, NULL, 125);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mno-isi', 'МНО (ISI)', 'Коагулология', NULL, 'numeric', NULL, 1, NULL, 126);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mno-mezhdunarodnoe-normalizovannoe-otnoshenie', 'МНО(международное нормализованное отношение)', 'Коагулология', NULL, 'numeric', NULL, 1, NULL, 127);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('protrombinovoe-vremya-pt', 'Протромбиновое время (PT)', 'Коагулология', 'секунд', 'numeric', NULL, 1, NULL, 128);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('protrombinovyy-indeks-pt', 'Протромбиновый индекс (PT)', 'Коагулология', '%', 'numeric', NULL, 1, NULL, 129);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('pt-protrombinovoe-vremya', 'ПТ(Протромбиновое время)', 'Коагулология', 'сек', 'numeric', NULL, 1, NULL, 130);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('pti-protrombinovyy-indeks', 'ПТИ(протромбиновый индекс)', 'Коагулология', '%', 'numeric', NULL, 1, NULL, 131);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tv-trombinovoe-vremya', 'ТВ(тромбиновое время', 'Коагулология', 'сек', 'numeric', NULL, 1, NULL, 132);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('trombinovoe-vremya-tt', 'Тромбиновое время (TT)', 'Коагулология', 'секунд', 'numeric', NULL, 1, NULL, 133);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('fibrinogen', 'Фибриноген', 'Коагулология', 'г/л', 'numeric', NULL, 1, NULL, 134);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('fibrinogen-fib', 'Фибриноген (FIB)', 'Коагулология', 'г/л', 'numeric', NULL, 1, NULL, 135);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('bakterii', 'Бактерии', 'Микробиология', NULL, 'text', NULL, 1, NULL, 136);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('drozhzhi', 'Дрожжи', 'Микробиология', NULL, 'text', NULL, 1, NULL, 137);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('askorbinovaya-kislota', 'Аскорбиновая кислота', 'Общеклинические исследования', NULL, 'numeric', NULL, 1, NULL, 138);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('atseton', 'Ацетон', 'Общеклинические исследования', NULL, 'numeric', NULL, 1, NULL, 139);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('belok', 'Белок', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 140);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('voskovidnyy-tsilindr', 'Восковидный Цилиндр', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 141);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gialinovyy-tsilindr', 'Гиалиновый Цилиндр', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 142);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('zernistyy-tsilindr', 'Зернистый Цилиндр', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 143);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ketony', 'Кетоны', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 144);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kislotnost', 'Кислотность', 'Общеклинические исследования', NULL, 'numeric', NULL, 1, NULL, 145);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kislotnost-ph', 'Кислотность Ph', 'Общеклинические исследования', NULL, 'numeric', NULL, 1, NULL, 146);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kolichestvo-mocha-peshob-mi-dori', 'Количество моча пешоб миқдори', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 147);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kristally-digidrata-oksalata-kaltsiya', 'Кристаллы дигидрата оксалата кальция', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 148);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kristally-monogidrata-oksalata-kaltsiya', 'Кристаллы моногидрата оксалата кальция', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 149);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('kristaly-mochevoy-kisloty', 'Кристалы мочевой кислоты', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 150);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('krov', 'Кровь', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 151);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mochevaya-kislota', 'Мочевая кислота', 'Общеклинические исследования', 'мкмоль/л', 'numeric', NULL, 1, NULL, 152);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mochevina', 'Мочевина', 'Общеклинические исследования', 'ммоль/л', 'numeric', NULL, 1, NULL, 153);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mochevina-bun', 'Мочевина (BUN)', 'Общеклинические исследования', 'ммоль/л', 'numeric', NULL, 1, NULL, 154);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('mochevina-urea', 'Мочевина (UREA)', 'Общеклинические исследования', 'мкмоль/л', 'numeric', NULL, 1, NULL, 155);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('nitrity', 'Нитриты', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 156);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('perehodnyy-epiteliy', 'Переходный Эпителий', 'Общеклинические исследования', NULL, 'numeric', NULL, 1, NULL, 157);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ploskiy-epiteliy', 'Плоский Эпителий', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 158);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('pochechnyy-epiteliy', 'Почечный Эпителий', 'Общеклинические исследования', NULL, 'numeric', NULL, 1, NULL, 159);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('prozrachnost', 'Прозрачность', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 160);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('prozrachnost-tini-ligi', 'Прозрачность тиниқлиги', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 161);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('reaktsiya', 'Реакция', 'Общеклинические исследования', 'PH', 'text', NULL, 1, NULL, 162);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('slizistye-niti', 'Слизистые нити', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 163);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('sliz', 'Слизь', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 164);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('soli', 'Соли', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 165);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('udelnyy-ves', 'Удельный Вес', 'Общеклинические исследования', NULL, 'numeric', NULL, 1, NULL, 166);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('urobilinogen', 'Уробилиноген', 'Общеклинические исследования', 'мкмоль.л', 'numeric', NULL, 1, NULL, 167);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('holesterin-lipoproteiny-vysokiy-plotnosti-hdl-c', 'Холестерин липопротеины высокий плотности (HDL-C)', 'Общеклинические исследования', 'ммоль/л', 'numeric', NULL, 1, NULL, 168);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('holesterin-lipoproteiny-nizkiy-plotnosti-ldl-c', 'Холестерин липопротеины низкий плотности (LDL-C)', 'Общеклинические исследования', 'ммолъ/л', 'numeric', NULL, 1, NULL, 169);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tsvet', 'Цвет', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 170);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tsvet-rangi', 'Цвет ранги', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 171);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tsilindry', 'цилиндры', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 172);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tsilindry-voskovidnye', 'Цилиндры восковидные', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 173);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tsilindry-gialinovye', 'Цилиндры гиалиновые', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 174);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('tsilindry-zernistye', 'Цилиндры зернистые', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 175);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('epiteliy-ploskiy', 'Эпителий плоский', 'Общеклинические исследования', NULL, 'numeric', NULL, 1, NULL, 176);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('epiteliy-pochechnyy', 'Эпителий почечный', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 177);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('epiteliy-promezhutochnyy', 'Эпителий промежуточный', 'Общеклинические исследования', NULL, 'text', NULL, 1, NULL, 178);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ca-125', 'CA-125', 'Онкомаркеры', 'ед/мл', 'numeric', NULL, 1, NULL, 179);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('analiz-krovi-rw', 'Анализ крови RW', 'Серология и инфекции', NULL, 'text', NULL, 1, NULL, 180);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('vich-dlya-operatsii-oiv', 'ВИЧ для операции (ОИВ)', 'Серология и инфекции', NULL, 'text', NULL, 1, NULL, 181);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('vich-ekspress', 'ВИЧ экспресс', 'Серология и инфекции', NULL, 'text', NULL, 1, NULL, 182);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gepatit-b', 'ГЕПАТИТ Б', 'Серология и инфекции', NULL, 'text', NULL, 1, NULL, 183);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gepatit-s', 'ГЕПАТИТ С', 'Серология и инфекции', NULL, 'text', NULL, 1, NULL, 184);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('gepatit-s-novyy', 'Гепатит С (новый)', 'Серология и инфекции', NULL, 'select', 'Отрицательно, Положительно', 1, NULL, 185);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('ureaplazma-ifa', 'Уреаплазма (ИФА)', 'Серология и инфекции', NULL, 'numeric', NULL, 1, NULL, 186);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('hlamidii-igg-ifa', 'Хламидии IgG (ИФА)', 'Серология и инфекции', NULL, 'numeric', NULL, 1, NULL, 187);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('hbs-ag-ekspress', 'HBS Ag экспресс', 'Серология и инфекции', NULL, 'select', 'отрицательно, положительный', 1, NULL, 188);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('hcv-ekspress', 'HCV Экспресс', 'Серология и инфекции', NULL, 'text', NULL, 1, NULL, 189);
INSERT INTO lab_analyte_templates (code, name, category, unit, value_type, value_options, decimals, group_label, sort_order) VALUES ('rw', 'RW', 'Серология и инфекции', NULL, 'text', NULL, 1, NULL, 190);
