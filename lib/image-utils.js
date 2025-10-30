import sharp from 'sharp';

export async function normalizeToCanvas(buffer, width, height) {
  return await sharp(buffer)
    .resize({ width, height, fit: 'contain', background: '#204EA3' })
    .flatten({ background: '#204EA3' })
    .png()
    .toBuffer();
}
