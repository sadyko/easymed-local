// BRANCH_SELF_SERVICE_V1 — главная клиника заводит свой филиал сама.
//
// PRESENTED BY the MAIN clinic, with its install_token — как и /cp/v1/relay-token,
// по той же причине: главная клиника единственная в группе прошла активацию, и
// только у неё есть чем доказать вендору, кто она.
//
// ЧТО ЭНДПОИНТ ДЕЛАЕТ, исчерпывающе: создаёт НОВУЮ строку clinics с
// parent_clinic_id = вызывающая клиника и возвращает её enrollment_code. Больше
// ничего: он не меняет вызывающую клинику, не выдаёт install_token (его филиал
// получит сам, когда активируется кодом) и не трогает чужие строки.
//
// ЧТО ЭТО ОТДАЁТ, прямым текстом: активированная клиника может создать
// платящего клиента без участия вендора. Это осознанное решение владельца
// (2026-09-02): филиалы заводит сама сеть, у каждого филиала своя подписка и
// свой счёт. Строка создаётся сразу active — см. BRANCH_SUBSCRIPTION ниже: одна
// константа, чтобы политику можно было сменить на «создаётся unpaid, вендор
// включает вручную», не трогая ничего другого.
//
// Почему код возвращается, а не отправляется филиалу: у вендора нет связи с
// машиной филиала — её ещё не существует. Код едет к филиалу внутри ключа
// связывания, который главная клиника и так передаёт из рук в руки.
//
// BRANCH_REISSUE_V1 — вторая ручка файла, POST /:clinic_id/reissue, и вот
// зачем она нужна. Код активации ОДНОРАЗОВЫЙ: при активации он стирается, а
// строке выдаётся install_token (см. services/enrollment.js). Ключ связывания,
// который главная клиника показывает у себя на экране, содержит внутри тот
// код, который филиал получил при создании — один раз и навсегда. Значит
// ПЕРЕУСТАНОВЛЕННЫЙ компьютер филиала уже не активируется НИКОГДА: его код
// сгорел при первой активации, а другого главной клинике взять неоткуда.
// Проверено на тестовом филиале владельца 2026-09-02. Единственным выходом до
// сих пор была правка строки в базе вендора руками.
//
// Перевыпуск даёт филиалу новый код и одновременно гасит install_token
// прежней установки — один филиал, один компьютер. Старый компьютер честно
// «темнеет» (перестаёт проходить check-in), вместо того чтобы две машины молча
// делили одну лицензию и один счёт. Новой строки при этом НЕ создаётся: тот же
// clinic_id, та же подписка, тот же unlock_secret, те же модули — филиал
// возвращается тем же клиентом, а не становится новым.
import { Router } from 'express';
import { createEnrollmentCode, reissueEnrollmentCode } from '../services/enrollment.js';

// Политика подписки новорождённого филиала. 'active' — сеть заводит филиалы
// сама и платит за них; 'unpaid' — филиал ставится и связывается, но остаётся
// заперт, пока вендор не включит подписку в панели.
const BRANCH_SUBSCRIPTION = 'active';

// Тот же ответ на любой отказ аутентификации, что и у checkin/relay-token: по
// различию в ответах можно было бы перебирать живые install_token.
const GENERIC_FAILURE_STATUS = 401;
const GENERIC_FAILURE_BODY = { error: 'unauthorized' };

// Имя филиала приходит от человека и попадает в панель вендора. Ограничение
// нужно не «для валидации», а чтобы одна клиника не записала в реестр роман.
const MAX_NAME = 120;

