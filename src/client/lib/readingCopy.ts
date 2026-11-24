// A smaller copy of a photo for the model to read. A phone photo is 3 to 12 MB and 12 megapixels;
// the model reads a receipt just as well at about 2,000 px on the long side, much sooner. The
// copy is made here (the browser can decode and scale images; a Worker can't, cleanly) and sent
// after the original, which is uploaded and kept untouched.

/** Long side of the reading copy, in pixels. */
export const READING_EDGE = 2048;
/** Photos already this small (and in a type every model reads) are read as they are. */
const SMALL_ENOUGH_BYTES = 1.5 * 1024 * 1024;
const READABLE = ['image/jpeg', 'image/png', 'image/webp'];

/** Whether a file is a photo the app might make a reading copy of. */
export const isPhoto = (file: File) => file.type.startsWith('image/');

/**
 * A JPEG copy of the photo, upright (its EXIF rotation applied) and at most READING_EDGE on the
 * long side; null when it isn't needed or the browser can't decode the file.
 */
export async function makeReadingCopy(file: File): Promise<Blob | null> {
  if (!isPhoto(file) || typeof createImageBitmap !== 'function') return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null; // e.g. HEIC outside Safari: the original is read as it is
  }
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (!long) return null;
    if (long <= READING_EDGE && file.size <= SMALL_ENOUGH_BYTES && READABLE.includes(file.type))
      return null;
    const scale = Math.min(1, READING_EDGE / long);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const g = canvas.getContext('2d');
    if (!g) return null;
    // A white page under anything transparent (PNG screenshots), since JPEG has no transparency.
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85),
    );
  } catch {
    return null;
  } finally {
    bmp.close();
  }
}
