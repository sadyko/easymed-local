// API_DOCS_V1 — СОЗДАН `node public-server/scripts/docs-build.mjs`; руками не править.
//
// RESPONSES — что публичный сервер ответил на запросы примеров документации
// (docs/content.js EXAMPLES) для клиники-примера «Шифо» (test-helpers/docs-world.js);
// LABELS — переводы подписей прав, событий и групп услуг из словаря программы
// (public/js/admin/i18n-strings.js): страница говорит теми же словами, что экран
// клиники. Страж docs/examples.http.test.js пересобирает файл и сверяет.
export const LABELS = {
  "О клинике": {
    "uz": "Klinika haqida",
    "en": "About the clinic"
  },
  "Название, описание, логотипы, контакты, соцсети, карта": {
    "uz": "Nomi, tavsifi, logotiplar, kontaktlar, ijtimoiy tarmoqlar, xarita",
    "en": "Name, description, logos, contacts, social media, map"
  },
  "Филиалы": {
    "uz": "Filiallar",
    "en": "Branches"
  },
  "Город и район (коды из справочника), адрес на трёх языках, телефоны, часы, маршрут": {
    "uz": "Shahar va tuman (ma’lumotnoma kodlari), uch tildagi manzil, telefonlar, ish vaqti, yo‘nalish",
    "en": "City and district (reference codes), address in three languages, phones, hours, directions"
  },
  "Врачи": {
    "uz": "Shifokorlar",
    "en": "Doctors"
  },
  "Публичный профиль, специальности (коды из справочника), стаж, фото, цены консультаций": {
    "uz": "Ommaviy profil, mutaxassisliklar (ma’lumotnoma kodlari), tajriba, foto, konsultatsiya narxlari",
    "en": "Public profile, specialties (reference codes), experience, photo, consultation prices"
  },
  "Услуги и цены": {
    "uz": "Xizmatlar va narxlar",
    "en": "Services and prices"
  },
  "Пять групп: консультации, лаборатория, диагностика, процедуры, хирургия": {
    "uz": "Beshta guruh: konsultatsiyalar, laboratoriya, diagnostika, muolajalar, jarrohlik",
    "en": "Five groups: consultations, laboratory, diagnostics, procedures, surgery"
  },
  "Пакеты услуг": {
    "uz": "Xizmat paketlari",
    "en": "Service packages"
  },
  "Состав, цена без скидки и цена пакета, срок действия": {
    "uz": "Tarkibi, chegirmasiz narx va paket narxi, amal qilish muddati",
    "en": "Contents, price without discount and package price, validity"
  },
  "Свободное время": {
    "uz": "Bo‘sh vaqt",
    "en": "Free time slots"
  },
  "Окна по 15 минут на столько дней вперёд, на сколько открыта запись у врача (7, 14 или 30); у врачей с живой очередью — часы приёма": {
    "uz": "Shifokorda yozilish qancha kunga ochiq bo‘lsa (7, 14 yoki 30), shuncha kun oldinga 15 daqiqalik oynalar; jonli navbatli shifokorlarda — qabul soatlari",
    "en": "15-minute slots as many days ahead as the doctor’s booking is open (7, 14 or 30); for walk-in queue doctors, their reception hours"
  },
  "Заявки": {
    "uz": "Arizalar",
    "en": "Requests"
  },
  "Пациент оставляет имя и телефон. В CRM появляется карточка заявки.": {
    "uz": "Bemor ismi va telefonini qoldiradi. CRMda ariza kartochkasi paydo bo‘ladi.",
    "en": "The patient leaves a name and phone. A request card appears in the CRM."
  },
  "Запись на приём": {
    "uz": "Qabulga yozilish",
    "en": "Appointment booking"
  },
  "Пациент выбирает свободное время. В CRM появляется заявка с выбранным временем.": {
    "uz": "Bemor bo‘sh vaqtni tanlaydi. CRMda tanlangan vaqt bilan ariza paydo bo‘ladi.",
    "en": "The patient picks a free slot. A request with the chosen time appears in the CRM."
  },
  "Отмена записи": {
    "uz": "Yozilishni bekor qilish",
    "en": "Booking cancellation"
  },
  "Пациент отменяет свою запись на сайте или у партнёра.": {
    "uz": "Bemor saytda yoki hamkorda o‘z yozilishini bekor qiladi.",
    "en": "The patient cancels their booking on the website or with the partner."
  },
  "Заявка принята": {
    "uz": "Ariza qabul qilindi",
    "en": "Request accepted"
  },
  "Администратор взял заявку в работу": {
    "uz": "Administrator arizani ishga oldi",
    "en": "An administrator took the request on"
  },
  "Пациент записан": {
    "uz": "Bemor yozildi",
    "en": "Patient booked"
  },
  "Клиника записала пациента по заявке: время занято": {
    "uz": "Klinika bemorni ariza bo‘yicha yozdi: vaqt band",
    "en": "The clinic booked the patient from the request: the slot is taken"
  },
  "Онлайн-запись подтверждена": {
    "uz": "Onlayn yozilish tasdiqlandi",
    "en": "Online booking confirmed"
  },
  "Администратор подтвердил время, которое выбрал пациент": {
    "uz": "Administrator bemor tanlagan vaqtni tasdiqladi",
    "en": "An administrator confirmed the time the patient chose"
  },
  "Предложено другое время": {
    "uz": "Boshqa vaqt taklif qilindi",
    "en": "Another time offered"
  },
  "Клиника предложила пациенту другое время вместо выбранного": {
    "uz": "Klinika bemorga tanlangan vaqt o‘rniga boshqa vaqtni taklif qildi",
    "en": "The clinic offered the patient another time instead of the chosen one"
  },
  "Онлайн-запись отклонена": {
    "uz": "Onlayn yozilish rad etildi",
    "en": "Online booking declined"
  },
  "Клиника не может принять пациента в выбранное время": {
    "uz": "Klinika bemorni tanlangan vaqtda qabul qila olmaydi",
    "en": "The clinic cannot see the patient at the chosen time"
  },
  "Запись отменена": {
    "uz": "Yozuv bekor qilindi",
    "en": "Appointment cancelled"
  },
  "Клиника или пациент отменили запись": {
    "uz": "Klinika yoki bemor yozilishni bekor qildi",
    "en": "The clinic or the patient cancelled the booking"
  },
  "Пациент пришёл": {
    "uz": "Bemor keldi",
    "en": "Patient arrived"
  },
  "Регистратура отметила приход пациента": {
    "uz": "Registratura bemor kelganini belgiladi",
    "en": "Reception marked the patient as arrived"
  },
  "Консультации": {
    "uz": "Konsultatsiyalar",
    "en": "Consultations"
  },
  "Лаборатория": {
    "uz": "Laboratoriya",
    "en": "Laboratory"
  },
  "Диагностика": {
    "uz": "Diagnostika",
    "en": "Diagnostics"
  },
  "Процедуры": {
    "uz": "Protseduralar",
    "en": "Procedures"
  },
  "Хирургия": {
    "uz": "Xirurgiya",
    "en": "Surgery"
  }
};

