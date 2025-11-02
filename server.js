import 'dotenv/config';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';

import { summarizeToSlides } from './lib/summarize.js';
import { selectIllustrationAsset } from './lib/supabase-assets.js';
import { synthesizeHeadline } from './lib/tts.js';
import { buildSilentVoiceover, buildVoiceover } from './lib/audio-stitch.js';
import { renderLocalVideo } from './lib/local-render.js';
import { renderSlideSVG } from './slide-svg.js';
import { createLongcatClient } from './lib/longcat.js';
import { pdfBufferToPlainText } from './lib/document-text.js';

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/assets', express.static('assets'));
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

const FPS = +process.env.VIDEO_FPS || 30;
const FORMAT = process.env.VIDEO_FORMAT || 'mp4';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const DEFAULT_ORIENTATION = normalizeOrientation(process.env.DEFAULT_ORIENTATION || '9:16');

const ORIENTATIONS = {
  '9:16': {
    width: +process.env.VERTICAL_WIDTH || +process.env.VIDEO_WIDTH || 1080,
    height: +process.env.VERTICAL_HEIGHT || +process.env.VIDEO_HEIGHT || 1920
  },
  '16:9': {
    width: +process.env.HORIZONTAL_WIDTH || 1920,
    height: +process.env.HORIZONTAL_HEIGHT || 1080
  }
};

const longcat = createLongcatClient();
const RENDERS_DIR = path.resolve('tmp', 'renders');
const downloadStore = new Map();

app.options('/api/create-video', (req, res) => {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendStatus(204);
});

