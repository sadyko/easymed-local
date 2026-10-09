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
    const byHost = db.prepare('SELECT * FROM lab_devices WHERE host = ? AND via IS NULL ORDER BY id').all(ip);   // LIS_PROXY_V1 — строки LIS Proxy своему порту не видны
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
    const hostless = db.prepare("SELECT * FROM lab_devices WHERE discovered = 1 AND (host IS NULL OR host = '') AND via IS NULL ORDER BY id").all();   // LIS_PROXY_V1
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
                                  AND via IS NULL
                                ORDER BY id`).all(DEFAULT_PORT, listenPort)   // LIS_PROXY_V1 — via IS NULL
    .filter((d) => !(guessed && d.profile && d.profile !== guessed.key))
    .filter((d) => !hasApp(d) || (key && appKey(d.sending_app) === key));
  const knowsName = key ? hostless.find((d) => hasApp(d)) : null;
  if (knowsName) return { device: claim(db, knowsName, { host: ip, app, facility }), created: false, reason: 'без адреса, по имени' };
  const free = hostless.filter((d) => !hasApp(d));
  if (free.length === 1) return { device: claim(db, free[0], { host: ip, app, facility }), created: false, reason: 'единственный без адреса' };

  const found = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE discovered = 1 AND via IS NULL').get().c;   // LIS_PROXY_V1 — у LIS Proxy свой предел
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

// ═══ LIS_PROXY_V1 — ПРИБОР ЗА LIS PROXY ═════════════════════════════════════
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 4.1, Р7, Р8.)
//
// LIS Proxy не называет модель и не шлёт HL7: в запросе только имя анализатора,
// как его записали в прокси (lisResult[name] / order[name]), подпись (-host,
// обычно имя лабораторного ПК) и адрес отправителя. Строка такого прибора —
// via = 'lisproxy'; имя, подпись и адрес — в proxy_name, proxy_label,
// proxy_ip. host и sending_app пусты: по host триггер мигр. 233 снимает
// подтверждения BS-200, по sending_app приём угадывает модель — а модель здесь
// выбирает только человек («Добавить»).
//
// Кто прибор (LIS_PROXY_V1, ревью I5 — подпись важнее адреса):
//   подпись названа (-host, у каждого лабораторного ПК своя):
//     1. строка с тем же именем и той же подписью (без учёта регистра) и тем же
//        адресом; иначе РОВНО ОДНА с тем же именем и подписью — адрес
//        лабораторного ПК сменился (DHCP): proxy_ip переписывается молча,
//        подтверждения и эпоха кодов целы (триггер смотрит host и port);
//     2. иначе строка с тем же именем и адресом БЕЗ подписи — та же (подпись
//        добавили в прокси): подпись запоминается;
//     3. иначе — новая находка. Чужая непустая подпись на том же адресе — другой
//        ПК (DHCP отдал ему старый адрес первого): подпись строки не
//        переписывается никогда, подтверждения первого ПК ему не достаются;
//   подпись не названа: (имя, адрес) — строка без подписи на этом адресе, иначе
//     единственная на нём; иначе ровно одна строка с тем же именем без подписи —
//     адрес сменился; иначе находка. Два ПК с одинаковым именем без подписи не
//     различаются — известное ограничение (инструкция: -host у каждого ПК свой).
//   Новая находка — discovered = 1, added = 0, модель пустая: ждёт «Добавить»
//   с выбором модели. При сомнении — лишняя видимая строка, а не склейка двух
//   приборов (как шаг 2 выше).
export const PROXY_VIA = 'lisproxy';
/** Предел находок LIS Proxy — свой, как MAX_DISCOVERED у своего порта. */
export const MAX_PROXY_FOUND = 20;

/**
 * @param {{name?:string, label?:string, ip?:string}} o
 * @returns {{device: object|null, moved: {from:string, to:string}|null, reason: string}}
 */
export function ensureProxyDevice(db, { name = '', label = '', ip = '' } = {}) {
  const key = appKey(name);
  const lab = String(label == null ? '' : label).trim();
  const addr = String(ip == null ? '' : ip).replace(/^::ffff:/, '').trim();
  if (!key) return { device: null, moved: null, reason: 'LIS Proxy не прислал имя анализатора' };
  const fresh = (id) => db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(id);
  const rows = db.prepare('SELECT * FROM lab_devices WHERE via = ? ORDER BY id').all(PROXY_VIA)
    .filter((d) => appKey(d.proxy_name) === key);
  const ipOf = (d) => String(d.proxy_ip == null ? '' : d.proxy_ip).trim();
  const labelOf = (d) => appKey(d.proxy_label);
  const labKey = appKey(lab);
  const moveTo = (d) => {
    db.prepare('UPDATE lab_devices SET proxy_ip = ? WHERE id = ?').run(addr, d.id);
    return { device: fresh(d.id), moved: { from: ipOf(d), to: addr }, reason: 'адрес сменился' };
  };
  if (labKey) {
    // ревью I5 — подпись названа: прибор — (имя, подпись), адрес — какой есть.
    const same = rows.filter((d) => labelOf(d) === labKey);
    const here = same.find((d) => ipOf(d) === addr);
    if (here) return { device: fresh(here.id), moved: null, reason: 'по адресу и имени' };
    if (same.length === 1) return moveTo(same[0]);
    if (!same.length) {
      const bare = rows.filter((d) => !labelOf(d) && ipOf(d) === addr);
      if (bare.length === 1) {
        db.prepare('UPDATE lab_devices SET proxy_label = ? WHERE id = ?').run(lab, bare[0].id);
        return { device: fresh(bare[0].id), moved: null, reason: 'по адресу и имени' };
      }
    }
  } else {
    const atIp = rows.filter((d) => ipOf(d) === addr);
    const here = atIp.find((d) => !labelOf(d)) || (atIp.length === 1 ? atIp[0] : null);
    if (here) return { device: fresh(here.id), moved: null, reason: 'по адресу и имени' };
    const bare = rows.filter((d) => !labelOf(d));
    if (bare.length === 1) return moveTo(bare[0]);
  }
  const found = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE via = ? AND discovered = 1').get(PROXY_VIA).c;
  if (found >= MAX_PROXY_FOUND) return { device: null, moved: null, reason: 'достигнут предел найденных приборов LIS Proxy (' + MAX_PROXY_FOUND + ')' };
  const base = String(name).trim();
  const taken = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE name = ?').get(base).c > 0;
  const shown = taken ? base + ' (' + (lab || addr || '#' + (found + 1)) + ')' : base;
  const id = db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added, via, proxy_name, proxy_label, proxy_ip)
                         VALUES (?, '', 'mllp', '', NULL, 1, 1, 0, ?, ?, ?, ?)`)
    .run(shown, PROXY_VIA, base, lab || null, addr || null).lastInsertRowid;
  return { device: fresh(id), moved: null, reason: 'заведён по первому запросу LIS Proxy' };
}
