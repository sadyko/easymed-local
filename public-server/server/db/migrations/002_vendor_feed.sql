-- PUBLIC_LICENCE_V1 — последний принятый список производителя (шаг 8c): клиники,
-- которых партнёры не видят, и отозванные ключи. Документ хранится целиком, с
-- подписью — при запуске он проверяется заново (store/feed.js loadFeed), так что
-- правка строки руками ничего не даёт. Одна строка. В документе — номера клиник
-- и отпечатки ключей, ни данных пациентов, ни самих ключей.
CREATE TABLE vendor_feed (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  issued_at   TEXT NOT NULL,
  doc         TEXT NOT NULL,
  received_at TEXT NOT NULL
);