app.post('/api/create-video', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF provided' });
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    return res.status(400).json({ error: 'Server is missing speech API keys' });
  }

  const orientation = normalizeOrientation(req.body?.orientation || DEFAULT_ORIENTATION);
  const { width, height } = ORIENTATIONS[orientation];
  const tmpRoot = path.resolve('tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  const requestDir = await fs.mkdtemp(path.join(tmpRoot, 'job-'));

  const progress = [];
  const slideLogs = [];

  try {
    progress.push({ step: 'analyze', status: 'started' });
    const { text: rawText, pageCount } = await pdfBufferToPlainText(req.file.buffer);
    const text = sanitizeAndClamp(rawText, 20000);
    if (!text.trim()) {
      throw new Error('Unable to extract usable text from PDF');
    }
    progress.push({ step: 'analyze', status: 'completed', detail: `Extracted ${text.length} chars` });
    const excerpt = text.slice(0, 180).replace(/\s+/g, ' ').trim();
    if (excerpt) {
      progress.push({ step: 'analyze', status: 'info', detail: `Excerpt: ${excerpt}` });
    }

    progress.push({ step: 'plan', status: 'started' });
    const summary = await summarizeToSlides({ longcat, text });
    if (Array.isArray(summary.warnings) && summary.warnings.length) {
      summary.warnings.forEach((warning) => {
        progress.push({ step: 'plan', status: 'info', detail: warning });
      });
    }
    const slides = summary.slides;
    slides.forEach((slide, idx) => {
      const paragraphPreview = (slide?.paragraph || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const bulletPreview = Array.isArray(slide?.bullets) && slide.bullets.length
        ? slide.bullets.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 2).join(' | ').slice(0, 160)
        : '';
      const detailParts = [
        `Slide ${idx + 1}: ${slide?.headline || '(no headline)'}`,
        paragraphPreview ? `Paragraph: ${paragraphPreview}` : 'Paragraph: <empty>',
        bulletPreview ? `Bullets: ${bulletPreview}` : null
      ].filter(Boolean);
      progress.push({ step: 'plan', status: 'info', detail: detailParts.join(' · ') });
    });
    progress.push({
      step: 'plan',
      status: 'completed',
      detail: `${slides.length} slides planned`
    });

    progress.push({ step: 'generate-images', status: 'started' });
    const mediaEntries = [];
    for (let i = 0; i < slides.length; i += 1) {
      const slide = slides[i];
      const narrativeLines = buildSlideNarrativeLines(slide);
      const filename = `slide-${i + 1}.png`;
      const outputPath = path.join(requestDir, filename);

      let illustration = null;
      let illustrationError = null;
      try {
        illustration = await selectIllustrationAsset({ slide, orientation });
      } catch (assetErr) {
        illustration = null;
        illustrationError = assetErr instanceof Error ? assetErr.message : String(assetErr);
        console.warn(`Illustration lookup failed for slide ${i + 1}:`, illustrationError);
        progress.push({
          step: 'generate-images',
          status: 'info',
          detail: `Slide ${i + 1}: falling back to SVG-only artwork (${illustrationError})`
        });
      }
      const slideBuffer = await renderSlideSVG({
        width,
        height,
        orientation,
        headline: slide.headline,
        paragraphs: narrativeLines,
        imageBuffer: illustration?.buffer ?? null,
        showFrame: true,
        showBullets: true
      });
      await fs.writeFile(outputPath, slideBuffer);

      const assetInfo = illustration
        ? { type: illustration.type || 'supabase-illustration', path: illustration.path || null }
        : { type: 'svg-only', path: null };

      const isVertical = orientation === '9:16';
      const imageLayer = {
        type: 'image',
        path: outputPath,
        resizeMode: 'cover'
      };

      const layers = [
        imageLayer,
        {
          type: 'title',
          text: slide.headline,
          fontFamily: 'Outfit',
          googleFont: 'Outfit:700',
          fontWeight: 700,
          fontSize: isVertical ? 64 : 56,
          textColor: '#F5EF77',
          position: isVertical ? 'top' : 'top-left',
          animation: { name: 'fadeInUp', start: 0, duration: 0.8 }
        },
        ...narrativeLines.map((text, idx) => ({
          type: 'text',
          text,
          fontFamily: 'Outfit',
          googleFont: 'Outfit:700',
          fontWeight: 700,
          fontSize: isVertical ? 32 : 30,
          textColor: '#F5EF77',
          position: isVertical ? 'top' : 'left',
          animation: { name: 'fadeInUp', start: 0.4 + idx * 0.3, duration: 0.7 }
        }))
      ];

      mediaEntries.push({
        slide,
        localPath: outputPath,
        assetInfo,
        jsonCut: {
          frame: { width, height },
          duration: 10,
          transition: { name: 'fade', duration: 0.7 },
          layers
        }
      });

      slideLogs.push({
        index: i + 1,
        headline: slide.headline,
        paragraph: slide.paragraph || null,
        narrativeLines,
        imageSource: assetInfo.type,
        textMode: 'svg',
        chart: slide.chart?.type || null,
        page: slide.page ?? null,
        assetError: illustrationError
      });
    }
    progress.push({ step: 'generate-images', status: 'completed' });

    progress.push({ step: 'tts', status: 'started' });
    const audioClips = [];
    let ttsError = null;
    for (let i = 0; i < mediaEntries.length; i += 1) {
      const rawHeadline = mediaEntries[i].slide?.headline || `Section ${i + 1}`;
      const speechText = rawHeadline.replace(/\s+/g, ' ').trim();
      try {
        const tts = await synthesizeHeadline({
          headline: speechText,
          index: i + 1,
          outputDir: requestDir,
          apiKey: ELEVENLABS_API_KEY,
          voiceId: ELEVENLABS_VOICE_ID
        });
        audioClips.push(tts);
        slideLogs[i].ttsDuration = Number((tts.duration || 0).toFixed(2));
        slideLogs[i].voiceoverText = speechText;
      } catch (error) {
        ttsError = error instanceof Error ? error : new Error(String(error));
        const detail = ttsError.message?.slice?.(0, 180) || String(ttsError);
        console.warn(`Voiceover generation failed on slide ${i + 1}:`, detail);
        progress.push({
          step: 'tts',
          status: 'info',
          detail: `Voiceover disabled after failure on slide ${i + 1}: ${detail}`
        });
        break;
      }
    }

    let voiceoverPath;
    let voiceoverDuration;
    if (!ttsError && audioClips.length === mediaEntries.length && audioClips.length) {
      progress.push({
        step: 'tts',
        status: 'completed',
        detail: `Generated ${audioClips.length} voiceover clips`
      });

      const standardVoiceoverPath = path.join(requestDir, 'voiceover.mp3');
      const voiceover = await buildVoiceover(audioClips, {
        workingDir: requestDir,
        outputPath: standardVoiceoverPath
      });
      voiceoverPath = voiceover.filePath;
      voiceoverDuration = voiceover.duration;
    } else {
      const totalDuration = mediaEntries.reduce(
        (sum, entry) => sum + (Number.isFinite(entry.duration) && entry.duration > 0 ? entry.duration : 10),
        0
      );
      const silentPath = path.join(requestDir, 'voiceover-silent.mp3');
      const silent = await buildSilentVoiceover({
        durationSeconds: totalDuration,
        outputPath: silentPath
      });
      voiceoverPath = silent.filePath;
      voiceoverDuration = silent.duration;
      slideLogs.forEach((log, index) => {
        if (audioClips[index]) {
          return;
        }
        log.ttsDuration = 0;
        log.voiceoverText = null;
        if (ttsError) {
          log.ttsError = ttsError.message || String(ttsError);
        } else {
          log.ttsError = 'Voiceover skipped (no audio generated)';
        }
      });
      progress.push({
        step: 'tts',
        status: 'completed',
        detail: 'Voiceover skipped; using silent audio track'
      });
    }

    mediaEntries.forEach((entry) => {
      entry.duration = 10;
      entry.jsonCut.duration = 10;
    });

    progress.push({ step: 'render', status: 'started', detail: 'Rendering locally with ffmpeg' });
    const tempVideoPath = path.join(requestDir, `render-${Date.now()}.${FORMAT}`);
    await renderLocalVideo({
      slides: mediaEntries,
      voiceoverPath,
      outputPath: tempVideoPath,
      fps: FPS
    });

    const fileId = await registerLocalDownload(tempVideoPath, FORMAT);
    progress.push({ step: 'render', status: 'completed', detail: 'Local render complete' });

    const downloadUrl = `/api/download?fileId=${encodeURIComponent(fileId)}&fmt=${FORMAT}&local=1`;
    const totalDuration =
      voiceoverDuration ??
      mediaEntries.reduce((sum, entry) => sum + (entry.duration ?? 10), 0);

    return res.json({
      ok: true,
      downloadUrl,
      filename: `summary-video.${FORMAT}`,
      orientation,
      durationSeconds: Number.isFinite(totalDuration)
        ? Number(totalDuration.toFixed(1))
        : mediaEntries.length * 10,
      provider: 'local',
      jobId: null,
      slides: slideLogs,
      progress
    });
  } catch (err) {
    console.error(err);
    const lastStep = [...progress].reverse().find((entry) => entry.status === 'started');
    progress.push({
      step: lastStep?.step || 'analyze',
      status: 'error',
      detail: err?.message || String(err)
    });
    return res.status(500).json({
      error: err?.message || String(err),
      progress,
      slides: slideLogs
    });
  } finally {
    await safeRemove(requestDir);
  }
});

