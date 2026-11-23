// HERO_SLIDESHOW_V1 — смена фотографии в заголовке каждые 5 секунд.
//
// Отдельный файл и условное подключение (layout.js, pageType === 'home'):
// заголовок со слайдшоу есть только на главной, а site.js грузится на каждой
// странице. Инлайновым скриптом это сделать нельзя — CSP сайта не разрешает
// 'unsafe-inline'.
//
// Разметку скрипт НЕ создаёт: все кадры уже лежат в документе, лишние скрыты
// атрибутом hidden. Поэтому без JS страница показывает первый кадр и только
// его, а не стопку картинок.
(function () {
  var box = document.querySelector('[data-hero-slideshow]');
  if (!box) return;

  // КОЛЛАЖ ОСТАЁТСЯ на месте — меняется его содержимое. Двигаем обе позиции
  // одним счётчиком: переднее показывает кадр i, заднее — следующий за ним.
  // Так коллаж всегда полон, каждый снимок успевает побывать и передним, и
  // задним, и никогда не совпадает сам с собой.
  var front = box.querySelector('[data-hero-slot="front"]');
  var back = box.querySelector('[data-hero-slot="back"]');
  if (!front) return;

  var frontFrames = [].slice.call(front.querySelectorAll('.hero__frame'));
  var backFrames = back ? [].slice.call(back.querySelectorAll('.hero__frame')) : [];
  var n = frontFrames.length;
  if (n < 2) return;   // одному кадру меняться не на что

  // ДОСТУПНОСТЬ, а не стилистика. Крупная картинка, сама собой меняющаяся во
  // весь заголовок, у людей с вестибулярными нарушениями вызывает физическую
  // дурноту. Если система просит «меньше движения» — не запускаем ВООБЩЕ, а не
  // делаем переход побыстрее.
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (calm && calm.matches) return;

  var INTERVAL = 5000;
  var i = 0;
  var timer = null;

  function only(frames, visible) {
    for (var k = 0; k < frames.length; k++) frames[k].hidden = (k !== visible);
  }

  function show(next) {
    if (next === i) return;
    i = next;
    only(frontFrames, i);
    if (backFrames.length) only(backFrames, (i + 1) % n);
  }

  function tick() { show((i + 1) % n); }

  function start() {
    if (timer) return;
    timer = window.setInterval(tick, INTERVAL);
  }
  function stop() {
    if (!timer) return;
    window.clearInterval(timer);
    timer = null;
  }

  // Пауза, когда человек смотрит именно сюда: увёл курсор на фотографию или
  // дошёл до неё с клавиатуры — значит рассматривает, и подменять картинку
  // под ним не надо.
  box.addEventListener('mouseenter', stop);
  box.addEventListener('mouseleave', start);
  box.addEventListener('focusin', stop);
  box.addEventListener('focusout', start);

  // Вкладка в фоне — таймер не нужен: он ничего не показывает, но продолжает
  // будить страницу и тратить батарею телефона.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  // Если системную настройку «меньше движения» включили уже после загрузки —
  // останавливаемся сразу, не дожидаясь перезагрузки страницы.
  if (calm && calm.addEventListener) {
    calm.addEventListener('change', function (e) {
      if (e.matches) { stop(); show(0); } else start();
    });
  }

  start();
})();
