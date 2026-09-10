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
export function ensureDevice(db, { sendingApp = '', peer = '', port = 2575, allowCreate = true } = {}) {
  const ip = String(peer || '').replace(/^::ffff:/, '');

  const guessed = guessProfile(sendingApp);

  // 1. Прибор с этим адресом уже заведён — при условии, что он ТОЙ ЖЕ модели.
  //
  //    Совпадения адреса мало. Два прибора бывают видны системе с одного адреса
  //    (оба подключены к одному лабораторному ПК, или сеть за NAT), и если
  //    отправитель назвался другой моделью, приписать его чужой строке значит
  //    накормить панель данными не того аппарата. Модель мы узнать можем —
  //    значит обязаны проверить.
  if (ip) {
    const byHost = db.prepare('SELECT * FROM lab_devices WHERE host = ? ORDER BY id').all(ip);
    if (byHost.length) {
      // Прибор, заведённый ЧЕЛОВЕКОМ на этот адрес, — истина в последней
      // инстанции, и модель мы у него не оспариваем. Человек сказал «по адресу
      // 10.0.0.9 стоит вот этот прибор»; если он ошибся с моделью, это его
      // ошибка и его правка, а не повод завести вторую строку у него за спиной.
      const byHuman = byHost.find((d) => !d.discovered);
      if (byHuman) return { device: byHuman, created: false, reason: 'заведён человеком на этот адрес' };

      // Среди НАЙДЕННЫХ строк модель проверяем: их имена и профили — наша
      // догадка, и склеивать по ней два разных аппарата нельзя.
      const sameModel = guessed ? byHost.find((d) => d.profile === guessed.key) : null;
      if (sameModel) return { device: sameModel, created: false, reason: 'по адресу и модели' };
      // Модель не опознана — верим адресу. Иначе незнакомый прибор заводил бы
      // новую строку на каждое сообщение.
      if (!guessed) return { device: byHost[0], created: false, reason: 'по адресу' };
    }
  }

  // 2. Найденный ранее прибор, который представился так же И ЗА КОТОРЫМ НЕ
  //    ЗАКРЕПЛЁН ДРУГОЙ АДРЕС.
  //
  //    Здесь развилка, у которой нет правильного ответа в самом протоколе. Два
  //    одинаковых анализатора представляются по HL7 ОДИНАКОВО (MSH-3 — это
  //    модель, не серийный номер), и «тот же прибор с новым адресом» ничем не
  //    отличается от «второго такого же прибора». Различить их нечем.
  //
  //    Выбрано: считать это ВТОРЫМ прибором. Из двух возможных ошибок
  //     — склеить два настоящих прибора в одну строку: лаборатория не увидит,
  //       что их два, адрес и «последнее сообщение» будут прыгать между ними, и
  //       ни одной строке верить нельзя;
  //     — завести лишнюю строку после смены адреса по DHCP: она ВИДНА и
  //       удаляется одним щелчком, а результаты продолжают ложиться (панель
  //       принимает от прибора той же модели),
  //    вторая заметна и обратима, а первая тиха и вводит в заблуждение.
  if (sendingApp) {
    const byName = db.prepare("SELECT * FROM lab_devices WHERE discovered = 1 AND name = ? AND (host IS NULL OR host = '') LIMIT 1").get(sendingApp);
    if (byName) {
      if (ip) db.prepare('UPDATE lab_devices SET host = ? WHERE id = ?').run(ip, byName.id);
      return { device: db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(byName.id), created: false, reason: 'по имени' };
    }
  }

  // 3. Единственный настроенный прибор без адреса — он и есть отправитель.
  //    Клиника с одним анализатором не обязана заполнять поле адреса.
  const hostless = db.prepare("SELECT * FROM lab_devices WHERE enabled = 1 AND (host IS NULL OR host = '')").all();
  if (hostless.length === 1) return { device: hostless[0], created: false, reason: 'единственный без адреса' };

  // Мусор на порту не должен заводить приборов: сообщение, которое не удалось
  // даже разобрать, ничего о себе не сообщило, и строка по нему была бы
  // выдумкой. Оно всё равно сохранится в лотке (инвариант 2).
  if (!allowCreate) return { device: null, created: false, reason: 'нераспознанное сообщение — прибор не заводим' };

  const found = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE discovered = 1').get().c;
  if (found >= MAX_DISCOVERED) return { device: null, created: false, reason: 'достигнут предел найденных приборов' };

  const profile = guessed;
  let name = sendingApp || (ip ? 'Анализатор ' + ip : 'Анализатор');
  // Два одинаковых прибора обязаны различаться в списке. Единственное, чем они
  // отличаются, — адрес, поэтому он и уходит в имя: две строки «BC-20» человек
  // не разберёт, а «BC-20 (10.0.0.12)» разберёт сразу.
  if (db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE name = ?').get(name).c > 0) {
    name = ip ? name + ' (' + ip + ')' : name + ' #' + (found + 1);
  }
  const id = db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered)
                         VALUES (?, ?, 'mllp', ?, ?, 1, 1)`)
    .run(name, profile ? profile.key : '', ip, port).lastInsertRowid;

  return { device: db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(id), created: true, reason: 'заведён по первому сообщению' };
}