// Serve locally rendered videos
app.get('/api/download', async (req, res) => {
  const fileId = String(req.query.fileId || '');
  const fmt = String(req.query.fmt || 'mp4');
  if (!fileId) return res.status(400).send('Missing fileId');

  const record = downloadStore.get(fileId);
  if (!record) return res.status(404).send('File not found');

  try {
    await fs.access(record.path);
  } catch {
    downloadStore.delete(fileId);
    return res.status(404).send('File expired');
  }

  res.setHeader('Content-Type', fmt === 'mov' ? 'video/quicktime' : 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="summary-video.${fmt}"`);
  const stream = createReadStream(record.path);
  stream.on('close', async () => {
    downloadStore.delete(fileId);
    await fs.unlink(record.path).catch(() => {});
  });
  stream.pipe(res);
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Server on http://localhost:${port}`));

// ------------------- Helpers -------------------

function buildSlideNarrativeLines(slide) {
  const paragraph = typeof slide?.paragraph === 'string' ? slide.paragraph.replace(/\s+/g, ' ').trim() : '';
  if (paragraph) {
    const sentences = paragraph
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const segments =
      sentences.length > 0
        ? sentences
        : paragraph
            .split(/[,;\u2022]+/)
            .map((segment) => segment.trim())
            .filter(Boolean);
    const lines = segments.map((line) => truncateForLayer(line, 140)).filter(Boolean);
    if (lines.length) {
      return lines.slice(0, 4);
    }
  }
  return buildLayerParagraphs(slide?.bullets || []);
}
function buildLayerParagraphs(bullets = []) {
  return (bullets || [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((text) => truncateForLayer(text, 140))
    .slice(0, 4);
}

function truncateForLayer(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function sanitizeAndClamp(input, maxChars) {
  return String(input || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, maxChars);
}

function normalizeOrientation(value) {
  return value === '16:9' ? '16:9' : '9:16';
}

async function registerLocalDownload(tempPath, format) {
  await fs.mkdir(RENDERS_DIR, { recursive: true });

  const fileId = randomUUID();
  const finalPath = path.join(RENDERS_DIR, `${fileId}.${format}`);

  await fs.rename(tempPath, finalPath);
  downloadStore.set(fileId, { path: finalPath, format, createdAt: Date.now() });
  return fileId;
}

async function safeRemove(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('Failed to clean temp dir', err);
  }
}
































