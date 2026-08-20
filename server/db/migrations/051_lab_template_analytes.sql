-- LAB_TEMPLATES_V1 (part 2) — indicator lists for the panels that genuinely
-- carry more than one measurement. The other 993 laboratory templates are
-- single-analyte tests (Гемоглобин, Глюкоза, СОЭ…); importing one of those creates
-- a panel with a single parameter named after the test, so they need no list here.
--
-- Names, units, result types and grouping only. EVERY REFERENCE RANGE IS ABSENT —
-- ranges depend on the analyser, method and population each lab uses, so shipping
-- numbers would be clinically unsafe. The clinic fills them in Настройки →
-- Лаборатория, where the editor supports общие / М / Ж bounds plus named
-- age- and sex-specific диапазоны. 050.test.js pins the absence.


-- klinicheskiy-analiz-krovi — 17 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Эритроциты (RBC)', '10^12/л', 'numeric', NULL, 2, 'Эритроцитарные показатели', 1 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Гемоглобин (HGB)', 'г/л', 'numeric', NULL, 0, 'Эритроцитарные показатели', 2 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Гематокрит (HCT)', '%', 'numeric', NULL, 1, 'Эритроцитарные показатели', 3 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Средний объём эритроцита (MCV)', 'фл', 'numeric', NULL, 1, 'Эритроцитарные показатели', 4 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Среднее содержание Hb (MCH)', 'пг', 'numeric', NULL, 1, 'Эритроцитарные показатели', 5 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Средняя концентрация Hb (MCHC)', 'г/л', 'numeric', NULL, 0, 'Эритроцитарные показатели', 6 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Ширина распределения эритроцитов (RDW)', '%', 'numeric', NULL, 1, 'Эритроцитарные показатели', 7 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Тромбоциты (PLT)', '10^9/л', 'numeric', NULL, 0, 'Тромбоциты', 8 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Средний объём тромбоцита (MPV)', 'фл', 'numeric', NULL, 1, 'Тромбоциты', 9 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Лейкоциты (WBC)', '10^9/л', 'numeric', NULL, 1, 'Лейкоциты', 10 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Нейтрофилы палочкоядерные', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 11 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Нейтрофилы сегментоядерные', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 12 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Эозинофилы', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 13 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Базофилы', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 14 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Лимфоциты', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 15 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Моноциты', '%', 'numeric', NULL, 1, 'Лейкоцитарная формула', 16 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'СОЭ', 'мм/ч', 'numeric', NULL, 0, 'СОЭ', 17 FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi';

-- obschiy-analiz-krovi — 6 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Эритроциты (RBC)', '10^12/л', 'numeric', NULL, 2, NULL, 1 FROM lab_panel_templates WHERE code = 'obschiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Гемоглобин (HGB)', 'г/л', 'numeric', NULL, 0, NULL, 2 FROM lab_panel_templates WHERE code = 'obschiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Гематокрит (HCT)', '%', 'numeric', NULL, 1, NULL, 3 FROM lab_panel_templates WHERE code = 'obschiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Тромбоциты (PLT)', '10^9/л', 'numeric', NULL, 0, NULL, 4 FROM lab_panel_templates WHERE code = 'obschiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Лейкоциты (WBC)', '10^9/л', 'numeric', NULL, 1, NULL, 5 FROM lab_panel_templates WHERE code = 'obschiy-analiz-krovi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'СОЭ', 'мм/ч', 'numeric', NULL, 0, NULL, 6 FROM lab_panel_templates WHERE code = 'obschiy-analiz-krovi';

-- leykotsitarnaya-formula-ruchnaya-metodika — 8 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Нейтрофилы палочкоядерные', '%', 'numeric', NULL, 1, NULL, 1 FROM lab_panel_templates WHERE code = 'leykotsitarnaya-formula-ruchnaya-metodika';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Нейтрофилы сегментоядерные', '%', 'numeric', NULL, 1, NULL, 2 FROM lab_panel_templates WHERE code = 'leykotsitarnaya-formula-ruchnaya-metodika';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Эозинофилы', '%', 'numeric', NULL, 1, NULL, 3 FROM lab_panel_templates WHERE code = 'leykotsitarnaya-formula-ruchnaya-metodika';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Базофилы', '%', 'numeric', NULL, 1, NULL, 4 FROM lab_panel_templates WHERE code = 'leykotsitarnaya-formula-ruchnaya-metodika';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Лимфоциты', '%', 'numeric', NULL, 1, NULL, 5 FROM lab_panel_templates WHERE code = 'leykotsitarnaya-formula-ruchnaya-metodika';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Моноциты', '%', 'numeric', NULL, 1, NULL, 6 FROM lab_panel_templates WHERE code = 'leykotsitarnaya-formula-ruchnaya-metodika';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Плазматические клетки', '%', 'numeric', NULL, 1, NULL, 7 FROM lab_panel_templates WHERE code = 'leykotsitarnaya-formula-ruchnaya-metodika';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Морфология клеток крови', NULL, 'text', NULL, 0, NULL, 8 FROM lab_panel_templates WHERE code = 'leykotsitarnaya-formula-ruchnaya-metodika';

