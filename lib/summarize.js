import { z } from 'zod';

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
  bullets: z.array(z.string()).min(3).max(5),
  chart: ChartSchema
});

const SummarySchema = z.object({
  docTitle: z.string().min(1),
  slides: z.array(SlideSchema).min(3).max(6)
});

function toJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      docTitle: { type: 'string' },
      slides: {
        type: 'array',
        minItems: 3,
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            headline: { type: 'string' },
            bullets: {
              type: 'array',
              minItems: 3,
              maxItems: 5,
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
          required: ['headline', 'bullets', 'chart']
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

  let slideCount = 6;
  if (charCount < 2500 && uniqueSections < 3) {
    slideCount = 3;
  } else if (charCount < 5000) {
    slideCount = charCount < 3750 ? 4 : 5;
  } else {
    slideCount = 6;
  }

  slideCount = Math.min(6, Math.max(3, slideCount));

  return { slideCount, charCount, numericTokens, uniqueSections };
}

function ensureEmojiHeadline(headline) {
  if (!headline) return '✨ Summary';
  const trimmed = headline.trim();
  const emojiRegex = /\p{Extended_Pictographic}/u;
  if (emojiRegex.test(trimmed[0])) {
    return trimmed;
  }
  return `✨ ${trimmed}`;
}

export async function summarizeToSlides({ longcat, text }) {
  if (!text?.trim()) {
    throw new Error('No text content extracted from PDF');
  }
  if (!longcat || typeof longcat.jsonCompletion !== 'function') {
    throw new Error('Longcat client not configured');
  }

  const stats = determineSlideCount(text);

  const system = `You summarize documents into concise video-ready paragraphs.
Return between 3 and 6 slides based on the provided target count.
Each slide needs:
- headline starting with an emoji (keep emoji in the string)
- 3 to 5 focused bullet points (no trailing punctuation unless necessary)
- optional chart data (simple numbers) only when the source material includes quantitative information.
Headlines must be <= 80 characters. Bullets <= 120 characters.
Prefer charts when numeric tokens are available.`;

  const user = [
    `Document characters: ${stats.charCount}`,
    `Numeric tokens detected: ${stats.numericTokens}`,
    `Detected sections: ${stats.uniqueSections}`,
    `Target slide count: ${stats.slideCount}`,
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
    structured = normalizeStructuredResponse(parseStructuredResponse(raw));
  } catch (error) {
    const fallback = tryHeuristicFallback({ error, text, stats });
    if (!fallback) {
      throw error;
    }
    return fallback;
  }

  const parsed = SummarySchema.parse(structured);

  // Trim to heuristic count when too many slides, otherwise respect the model output.
  let slides = parsed.slides.slice(0, stats.slideCount);

  if (slides.length < 3) {
    slides = slides.concat(new Array(3 - slides.length).fill(null));
  }

  const normalizedSlides = slides.map((slide) => ({
    headline: ensureEmojiHeadline(slide.headline),
    bullets: normalizeBullets(slide.bullets),
    chart: slide.chart ?? undefined
  }));

  return {
    docTitle: parsed.docTitle,
    slides: normalizedSlides,
    stats
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

  let slides = safe.slides.slice(0, stats.slideCount);
  if (slides.length < 3) {
    slides = slides.concat(new Array(3 - slides.length).fill(null));
  }

  const normalizedSlides = slides.map((slide, index) => {
    const safeSlide =
      slide ??
      {
        headline: `Slide ${index + 1}`,
        bullets: [],
        chart: null
      };

    return {
      headline: ensureEmojiHeadline(safeSlide.headline),
      bullets: normalizeBullets(safeSlide.bullets),
      chart: safeSlide.chart ?? undefined
    };
  });

  return {
    docTitle: safe.docTitle,
    slides: normalizedSlides,
    stats
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

  const result = {
    ...data,
    docTitle: typeof data.docTitle === 'string' && data.docTitle.trim()
      ? data.docTitle.trim()
      : 'Generated Summary',
    slides: []
  };

  const slidesArray = Array.isArray(data.slides) ? data.slides.slice(0, 6) : [];

  result.slides = slidesArray.map((slide, index) => {
    if (!slide || typeof slide !== 'object') {
      return {
        headline: `Slide ${index + 1}`,
        bullets: [],
        chart: null
      };
    }

    const headline =
      typeof slide.headline === 'string' && slide.headline.trim()
        ? slide.headline.trim()
        : `Slide ${index + 1}`;

    return {
      headline,
      bullets: normalizeBullets(slide.bullets),
      chart: slide.chart ?? null
    };
  });

  while (result.slides.length < 3) {
    const index = result.slides.length;
    result.slides.push({
      headline: `Slide ${index + 1}`,
      bullets: [],
      chart: null
    });
  }

  return result;
}

function normalizeBullets(input) {
  const raw = (Array.isArray(input) ? input : [])
    .map((bullet) => String(bullet || '').trim())
    .filter(Boolean)
    .slice(0, 5);

  if (raw.length >= 3) return raw;

  const filler = [
    'Add supporting detail here.',
    'Describe the key point clearly.',
    'Provide an example or note.'
  ];

  while (raw.length < 3) {
    raw.push(filler[raw.length % filler.length]);
  }

  return raw;
}

function cleanBulletLine(line) {
  if (!line) return '';
  return line.replace(/^[*\-\u2022]+\s*/, '').trim();
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

  const sentences = cleaned
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24);

  const segments = sentences.length
    ? sentences
    : cleaned
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

  const targetSlides = Math.min(Math.max(stats.slideCount || 3, 3), 6);
  const chunkSize = Math.max(1, Math.ceil(segments.length / targetSlides));
  const slides = [];

  for (let index = 0; index < targetSlides; index += 1) {
    const chunk = segments.slice(index * chunkSize, (index + 1) * chunkSize);
    if (!chunk.length) continue;

    const headline = heuristicHeadline(chunk[0], index);
    const bullets = chunk
      .map((sentence) => truncateSummaryText(sentence, 118))
      .filter(Boolean)
      .slice(0, 5);

    slides.push({
      headline,
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
    docTitle: heuristicDocTitle(slides[0]?.headline || segments[0] || cleaned),
    slides: slides.slice(0, 6)
  };
}

function buildFallbackSlides(bullets) {
  return [
    {
      headline: 'Slide 1',
      bullets: normalizeBullets(bullets),
      chart: null
    },
    {
      headline: 'Slide 2',
      bullets: normalizeBullets(bullets),
      chart: null
    },
    {
      headline: 'Slide 3',
      bullets: normalizeBullets(bullets),
      chart: null
    }
  ];
}

function heuristicHeadline(source, index) {
  const cleaned = cleanBulletLine(String(source || ''));
  if (!cleaned) return `Slide ${index + 1}`;
  const trimmed = cleaned.replace(/^[^a-z0-9]+/gi, '').trim();
  if (!trimmed) return `Slide ${index + 1}`;
  return truncateSummaryText(trimmed.charAt(0).toUpperCase() + trimmed.slice(1), 78);
}

function heuristicDocTitle(source) {
  const cleaned = cleanBulletLine(String(source || ''));
  if (!cleaned) return 'Generated Summary';
  return truncateSummaryText(cleaned, 120);
}

function truncateSummaryText(text, maxChars) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
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
