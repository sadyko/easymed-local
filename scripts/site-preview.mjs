// WEBSITE_V1 — просмотр сайта разработчиком: node scripts/site-preview.mjs <путь к копии easymed.db> [порт]
//
// Поднимает ТОЛЬКО приложение сайта (server/site/app.js) на копии базы — без
// ЕРП, ботов и лицензии. Это не обход лицензии: в клинике этого скрипта нет
// (scripts/ не входит в пакет выпуска), а настоящий сервер поднимает сайт лишь
// через server/site/controller.js. Копия, а не рабочая база: сайт пишет заявки,
// карточки CRM и аналитику.
import path from 'node:path';
import { openDb } from '../server/db/connection.js';
import { migrate } from '../server/db/migrate.js';
import { createSiteApp } from '../server/site/app.js';

const [file, portArg] = process.argv.slice(2);
if (!file || /[\\/]data[\\/]easymed\.db$/i.test(path.resolve(file))) {
  console.error('Usage: node scripts/site-preview.mjs <COPY of easymed.db> [port]  (never the live data/easymed.db)');
  process.exit(2);
}
const db = openDb(path.resolve(file));
migrate(db);
const port = Number(portArg) || 8001;
createSiteApp(db, { storageDir: path.join(path.dirname(path.resolve(file)), 'storage') })
  .listen(port, '127.0.0.1', () => console.log(`Site preview: http://localhost:${port}/`));