export const RESPONSES = {
  "ru": {
    "geo": {
      "status": 200,
      "body": {
        "countries": [
          {
            "code": "UZ",
            "name": "Узбекистан"
          },
          {
            "code": "KZ",
            "name": "Казахстан"
          }
        ],
        "cities": [
          {
            "slug": "tashkent-city",
            "name": "город Ташкент",
            "districts": [
              {
                "slug": "bektemir",
                "name": "Бектемирский район"
              },
              {
                "slug": "mirobod",
                "name": "Мирабадский район"
              }
            ]
          }
        ]
      }
    },
    "specialties": {
      "status": 200,
      "body": {
        "specialties": [
          {
            "slug": "akusher-ginekolog",
            "name": "Акушер-гинеколог"
          },
          {
            "slug": "allergolog-immunolog",
            "name": "Аллерголог-иммунолог"
          },
          {
            "slug": "angiolog",
            "name": "Ангиолог"
          }
        ]
      }
    },
    "clinic": {
      "status": 200,
      "body": {
        "name": "Клиника «Шифо»",
        "about": "Семейная клиника: взрослые и дети, анализы, УЗИ.",
        "country": "UZ",
        "city": "tashkent-city",
        "district": "yunusobod",
        "street": "ул. Амира Темура, 1",
        "address": "город Ташкент, Юнусабадский район, ул. Амира Темура, 1",
        "phone": "+998712000000",
        "site": "https://shifo.example",
        "telegram_bot": "@shifo_example_bot",
        "telegram_channel": "@shifo_example",
        "instagram": "@shifo.example",
        "logo": {
          "square": "https://api.easymed.uz/shifo/v1/media/cea9dd816d60f34c6a18f35350e00ab868d8fe002be2c51886fdae50bf9df0f7.png",
          "portrait": null
        },
        "map_url": "https://yandex.uz/maps/?pt=69.2797,41.3111&z=17",
        "route_url": "https://yandex.uz/maps/?rtext=~41.3111,69.2797&rtt=auto",
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "branches": {
      "status": 200,
      "body": {
        "branches": [
          {
            "id": 1,
            "name": "Главный корпус",
            "city": "tashkent-city",
            "district": "yunusobod",
            "street": "ул. Амира Темура, 1",
            "landmark": "напротив парка",
            "address": "город Ташкент, Юнусабадский район, ул. Амира Темура, 1",
            "phone": "+998712000000",
            "hours": {
              "mon": [
                "08:00",
                "18:00"
              ],
              "tue": [
                "08:00",
                "18:00"
              ],
              "wed": [
                "08:00",
                "18:00"
              ],
              "thu": [
                "08:00",
                "18:00"
              ],
              "fri": [
                "08:00",
                "18:00"
              ],
              "sat": [
                "09:00",
                "15:00"
              ],
              "sun": null
            },
            "open_24_7": false,
            "map_url": "https://yandex.uz/maps/?pt=69.2797,41.3111&z=17",
            "route_url": "https://yandex.uz/maps/?rtext=~41.3111,69.2797&rtt=auto"
          },
          {
            "id": 2,
            "name": "Филиал «Мирабад»",
            "city": "tashkent-city",
            "district": "mirobod",
            "street": "ул. Нукус, 5",
            "landmark": "",
            "address": "город Ташкент, Мирабадский район, ул. Нукус, 5",
            "phone": "+998712000001",
            "hours": {
              "mon": [
                "08:00",
                "18:00"
              ],
              "tue": [
                "08:00",
                "18:00"
              ],
              "wed": [
                "08:00",
                "18:00"
              ],
              "thu": [
                "08:00",
                "18:00"
              ],
              "fri": [
                "08:00",
                "18:00"
              ],
              "sat": null,
              "sun": null
            },
            "open_24_7": false,
            "map_url": "",
            "route_url": ""
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "doctors": {
      "status": 200,
      "body": {
        "doctors": [
          {
            "id": 7,
            "name": "Каримов Азиз Рустамович",
            "title": "Врач высшей категории",
            "bio": "Детский врач, 12 лет практики.",
            "specialties": [
              "pediatr"
            ],
            "experience_years": 12,
            "languages": [
              "ru",
              "uz"
            ],
            "photo": "https://api.easymed.uz/shifo/v1/media/ce1ef52a4851e3b88f63ee8ad2b89acb885be028fb05f09dd99e35483f1dee1f.webp",
            "branch_ids": [
              1
            ],
            "reception": "booking",
            "booking_days": 14,
            "consultations": [
              {
                "type": "initial",
                "name": "Первичный приём",
                "price": 150000,
                "minutes": 30
              }
            ],
            "services": [
              {
                "service_id": 303,
                "price": 80000
              }
            ]
          },
          {
            "id": 8,
            "name": "Юсупова Нигора Алишеровна",
            "title": "",
            "bio": "Терапевт.",
            "specialties": [
              "terapevt"
            ],
            "experience_years": 8,
            "languages": [
              "ru",
              "uz",
              "en"
            ],
            "photo": null,
            "branch_ids": [
              2
            ],
            "reception": "live_queue",
            "booking_days": 14,
            "consultations": [],
            "services": []
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "slots-day": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "date": "2030-03-12",
        "slot_minutes": 15,
        "slots": [
          {
            "start": "09:00",
            "free": true
          },
          {
            "start": "09:15",
            "free": true
          },
          {
            "start": "09:30",
            "free": false
          },
          {
            "start": "09:45",
            "free": true
          },
          {
            "start": "10:00",
            "free": true
          },
          {
            "start": "10:15",
            "free": true
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-fit": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "date": "2030-03-12",
        "slot_minutes": 15,
        "slots": [
          {
            "start": "09:00",
            "free": true
          },
          {
            "start": "09:45",
            "free": true
          },
          {
            "start": "10:00",
            "free": true
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-days": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "slot_minutes": 15,
        "days": [
          {
            "date": "2030-03-12",
            "slots": [
              {
                "start": "09:00",
                "free": true
              },
              {
                "start": "09:45",
                "free": true
              },
              {
                "start": "10:00",
                "free": true
              }
            ]
          },
          {
            "date": "2030-03-13",
            "slots": [
              {
                "start": "14:00",
                "free": true
              },
              {
                "start": "14:15",
                "free": true
              },
              {
                "start": "14:30",
                "free": true
              }
            ]
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-live": {
      "status": 200,
      "body": {
        "doctor_id": 8,
        "reception": "live_queue",
        "hours": {
          "mon": [
            "08:00",
            "14:00"
          ],
          "tue": [
            "08:00",
            "14:00"
          ],
          "wed": [
            "08:00",
            "14:00"
          ],
          "thu": [
            "08:00",
            "14:00"
          ],
          "fri": [
            "08:00",
            "14:00"
          ],
          "sat": null,
          "sun": null
        },
        "queue_now": 3,
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "services": {
      "status": 200,
      "body": {
        "services": [
          {
            "id": 301,
            "group": "lab",
            "name": "Общий анализ крови",
            "price": 45000,
            "minutes": 10
          },
          {
            "id": 302,
            "group": "diagnostics",
            "name": "УЗИ брюшной полости",
            "price": 180000,
            "minutes": 20
          },
          {
            "id": 303,
            "group": "consultations",
            "name": "Консультация по анализам",
            "price": 80000,
            "minutes": 15
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "packages": {
      "status": 200,
      "body": {
        "packages": [
          {
            "id": 4,
            "name": "Check-up базовый",
            "price_full": 225000,
            "price": 191250,
            "discount_percent": 15,
            "valid_until": "2030-06-30",
            "items": [
              {
                "service_id": 301,
                "price_full": 45000,
                "price": 38250
              },
              {
                "service_id": 302,
                "price_full": 180000,
                "price": 153000
              }
            ]
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "request-new": {
      "status": 201,
      "body": {
        "request_id": "rq_Shf7Qk2Lm9Xc4Vb8Nz3Wd5Ta",
        "external_id": "cb-1001",
        "type": "request",
        "status": "new",
        "service_id": 301,
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:00:00+05:00"
      }
    },
    "appointment-new": {
      "status": 201,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:00:00+05:00"
      }
    },
    "error-slot-taken": {
      "status": 409,
      "body": {
        "error": {
          "code": "slot_taken",
          "message": "Это время уже занято — запросите /slots заново."
        }
      }
    },
    "request-held": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "hold_until": "2030-03-11T09:31:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:01:00+05:00"
      }
    },
    "request-offered": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "offered",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "offered_start": "2030-03-12T10:00:00+05:00",
        "offer_until": "2030-03-11T09:35:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:05:00+05:00"
      }
    },
    "offer-accept": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T10:00:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:07:00+05:00"
      }
    },
    "appointment-cancel": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "cancelled",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T10:00:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:10:00+05:00"
      }
    },
    "error-field": {
      "status": 400,
      "body": {
        "error": {
          "code": "invalid_field",
          "message": "Поле заполнено неверно — см. field и reason.",
          "field": "patient.phone",
          "reason": "format"
        }
      }
    },
    "error-key": {
      "status": 401,
      "body": {
        "error": {
          "code": "invalid_key",
          "message": "Ключа нет или он неверный."
        }
      }
    }
  },
  "uz": {
    "geo": {
      "status": 200,
      "body": {
        "countries": [
          {
            "code": "UZ",
            "name": "O‘zbekiston"
          },
          {
            "code": "KZ",
            "name": "Qozog‘iston"
          }
        ],
        "cities": [
          {
            "slug": "tashkent-city",
            "name": "Toshkent shahri",
            "districts": [
              {
                "slug": "bektemir",
                "name": "Bektemir tumani"
              },
              {
                "slug": "mirobod",
                "name": "Mirobod tumani"
              }
            ]
          }
        ]
      }
    },
    "specialties": {
      "status": 200,
      "body": {
        "specialties": [
          {
            "slug": "akusher-ginekolog",
            "name": "Akusher-ginekolog"
          },
          {
            "slug": "allergolog-immunolog",
            "name": "Allergolog-immunolog"
          },
          {
            "slug": "angiolog",
            "name": "Angiolog"
          }
        ]
      }
    },
    "clinic": {
      "status": 200,
      "body": {
        "name": "«Shifo» klinikasi",
        "about": "Oilaviy klinika: kattalar va bolalar, tahlillar, UTT.",
        "country": "UZ",
        "city": "tashkent-city",
        "district": "yunusobod",
        "street": "Amir Temur ko‘chasi, 1",
        "address": "Toshkent shahri, Yunusobod tumani, Amir Temur ko‘chasi, 1",
        "phone": "+998712000000",
        "site": "https://shifo.example",
        "telegram_bot": "@shifo_example_bot",
        "telegram_channel": "@shifo_example",
        "instagram": "@shifo.example",
        "logo": {
          "square": "https://api.easymed.uz/shifo/v1/media/cea9dd816d60f34c6a18f35350e00ab868d8fe002be2c51886fdae50bf9df0f7.png",
          "portrait": null
        },
        "map_url": "https://yandex.uz/maps/?pt=69.2797,41.3111&z=17",
        "route_url": "https://yandex.uz/maps/?rtext=~41.3111,69.2797&rtt=auto",
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "branches": {
      "status": 200,
      "body": {
        "branches": [
          {
            "id": 1,
            "name": "Bosh bino",
            "city": "tashkent-city",
            "district": "yunusobod",
            "street": "Amir Temur ko‘chasi, 1",
            "landmark": "bog‘ qarshisida",
            "address": "Toshkent shahri, Yunusobod tumani, Amir Temur ko‘chasi, 1",
            "phone": "+998712000000",
            "hours": {
              "mon": [
                "08:00",
                "18:00"
              ],
              "tue": [
                "08:00",
                "18:00"
              ],
              "wed": [
                "08:00",
                "18:00"
              ],
              "thu": [
                "08:00",
                "18:00"
              ],
              "fri": [
                "08:00",
                "18:00"
              ],
              "sat": [
                "09:00",
                "15:00"
              ],
              "sun": null
            },
            "open_24_7": false,
            "map_url": "https://yandex.uz/maps/?pt=69.2797,41.3111&z=17",
            "route_url": "https://yandex.uz/maps/?rtext=~41.3111,69.2797&rtt=auto"
          },
          {
            "id": 2,
            "name": "«Mirobod» filiali",
            "city": "tashkent-city",
            "district": "mirobod",
            "street": "Nukus ko‘chasi, 5",
            "landmark": "",
            "address": "Toshkent shahri, Mirobod tumani, Nukus ko‘chasi, 5",
            "phone": "+998712000001",
            "hours": {
              "mon": [
                "08:00",
                "18:00"
              ],
              "tue": [
                "08:00",
                "18:00"
              ],
              "wed": [
                "08:00",
                "18:00"
              ],
              "thu": [
                "08:00",
                "18:00"
              ],
              "fri": [
                "08:00",
                "18:00"
              ],
              "sat": null,
              "sun": null
            },
            "open_24_7": false,
            "map_url": "",
            "route_url": ""
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "doctors": {
      "status": 200,
      "body": {
        "doctors": [
          {
            "id": 7,
            "name": "Karimov Aziz Rustamovich",
            "title": "Oliy toifali shifokor",
            "bio": "Bolalar shifokori, 12 yillik tajriba.",
            "specialties": [
              "pediatr"
            ],
            "experience_years": 12,
            "languages": [
              "ru",
              "uz"
            ],
            "photo": "https://api.easymed.uz/shifo/v1/media/ce1ef52a4851e3b88f63ee8ad2b89acb885be028fb05f09dd99e35483f1dee1f.webp",
            "branch_ids": [
              1
            ],
            "reception": "booking",
            "booking_days": 14,
            "consultations": [
              {
                "type": "initial",
                "name": "Birlamchi qabul",
                "price": 150000,
                "minutes": 30
              }
            ],
            "services": [
              {
                "service_id": 303,
                "price": 80000
              }
            ]
          },
          {
            "id": 8,
            "name": "Yusupova Nigora Alisherovna",
            "title": "",
            "bio": "Terapevt.",
            "specialties": [
              "terapevt"
            ],
            "experience_years": 8,
            "languages": [
              "ru",
              "uz",
              "en"
            ],
            "photo": null,
            "branch_ids": [
              2
            ],
            "reception": "live_queue",
            "booking_days": 14,
            "consultations": [],
            "services": []
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "slots-day": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "date": "2030-03-12",
        "slot_minutes": 15,
        "slots": [
          {
            "start": "09:00",
            "free": true
          },
          {
            "start": "09:15",
            "free": true
          },
          {
            "start": "09:30",
            "free": false
          },
          {
            "start": "09:45",
            "free": true
          },
          {
            "start": "10:00",
            "free": true
          },
          {
            "start": "10:15",
            "free": true
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-fit": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "date": "2030-03-12",
        "slot_minutes": 15,
        "slots": [
          {
            "start": "09:00",
            "free": true
          },
          {
            "start": "09:45",
            "free": true
          },
          {
            "start": "10:00",
            "free": true
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-days": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "slot_minutes": 15,
        "days": [
          {
            "date": "2030-03-12",
            "slots": [
              {
                "start": "09:00",
                "free": true
              },
              {
                "start": "09:45",
                "free": true
              },
              {
                "start": "10:00",
                "free": true
              }
            ]
          },
          {
            "date": "2030-03-13",
            "slots": [
              {
                "start": "14:00",
                "free": true
              },
              {
                "start": "14:15",
                "free": true
              },
              {
                "start": "14:30",
                "free": true
              }
            ]
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-live": {
      "status": 200,
      "body": {
        "doctor_id": 8,
        "reception": "live_queue",
        "hours": {
          "mon": [
            "08:00",
            "14:00"
          ],
          "tue": [
            "08:00",
            "14:00"
          ],
          "wed": [
            "08:00",
            "14:00"
          ],
          "thu": [
            "08:00",
            "14:00"
          ],
          "fri": [
            "08:00",
            "14:00"
          ],
          "sat": null,
          "sun": null
        },
        "queue_now": 3,
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "services": {
      "status": 200,
      "body": {
        "services": [
          {
            "id": 301,
            "group": "lab",
            "name": "Umumiy qon tahlili",
            "price": 45000,
            "minutes": 10
          },
          {
            "id": 302,
            "group": "diagnostics",
            "name": "Qorin bo‘shlig‘i UTT",
            "price": 180000,
            "minutes": 20
          },
          {
            "id": 303,
            "group": "consultations",
            "name": "Tahlillar bo‘yicha maslahat",
            "price": 80000,
            "minutes": 15
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "packages": {
      "status": 200,
      "body": {
        "packages": [
          {
            "id": 4,
            "name": "Check-up asosiy",
            "price_full": 225000,
            "price": 191250,
            "discount_percent": 15,
            "valid_until": "2030-06-30",
            "items": [
              {
                "service_id": 301,
                "price_full": 45000,
                "price": 38250
              },
              {
                "service_id": 302,
                "price_full": 180000,
                "price": 153000
              }
            ]
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "request-new": {
      "status": 201,
      "body": {
        "request_id": "rq_Shf7Qk2Lm9Xc4Vb8Nz3Wd5Ta",
        "external_id": "cb-1001",
        "type": "request",
        "status": "new",
        "service_id": 301,
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:00:00+05:00"
      }
    },
    "appointment-new": {
      "status": 201,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:00:00+05:00"
      }
    },
    "error-slot-taken": {
      "status": 409,
      "body": {
        "error": {
          "code": "slot_taken",
          "message": "Bu vaqt band — /slots ni qayta so‘rang."
        }
      }
    },
    "request-held": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "hold_until": "2030-03-11T09:31:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:01:00+05:00"
      }
    },
    "request-offered": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "offered",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "offered_start": "2030-03-12T10:00:00+05:00",
        "offer_until": "2030-03-11T09:35:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:05:00+05:00"
      }
    },
    "offer-accept": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T10:00:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:07:00+05:00"
      }
    },
    "appointment-cancel": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "cancelled",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T10:00:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:10:00+05:00"
      }
    },
    "error-field": {
      "status": 400,
      "body": {
        "error": {
          "code": "invalid_field",
          "message": "Maydon noto‘g‘ri to‘ldirilgan — field va reason ga qarang.",
          "field": "patient.phone",
          "reason": "format"
        }
      }
    },
    "error-key": {
      "status": 401,
      "body": {
        "error": {
          "code": "invalid_key",
          "message": "Kalit yo‘q yoki noto‘g‘ri."
        }
      }
    }
  },
  "en": {
    "geo": {
      "status": 200,
      "body": {
        "countries": [
          {
            "code": "UZ",
            "name": "Uzbekistan"
          },
          {
            "code": "KZ",
            "name": "Kazakhstan"
          }
        ],
        "cities": [
          {
            "slug": "tashkent-city",
            "name": "Tashkent city",
            "districts": [
              {
                "slug": "bektemir",
                "name": "Bektemir district"
              },
              {
                "slug": "mirobod",
                "name": "Mirobod district"
              }
            ]
          }
        ]
      }
    },
    "specialties": {
      "status": 200,
      "body": {
        "specialties": [
          {
            "slug": "akusher-ginekolog",
            "name": "Obstetrician-Gynecologist"
          },
          {
            "slug": "allergolog-immunolog",
            "name": "Allergist-Immunologist"
          },
          {
            "slug": "angiolog",
            "name": "Angiologist"
          }
        ]
      }
    },
    "clinic": {
      "status": 200,
      "body": {
        "name": "Shifo Clinic",
        "about": "Family clinic: adults and children, lab tests, ultrasound.",
        "country": "UZ",
        "city": "tashkent-city",
        "district": "yunusobod",
        "street": "1 Amir Temur Street",
        "address": "Tashkent city, Yunusabad district, 1 Amir Temur Street",
        "phone": "+998712000000",
        "site": "https://shifo.example",
        "telegram_bot": "@shifo_example_bot",
        "telegram_channel": "@shifo_example",
        "instagram": "@shifo.example",
        "logo": {
          "square": "https://api.easymed.uz/shifo/v1/media/cea9dd816d60f34c6a18f35350e00ab868d8fe002be2c51886fdae50bf9df0f7.png",
          "portrait": null
        },
        "map_url": "https://yandex.uz/maps/?pt=69.2797,41.3111&z=17",
        "route_url": "https://yandex.uz/maps/?rtext=~41.3111,69.2797&rtt=auto",
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "branches": {
      "status": 200,
      "body": {
        "branches": [
          {
            "id": 1,
            "name": "Main building",
            "city": "tashkent-city",
            "district": "yunusobod",
            "street": "1 Amir Temur Street",
            "landmark": "opposite the park",
            "address": "Tashkent city, Yunusabad district, 1 Amir Temur Street",
            "phone": "+998712000000",
            "hours": {
              "mon": [
                "08:00",
                "18:00"
              ],
              "tue": [
                "08:00",
                "18:00"
              ],
              "wed": [
                "08:00",
                "18:00"
              ],
              "thu": [
                "08:00",
                "18:00"
              ],
              "fri": [
                "08:00",
                "18:00"
              ],
              "sat": [
                "09:00",
                "15:00"
              ],
              "sun": null
            },
            "open_24_7": false,
            "map_url": "https://yandex.uz/maps/?pt=69.2797,41.3111&z=17",
            "route_url": "https://yandex.uz/maps/?rtext=~41.3111,69.2797&rtt=auto"
          },
          {
            "id": 2,
            "name": "Mirobod branch",
            "city": "tashkent-city",
            "district": "mirobod",
            "street": "5 Nukus Street",
            "landmark": "",
            "address": "Tashkent city, Mirobod district, 5 Nukus Street",
            "phone": "+998712000001",
            "hours": {
              "mon": [
                "08:00",
                "18:00"
              ],
              "tue": [
                "08:00",
                "18:00"
              ],
              "wed": [
                "08:00",
                "18:00"
              ],
              "thu": [
                "08:00",
                "18:00"
              ],
              "fri": [
                "08:00",
                "18:00"
              ],
              "sat": null,
              "sun": null
            },
            "open_24_7": false,
            "map_url": "",
            "route_url": ""
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "doctors": {
      "status": 200,
      "body": {
        "doctors": [
          {
            "id": 7,
            "name": "Aziz Karimov",
            "title": "Senior physician",
            "bio": "Paediatrician, 12 years of practice.",
            "specialties": [
              "pediatr"
            ],
            "experience_years": 12,
            "languages": [
              "ru",
              "uz"
            ],
            "photo": "https://api.easymed.uz/shifo/v1/media/ce1ef52a4851e3b88f63ee8ad2b89acb885be028fb05f09dd99e35483f1dee1f.webp",
            "branch_ids": [
              1
            ],
            "reception": "booking",
            "booking_days": 14,
            "consultations": [
              {
                "type": "initial",
                "name": "First visit",
                "price": 150000,
                "minutes": 30
              }
            ],
            "services": [
              {
                "service_id": 303,
                "price": 80000
              }
            ]
          },
          {
            "id": 8,
            "name": "Nigora Yusupova",
            "title": "",
            "bio": "General practitioner.",
            "specialties": [
              "terapevt"
            ],
            "experience_years": 8,
            "languages": [
              "ru",
              "uz",
              "en"
            ],
            "photo": null,
            "branch_ids": [
              2
            ],
            "reception": "live_queue",
            "booking_days": 14,
            "consultations": [],
            "services": []
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "slots-day": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "date": "2030-03-12",
        "slot_minutes": 15,
        "slots": [
          {
            "start": "09:00",
            "free": true
          },
          {
            "start": "09:15",
            "free": true
          },
          {
            "start": "09:30",
            "free": false
          },
          {
            "start": "09:45",
            "free": true
          },
          {
            "start": "10:00",
            "free": true
          },
          {
            "start": "10:15",
            "free": true
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-fit": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "date": "2030-03-12",
        "slot_minutes": 15,
        "slots": [
          {
            "start": "09:00",
            "free": true
          },
          {
            "start": "09:45",
            "free": true
          },
          {
            "start": "10:00",
            "free": true
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-days": {
      "status": 200,
      "body": {
        "doctor_id": 7,
        "slot_minutes": 15,
        "days": [
          {
            "date": "2030-03-12",
            "slots": [
              {
                "start": "09:00",
                "free": true
              },
              {
                "start": "09:45",
                "free": true
              },
              {
                "start": "10:00",
                "free": true
              }
            ]
          },
          {
            "date": "2030-03-13",
            "slots": [
              {
                "start": "14:00",
                "free": true
              },
              {
                "start": "14:15",
                "free": true
              },
              {
                "start": "14:30",
                "free": true
              }
            ]
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "slots-live": {
      "status": 200,
      "body": {
        "doctor_id": 8,
        "reception": "live_queue",
        "hours": {
          "mon": [
            "08:00",
            "14:00"
          ],
          "tue": [
            "08:00",
            "14:00"
          ],
          "wed": [
            "08:00",
            "14:00"
          ],
          "thu": [
            "08:00",
            "14:00"
          ],
          "fri": [
            "08:00",
            "14:00"
          ],
          "sat": null,
          "sun": null
        },
        "queue_now": 3,
        "as_of": "2030-03-11T09:00:00+05:00",
        "stale": false
      }
    },
    "services": {
      "status": 200,
      "body": {
        "services": [
          {
            "id": 301,
            "group": "lab",
            "name": "Complete blood count",
            "price": 45000,
            "minutes": 10
          },
          {
            "id": 302,
            "group": "diagnostics",
            "name": "Abdominal ultrasound",
            "price": 180000,
            "minutes": 20
          },
          {
            "id": 303,
            "group": "consultations",
            "name": "Test results consultation",
            "price": 80000,
            "minutes": 15
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "packages": {
      "status": 200,
      "body": {
        "packages": [
          {
            "id": 4,
            "name": "Basic check-up",
            "price_full": 225000,
            "price": 191250,
            "discount_percent": 15,
            "valid_until": "2030-06-30",
            "items": [
              {
                "service_id": 301,
                "price_full": 45000,
                "price": 38250
              },
              {
                "service_id": 302,
                "price_full": 180000,
                "price": 153000
              }
            ]
          }
        ],
        "as_of": "2030-03-11T09:00:00+05:00"
      }
    },
    "request-new": {
      "status": 201,
      "body": {
        "request_id": "rq_Shf7Qk2Lm9Xc4Vb8Nz3Wd5Ta",
        "external_id": "cb-1001",
        "type": "request",
        "status": "new",
        "service_id": 301,
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:00:00+05:00"
      }
    },
    "appointment-new": {
      "status": 201,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:00:00+05:00"
      }
    },
    "error-slot-taken": {
      "status": 409,
      "body": {
        "error": {
          "code": "slot_taken",
          "message": "This time is already taken — request /slots again."
        }
      }
    },
    "request-held": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "hold_until": "2030-03-11T09:31:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:01:00+05:00"
      }
    },
    "request-offered": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "offered",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T09:45:00+05:00",
        "offered_start": "2030-03-12T10:00:00+05:00",
        "offer_until": "2030-03-11T09:35:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:05:00+05:00"
      }
    },
    "offer-accept": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "pending",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T10:00:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:07:00+05:00"
      }
    },
    "appointment-cancel": {
      "status": 200,
      "body": {
        "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
        "external_id": "bk-2002",
        "type": "appointment",
        "status": "cancelled",
        "doctor_id": 7,
        "branch_id": 1,
        "consultation": "initial",
        "start": "2030-03-12T10:00:00+05:00",
        "created_at": "2030-03-11T09:00:00+05:00",
        "updated_at": "2030-03-11T09:10:00+05:00"
      }
    },
    "error-field": {
      "status": 400,
      "body": {
        "error": {
          "code": "invalid_field",
          "message": "A field is invalid — see field and reason.",
          "field": "patient.phone",
          "reason": "format"
        }
      }
    },
    "error-key": {
      "status": 401,
      "body": {
        "error": {
          "code": "invalid_key",
          "message": "The key is missing or invalid."
        }
      }
    }
  }
};
