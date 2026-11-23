// SERVICES_FILTER_V1 — живой поиск и фильтр по группам на странице услуг.
//
// Отдельный файл, а не хвост site.js, по двум причинам. Во-первых, границы:
// каталог услуг ведёт своя сессия, и общий файл на двух владельцев — это
// гарантированная драка в одном месте. Во-вторых, вес: site.js грузится на
// КАЖДОЙ странице, а этот код нужен ровно на одной — layout.js подключает его
// только при pageType === 'services'.
//
// Фильтрация продублирована на сервере (?q=, ?group= в render/services.js):
// без JS страница ищет перезагрузкой, здесь — по мере ввода.

/* --- Live service search (SERVICES_FILTER_V1) -----------------------------
   ЗОНА СЕССИИ, ДЕЛАВШЕЙ КАТАЛОГ УСЛУГ. Блок самодостаточен и заканчивается
   здесь же — если правишь site.js, правь выше этой черты.

   Форма над каталогом — настоящая <form method="get">, и без этого файла она
   работает: кнопка «Найти» перезагружает страницу с ?q=, сервер фильтрует.
   Здесь мы лишь убираем перезагрузку, фильтруя уже отрисованные строки по
   мере ввода.

   Сравниваем с data-search — там имя и описание, приведённые к нижнему
   регистру НА СЕРВЕРЕ. Семьсот toLowerCase() на каждую букву в браузере
   телефона — это заметная задержка, а на сервере это один проход на рендер.

   Группы прячем, когда в них не осталось видимых строк: иначе заголовок
   «Гинекология» висел бы над пустотой. */
(function () {
  var form = document.querySelector('[data-svc-filter]');
  if (!form) return;
  var input = form.querySelector('input[name="q"]');
  if (!input) return;

  var rows = [].slice.call(document.querySelectorAll('.svc-row[data-search]'));
  var groups = [].slice.call(document.querySelectorAll('.svc-group'));
  var none = document.querySelector('[data-svc-none]');
  if (!rows.length) return;

  /* Группы и их строки связываем ОДИН раз: querySelectorAll внутри каждой
     группы на каждую букву — это тот же обход списка ещё раз. */
  var buckets = groups.map(function (g) {
    return { el: g, rows: [].slice.call(g.querySelectorAll('.svc-row[data-search]')) };
  });

  var lastQuery = null;

  var apply = function () {
    var q = input.value.trim().toLowerCase();
    if (q === lastQuery) return;
    lastQuery = q;

    var total = 0;
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i];
      var visible = 0;
      for (var j = 0; j < b.rows.length; j++) {
        var row = b.rows[j];
        var show = !q || row.getAttribute('data-search').indexOf(q) !== -1;
        if (show) visible++;
        if (row.hidden === !show) continue;   /* уже в нужном состоянии */
        row.hidden = !show;
      }
      b.el.hidden = visible === 0;
      total += visible;
    }
    if (none) none.hidden = total !== 0;
  };

  /* Ввод быстрее отрисовки: без задержки каждая буква запускает проход по
     всем строкам, и поле начинает «залипать» на длинных запросах. */
  var timer = null;
  input.addEventListener('input', function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, 90);
  });

  /* Enter больше не перезагружает страницу: результат уже на экране, а
     перезагрузка сбросила бы позицию прокрутки и фокус. Кнопка «Найти»
     делает то же самое — фильтрует на месте. */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (timer) clearTimeout(timer);
    lastQuery = null;
    apply();
    input.blur();                              /* на телефоне убирает клавиатуру */
  });
})();
