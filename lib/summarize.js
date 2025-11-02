import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';


const ASCII_REPLACEMENTS = new Map(
  Object.entries({
    '“': '"',
    '”': '"',
    '„': '"',
    '«': '"',
    '»': '"',
    '‟': '"',
    '‘': '\'',
    '’': '\'',
    '‚': ',',
    '‛': '\'',
    '–': '-',
    '—': '-',
    '―': '-',
    '−': '-',
    '‐': '-',
    '‑': '-',
    '·': '-',
    '•': '-',
    '…': '...'
  })
);

const SUMMARY_PARAGRAPH_PLACEHOLDER = 'Summary forthcoming.';
const BULLET_FILLER_STRINGS = [
  'Add key detail drawn from the source material.',
  'Highlight a concrete detail from the document.'
];


const ChartSchema = z
  .object({
    type: z.enum(['bar', 'line', 'pie']),
    categories: z.array(z.string()).min(1),
    series: z
      .array(
        z.object({
          label: z.string(),
          values: z.array(z.number()).min(1)
        })
      )
      .min(1)
  })
  .nullable();

const SlideSchema = z.object({
  headline: z.string(),
  paragraph: z.string().min(1),
  bullets: z.array(z.string()).min(2).max(4),
  chart: ChartSchema
});

const SummarySchema = z.object({
  docTitle: z.string().min(1),
  slides: z.array(SlideSchema).min(2).max(8)
});

const DEBUG_SUMMARY = process.env.DEBUG_SUMMARY === 'true';

function toAscii(input) {
  if (input == null) return '';
  const normalized = String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  let output = '';
  for (const char of normalized) {
    if (ASCII_REPLACEMENTS.has(char)) {
      output += ASCII_REPLACEMENTS.get(char);
      continue;
    }
    const code = char.charCodeAt(0);
    if (code === 10 || code === 13 || code === 9) {
      output += ' ';
      continue;
    }
    if (code >= 32 && code <= 126) {
      output += char;
      continue;
    }
  }
  return output;
}

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function placeholderKey(value) {
  return collapseWhitespace(toAscii(value)).toLowerCase();
}

const PARAGRAPH_PLACEHOLDER_KEYS = new Set(
  [SUMMARY_PARAGRAPH_PLACEHOLDER, 'Summary forthcoming'].map(placeholderKey)
);
const BULLET_PLACEHOLDER_KEYS = new Set(
  [SUMMARY_PARAGRAPH_PLACEHOLDER, 'Summary forthcoming', ...BULLET_FILLER_STRINGS].map(
    placeholderKey
  )
);

function isPlaceholderParagraph(text) {
  const key = placeholderKey(text);
  return !key || PARAGRAPH_PLACEHOLDER_KEYS.has(key);
}

function isPlaceholderBullet(text) {
  const key = placeholderKey(text);
  return !key || BULLET_PLACEHOLDER_KEYS.has(key);
}

function toJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      docTitle: { type: 'string' },
      slides: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            headline: { type: 'string' },
            paragraph: { type: 'string' },
            bullets: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string' }
            },
            chart: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    type: { type: 'string', enum: ['bar', 'line', 'pie'] },
                    categories: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'string' }
                    },
                    series: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          label: { type: 'string' },
                          values: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'number' }
                          }
                        },
                        required: ['label', 'values']
                      }
                    }
                  },
                  required: ['type', 'categories', 'series']
                }
              ]
            }
          },
          required: ['headline', 'paragraph', 'bullets', 'chart']
        }
      }
    },
    required: ['docTitle', 'slides']
  };
}

function countNumericTokens(text) {
  return (text.match(/\b\d+(?:\.\d+)?\b/g) || []).length;
}

function countSections(text) {
  const sections = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 120);
  const unique = new Set(sections.map((s) => s.slice(0, 80))).size;
  return Math.max(unique, sections.length ? 1 : 0);
}

function determineSlideCount(text) {
  const charCount = text.length;
  const numericTokens = countNumericTokens(text);
  const uniqueSections = countSections(text);

  let slideCount;
  if (charCount < 1200 && uniqueSections <= 1) {
    slideCount = 2;
  } else if (charCount < 2600 && uniqueSections <= 2) {
    slideCount = 3;
  } else if (charCount < 4200) {
    slideCount = 4;
  } else if (charCount < 6200) {
    slideCount = 5;
  } else if (charCount < 8800) {
    slideCount = 6;
  } else if (charCount < 11500 || uniqueSections >= 6) {
    slideCount = 7;
  } else {
    slideCount = 8;
  }

  if (uniqueSections >= 5 && slideCount < 6) {
    slideCount = Math.min(8, Math.max(slideCount, 6));
  }

  slideCount = Math.min(8, Math.max(2, slideCount));

  return { slideCount, charCount, numericTokens, uniqueSections };
}

