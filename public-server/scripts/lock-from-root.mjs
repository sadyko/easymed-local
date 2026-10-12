// PUBLIC_SERVER_V1 — package-lock.json службы из корневого package-lock.json
// (ревью 8b, C13). Без сети и без npm: берутся ровно те версии, адреса и
// отпечатки, что стоят в корне и прогнаны тестами. Из корневого lock
// выбираются пакеты, до которых доходит поиск Node от зависимостей
// public-server/package.json, — с теми же путями node_modules, так что каждая
// зависимость находится так же, как в корне.
//
// Запуск из корня репозитория (после смены версий express / better-sqlite3 в
// корне): node public-server/scripts/lock-from-root.mjs
// Страж: public-server/server/lockfile.test.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Путь пакета dep, который найдёт Node из пакета по пути from ('' — корень). */
function resolveFrom(all, from, dep) {
  let dir = from;
  for (;;) {
    const cand = (dir ? dir + '/' : '') + 'node_modules/' + dep;
    if (all[cand]) return cand;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i < 0 ? '' : dir.slice(0, i);
  }
}

/**
 * @param {{packages:Object<string, object>}} root корневой package-lock.json (lockfileVersion 3)
 * @param {{name:string, version:string, dependencies:Object<string,string>, engines?:object}} pkg public-server/package.json
 */
export function lockFromRoot(root, pkg) {
  const all = root && root.packages;
  if (!all) throw new Error('корневой package-lock.json без packages (нужен lockfileVersion 3)');
  const reached = new Map();   // путь → дошли ли по обязательной зависимости
  const queue = [];
  const visit = (from, deps, optional) => {
    for (const dep of Object.keys(deps || {})) {
      const p = resolveFrom(all, from, dep);
      if (!p) {
        if (optional) continue;
        throw new Error('в корневом lock нет ' + dep + ' (нужен ' + (from || 'public-server') + ')');
      }
      const was = reached.get(p);
      if (was === undefined || (was === false && !optional)) { reached.set(p, !optional); queue.push(p); }
    }
  };
  visit('', pkg.dependencies, false);
  while (queue.length) {
    const p = queue.shift();
    const e = all[p];
    const required = reached.get(p);
    visit(p, e.dependencies, !required);
    visit(p, e.optionalDependencies, true);
    const peers = Object.keys(e.peerDependencies || {}).filter((d) => !(e.peerDependenciesMeta && e.peerDependenciesMeta[d] && e.peerDependenciesMeta[d].optional));
    visit(p, Object.fromEntries(peers.map((d) => [d, e.peerDependencies[d]])), !required);
  }
  const packages = {
    '': { name: pkg.name, version: pkg.version, dependencies: { ...pkg.dependencies }, ...(pkg.engines ? { engines: { ...pkg.engines } } : {}) },
  };
  for (const p of [...reached.keys()].sort()) {
    const { dev, devOptional, optional, peer, ...rest } = all[p];
    packages[p] = { ...rest, ...(reached.get(p) ? {} : { optional: true }) };
  }
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = path.dirname(HERE);
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const lock = lockFromRoot(read(path.join(service, '..', 'package-lock.json')), read(path.join(service, 'package.json')));
  fs.writeFileSync(path.join(service, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  console.log('public-server/package-lock.json:', Object.keys(lock.packages).length - 1, 'пакетов');
}
