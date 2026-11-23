// WEBSITE_V1 — словари интерфейса сайта. Контент сущностей живёт в БД
// (content JSON по языкам); здесь только слова самого интерфейса.
export const LANGS = ['uz', 'ru', 'en'];
export const DEFAULT_LANG = 'uz';

const DICT = {
  uz: {
    nav: {
      home: 'Bosh sahifa',
      doctors: 'Shifokorlar',
      services: 'Xizmatlar',
      departments: "Bo'limlar",
      about: 'Klinika haqida',
      contact: 'Aloqa',
      appointment: 'Qabulga yozilish',
      news: 'Yangiliklar',
    },
    cta: {
      book: 'Qabulga yozilish',
      call: "Qo'ng'iroq qilish",
      directions: "Yo'nalishni ko'rish",
      taxi: 'Taksi chaqirish',   // CONTACT_HOME_V1
      all_doctors: "Barcha shifokorlar",
      request: 'Ariza qoldirish',
      all_services: "Barcha xizmatlar",
      all_departments: "Barcha bo'limlar",
      learn_more: "Batafsil",
    },
    form: {
      name: 'Ismingiz',
      phone: 'Telefon raqamingiz',
      email: 'Elektron pochta',
      message: 'Xabaringiz',
      service: 'Xizmat turi',
      doctor: 'Shifokor',
      any_doctor: 'Farqi yoʻq',
      date: 'Sana',
      time: 'Vaqt',
      morning: 'Ertalab',
      afternoon: 'Kunduzi',
      evening: 'Kechqurun',
      submit: 'Yuborish',
      sent_title: 'Arizangiz qabul qilindi!',
      sent_text: "Tez orada operatorimiz siz bilan bog'lanadi.",
      error: "Xatolik yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring.",
      required: "Bu maydonni to'ldirish shart",
      phone_invalid: "Telefon raqami noto'g'ri kiritildi",
    },
    section: {
      services: 'Xizmatlarimiz',
      doctors: 'Shifokorlarimiz',
      departments: "Bo'limlarimiz",
      testimonials: 'Bemorlarimiz fikri',
      faq: 'Ko’p beriladigan savollar',
      why_us: 'Nega aynan biz?',
      contacts: "Bog'lanish uchun",
      other_services: 'Boshqa xizmatlar',
      news: 'Yangiliklar',
    },
    service: {
      preparation: 'Tayyorgarlik',
    },
    empty: {
      services: "Xizmatlar tez orada qo'shiladi",
      departments: "Bo'limlar tez orada qo'shiladi",
      faq: "Savollar hali kiritilmagan",
      news: "Yangiliklar tez orada qo'shiladi",
    },
    footer: {
      rights: 'Barcha huquqlar himoyalangan.',
    },
    notfound: {
      title: 'Sahifa topilmadi',
      text: "Siz izlayotgan sahifa mavjud emas yoki ko'chirilgan.",
    },
    price: {
      from: 'dan boshlab',
      currency: "so'm",
    },
    search: {
      placeholder: 'Xizmatni qidirish…',
      placeholder_doctors: 'Shifokorni qidirish…',   // DOC_FILTER_V1
      submit: 'Qidirish',
      all: 'Barchasi',
      nothing: "So'rov bo'yicha hech narsa topilmadi",
      reset: 'Tozalash',
    },
    minutes: 'daqiqa',
    years_exp: 'yil tajriba',
    langs_label: 'Til',
    day: {
      mon: 'Dushanba',
      tue: 'Seshanba',
      wed: 'Chorshanba',
      thu: 'Payshanba',
      fri: 'Juma',
      sat: 'Shanba',
      sun: 'Yakshanba',
      everyday: 'Har kuni',
      short: { mon: 'Du', tue: 'Se', wed: 'Cho', thu: 'Pa', fri: 'Ju', sat: 'Sha', sun: 'Ya' },
      closed: 'Yopiq',
      always: 'Kunu tun ochiq',
    },
    legal: {
      privacy_title: 'Maxfiylik siyosati',
      terms_title: 'Foydalanish shartlari',
      privacy_stub: "Maxfiylik siyosati matni tez orada joylashtiriladi.",
      terms_stub: "Foydalanish shartlari matni tez orada joylashtiriladi.",
    },
    contact: {
      hours_title: 'Ish vaqti',
      label_phone: 'Telefon',
      label_telegram: 'Telegram',
      label_address: 'Manzil',
      label_email: 'Elektron pochta',
      label_hours: 'Ish vaqti',
      telegram_write: 'Telegramda yozish',
      form_title: 'Xabar yuboring',
      callback_title: "Qo'ng'iroqqa buyurtma bering",
    },
  },
  ru: {
    nav: {
      home: 'Главная',
      doctors: 'Врачи',
      services: 'Услуги',
      departments: 'Отделения',
      about: 'О клинике',
      contact: 'Контакты',
      appointment: 'Записаться на приём',
      news: 'Новости',
    },
    cta: {
      book: 'Записаться на приём',
      call: 'Позвонить',
      directions: 'Как добраться',
      taxi: 'Вызвать такси',   // CONTACT_HOME_V1
      all_doctors: 'Все врачи',
      request: 'Оставить заявку',
      all_services: 'Все услуги',
      all_departments: 'Все направления',
      learn_more: 'Подробнее',
    },
    form: {
      name: 'Ваше имя',
      phone: 'Номер телефона',
      email: 'Электронная почта',
      message: 'Ваше сообщение',
      service: 'Услуга',
      doctor: 'Врач',
      any_doctor: 'Не имеет значения',
      date: 'Дата',
      time: 'Время',
      morning: 'Утро',
      afternoon: 'День',
      evening: 'Вечер',
      submit: 'Отправить',
      sent_title: 'Ваша заявка принята!',
      sent_text: 'Наш оператор свяжется с вами в ближайшее время.',
      error: 'Произошла ошибка. Пожалуйста, попробуйте ещё раз чуть позже.',
      required: 'Это поле обязательно для заполнения',
      phone_invalid: 'Неверный формат номера телефона',
    },
    section: {
      services: 'Наши услуги',
      doctors: 'Наши врачи',
      departments: 'Наши отделения',
      testimonials: 'Отзывы пациентов',
      faq: 'Часто задаваемые вопросы',
      why_us: 'Почему выбирают нас',
      contacts: 'Свяжитесь с нами',
      other_services: 'Другие услуги',
      news: 'Новости',
    },
    service: {
      preparation: 'Подготовка',
    },
    empty: {
      services: 'Услуги скоро появятся',
      departments: 'Разделы скоро появятся',
      faq: 'Вопросы пока не добавлены',
      news: 'Новости скоро появятся',
    },
    footer: {
      rights: 'Все права защищены.',
    },
    notfound: {
      title: 'Страница не найдена',
      text: 'Запрашиваемая страница не существует или была перемещена.',
    },
    price: {
      from: 'от',
      currency: 'сум',
    },
    search: {
      placeholder: 'Поиск услуги…',
      placeholder_doctors: 'Поиск врача…',   // DOC_FILTER_V1
      submit: 'Найти',
      all: 'Все',
      nothing: 'По вашему запросу ничего не найдено',
      reset: 'Сбросить',
    },
    minutes: 'мин',
    years_exp: 'лет опыта',
    langs_label: 'Язык',
    day: {
      mon: 'Понедельник',
      tue: 'Вторник',
      wed: 'Среда',
      thu: 'Четверг',
      fri: 'Пятница',
      sat: 'Суббота',
      sun: 'Воскресенье',
      everyday: 'Ежедневно',
      short: { mon: 'Пн', tue: 'Вт', wed: 'Ср', thu: 'Чт', fri: 'Пт', sat: 'Сб', sun: 'Вс' },
      closed: 'Выходной',
      always: 'Круглосуточно',
    },
    legal: {
      privacy_title: 'Политика конфиденциальности',
      terms_title: 'Условия использования',
      privacy_stub: 'Текст политики конфиденциальности будет опубликован в ближайшее время.',
      terms_stub: 'Текст условий использования будет опубликован в ближайшее время.',
    },
    contact: {
      hours_title: 'Часы работы',
      label_phone: 'Телефон',
      label_telegram: 'Telegram',
      label_address: 'Адрес',
      label_email: 'Электронная почта',
      label_hours: 'Режим работы',
      telegram_write: 'Написать в Telegram',
      form_title: 'Напишите нам',
      callback_title: 'Заказать обратный звонок',
    },
  },
  en: {
    nav: {
      home: 'Home',
      doctors: 'Doctors',
      services: 'Services',
      departments: 'Departments',
      about: 'About us',
      contact: 'Contact',
      appointment: 'Book an appointment',
      news: 'News',
    },
    cta: {
      book: 'Book an appointment',
      call: 'Call us',
      directions: 'Get directions',
      taxi: 'Order a taxi',   // CONTACT_HOME_V1
      all_doctors: 'All doctors',
      request: 'Leave a request',
      all_services: 'All services',
      all_departments: 'All departments',
      learn_more: 'Learn more',
    },
    form: {
      name: 'Your name',
      phone: 'Phone number',
      email: 'Email address',
      message: 'Your message',
      service: 'Service',
      doctor: 'Doctor',
      any_doctor: 'No preference',
      date: 'Date',
      time: 'Time',
      morning: 'Morning',
      afternoon: 'Afternoon',
      evening: 'Evening',
      submit: 'Submit',
      sent_title: 'Your request has been received!',
      sent_text: 'Our staff will contact you shortly.',
      error: 'Something went wrong. Please try again in a moment.',
      required: 'This field is required',
      phone_invalid: 'Please enter a valid phone number',
    },
    section: {
      services: 'Our services',
      doctors: 'Our doctors',
      departments: 'Our departments',
      testimonials: 'Patient testimonials',
      faq: 'Frequently asked questions',
      why_us: 'Why choose us',
      contacts: 'Get in touch',
      other_services: 'Other services',
      news: 'News',
    },
    service: {
      preparation: 'Preparation',
    },
    empty: {
      services: 'Services coming soon',
      departments: 'Departments coming soon',
      faq: 'No questions yet',
      news: 'News coming soon',
    },
    footer: {
      rights: 'All rights reserved.',
    },
    notfound: {
      title: 'Page not found',
      text: "The page you're looking for doesn't exist or has been moved.",
    },
    price: {
      from: 'from',
      currency: 'UZS',
    },
    search: {
      placeholder: 'Search services…',
      placeholder_doctors: 'Search a doctor…',   // DOC_FILTER_V1
      submit: 'Search',
      all: 'All',
      nothing: 'Nothing matches your search',
      reset: 'Clear',
    },
    minutes: 'min',
    years_exp: 'years of experience',
    langs_label: 'Language',
    day: {
      mon: 'Monday',
      tue: 'Tuesday',
      wed: 'Wednesday',
      thu: 'Thursday',
      fri: 'Friday',
      sat: 'Saturday',
      sun: 'Sunday',
      everyday: 'Every day',
      short: { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' },
      closed: 'Closed',
      always: 'Open 24/7',
    },
    legal: {
      privacy_title: 'Privacy Policy',
      terms_title: 'Terms of Use',
      privacy_stub: 'The privacy policy text will be published soon.',
      terms_stub: 'The terms of use text will be published soon.',
    },
    contact: {
      hours_title: 'Working hours',
      label_phone: 'Phone',
      label_telegram: 'Telegram',
      label_address: 'Address',
      label_email: 'Email',
      label_hours: 'Opening hours',
      telegram_write: 'Message on Telegram',
      form_title: 'Send us a message',
      callback_title: 'Request a callback',
    },
  },
};

function dig(obj, key) {
  return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

export function t(lang, key) {
  return dig(DICT[lang], key) ?? dig(DICT.uz, key) ?? dig(DICT.ru, key) ?? key;
}

function onlyStrings(o) {
  const r = {};
  for (const [k, v] of Object.entries(o || {})) if (typeof v === 'string') r[k] = v;
  return r;
}

export function pickContent(jsonText, lang) {
  let all = {};
  try {
    const p = JSON.parse(jsonText || '{}');
    if (p && typeof p === 'object') all = p;
  } catch {
    return {};
  }
  const out = {};
  // Порядок: от самого дальнего фолбэка к запрошенному языку — так более
  // приоритетные значения перезаписывают менее приоритетные.
  for (const l of ['en', 'ru', 'uz']) if (l !== lang && all[l]) Object.assign(out, onlyStrings(all[l]));
  if (all[lang]) Object.assign(out, onlyStrings(all[lang]));
  return out;
}

export function langUrl(lang, path) {
  return path.replace(/^\/(uz|ru|en)(?=\/|$)/, '/' + lang);
}

export function otherLangs(lang) {
  return LANGS.filter((l) => l !== lang);
}
