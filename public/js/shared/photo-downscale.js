// PATIENT_PHOTO_V1 (2026-09-05) — УМЕНЬШЕНИЕ ПОРТРЕТА В БРАУЗЕРЕ, до отправки.
//
// Зачем вообще: фотография пациента показывается квадратом 96 px, фотография
// врача — 156 px. Телефон и веб-камера отдают 3–12 мегапикселей. Разница между
// «хранить исходник» и «хранить 1024 px» — это примерно 40× по диску, и платит
// за неё клиника ДВАЖДЫ: местом на компьютере регистратуры и первой копией
// каждого файла в ежедневном снимке резервной копии (снимок делается жёсткими
// ссылками, но НОВЫЙ файл в снимок попадает целиком).
//
// Чего здесь НЕТ и не будет: уменьшения ВЛОЖЕНИЙ карты пациента. Скан
// направления и снимок результата открывают, чтобы прочитать мелкий текст;
// ужать их — значит тихо испортить документ, и никто об этом не узнает, пока
// не понадобится прочитать. Этот модуль зовут ровно два виджета фото
// (views/patient-create-modal.js, views/doctor-profile.js), и оба показывают
// портрет, в который никто не вглядывается.
//
// ОТКАЗ УМЕНЬШАТЬ — НЕ ОШИБКА. Если браузер не смог раскодировать картинку
// (HEIC в Chrome), не дал canvas или отдал результат ТЯЖЕЛЕЕ исходника, файл
// уходит как есть: пусть решает предел на сервере, а не наша неудача. Худшее,
// что тут можно сделать, — уронить сохранение пациента из-за аватара.

import { PHOTO_MAX_SIDE, PHOTO_JPEG_QUALITY, photoTargetSize } from './patient-file-limits.js?v=pph1';

const asFile = (blob, name, type) => {
    try { return new File([blob], name, { type }); }
    catch (e) { try { blob.name = name; } catch (e2) { /* Blob без имени — вызов сам подставит */ } return blob; }
};

// Имя результата всегда .jpg: содержимое ПОСЛЕ пережатия — именно JPEG, и
// расширение обязано об этом говорить. Сервер отдаёт Content-Type по
// расширению (routes/storage.js), поэтому «.png с байтами JPEG» показался бы
// битой картинкой.
const jpegName = (name) => String(name || 'photo').replace(/\.[^.]*$/, '') .replace(/[^\w.\-]+/g, '_').slice(-60) + '.jpg';

/**
 * Уменьшить фотографию до PHOTO_MAX_SIDE по длинной стороне.
 * @param {File|Blob} file
 * @param {{maxSide?:number, quality?:number}} [opts]
 * @returns {Promise<File|Blob>} новый файл — или ТОТ ЖЕ, если уменьшать нечего
 *   или не получилось.
 */
export async function downscalePhoto(file, opts = {}) {
    const maxSide = opts.maxSide || PHOTO_MAX_SIDE;
    const quality = opts.quality || PHOTO_JPEG_QUALITY;
    if (!file || typeof file.size !== 'number') return file;
    try {
        if (typeof createImageBitmap !== 'function') return file;
        const bmp = await createImageBitmap(file);
        const target = photoTargetSize(bmp.width, bmp.height, maxSide);
        if (!target) { try { bmp.close && bmp.close(); } catch (e) {} return file; }

        const cv = document.createElement('canvas');
        cv.width = target.width; cv.height = target.height;
        const ctx = cv.getContext('2d');
        if (!ctx) return file;
        ctx.drawImage(bmp, 0, 0, target.width, target.height);
        try { bmp.close && bmp.close(); } catch (e) {}

        const out = await new Promise((resolve) => {
            try { cv.toBlob(resolve, 'image/jpeg', quality); }
            catch (e) { resolve(null); }
        });
        // Пережатие, которое СДЕЛАЛО ТЯЖЕЛЕЕ, — не улучшение. Так бывает с
        // маленьким PNG-скриншотом: JPEG того же размера весит больше.
        if (!out || !out.size || out.size >= file.size) return file;
        return asFile(out, jpegName(file.name), 'image/jpeg');
    } catch (e) {
        // HEIC, битый файл, запрет canvas — отправляем исходник.
        return file;
    }
}
