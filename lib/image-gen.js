import fs from 'fs/promises';
import { normalizeToCanvas } from './image-utils.js';

function stripEmojiPrefix(text) {
  if (!text) return '';
  const trimmed = text.trim();
  const emojiRegex = /^\p{Extended_Pictographic}\s*/u;
  return trimmed.replace(emojiRegex, '').trim();
}

export async function generateKawaiiImage({
  openai,
  headline,
  bullets,
  orientation,
  width,
  height,
  outputPath
}) {
  const orientationKey = orientation === '16:9' ? '16:9' : '9:16';
  const size = orientationKey === '16:9' ? '1536x1024' : '1024x1536';
  const targetWidth = width || (orientationKey === '16:9' ? 1920 : 1080);
  const targetHeight = height || (orientationKey === '16:9' ? 1080 : 1920);
  const cleanedHeadline = stripEmojiPrefix(headline);
  const keyPoints = (bullets || []).slice(0, 3).map((point) => stripEmojiPrefix(point));

  const compositionHint =
    orientationKey === '16:9'
      ? 'Layout: horizontal 16:9. Keep the main subject centered with generous left and right padding.'
      : 'Layout: vertical 9:16. Keep the main subject centered with generous top and bottom padding.';

  const prompt = [
    'Create a cute, flat, textless illustration (no words, no numbers).',
    'Background color must appear as #204EA3 (no black, no transparency).',
    'Center the illustration and keep margins so text fits around the edges.',
    'Use bright #F5EF77 accents for harmony; avoid dark or black fills.',
    'Keep the composition smaller than the frame so UI text can sit comfortably at the edges.',
    'Style: kawaii/rounded, soft shadows, clean outlines, minimal icons.',
    '',
    'Topic cues:',
    `- Headline: "${cleanedHeadline}"`,
    `- Supporting ideas: ${keyPoints.length ? keyPoints.join('; ') : 'n/a'}`,
    '',
    compositionHint
  ].join('\n');

  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt,
    size,
    output_format: 'png',
    quality: 'high'
  });

  const image = response.data?.[0]?.b64_json;
  if (!image) {
    throw new Error('OpenAI image generation returned no data');
  }

  const buffer = Buffer.from(image, 'base64');
  const normalized = await normalizeToCanvas(buffer, targetWidth, targetHeight);

  if (outputPath) {
    await fs.writeFile(outputPath, normalized);
    return outputPath;
  }

  return normalized;
}