export function branchRouter(db) {
  const router = Router();

  router.post('/', (req, res) => {
    const { name } = req.body || {};
    const parent = callerByInstallToken(db, req);
    if (!parent) return res.status(GENERIC_FAILURE_STATUS).json(GENERIC_FAILURE_BODY);

    // Филиал филиала — нет. Дерево глубже одного уровня никто не просил, а
    // считать подписки и связывать справочники по цепочке пришлось бы уже
    // иначе. Отказ явный, чтобы это не «сработало» случайно и не превратилось
    // в требование задним числом.
    if (parent.parent_clinic_id) {
      return res.status(409).json({ error: 'branch_of_branch' });
    }

    // Заперта ли сама главная клиника — проверяем ЗДЕСЬ: неоплаченная сеть не
    // должна наращивать филиалы. Это единственная проверка подписки в файле.
    if (parent.subscription !== 'active') {
      return res.status(402).json({ error: 'parent_unpaid' });
    }

    const branchName = String(name || '').trim().slice(0, MAX_NAME)
      || (parent.name + ' — филиал');

    // clinic_id филиала выдаём мы, а не звонящий: иначе клиника могла бы
    // назначить филиалу чужой идентификатор.
    const clinicId = nextBranchId(db, parent.clinic_id);
    let code;
    try {
      code = createEnrollmentCode(db, { clinicId, name: branchName });
    } catch (e) {
      return res.status(500).json({ error: 'could_not_create' });
    }
    db.prepare('UPDATE clinics SET parent_clinic_id = ?, subscription = ? WHERE clinic_id = ?')
      .run(parent.clinic_id, BRANCH_SUBSCRIPTION, clinicId);

    return res.json({ clinic_id: clinicId, name: branchName, enrollment_code: code });
  });

  // BRANCH_REISSUE_V1 — новый код активации для УЖЕ СУЩЕСТВУЮЩЕГО филиала.
  // Предъявляет её тот же, кто заводил филиал, и тем же способом: главная
  // клиника со своим install_token в теле запроса (см. callerByInstallToken —
  // одна функция на обе ручки, чтобы «аутентификация та же» было правдой по
  // построению, а не по совпадению двух копий).
  router.post('/:clinic_id/reissue', (req, res) => {
    const parent = callerByInstallToken(db, req);
    if (!parent) return res.status(GENERIC_FAILURE_STATUS).json(GENERIC_FAILURE_BODY);

    // ОДНО условие на три отказа — не существует, погашен (active = 0), или
    // это вообще не твой филиал — и ОДИН ответ 404 на все три. Иначе по
    // различию ответов сеть перебирала бы чужие clinic_id: «404 — такого нет»
    // против «403 — есть, но не твой» это и есть готовый сканер реестра. Та же
    // причина, по которой enroll.js отвечает одинаково на любой плохой код.
    //
    // parent_clinic_id = вызывающая клиника — это ВСЯ авторизация, и её
    // достаточно: у филиала своих филиалов нет (см. branch_of_branch выше),
    // поэтому филиал, дотянувшийся сюда, не найдёт ни одной подходящей строки
    // и получит тот же 404, без отдельной проверки.
    //
    // Подписка НЕ проверяется, в отличие от создания филиала выше, и это
    // осознанно: 402 там означает «неоплаченная сеть не наращивает филиалы»,
    // то есть не заводит НОВЫХ платящих клиентов. Здесь ничего не заводится —
    // это восстановление уже существующего филиала после переустановки, и
    // запирать его за оплатой значило бы, что просроченная на день сеть не
    // может поднять упавший компьютер. Заперт филиал или нет, решает check-in
    // по СВОЕЙ подписке, ровно как и до перевыпуска.
    const branch = db.prepare(
      `SELECT clinic_id, name FROM clinics
        WHERE clinic_id = ? AND parent_clinic_id = ? AND active = 1`
    ).get(String(req.params.clinic_id), parent.clinic_id);
    if (!branch) return res.status(404).json({ error: 'not_found' });

    let code;
    try {
      // Одна UPDATE: новый код + install_token = NULL. Строк не создаёт —
      // см. reissueEnrollmentCode, там же и почему обе половины в одном
      // запросе.
      code = reissueEnrollmentCode(db, { clinicId: branch.clinic_id });
    } catch (e) {
      return res.status(500).json({ error: 'could_not_reissue' });
    }
    // Строка была прочитана строкой выше в том же синхронном обработчике, так
    // что null здесь недостижим; на всякий случай — тот же 404, а не 500.
    if (!code) return res.status(404).json({ error: 'not_found' });

    // САМ КОД В ЛОГ НЕ ПОПАДАЕТ — ни здесь, ни где-либо ещё: это одноразовый
    // пароль на активацию (см. routes/enroll.js и обработчик ошибок в app.js,
    // который по той же причине никогда не печатает тело запроса). В журнале
    // нужны факт и время: какой филиал перевыпущен, кем, и что прежняя
    // установка с этой секунды в check-in не проходит.
    console.log(`[control-plane] branch ${branch.clinic_id} got a fresh enrollment code (asked for by ${parent.clinic_id}); its previous install token is now dead`);

    return res.json({ clinic_id: branch.clinic_id, name: branch.name, enrollment_code: code });
  });

  return router;
}

// Аутентификация обеих ручек файла: главная клиника предъявляет свой
// install_token В ТЕЛЕ запроса — не заголовком. Так это делает вся клиентская
// половина control plane (enroll, checkin), и менять конвенцию ради второй
// ручки одного файла значило бы, что клиент шлёт токен то так, то эдак.
//
// Ровно тот же SELECT, что был у создания филиала, — теперь буквально один на
// двоих, чтобы две проверки не разъехались при следующей правке.
//
// active = 1 здесь НЕ проверяется, и это сознательно оставлено как было: у
// создания филиала этой проверки нет с самого начала, а расходиться двум
// ручкам одного файла нельзя. Если погашенной клинике надо закрывать и эту
// дверь — закрывать её надо ОБЕИМ ручкам сразу, одной правкой здесь.
function callerByInstallToken(db, req) {
  const token = (req.body || {}).install_token;
  if (typeof token !== 'string' || token.length === 0) return null;
  return db.prepare(
    'SELECT clinic_id, name, subscription, parent_clinic_id FROM clinics WHERE install_token = ?'
  ).get(token) || null;
}

// c-000005-b1, -b2, … — читаемо в панели и сразу видно, чей это филиал.
// Считаем от количества уже существующих детей, а не от глобального счётчика:
// номер филиала — свойство сети, а не реестра.
function nextBranchId(db, parentId) {
  const row = db.prepare('SELECT COUNT(*) n FROM clinics WHERE parent_clinic_id = ?').get(parentId);
  let n = (row ? row.n : 0) + 1;
  for (let attempt = 0; attempt < 50; attempt++, n++) {
    const id = `${parentId}-b${n}`;
    const clash = db.prepare('SELECT 1 FROM clinics WHERE clinic_id = ?').get(id);
    if (!clash) return id;
  }
  throw new Error('nextBranchId: could not find a free branch id');
}
