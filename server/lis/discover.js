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
//
// LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — прибор узнаётся по адресу и по
// тому, КАК ОН СЕБЯ НАЗВАЛ (MSH-3, колонка sending_app, мигр. 229), а не по
// модели. Модель и название правит человек («Добавить», «Изменить»), и строка,
// которую искали по угаданной модели, после правки терялась: следующая проба
// заводила дубль, а панели исправленной строки уходили в лоток (S5). Имя,
// которым прибор назвался сам, человек не правит — на нём различение и держится.
import { listProfiles, aliasesOf } from './profiles/index.js';   // aliasesOf: LIS_REAL_ANALYZERS_V1_MODEL

// Потолок на находки: порт неаутентифицирован, и без предела кто угодно в сети
// клиники мог бы наплодить строк. Двадцать приборов — это больше, чем есть у
// любой клиники, которую мы видели.
const MAX_DISCOVERED = 20;

// Порт по умолчанию — тот же, что у слушателей (index.js, DEFAULT_PORT).
// Отсюда не импортируется: index.js сам импортирует этот файл, и цикл импортов
// ради одного числа не нужен.
const DEFAULT_PORT = 2575;

/** Схлопывает «BC-5300», «bc 5300», «BC_5300» к одному виду для сравнения. */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const WORD_CHAR = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
/** Короткая модель (до 5 знаков: «A1000», «BS-200», «BC-20») — только целым словом. */
const SHORT_MODEL = 5;

/**
 * LIS_REAL_ANALYZERS_V1_MODEL — модель «содержится» в имени, только если сразу
 * за ней не цифра: «bs200» не узнаётся в «bs2000m», «bc20» — в «bc2006».
 *
 * LIS_REAL_ANALYZERS_V1 (ревью R2, п. 8) — и с начала слова: перед моделью в
 * имени, как оно пришло, — начало или не буква и не цифра. У «A1000» левой
 * границы не было, и Sysmex CA-1000 (коагулометр), «XA1000» угадывались как
 * AutoLumo. Короткая модель (до 5 знаков) — целым словом и справа: за ней не
 * буква («EasyLab A1000X», «BC-20s» — другие приборы). Длинная («BC-5300»,
 * «BS-200E») — как прежде справа: только не цифра.
 * @param {string} raw    имя, как прибор его написал
 * @param {string} model  модель, сжатая norm()
 */
