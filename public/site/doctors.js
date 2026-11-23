// DOC_FILTER_V1 — живой поиск и фильтр по специальности на странице врачей.
//
// Отдельный файл по тем же причинам, что и services.js: код нужен ровно на
// одной странице, а site.js грузится на каждой. layout.js подключает его
// только при pageType === 'doctors'.
//
// Фильтрация продублирована на сервере (?q=, ?spec= в render/doctors.js):
// без JS страница ищет перезагрузкой, здесь — по мере ввода.
(function () {
  var form = document.querySelector('[data-doc-filter]');
  if (!form) return;

  var input = form.querySelector('input[name="q"]');
  var grid = document.querySelector('[data-doc-grid]');
  var none = document.querySelector('[data-doc-none]');
  if (!input || !grid) return;

  var cards = [].slice.call(grid.querySelectorAll('.doctor-card[data-search]'));
  if (!cards.length) return;

  // Активная специальность берётся из чипа, который сервер уже пометил
  // текущим, — второй источник правды (например, разбор адресной строки)
  // разошёлся бы с разметкой при первой же правке ссылок.
  var current = form.querySelector('.svc-chip.is-current');
  var spec = (current && current.getAttribute('data-spec')) || '';

  function apply() {
    // data-search собран НА СЕРВЕРЕ в нижнем регистре: двадцать toLowerCase()
    // на букву — мелочь, но привычка считать это на клиенте дорого обходится
    // там, где строк сотни (см. каталог услуг).
    var q = input.value.trim().toLowerCase();
    var shown = 0;

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var okSpec = !spec || card.getAttribute('data-spec') === spec;
      var okText = !q || card.getAttribute('data-search').indexOf(q) !== -1;
      var show = okSpec && okText;
      card.hidden = !show;
      if (show) shown++;
    }

    // Пустой результат обязан сказать, ПОЧЕМУ пусто: молча опустевшая сетка
    // читается как поломка сайта, а не как «ничего не нашлось».
    if (none) none.hidden = shown !== 0;
  }

  input.addEventListener('input', apply);

  // Чипы специальностей — настоящие ссылки, и без JS они работают
  // перезагрузкой. Перехватываем только если скрипт жив: тогда фильтр
  // мгновенный, а адрес всё равно обновляем, чтобы ссылку можно было
  // скопировать и переслать.
  form.addEventListener('click', function (e) {
    var chip = e.target.closest && e.target.closest('.svc-chip');
    if (!chip || !form.contains(chip)) return;
    e.preventDefault();

    spec = chip.getAttribute('data-spec') || '';
    var chips = form.querySelectorAll('.svc-chip');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i] === chip;
      chips[i].classList.toggle('is-current', on);
      if (on) chips[i].setAttribute('aria-current', 'true');
      else chips[i].removeAttribute('aria-current');
    }
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', chip.getAttribute('href'));
    }
    apply();
  });

  apply();
})();
