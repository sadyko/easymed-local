/* Easy-Med public website — the only script on the page.
   Vanilla, no build step, no dependencies. Everything degrades: the site is
   fully usable with JS off (FAQ uses <details>, the mobile bar is plain links).
   Task 10 attaches the appointment-form enhancement to window.emSite. */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  function prefersReducedMotion() {
    return !!(reduced && reduced.matches);
  }

  /* --- Mobile navigation ------------------------------------------------ */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');

  function setNav(open) {
    if (!toggle || !nav) return;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) nav.setAttribute('data-open', '');
    else nav.removeAttribute('data-open');
  }

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      setNav(toggle.getAttribute('aria-expanded') !== 'true');
    });

    // A tap on any link inside the drawer closes it.
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) setNav(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setNav(false);
        toggle.focus();
      }
    });

    // Tapping outside the open drawer closes it.
    document.addEventListener('click', function (e) {
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      if (nav.contains(e.target) || toggle.contains(e.target)) return;
      setNav(false);
    });

    // The drawer only exists below 900px; a resize past that must reset it.
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 900) setNav(false);
    });
  }

  /* --- Same-page anchors ------------------------------------------------ */
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href^="#"]');
    if (!link) return;
    var id = link.getAttribute('href');
    if (!id || id === '#') return;

    var target;
    try { target = document.querySelector(id); } catch (err) { return; }
    if (!target) return;

    e.preventDefault();
    setNav(false);
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start'
    });

    // Keep keyboard focus with the eye, without stealing it from the scroll.
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });

    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', id);
    }
  });

  /* --- Request forms (appointment / contact / callback) ----------------
     Progressive enhancement over the plain <form method=post> that already
     works with JS off (server/site/requests.js handles both). Any form
     carrying the .js-request-form class hook is upgraded: submit is
     intercepted, sent as JSON to /api/requests, and on success the form is
     replaced with an inline message built from its own data-success-title/
     data-success-text attributes (rendered server-side from i18n by the
     page — this script has no translations of its own). A form without
     those attributes is simply left to its native no-JS POST + redirect. */
  function showRequestSuccess(form) {
    var title = form.getAttribute('data-success-title') || '';
    var text = form.getAttribute('data-success-text') || '';
    var note = document.createElement('div');
    note.className = 'form-note js-request-form__success';
    note.setAttribute('role', 'status');
    if (title) {
      var h = document.createElement('strong');
      h.textContent = title;
      note.appendChild(h);
    }
    if (text) {
      var p = document.createElement('p');
      p.textContent = text;
      note.appendChild(p);
    }
    if (form.parentNode) form.parentNode.replaceChild(note, form);
  }

  function showRequestError(form, message) {
    // The form's own data-error-text is rendered server-side from i18n in
    // the visitor's language; the server's error message (e.g. "Phone is
    // invalid.") is always English and only stands in when the page gave
    // no localized text to show at all.
    var text = form.getAttribute('data-error-text') || message || '';
    if (!text) return;
    var note = form.querySelector('.js-request-form__error');
    if (!note) {
      note = document.createElement('div');
      note.className = 'form-note form-note--error js-request-form__error';
      note.setAttribute('role', 'alert');
      form.insertBefore(note, form.firstChild);
    }
    note.textContent = text;
  }

  var requestForms = document.querySelectorAll('.js-request-form');
  if (requestForms.length && window.fetch && window.FormData) {
    Array.prototype.forEach.call(requestForms, function (form) {
      if (!form.hasAttribute('data-success-title')) return; // nothing to say — stay plain
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var data = {};
        new FormData(form).forEach(function (value, key) { data[key] = value; });
        var submitBtn = form.querySelector('[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        fetch(form.getAttribute('action'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(data)
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (json) {
            return { ok: res.ok, json: json };
          });
        }).then(function (result) {
          if (result.ok) showRequestSuccess(form);
          else {
            showRequestError(form, result.json && result.json.error && result.json.error.message);
            if (submitBtn) submitBtn.disabled = false;
          }
        }).catch(function () {
          showRequestError(form);
          if (submitBtn) submitBtn.disabled = false;
        });
      });
    });
  }

  /* --- Quick request modal (QUICK_REQUEST_V1) ----------------------------
     Кнопка «Оставить заявку» у услуги или врача остаётся НАСТОЯЩЕЙ ссылкой на
     /appointment: без JS она просто открывает полную страницу, как и раньше.
     Здесь мы лишь перехватываем клик и показываем окно на два поля, подставив
     услугу или врача из data-атрибутов кнопки.

     Фокус уходит на первое поле; Esc и клик по фону закрывают; при закрытии
     фокус возвращается на кнопку, с которой всё началось, — иначе человек,
     управляющий клавиатурой, теряет место на странице. */
  var qr = document.getElementById('qr');
  if (qr) {
    var qrService = document.getElementById('qr-service');
    var qrDoctor = document.getElementById('qr-doctor');
    var qrSubject = document.getElementById('qr-subject');
    var qrName = document.getElementById('qr-name');
    var qrOpener = null;

    var qrClose = function () {
      qr.setAttribute('hidden', '');
      document.documentElement.style.overflow = '';
      if (qrOpener && qrOpener.focus) qrOpener.focus();
      qrOpener = null;
    };

    var qrOpen = function (trigger) {
      qrOpener = trigger;
      if (qrService) qrService.value = trigger.getAttribute('data-service') || '';
      if (qrDoctor) qrDoctor.value = trigger.getAttribute('data-doctor') || '';
      var subject = trigger.getAttribute('data-subject') || '';
      if (qrSubject) {
        if (subject) { qrSubject.textContent = subject; qrSubject.removeAttribute('hidden'); }
        else { qrSubject.textContent = ''; qrSubject.setAttribute('hidden', ''); }
      }
      qr.removeAttribute('hidden');
      /* Фон не должен прокручиваться под открытым окном. */
      document.documentElement.style.overflow = 'hidden';
      if (qrName && qrName.focus) qrName.focus();
    };

    document.addEventListener('click', function (e) {
      var t = e.target;
      var trigger = t && t.closest ? t.closest('[data-qr-open]') : null;
      if (trigger) {
        /* Ctrl/Cmd/Shift и не-левая кнопка — человек осознанно открывает в
           новой вкладке; такой клик перехватывать нельзя. */
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        qrOpen(trigger);
        return;
      }

      /* QUICK_REQUEST_EVERYWHERE_V1 — ЛЮБАЯ кнопка «Записаться» открывает окно.
         Владелец: «change this page on all buttons where it exist, I don`t need
         it, I need just simple pop up».

         Один делегированный обработчик вместо data-qr-open в шести файлах:
         кнопки живут в шапке, подвале, мобильной панели, герое, на страницах
         отделений и услуг, и расставленные вручную атрибуты разошлись бы при
         первой же новой кнопке. Здесь же новая кнопка получает поведение сама,
         просто потому что ведёт на /appointment.

         Проверка идёт СТРОГО ПОСЛЕ data-qr-open выше: у тех ссылок уже проставлен
         предмет заявки (услуга, врач), и перехватить их здесь значило бы открыть
         окно с пустым предметом.

         Ссылка остаётся настоящей: без JS, в новой вкладке и по внешней ссылке
         страница /appointment работает как раньше — она становится запасным
         входом, а не основным. Поэтому её и не удаляем. */
      var link = t && t.closest ? t.closest('a[href]') : null;
      if (link && !link.hasAttribute('data-qr-open')) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (link.target && link.target !== '_self') return;
        var href = link.getAttribute('href') || '';
        /* Только «голая» страница записи: адрес с параметрами (?service=…)
           несёт предмет заявки, который это окно не прочитает, — такие ссылки
           пусть уводят на страницу, где параметр разбирается. */
        if (/^\/[a-z]{2}\/appointment\/?$/.test(href)) {
          e.preventDefault();
          qrOpen(link);
          return;
        }
      }

      if (t && t.closest && t.closest('[data-qr-close]')) qrClose();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !qr.hasAttribute('hidden')) qrClose();
    });
  }

  /* --- Analytics beacon (W3) ---------------------------------------------
     One anonymous, first-party ping per page load — no cookies read here,
     no personal data sent. server/site/analytics.js does all the work
     (session, bot filter, cookies); this call is fire-and-forget and never
     blocks or delays the page. sendBeacon survives the page unloading, which
     matters because most visits leave via a link click, not a long dwell. */
  function sendBeacon() {
    var payload = JSON.stringify({
      path: location.pathname + location.search,
      page_type: (document.body && document.body.dataset.pageType) || 'other',
      ref: document.referrer,
      lang: document.documentElement.lang
    });
    if (navigator.sendBeacon) {
      try {
        navigator.sendBeacon('/api/beacon', new Blob([payload], { type: 'application/json' }));
        return;
      } catch (err) { /* fall through to fetch */ }
    }
    if (window.fetch) {
      fetch('/api/beacon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      }).catch(function () {});
    }
  }
  sendBeacon();

  /* --- Extension point -------------------------------------------------- */
  // Task 10 (appointment form) registers its enhancement here.
  window.emSite = window.emSite || {};
  window.emSite.prefersReducedMotion = prefersReducedMotion;
  window.emSite.closeNav = function () { setNav(false); };
})();