function containsModel(raw, model) {
  const chars = [];
  const at = [];   // позиция каждого знака сжатого имени в имени, как оно пришло
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i].toLowerCase();
    if (/[a-z0-9]/.test(c)) { chars.push(c); at.push(i); }
  }
  const name = chars.join('');
  for (let i = name.indexOf(model); i !== -1; i = name.indexOf(model, i + 1)) {
    if (/[0-9]/.test(name.charAt(i + model.length))) continue;
    const before = raw.charAt(at[i] - 1);
    if (before && WORD_CHAR.test(before)) continue;
    const after = raw.charAt(at[i + model.length - 1] + 1);
    if (model.length <= SHORT_MODEL && after && LETTER.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * Профиль по тому, как прибор себя назвал. null — не узнали, и это законно: у
 * прибора останется пустая модель, а лаборант выберет её сам.
 *
 * LIS_REAL_ANALYZERS_V1_MODEL — MSH-3 И MSH-4 по очереди, модель И псевдонимы
 * профиля (aliases): так узнаются оба порядка — «производитель | модель»
 * (BS-200: «Mindray|BS-200E», руководство, с. 7–8) и «модель | марка»
 * (Autobio: «A1000|Autolumo»; гематология Mindray: «BC-780|Mindray»).
 *   1. точное совпадение — сначала по MSH-3, потом по MSH-4;
 *   2. «содержит» с границей-цифрой — сначала MSH-3, потом MSH-4; из
 *      подошедших — самая длинная: «BC-5300» точнее, чем «BC-20»;
 *   3. не узнали — null.
 * Прежняя форма — строка MSH-3 — работает как раньше.
 * @param {{app?: string, facility?: string}|string} who
 */
export function guessProfile(who) {
  const { app = '', facility = '' } = who && typeof who === 'object' ? who : { app: who };
  const raws = [String(app == null ? '' : app), String(facility == null ? '' : facility)].filter((r) => norm(r));
  if (!raws.length) return null;
  const all = listProfiles().map((p) => ({ p, keys: aliasesOf(p).map(norm).filter(Boolean) }));
  // Точное совпадение модели или псевдонима — единственный надёжный случай.
  for (const raw of raws) {
    const want = norm(raw);
    const exact = all.find(({ keys }) => keys.includes(want));
    if (exact) return exact.p;
  }
  // «MINDRAY BC-5300» или «BC-5300 v2» — имя прибора содержит модель.
  for (const raw of raws) {
    let best = null;
    let bestLen = 0;
    for (const { p, keys } of all) {
      for (const k of keys) {
        if (k.length >= 4 && k.length > bestLen && containsModel(raw, k)) { best = p; bestLen = k.length; }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Как прибор назвал себя — для сравнения: без пробелов вокруг и без учёта регистра. */
const appKey = (s) => String(s == null ? '' : s).trim().toLowerCase();
/** Строка уже знает, как называет себя её прибор. */
const hasApp = (d) => appKey(d.sending_app) !== '';

/**
 * LIS_REAL_ANALYZERS_V1_MODEL — дописывает строке, как прибор назвал себя:
 * MSH-3 (sending_app) и MSH-4 (sending_facility, мигр. 233). Каждое пишется,
 * только если строка его ещё не знает: запомненное первым не перезаписывается
 * — так же, как в бэкфилле мигр. 229. Пишет только сервер.
 */
function learn(db, dev, { app = '', facility = '' }) {
  if (app && !hasApp(dev)) db.prepare('UPDATE lab_devices SET sending_app = ? WHERE id = ?').run(app, dev.id);
  if (facility && String(dev.sending_facility == null ? '' : dev.sending_facility).trim() === '') {
    db.prepare('UPDATE lab_devices SET sending_facility = ? WHERE id = ?').run(facility, dev.id);
  }
}

/**
 * LIS_REAL_ANALYZERS_V1_DIAL — к прибору, который ждёт звонка, Easy-Med
 * подключается сам: прибор известен заранее, ensureDevice не нужен. Строка
 * лишь дописывает, как он назвал себя (MSH-3/4), если ещё не знает: тогда, если
 * прибор позже станет звонить сам, шаг 1(а) найдёт ту же строку.
 */
export function learnSender(db, deviceId, { app = '', facility = '' } = {}) {
  const dev = db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(deviceId);
  if (!dev) return;
  learn(db, dev, { app: String(app == null ? '' : app).trim(), facility: String(facility == null ? '' : facility).trim() });
}

/**
 * Дописывает строке адрес (если он передан) и имя отправителя и возвращает её
 * свежей. Имя пишется, только если строка его ещё не знает: запомненное первым
 * не перезаписывается — так же, как в бэкфилле мигр. 229.
 */
function claim(db, dev, { host = '', app = '', facility = '' }) {
  if (host) db.prepare('UPDATE lab_devices SET host = ? WHERE id = ?').run(host, dev.id);
  learn(db, dev, { app, facility });   // LIS_REAL_ANALYZERS_V1_MODEL — и MSH-4
  return db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(dev.id);
}

/**
 * Находит прибор по адресу и имени, которым он назвался, или заводит новый.
 *
 * @param {object} o
 * @param {string} [o.sendingApp]  MSH-3, как прибор назвал себя ('' — не назвался)
 * @param {string} [o.sendingFacility]  MSH-4 (LIS_REAL_ANALYZERS_V1_MODEL): только
 *        для догадки о модели и показа; в различении приборов не участвует
 * @param {string} [o.peer]        адрес отправителя
 * @param {number} [o.port]        порт, на который пришло сообщение
 * @param {boolean} [o.allowCreate] false — сообщение не разобралось (мусор)
 * @returns {{device: object|null, created: boolean, reason: string}}
 *   device = null означает «не завели» — мусор на порту или потолок находок
 *   исчерпан. Сообщение при этом всё равно сохранится в лотке (инвариант 2),
 *   просто без прибора.
 */
export function ensureDevice(db, { sendingApp = '', sendingFacility = '', peer = '', port = DEFAULT_PORT, allowCreate = true } = {}) {
  const ip = String(peer || '').replace(/^::ffff:/, '');
  const app = String(sendingApp == null ? '' : sendingApp).trim();
  const key = appKey(app);
  const listenPort = Number(port) || DEFAULT_PORT;
  // LIS_REAL_ANALYZERS_V1_MODEL — MSH-4: модель угадывается и по нему (BS-200:
  // «Mindray|BS-200E»), а строка его запоминает. Различение — по-прежнему
  // адрес и MSH-3.
  const facility = String(sendingFacility == null ? '' : sendingFacility).trim();

  const guessed = guessProfile({ app, facility });

  // 1. Тот же адрес.
  //
  //    Совпадения адреса мало. Два прибора бывают видны системе с одного адреса
  //    (два переадресатора COM на одном лабораторном ПК, сеть за NAT), и
  //    приписать второй к строке первого значит накормить панель данными не
  //    того аппарата — или спрятать второй навсегда: AutoLumo (модель не
  //    угадать) ложился в строку BC-2800 «по адресу» и не появлялся никогда
  //    (S4). Поэтому по адресу ищется строка, знающая ИМЯ отправителя.
  if (ip) {
    const byHost = db.prepare('SELECT * FROM lab_devices WHERE host = ? ORDER BY id').all(ip);
    if (byHost.length && key) {
      // (а) Строка этого адреса, которая уже знает это имя, — она, какими бы
      //     ни были её модель и название сейчас. Их правит человек, и строка
      //     после правки обязана остаться своей (S5).
      const named = byHost.find((d) => appKey(d.sending_app) === key);
      // LIS_REAL_ANALYZERS_V1_MODEL — строка, заведённая до мигр. 233, узнаёт
      // MSH-4 со следующей пробы (бэкфилла нет).
      if (named && facility && !String(named.sending_facility == null ? '' : named.sending_facility).trim()) {
        return { device: claim(db, named, { facility }), created: false, reason: 'по адресу и имени' };
      }
      if (named) return { device: named, created: false, reason: 'по адресу и имени' };

      // (б) Строки этого адреса, ещё не знающие имени, — заведённые до
      //     мигр. 229 или человеком и ещё не принимавшие проб. Строка берёт
      //     отправителя и запоминает его имя: дальше она его и только его.
      const unnamed = byHost.filter((d) => !hasApp(d));
      // Прибор, заведённый ЧЕЛОВЕКОМ на этот адрес, — истина в последней
      // инстанции, и модель мы у него не оспариваем. Человек сказал «по адресу
      // 10.0.0.9 стоит вот этот прибор»; если он ошибся с моделью, это его
      // ошибка и его правка, а не повод завести вторую строку у него за спиной.
      const byHuman = unnamed.find((d) => !d.discovered);
      if (byHuman) return { device: claim(db, byHuman, { app, facility }), created: false, reason: 'заведён человеком на этот адрес' };
      // Найденная строка без имени (старая, до мигр. 229) — по прежнему правилу
      // модели: её модель — наша догадка, и склеивать по ней два разных
      // аппарата нельзя. Модель не опознана — верим адресу, иначе незнакомый
      // прибор заводил бы новую строку на каждое сообщение.
      const oldFound = guessed
        ? unnamed.find((d) => d.discovered && d.profile === guessed.key)
        : unnamed.find((d) => d.discovered);
      if (oldFound) return { device: claim(db, oldFound, { app, facility }), created: false, reason: guessed ? 'по адресу и модели' : 'по адресу' };

      // (в) Строки этого адреса знают другие имена (или это старая находка
      //     другой модели) — значит, за адресом другой прибор. Дальше по
      //     шагам, и в конце — новая находка.
    } else if (byHost.length) {
      // Прибор не назвался (MSH-3 пуст) — различать нечем, кроме адреса.
      // Строка, которая тоже не знает имени, вернее: её заводил безымянный.
      const dev = byHost.find((d) => !hasApp(d)) || byHost[0];
      return { device: dev, created: false, reason: 'по адресу' };
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
  //
  //    LIS_DISCOVERY_FIX_V1 — «представился так же» значит то же имя в
  //    sending_app (без учёта регистра): название строки мог поменять человек.
  //    У строки, ещё не знающей имени (до мигр. 229), — по названию, как раньше.
  if (key) {
    const hostless = db.prepare("SELECT * FROM lab_devices WHERE discovered = 1 AND (host IS NULL OR host = '') ORDER BY id").all();
    const byName = hostless.find((d) => appKey(d.sending_app) === key)
      || hostless.find((d) => !hasApp(d) && d.name === app);
    if (byName) return { device: claim(db, byName, { host: ip, app, facility }), created: false, reason: 'по имени' };
  }

  // Мусор на порту не должен заводить приборов: сообщение, которое не удалось
  // даже разобрать, ничего о себе не сообщило, и строка по нему была бы
  // выдумкой. Оно всё равно сохранится в лотке (инвариант 2).
  //
  // LIS_DISCOVERY_FIX_V1 — и строку без адреса (шаг 3) мусор не забирает: она
  // запоминает адрес первого, кого приняла, и отдать её тому, кто шлёт на
  // порт неразбираемое, значило бы закрыть её для настоящего анализатора.
  if (!allowCreate) return { device: null, created: false, reason: 'нераспознанное сообщение — прибор не заводим' };

  // 3. Прибор, заведённый ЧЕЛОВЕКОМ без адреса (решение владельца 2026-09-29).
  //    Клиника с одним анализатором не обязана заполнять поле адреса — но
  //    прежнее «единственный без адреса — он и есть отправитель» не смотрело ни
  //    на порт, ни на вид подключения: строка «Кабель COM», у которой адреса
  //    нет никогда, забирала сетевой BS-240 (S1), строка на порту 5100 —
  //    чужой прибор на 2575 (S2), и настоящий прибор так и не появлялся в
  //    «Найдены в сети». Теперь такая строка принимает пробу, только если всё
  //    сразу:
  //     — она сетевая (mllp) и включена;
  //     — сообщение пришло на ЕЁ порт (пустой порт — 2575);
  //     — модель отправителя ей не противоречит: противоречие — это угаданная
  //       модель есть, у строки модель есть, и они разные;
  //     — она ещё не привязана к другому прибору (не знает другого имени).
  //    С первой пробы строка запоминает имя И адрес отправителя и дальше
  //    принимает только его: два одинаковых прибора называют себя одинаково и
  //    различаются только адресом. Любой другой прибор — новая находка.
  //    Если таких строк несколько: та, что уже знает это имя (бэкфилл мигр. 229
  //    пишет имя без адреса); иначе единственная свободная; иначе находка —
  //    угадывать между двумя свободными строками нельзя.
  const hostless = db.prepare(`SELECT * FROM lab_devices
                                WHERE discovered = 0 AND enabled = 1 AND transport = 'mllp'
                                  AND (host IS NULL OR host = '')
                                  AND COALESCE(port, ?) = ?
                                ORDER BY id`).all(DEFAULT_PORT, listenPort)
    .filter((d) => !(guessed && d.profile && d.profile !== guessed.key))
    .filter((d) => !hasApp(d) || (key && appKey(d.sending_app) === key));
  const knowsName = key ? hostless.find((d) => hasApp(d)) : null;
  if (knowsName) return { device: claim(db, knowsName, { host: ip, app, facility }), created: false, reason: 'без адреса, по имени' };
  const free = hostless.filter((d) => !hasApp(d));
  if (free.length === 1) return { device: claim(db, free[0], { host: ip, app, facility }), created: false, reason: 'единственный без адреса' };

  const found = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE discovered = 1').get().c;
  if (found >= MAX_DISCOVERED) return { device: null, created: false, reason: 'достигнут предел найденных приборов' };

  const profile = guessed;
  // LIS_REAL_ANALYZERS_V1 (ревью R2) — модель узнана только по MSH-4 (в MSH-3
  // производитель: BS-200 — «Mindray|BS-200E»): название — «MSH-3 MSH-4»,
  // «Mindray BS-200E», а не «Mindray». Только название: различение приборов
  // — по-прежнему адрес и MSH-3 (sending_app).
  const byFacility = guessed && facility && !guessProfile({ app });
  let name = (byFacility ? [app, facility].filter(Boolean).join(' ') : app) || (ip ? 'Анализатор ' + ip : 'Анализатор');
  // Два одинаковых прибора обязаны различаться в списке. Единственное, чем они
  // отличаются, — адрес, поэтому он и уходит в имя: две строки «BC-20» человек
  // не разберёт, а «BC-20 (10.0.0.12)» разберёт сразу.
  if (db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE name = ?').get(name).c > 0) {
    name = ip ? name + ' (' + ip + ')' : name + ' #' + (found + 1);
  }
  // LIS_ANALYZER_LIST_V1 — находка ждёт одного нажатия «Добавить» в окне
  // «Добавить прибор» (added = 0; решение владельца 2026-09-29). Пробы
  // найденного прибора сохраняются всегда (инвариант 2).
  // LIS_VENDOR_EXACT_V1 (N2) — но в бланки они не идут, пока прибор не
  // добавлен: модель находки — догадка по имени, а по модели читаются номер
  // пробы и значения (ingest.js, «прибор ещё не добавлен…»; приёмка BC-5300 N2).
  // LIS_DISCOVERY_FIX_V1 — находка сразу помнит, как прибор себя назвал
  // (NULL — не назвался): по этому имени она и найдётся после любой правки.
  // LIS_REAL_ANALYZERS_V1_MODEL — и MSH-4 (NULL — не назвался).
  const id = db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added, sending_app, sending_facility)
                         VALUES (?, ?, 'mllp', ?, ?, 1, 1, 0, ?, ?)`)
    .run(name, profile ? profile.key : '', ip, listenPort, app || null, facility || null).lastInsertRowid;

  return { device: db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(id), created: true, reason: 'заведён по первому сообщению' };
}
