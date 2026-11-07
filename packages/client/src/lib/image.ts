/** Centre-crops an image file to a square and encodes it as WebP (client-side, no server image library). */
export async function squareWebp(file: Blob, size = 256, quality = 0.9): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const sx = (bmp.width - side) / 2;
  const sy = (bmp.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
  bmp.close();
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/webp", quality));
}

/** Reads natural dimensions of an image file (for layout before it loads). */
export async function imageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  } catch {
    return null;
  }
}

/** Fits (w,h) into a box keeping aspect ratio. */
export function fit(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const r = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * r), height: Math.round(h * r) };
}
