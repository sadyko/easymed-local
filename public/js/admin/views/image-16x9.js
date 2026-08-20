// TELEGRAM_BROADCAST_IMG_V1 — приведение любой картинки к формату 16:9.
//
// Кадрируем в БРАУЗЕРЕ, а не на сервере. Иначе в проект пришлось бы затащить
// библиотеку обработки изображений — сейчас зависимостей ровно три
// (bcryptjs, better-sqlite3, express), и каждая новая приносит собственные
// обновления и собственные уязвимости.
//
// Заодно это закрывает три задачи одним проходом через <canvas>:
//   1. гарантированные 16:9 — ровно то, что просили;
//   2. ограниченный вес: 1280x720 JPEG вместо 12-мегапиксельного снимка;
//   3. отсутствие EXIF — вместе с фотографией, снятой на телефон сотрудника,
//      иначе уехали бы GPS-координаты. Пациентам это отправлять незачем.

export const TARGET_W = 1280;
export const TARGET_H = 720;            // 1280x720 — ровно 16:9
const TARGET_RATIO = TARGET_W / TARGET_H;
const JPEG_QUALITY = 0.85;

// Какой кусок исходника попадёт в кадр: максимальный прямоугольник 16:9 по
// центру. Широкую картинку режем по бокам, высокую — сверху и снизу.
//
// Единственная часть кадрирования, которую можно проверить без браузера,
// поэтому она вынесена в чистую функцию и покрыта тестом отдельно от <canvas>.
export function centerCrop16x9(srcW, srcH) {
    const w = Math.max(1, Math.round(Number(srcW) || 0));
    const h = Math.max(1, Math.round(Number(srcH) || 0));
    if (w / h > TARGET_RATIO) {
        const sw = Math.round(h * TARGET_RATIO);
        return { sx: Math.round((w - sw) / 2), sy: 0, sw, sh: h };
    }
    const sh = Math.round(w / TARGET_RATIO);
    return { sx: 0, sy: Math.round((h - sh) / 2), sw: w, sh };
}

// Итоговый размер: НЕ растягиваем маленькую картинку до 1280x720 — апскейл
// только добавит веса и мыла. Если исходный кадр меньше, оставляем его размер,
// сохраняя пропорцию 16:9.
export function outputSize(cropW) {
    const w = Math.min(TARGET_W, Math.max(1, Math.round(cropW)));
    return { w, h: Math.round(w / TARGET_RATIO) };
}

// File -> Blob (image/jpeg) строго 16:9. Бросает понятную ошибку, если файл не
// картинка: сообщение уходит прямо в toast, поэтому оно на русском.
export async function fileTo16x9Jpeg(file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        throw new Error('Это не картинка — выберите файл JPG или PNG.');
    }
    const bitmap = await loadBitmap(file);
    try {
        const { sx, sy, sw, sh } = centerCrop16x9(bitmap.width, bitmap.height);
        const { w, h } = outputSize(sw);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        // Белая подложка: у PNG с прозрачностью иначе получится чёрный фон,
        // потому что JPEG альфу не хранит.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);

        const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
        if (!blob) throw new Error('Не удалось обработать картинку.');
        return blob;
    } finally {
        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
}

// createImageBitmap есть везде, где есть наш интерфейс, но на всякий случай
// падаем обратно на <img>: сломанная загрузка баннера не должна закрывать
// сотруднику всю форму рассылки.
async function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
        try { return await createImageBitmap(file); } catch (_) { /* ниже */ }
    }
    const url = URL.createObjectURL(file);
    try {
        return await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Не удалось прочитать картинку.'));
            img.src = url;
        });
    } finally { URL.revokeObjectURL(url); }
}