-- obschiy-analiz-mochi — 18 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Цвет', NULL, 'text', NULL, 0, 'Физические свойства', 1 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Прозрачность', NULL, 'select', 'Прозрачная, Слегка мутная, Мутная', 0, 'Физические свойства', 2 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Относительная плотность', NULL, 'numeric', NULL, 3, 'Физические свойства', 3 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Реакция (pH)', NULL, 'numeric', NULL, 1, 'Физические свойства', 4 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Белок', 'г/л', 'numeric', NULL, 3, 'Химическое исследование', 5 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Глюкоза', 'ммоль/л', 'numeric', NULL, 1, 'Химическое исследование', 6 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Кетоновые тела', NULL, 'select', 'Отрицательно, Следы, +, ++, +++', 0, 'Химическое исследование', 7 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Билирубин', NULL, 'select', 'Отрицательно, Положительно', 0, 'Химическое исследование', 8 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Уробилиноген', NULL, 'select', 'В норме, Повышен', 0, 'Химическое исследование', 9 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Нитриты', NULL, 'select', 'Отрицательно, Положительно', 0, 'Химическое исследование', 10 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Гемоглобин (кровь)', NULL, 'select', 'Отрицательно, Следы, +, ++, +++', 0, 'Химическое исследование', 11 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Лейкоциты', 'в п/зр', 'numeric', NULL, 0, 'Микроскопия осадка', 12 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Эритроциты', 'в п/зр', 'numeric', NULL, 0, 'Микроскопия осадка', 13 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Эпителий плоский', 'в п/зр', 'numeric', NULL, 0, 'Микроскопия осадка', 14 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Цилиндры', NULL, 'text', NULL, 0, 'Микроскопия осадка', 15 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Бактерии', NULL, 'select', 'Не обнаружены, Незначительное количество, Умеренное количество, Большое количество', 0, 'Микроскопия осадка', 16 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Слизь', NULL, 'select', 'Не обнаружена, Незначительное количество, Умеренное количество, Большое количество', 0, 'Микроскопия осадка', 17 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Соли', NULL, 'text', NULL, 0, 'Микроскопия осадка', 18 FROM lab_panel_templates WHERE code = 'obschiy-analiz-mochi';

-- obschiy-analiz-kala — 13 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Консистенция', NULL, 'text', NULL, 0, 'Физические свойства', 1 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Цвет', NULL, 'text', NULL, 0, 'Физические свойства', 2 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Слизь', NULL, 'select', 'Не обнаружена, Незначительное количество, Умеренное количество, Большое количество', 0, 'Физические свойства', 3 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Кровь', NULL, 'select', 'Не обнаружена, Обнаружена', 0, 'Физические свойства', 4 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Мышечные волокна', NULL, 'select', 'Не обнаружены, Единичные, Умеренное количество, Большое количество', 0, 'Микроскопия', 5 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Нейтральный жир', NULL, 'select', 'Не обнаружен, Единичные капли, Умеренное количество, Большое количество', 0, 'Микроскопия', 6 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Жирные кислоты', NULL, 'select', 'Не обнаружены, Единичные, Умеренное количество, Большое количество', 0, 'Микроскопия', 7 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Крахмал', NULL, 'select', 'Не обнаружен, Единичные зёрна, Умеренное количество, Большое количество', 0, 'Микроскопия', 8 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Йодофильная флора', NULL, 'select', 'Не обнаружена, Незначительное количество, Умеренное количество, Большое количество', 0, 'Микроскопия', 9 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Лейкоциты', 'в п/зр', 'numeric', NULL, 0, 'Микроскопия', 10 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Эритроциты', 'в п/зр', 'numeric', NULL, 0, 'Микроскопия', 11 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Яйца гельминтов', NULL, 'select', 'Не обнаружены, Обнаружены', 0, 'Паразитология', 12 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Простейшие', NULL, 'select', 'Не обнаружены, Обнаружены', 0, 'Паразитология', 13 FROM lab_panel_templates WHERE code = 'obschiy-analiz-kala';

