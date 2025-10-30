import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Import internal build of pdf-parse to avoid ESM issues during runtime.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

export async function pdfBufferToPlainText(buffer) {
  if (!buffer || !buffer.length) {
    return { text: '', pageCount: 0 };
  }

  const result = await pdfParse(buffer).catch(() => ({ text: '', numpages: 0 }));
  const cleaned = (result?.text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const pageCount = Number.isFinite(result?.numpages) ? result.numpages : 0;
  return { text: cleaned, pageCount };
}