function normalizeHeadline(headline, index) {
  const fallback = `Section ${index + 1}`;
  if (!headline) return fallback;
  const cleaned = stripEmojiPrefix(cleanBulletLine(String(headline)))
    .replace(/\*/g, '')
    .trim();
  const ascii = collapseWhitespace(toAscii(cleaned));
  if (!ascii) return fallback;
  const truncated = truncateSummaryText(ascii, 64);
  return truncated || fallback;
}

export async function summarizeToSlides({ longcat, text }) {
  const debugId = DEBUG_SUMMARY ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` : null;
  if (DEBUG_SUMMARY) {
    await writeDebugArtifact(debugId, 'input.txt', text);
  }
  if (!text?.trim()) {
    throw new Error('No text content extracted from PDF');
  }
  if (!longcat || typeof longcat.jsonCompletion !== 'function') {
    throw new Error('Longcat client not configured');
  }

  const stats = determineSlideCount(text);

  const system = `You craft structured, narrated summaries for short-form educational videos.
Always emit JSON that matches the provided schema and respect the requested section count.
Global formatting rules:
- Use ASCII characters only; avoid emoji, smart quotes, typographic dashes, and ellipses.
- Do not invent data or sources; rely strictly on the document.
- Keep language lean and direct; eliminate filler words and hedging.
Rules for each section:
- headline: no emojis, 6-10 vivid words, Title Case, <= 60 characters so that it naturally wraps to two balanced lines.
- paragraph: write exactly 2 disciplined sentences (<= 360 characters total) capturing concrete facts, names, dates, metrics, and causal relationships.
- bullets: provide 3 crisp highlights (<= 90 characters each) that divide the paragraph into clear beats; use present tense and avoid trailing punctuation unless necessary.
- chart: include only when the source has explicit quantitative data and supply matching categories plus numeric series for bar, line, or pie.
Keep the narrative progression logical, avoid repetition, and scale the number of sections with document density (short inputs 2-3 sections, long/dense up to 8).`;

  const user = [
    `Document characters: ${stats.charCount}`,
    `Numeric tokens detected: ${stats.numericTokens}`,
    `Detected sections: ${stats.uniqueSections}`,
    `Target section count: ${stats.slideCount}`,
    '',
    'Document:',
    text
  ].join('\n');

  let structured;
  try {
    const raw = await longcat.jsonCompletion({
      system,
      user,
      schema: toJsonSchema(),
      temperature: 0.3
    });
    await writeDebugArtifact(debugId, 'longcat-response.txt', raw);
    structured = normalizeStructuredResponse(parseStructuredResponse(raw));
  } catch (error) {
    await writeDebugArtifact(debugId, 'error.txt', describeError(error));
    const fallback = tryHeuristicFallback({ error, text, stats });
    if (!fallback) {
      throw error;
    }
    await writeDebugArtifact(debugId, 'fallback.json', JSON.stringify(fallback, null, 2));
    return fallback;
  }

  const parsed = SummarySchema.parse(structured);

  const desiredCount = Math.min(Math.max(stats.slideCount, 2), 8);
  let slides = parsed.slides.slice(0, desiredCount);

  if (!slides.length) {
    slides = parsed.slides.slice(0, 2);
  }

  while (slides.length < desiredCount) {
    const next = parsed.slides[slides.length];
    slides.push(next ?? null);
  }

  if (!slides.length) {
    slides = Array.from({ length: desiredCount }, () => null);
  }

  let docTitle = parsed.docTitle;
  let fallbackData = null;
  let fallbackReplacements = 0;
  const warnings = [];

  const ensureFallbackData = () => {
    if (!fallbackData) {
      fallbackData = normalizeStructuredResponse(buildHeuristicSummary(text, stats));
    }
    return fallbackData;
  };

  const pickFallbackSlide = (index) => {
    const fallback = ensureFallbackData();
    const fallbackSlides = Array.isArray(fallback.slides) ? fallback.slides : [];
    if (!fallbackSlides.length) return null;
    return fallbackSlides[index] ?? fallbackSlides[fallbackSlides.length - 1] ?? null;
  };

  const normalizedSlides = slides.map((slide, index) => {
    let sourceSlide =
      slide && typeof slide === 'object'
        ? slide
        : null;

    if (!slideHasMeaningfulContent(sourceSlide)) {
      const fallbackSlide = pickFallbackSlide(index);
      if (slideHasMeaningfulContent(fallbackSlide)) {
        fallbackReplacements += 1;
        sourceSlide = fallbackSlide;
        const fallbackContext = ensureFallbackData();
        if (index === 0 && isDocTitleWeak(docTitle) && fallbackContext.docTitle) {
          docTitle = fallbackContext.docTitle;
        }
        console.warn(
          `Longcat returned insufficient content for slide ${index + 1}; substituting heuristic summary segment.`
        );
      }
    }

    if (!sourceSlide) {
      sourceSlide = { headline: `Section ${index + 1}`, paragraph: '', bullets: [], chart: null };
    }

    const paragraph = normalizeParagraph(sourceSlide.paragraph, sourceSlide.bullets);

    return {
      headline: normalizeHeadline(sourceSlide.headline, index),
      paragraph,
      bullets: normalizeBullets(sourceSlide.bullets, paragraph),
      chart: normalizeChart(sourceSlide.chart)
    };
  });

  const summaryStats = {
    ...stats,
    plannedSections: normalizedSlides.length,
    targetSections: desiredCount
  };

  await writeDebugArtifact(debugId, 'normalized.json', JSON.stringify({ docTitle, slides: normalizedSlides, stats: summaryStats }, null, 2));

  if (fallbackReplacements > 0) {
    summaryStats.fallbackReplacements = fallbackReplacements;
    warnings.push(
      `Longcat returned incomplete content; substituted heuristic text for ${fallbackReplacements} section${fallbackReplacements === 1 ? '' : 's'}.`
    );
  }

  return {
    docTitle,
    slides: normalizedSlides,
    stats: summaryStats,
    warnings
  };
}

function tryHeuristicFallback({ error, text, stats }) {
  if (!isLikelyNetworkError(error)) {
    return null;
  }

  console.warn(
    `Longcat unreachable (${describeError(error)}); generating heuristic summary fallback.`
  );

  const summary = buildHeuristicSummary(text, stats);
  const parsed = SummarySchema.safeParse(summary);
  const safe = parsed.success
    ? parsed.data
    : SummarySchema.parse(normalizeStructuredResponse(summary));

  const desiredCount = Math.min(Math.max(stats.slideCount, 2), 8);
  let slides = safe.slides.slice(0, desiredCount);
  if (!slides.length) {
  slides = buildFallbackSlides([SUMMARY_PARAGRAPH_PLACEHOLDER]);
  }

  const normalizedSlides = slides.map((slide, index) => {
    const safeSlide =
      slide && typeof slide === 'object'
        ? slide
        : { headline: `Section ${index + 1}`, paragraph: '', bullets: [], chart: null };

    const paragraph = normalizeParagraph(safeSlide.paragraph, safeSlide.bullets);

    return {
      headline: normalizeHeadline(safeSlide.headline, index),
      paragraph,
      bullets: normalizeBullets(safeSlide.bullets, paragraph),
      chart: normalizeChart(safeSlide.chart)
    };
  });

  return {
    docTitle: safe.docTitle,
    slides: normalizedSlides,
    stats: {
      ...stats,
      plannedSections: normalizedSlides.length,
      targetSections: desiredCount
    },
    warnings: ['Longcat request failed; generated heuristic summary instead.']
  };
}

function parseStructuredResponse(content) {
  if (!content) {
    throw new Error('Longcat returned an empty response');
  }

  const jsonCandidate = tryExtractJson(content);
  if (jsonCandidate) {
    return jsonCandidate;
  }

  const slideFallback = parseSlidesFromText(content);
  if (slideFallback) {
    return slideFallback;
  }

  throw new Error('Longcat response was not valid JSON');
}

function tryExtractJson(content) {
  const cleaned = content.trim();

  const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const parsed = safeParse(fencedMatch[1].trim());
    if (parsed) return parsed;
  }

  const direct = safeParse(cleaned);
  if (direct) return direct;

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const sliced = cleaned.slice(firstBrace, lastBrace + 1).trim();
    const parsed = safeParse(sliced);
    if (parsed) return parsed;
  }

  return null;
}

function parseSlidesFromText(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');

  const explicitSlides = parseExplicitSlideBlocks(text);
  if (explicitSlides.length) {
    return buildSlidePayload(explicitSlides);
  }

  const groupedSlides = parseGroupedSections(text);
  if (groupedSlides.length) {
    return buildSlidePayload(groupedSlides);
  }

  return null;
}

function parseExplicitSlideBlocks(text) {
  const slideRegex =
    /\*\*Slide\s+\d+:\*\*\s*([\s\S]*?)(?=(\*\*Slide\s+\d+:)|\(\d+\s+slides|\Z)/gi;
  const slides = [];
  let match;

  while ((match = slideRegex.exec(text))) {
    const block = match[1]?.trim();
    if (!block) continue;

    const lines = block
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) continue;

    let headlineLine = lines[0];
    const italicHeadline = headlineLine.match(/^\*([^*]+)\*$/);
    if (italicHeadline) {
      headlineLine = italicHeadline[1].trim();
    }

    const headline = cleanHeadline(headlineLine, slides.length);
    const bullets = lines
      .slice(1)
      .map((line) => cleanBulletLine(line))
      .filter(Boolean)
      .slice(0, 5);

    slides.push({
      headline,
      bullets: bullets.length ? bullets : ['']
    });
  }

  return slides;
}

function parseGroupedSections(text) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const slides = [];
  blocks.forEach((block, idx) => {
    const lines = block
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) return;
    const bulletCandidates = lines.slice(1).map((line) => cleanBulletLine(line)).filter(Boolean);
    if (!bulletCandidates.length) return;

    slides.push({
      headline: cleanHeadline(lines[0], idx),
      bullets: bulletCandidates.slice(0, 5)
    });
  });

  return slides;
}

function buildSlidePayload(slides) {
  if (!slides.length) return null;

  return {
    docTitle: slides[0].headline || 'Generated Summary',
    slides: slides.map((slide) => ({
      headline: slide.headline,
      bullets: slide.bullets,
      chart: null
    }))
  };
}

function normalizeStructuredResponse(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const slideCandidates = extractSlideCandidates(data);
  const normalizedSlides = slideCandidates.slice(0, 8).map((slide, index) => {
    const safeSlide = slide && typeof slide === 'object' ? slide : {};
    const headlineText =
      typeof safeSlide.headline === 'string' && safeSlide.headline.trim()
        ? safeSlide.headline.trim()
        : `Section ${index + 1}`;

    const paragraph = normalizeParagraph(safeSlide.paragraph, safeSlide.bullets);

    return {
      headline: normalizeHeadline(headlineText, index),
      paragraph,
      bullets: normalizeBullets(safeSlide.bullets, paragraph),
      chart: normalizeChart(safeSlide.chart)
    };
  });

  while (normalizedSlides.length < 2) {
    const index = normalizedSlides.length;
    const paragraph = normalizeParagraph('', []);
    normalizedSlides.push({
      headline: normalizeHeadline(`Section ${index + 1}`, index),
      paragraph,
      bullets: normalizeBullets([], paragraph),
      chart: null
    });
  }

  return {
    docTitle: deriveDocTitle(data, normalizedSlides),
    slides: normalizedSlides
  };
}

function extractSlideCandidates(data) {
  if (!data || typeof data !== 'object') {
    return [];
  }

  if (Array.isArray(data.slides)) {
    return data.slides;
  }

  if (Array.isArray(data.sections)) {
    return data.sections;
  }

  if (isSlideLike(data)) {
    return [data];
  }

  return [];
}

function isSlideLike(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const headline = typeof candidate.headline === 'string' ? candidate.headline.trim() : '';
  const paragraph = typeof candidate.paragraph === 'string' ? candidate.paragraph.trim() : '';
  const bulletList = Array.isArray(candidate.bullets)
    ? candidate.bullets.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];

  return Boolean(headline && (paragraph || bulletList.length));
}

function deriveDocTitle(data, slides) {
  const candidates = [];
  if (data && typeof data === 'object') {
    candidates.push(data.docTitle, data.title, data.subject, data.topic, data.headline);
  }
  if (Array.isArray(slides) && slides.length) {
    candidates.push(slides[0].headline);
  }

  for (const candidate of candidates) {
    const cleaned = collapseWhitespace(toAscii(candidate));
    if (cleaned) {
      return truncateSummaryText(cleaned, 120);
    }
  }

  return 'Generated Summary';
}

function normalizeBullets(input, paragraph) {
  const raw = Array.isArray(input) ? input : [];
  const cleaned = Array.from(
    new Set(
      raw
        .map((bullet) => cleanBulletLine(bullet))
        .filter(Boolean)
        .map((value) => truncateSummaryText(value, 110))
    )
  );

  const highlights = paragraphHighlights(paragraph);
  for (const highlight of highlights) {
    if (cleaned.length >= 4) break;
    if (!cleaned.includes(highlight)) {
      cleaned.push(highlight);
    }
  }

  while (cleaned.length < 2) {
    cleaned.push(BULLET_FILLER_STRINGS[cleaned.length % BULLET_FILLER_STRINGS.length]);
  }

  return cleaned.slice(0, 4);
}

function normalizeParagraph(paragraph, bulletFallback) {
  const text = typeof paragraph === 'string' ? paragraph : '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned) {
    return truncateSummaryText(cleaned, 420);
  }

  const fallback = Array.isArray(bulletFallback)
    ? bulletFallback
        .map((entry) => cleanBulletLine(entry))
        .filter(Boolean)
        .join(' ')
    : '';

  if (fallback.trim()) {
    return truncateSummaryText(fallback, 420);
  }

  return SUMMARY_PARAGRAPH_PLACEHOLDER;
}

function normalizeChart(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const type = typeof input.type === 'string' ? input.type.toLowerCase() : '';
  if (!['bar', 'line', 'pie'].includes(type)) {
    return null;
  }

  const categories = Array.isArray(input.categories)
    ? input.categories.map((value) => String(value)).filter((value) => value.trim()).slice(0, 20)
    : [];
  let series = [];

  if (Array.isArray(input.series)) {
    const numericSeries = input.series
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    if (numericSeries.length === input.series.length && numericSeries.length) {
      const label = collapseWhitespace(toAscii(input.label)) || 'Series 1';
      series = [{ label, values: numericSeries.slice(0, 20) }];
    } else {
      series = input.series
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const label = typeof entry.label === 'string' ? entry.label.trim() : '';
          const values = Array.isArray(entry.values)
            ? entry.values
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value))
            : [];
          if (!label || !values.length) {
            return null;
          }
          return { label, values: values.slice(0, 20) };
        })
        .filter(Boolean)
        .slice(0, 6);
    }
  }

  if (!categories.length || !series.length) {
    return null;
  }

  return {
    type,
    categories,
    series
  };
}

function paragraphHighlights(paragraph) {
  return splitIntoSentences(paragraph)
    .map((sentence) => truncateSummaryText(sentence, 110))
    .filter(Boolean)
    .slice(0, 4);
}

function cleanBulletLine(line) {
  if (!line) return '';
  return line.replace(/^[*\-\u2022]+\s*/, '').trim();
}

function slideHasMeaningfulContent(slide) {
  if (!slide || typeof slide !== 'object') return false;

  const paragraphText =
    typeof slide.paragraph === 'string' ? slide.paragraph.replace(/\s+/g, ' ').trim() : '';
  const bulletTexts = Array.isArray(slide.bullets)
    ? slide.bullets
        .map((entry) => cleanBulletLine(entry))
        .filter((text) => Boolean(text) && !isPlaceholderBullet(text))
    : [];

  const isParagraphPlaceholder = isPlaceholderParagraph(paragraphText);
  const meaningfulBulletCount = bulletTexts.filter((text) => text.length >= 12).length;
  const totalBulletChars = bulletTexts.reduce((sum, text) => sum + text.length, 0);

  if (!isParagraphPlaceholder && paragraphText.length >= 80) return true;
  if (meaningfulBulletCount >= 2 && totalBulletChars >= 50) return true;
  if (!isParagraphPlaceholder && paragraphText.length >= 40 && (meaningfulBulletCount >= 1 || totalBulletChars >= 30)) {
    return true;
  }

  return false;
}

function isDocTitleWeak(title) {
  if (!title) return true;
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (!normalized) return true;

  const lower = normalized.toLowerCase();
  const genericTitles = new Set([
    'generated summary',
    'summary',
    'section 1',
    'section one',
    'section 2',
    'section two'
  ]);

  return genericTitles.has(lower);
}

function sanitizeFilename(name) {
  return String(name || '').replace(/[^a-z0-9._-]/gi, '_');
}

async function writeDebugArtifact(id, filename, content) {
  if (!DEBUG_SUMMARY || !id) return;
  try {
    const dir = path.resolve('tmp', 'debug-summary', id);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, sanitizeFilename(filename || 'artifact.txt'));
    const value = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await fs.writeFile(target, value, 'utf8');
  } catch (err) {
    console.warn('Failed to write summary debug artifact', err);
  }
}

function splitIntoSentences(text) {
  if (!text) return [];
  const normalized = collapseWhitespace(toAscii(text));
  if (!normalized) return [];

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length) {
    return sentences;
  }

  return normalized.split(';').map((segment) => segment.trim()).filter(Boolean);
}

function cleanHeadline(line, index) {
  const stripped = stripEmojiPrefix(cleanBulletLine(line || '').replace(/\*\*/g, ''));
  return stripped || `Slide ${index + 1}`;
}

function stripEmojiPrefix(text) {
  if (!text) return '';
  return text.replace(/^[\p{Extended_Pictographic}\u200d\s]+/gu, '').trim();
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildHeuristicSummary(text, stats) {
  const cleaned = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) {
    return {
      docTitle: 'Generated Summary',
      slides: buildFallbackSlides(['No readable content found in document.'])
    };
  }

  const sentences = splitIntoSentences(cleaned);
  const targetSections = Math.min(Math.max(stats.slideCount || 3, 2), 8);
  const chunkSize = Math.max(1, Math.ceil(sentences.length / targetSections));
  const slides = [];

  for (let index = 0; index < targetSections; index += 1) {
    const chunk = sentences.slice(index * chunkSize, (index + 1) * chunkSize);
    if (!chunk.length) continue;

    const paragraph = truncateSummaryText(chunk.join(' '), 420);
    const headline = heuristicHeadline(paragraph, index);
    const bullets = paragraphHighlights(paragraph).slice(0, 4);

    slides.push({
      headline,
      paragraph,
      bullets,
      chart: null
    });
  }

  if (!slides.length) {
    return {
      docTitle: heuristicDocTitle(cleaned),
      slides: buildFallbackSlides([cleaned.slice(0, 200)])
    };
  }

  return {
    docTitle: heuristicDocTitle(slides[0]?.headline || cleaned),
    slides: slides.slice(0, targetSections)
  };
}

function buildFallbackSlides(seed) {
  const paragraph = normalizeParagraph(seed?.join?.(' ') || seed || '', []);
  const bullets = normalizeBullets([], paragraph);
  return [
    {
      headline: 'Section 1',
      paragraph,
      bullets,
      chart: null
    },
    {
      headline: 'Section 2',
      paragraph,
      bullets,
      chart: null
    }
  ];
}

function heuristicHeadline(source, index) {
  const cleaned = cleanBulletLine(String(source || ''));
  if (!cleaned) return `Section ${index + 1}`;
  const trimmed = cleaned.replace(/^[^a-z0-9]+/gi, '').trim();
  if (!trimmed) return `Section ${index + 1}`;
  return truncateSummaryText(trimmed.charAt(0).toUpperCase() + trimmed.slice(1), 70);
}

function heuristicDocTitle(source) {
  const cleaned = cleanBulletLine(String(source || ''));
  if (!cleaned) return 'Generated Summary';
  return truncateSummaryText(cleaned, 120);
}

function truncateSummaryText(text, maxChars) {
  const ascii = collapseWhitespace(toAscii(text));
  if (!ascii) return '';
  if (ascii.length <= maxChars) {
    return ascii;
  }

  const slice = ascii.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxChars * 0.5)) {
    return slice.slice(0, lastSpace).trim();
  }
  return slice.trim();
}

function isLikelyNetworkError(error) {
  const codes = new Set([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_BODY_TIMEOUT',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN'
  ]);

  const cause = error?.cause ?? error;
  const code = cause?.code || cause?.errno;
  if (code && codes.has(code)) {
    return true;
  }

  const message = [error?.message, cause?.message].filter(Boolean).join(' ').toLowerCase();
  return message.includes('fetch failed') || message.includes('timeout') || message.includes('temporarily');
}

function describeError(error) {
  if (!error) return 'unknown error';
  const parts = [];
  if (error.message) parts.push(error.message);
  const cause = error.cause ?? error;
  if (cause?.code) parts.push(`code=${cause.code}`);
  return parts.join(' | ') || 'unknown error';
}



















