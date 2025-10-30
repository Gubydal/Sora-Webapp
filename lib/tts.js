import fs from 'fs/promises';
import path from 'path';
import { Agent } from 'undici';

const ELEVENLABS_ENDPOINT = 'https://api.elevenlabs.io/v1';
const MAX_TTS_ATTEMPTS = 3;
const RETRYABLE_CAUSE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ETIMEDOUT'
]);
const TTS_AGENT = new Agent({
  connect: { timeout: 60_000 },
  headersTimeout: 90_000,
  bodyTimeout: 0
});

export async function synthesizeHeadline({ headline, index, outputDir, apiKey, voiceId }) {
  if (!apiKey) throw new Error('Missing ELEVENLABS_API_KEY');
  if (!voiceId) throw new Error('Missing ELEVENLABS_VOICE_ID');

  const url = `${ELEVENLABS_ENDPOINT}/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const body = {
    text: headline,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.6,
      style: 0.35,
      use_speaker_boost: true
    }
  };

  let lastError;

  for (let attempt = 1; attempt <= MAX_TTS_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          Accept: 'audio/mpeg'
        },
        body: JSON.stringify(body),
        dispatcher: TTS_AGENT,
        signal: AbortSignal.timeout(70_000)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `ElevenLabs synthesis failed (${response.status}): ${text.slice(0, 200) || 'no details'}`
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const filePath = path.join(outputDir, `headline-${index}.mp3`);
      await fs.writeFile(filePath, buffer);

      // ElevenLabs `mp3_44100_128` responses are constant 128 kbps, so duration = bytes ÷ (bitrate / 8)
      const estimatedDuration = buffer.length / (128000 / 8);
      const duration = Number.isFinite(estimatedDuration) ? estimatedDuration : null;

      return { filePath, duration };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      if (error.message.startsWith('ElevenLabs synthesis failed')) {
        throw error;
      }

      const retryable = isRetryableError(error);
      const lastAttempt = attempt === MAX_TTS_ATTEMPTS;

      if (!retryable || lastAttempt) {
        throw new Error(`ElevenLabs synthesis request failed: ${formatFetchError(error)}`);
      }

      await delay(300 * attempt);
    }
  }

  throw new Error(
    `ElevenLabs synthesis request failed: ${formatFetchError(lastError || new Error('unknown error'))}`
  );
}

function isRetryableError(error) {
  const cause = error.cause;
  const code = (cause && cause.code) || error.code;

  if (code && RETRYABLE_CAUSE_CODES.has(code)) {
    return true;
  }

  if (error.name === 'AbortError') {
    return true;
  }

  const message = [error.message, cause?.message].filter(Boolean).join(' ').toLowerCase();
  return message.includes('timeout') || message.includes('temporarily unavailable');
}

function formatFetchError(error) {
  const descriptor = new Set();
  if (error.message) descriptor.add(error.message);
  const cause = error.cause;
  if (cause?.code) descriptor.add(`code=${cause.code}`);
  if (cause?.message) descriptor.add(cause.message);
  return Array.from(descriptor).join(' | ') || 'unknown error';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
