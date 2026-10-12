// API_DOCS_V1 — пересобрать public-server/server/docs/generated.js: ответы
// примеров документации (настоящий сервер в этом процессе, мир клиники «Шифо»,
// случайный порт 127.0.0.1 — test-helpers/docs-run.js) и переводы подписей из
// словаря программы. Запускать из корня репозитория после правки ответов
// партнёрам, примеров (docs/content.js) или подписей прав и событий:
//   node public-server/scripts/docs-build.mjs
// Страж docs/examples.http.test.js краснеет, пока файл не пересобран.
import fs from 'node:fs';
import path from 'node:path';
import { buildGenerated, GENERATED_FILE } from '../server/test-helpers/docs-run.js';

const text = await buildGenerated();
fs.writeFileSync(GENERATED_FILE, text);
console.log('docs: ' + path.relative(process.cwd(), GENERATED_FILE).replace(/\\/g, '/') + ' — ' + text.length + ' знаков');
