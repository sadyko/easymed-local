// LIS_AUTODISCOVER_V1 — прибор заводится сам, когда впервые заговорил.
//
// Решение владельца: «we should not setup anything». До этого наладка упиралась
// в шаг, который инженер физически не мог сделать заранее — он не знал ни
// адреса прибора, ни того, как тот себя называет, пока прибор не прислал первое
// сообщение. Теперь первое сообщение и есть заведение.
//
// Что здесь НЕ происходит: найденный прибор не начинает молча писать в бланки.
// Чтобы его результаты куда-то легли, человек всё равно обязан привязать его к
// панели и подтвердить поля (D3/D4). Самоопределение экономит настройку, а не
// отменяет подтверждение.
import { listProfiles } from './profiles/index.js';

// Потолок на находки: порт неаутентифицирован, и без предела кто угодно в сети
// клиники мог бы наплодить строк. Двадцать приборов — это больше, чем есть у
// любой клиники, которую мы видели.
const MAX_DISCOVERED = 20;

/** Схлопывает «BC-5300», «bc 5300», «BC_5300» к одному виду для сравнения. */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Профиль по тому, как прибор себя назвал в MSH-3. null — не узнали, и это
 * законно: у прибора останется пустая модель, а лаборант выберет её сам.
 */
export function guessProfile(sendingApp) {
  const want = norm(sendingApp);
  if (!want) return null;
  const all = listProfiles();
  // Точное совпадение модели — единственный надёжный случай.
  const exact = all.find((p) => norm(p.model) === want);
  if (exact) return exact;
  // «MINDRAY BC-5300» или «BC-5300 v2» — имя прибора содержит модель. Берём
  // самую длинную из подошедших: «BC-5300» точнее, чем «BC-20», если строка
  // содержит обе.
  const contains = all
    .filter((p) => norm(p.model).length >= 4 && want.includes(norm(p.model)))
    .sort((a, b) => norm(b.model).length - norm(a.model).length);
  return contains[0] || null;
}

/**
 * Находит прибор по адресу или заводит новый.
 *
 * @returns {{device: object|null, created: boolean, reason: string}}
 *   device = null означает «не завели» — потолок находок исчерпан. Сообщение
 *   при этом всё равно сохранится в лотке (инвариант 2), просто без прибора.
 */
export function ensureDevice(db, { sendingApp = '', peer = '', port = 2575 } = {}) {
  const ip = String(peer || '').replace(/^::ffff:/, '');

  // 1. Прибор с этим адресом уже заведён.
  if (ip) {
    const byHost = db.prepare('SELECT * FROM lab_devices WHERE host = ? LIMIT 1').get(ip);
    if (byHost) return { device: byHost, created: false, reason: 'по адресу' };
  }

  // 2. Найденный ранее прибор, который представился так же. Адрес мог смениться
  //    (DHCP), а прибор тот же — второй строки быть не должно.
  if (sendingApp) {
    const byName = db.prepare('SELECT * FROM lab_devices WHERE discovered = 1 AND name = ? LIMIT 1').get(sendingApp);
    if (byName) {
      if (ip && byName.host !== ip) db.prepare('UPDATE lab_devices SET host = ? WHERE id = ?').run(ip, byName.id);
      return { device: db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(byName.id), created: false, reason: 'по имени' };
    }
  }

  // 3. Единственный настроенный прибор без адреса — он и есть отправитель.
  //    Клиника с одним анализатором не обязана заполнять поле адреса.
  const hostless = db.prepare("SELECT * FROM lab_devices WHERE enabled = 1 AND (host IS NULL OR host = '')").all();
  if (hostless.length === 1) return { device: hostless[0], created: false, reason: 'единственный без адреса' };

  const found = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE discovered = 1').get().c;
  if (found >= MAX_DISCOVERED) return { device: null, created: false, reason: 'достигнут предел найденных приборов' };

  const profile = guessProfile(sendingApp);
  const name = sendingApp || (ip ? 'Анализатор ' + ip : 'Анализатор');
  const id = db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered)
                         VALUES (?, ?, 'mllp', ?, ?, 1, 1)`)
    .run(name, profile ? profile.key : '', ip, port).lastInsertRowid;

  return { device: db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(id), created: true, reason: 'заведён по первому сообщению' };
}
