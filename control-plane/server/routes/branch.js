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
import { Router } from 'express';
import { createEnrollmentCode } from '../services/enrollment.js';

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
    const { install_token: installToken, name } = req.body || {};
    if (typeof installToken !== 'string' || installToken.length === 0) {
      return res.status(GENERIC_FAILURE_STATUS).json(GENERIC_FAILURE_BODY);
    }

    const parent = db.prepare(
      'SELECT clinic_id, name, subscription, parent_clinic_id FROM clinics WHERE install_token = ?'
    ).get(installToken);
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

  return router;
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
