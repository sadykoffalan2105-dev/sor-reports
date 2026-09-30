/**
 * Подготовка фото для отправки в Claude API (только браузер):
 * уменьшение длинной стороны до maxSide и перекодирование в JPEG.
 */

export interface PreparedImage {
  /** base64 без префикса data: */
  data: string;
  media_type: 'image/jpeg';
}

/**
 * Уменьшает изображение (длинная сторона ≤ maxSide), кодирует в JPEG (0.85)
 * и возвращает base64 без префикса. Для форматов, которые браузер не умеет
 * декодировать (HEIC и т. п.), бросает понятную ошибку.
 */
export async function prepareImage(file: File | Blob, maxSide = 1600): Promise<PreparedImage> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('Подготовка фото доступна только в браузере');
  }
  let bitmap: ImageBitmap;
  try {
    // from-image: учитывать EXIF-ориентацию (фото с телефона иначе уйдёт в модель повёрнутым)
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const name = file instanceof File && file.name ? ` «${file.name}»` : '';
    throw new Error(
      `Не удалось открыть фото${name}. Браузер не смог декодировать файл (HEIC и подобные форматы не поддерживаются) — сохраните снимок как JPEG или PNG и попробуйте снова.`,
    );
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось создать холст для обработки фото');
    // JPEG не хранит прозрачность — подложка белая
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high'; // тонкие рукописные штрихи при уменьшении
    ctx.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:image/jpeg') || comma < 0) {
      throw new Error('Браузер не смог закодировать фото в JPEG');
    }
    return { data: dataUrl.slice(comma + 1), media_type: 'image/jpeg' };
  } finally {
    bitmap.close();
  }
}