-- gemostaziogramma-skrining — 6 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Протромбиновое время (ПВ)', 'сек', 'numeric', NULL, 1, NULL, 1 FROM lab_panel_templates WHERE code = 'gemostaziogramma-skrining';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Протромбиновый индекс (ПТИ)', '%', 'numeric', NULL, 0, NULL, 2 FROM lab_panel_templates WHERE code = 'gemostaziogramma-skrining';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'МНО (INR)', NULL, 'numeric', NULL, 2, NULL, 3 FROM lab_panel_templates WHERE code = 'gemostaziogramma-skrining';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'АЧТВ (APTT)', 'сек', 'numeric', NULL, 1, NULL, 4 FROM lab_panel_templates WHERE code = 'gemostaziogramma-skrining';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Фибриноген', 'г/л', 'numeric', NULL, 2, NULL, 5 FROM lab_panel_templates WHERE code = 'gemostaziogramma-skrining';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Тромбиновое время', 'сек', 'numeric', NULL, 1, NULL, 6 FROM lab_panel_templates WHERE code = 'gemostaziogramma-skrining';

-- gemostaziogramma-rasshirennaya — 10 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Протромбиновое время (ПВ)', 'сек', 'numeric', NULL, 1, NULL, 1 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Протромбиновый индекс (ПТИ)', '%', 'numeric', NULL, 0, NULL, 2 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'МНО (INR)', NULL, 'numeric', NULL, 2, NULL, 3 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'АЧТВ (APTT)', 'сек', 'numeric', NULL, 1, NULL, 4 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Фибриноген', 'г/л', 'numeric', NULL, 2, NULL, 5 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Тромбиновое время', 'сек', 'numeric', NULL, 1, NULL, 6 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Антитромбин III', '%', 'numeric', NULL, 0, NULL, 7 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'D-димер', 'мкг/мл FEU', 'numeric', NULL, 2, NULL, 8 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'РФМК', 'мг/100 мл', 'numeric', NULL, 1, NULL, 9 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Волчаночный антикоагулянт', NULL, 'select', 'Не обнаружен, Обнаружен', 0, NULL, 10 FROM lab_panel_templates WHERE code = 'gemostaziogramma-rasshirennaya';

-- lipidogramma — 6 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Холестерин общий', 'ммоль/л', 'numeric', NULL, 2, NULL, 1 FROM lab_panel_templates WHERE code = 'lipidogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Триглицериды', 'ммоль/л', 'numeric', NULL, 2, NULL, 2 FROM lab_panel_templates WHERE code = 'lipidogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'ЛПВП (HDL)', 'ммоль/л', 'numeric', NULL, 2, NULL, 3 FROM lab_panel_templates WHERE code = 'lipidogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'ЛПНП (LDL)', 'ммоль/л', 'numeric', NULL, 2, NULL, 4 FROM lab_panel_templates WHERE code = 'lipidogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'ЛПОНП (VLDL)', 'ммоль/л', 'numeric', NULL, 2, NULL, 5 FROM lab_panel_templates WHERE code = 'lipidogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Индекс атерогенности', NULL, 'numeric', NULL, 2, NULL, 6 FROM lab_panel_templates WHERE code = 'lipidogramma';

-- spermogramma — 14 показателей
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Объём эякулята', 'мл', 'numeric', NULL, 1, 'Макроскопия', 1 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Цвет', NULL, 'text', NULL, 0, 'Макроскопия', 2 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Вязкость', 'см', 'numeric', NULL, 1, 'Макроскопия', 3 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Реакция (pH)', NULL, 'numeric', NULL, 1, 'Макроскопия', 4 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Время разжижения', 'мин', 'numeric', NULL, 0, 'Макроскопия', 5 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Концентрация сперматозоидов', 'млн/мл', 'numeric', NULL, 1, 'Микроскопия', 6 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Общее количество сперматозоидов', 'млн', 'numeric', NULL, 1, 'Микроскопия', 7 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Прогрессивно-подвижные (PR)', '%', 'numeric', NULL, 0, 'Подвижность', 8 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Непрогрессивно-подвижные (NP)', '%', 'numeric', NULL, 0, 'Подвижность', 9 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Неподвижные (IM)', '%', 'numeric', NULL, 0, 'Подвижность', 10 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Жизнеспособность', '%', 'numeric', NULL, 0, 'Подвижность', 11 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Нормальные формы', '%', 'numeric', NULL, 0, 'Морфология', 12 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Лейкоциты', 'млн/мл', 'numeric', NULL, 1, 'Микроскопия', 13 FROM lab_panel_templates WHERE code = 'spermogramma';
INSERT INTO lab_panel_template_analytes (template_id, name, unit, value_type, value_options, decimals, group_label, sort_order)
  SELECT id, 'Агглютинация', NULL, 'select', 'Не обнаружена, Обнаружена', 0, 'Микроскопия', 14 FROM lab_panel_templates WHERE code = 'spermogramma';
