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
  const keyManager = createKeyManager(resolveElevenLabsKeys(apiKey));
  const voiceManager = createVoiceManager(resolveElevenLabsVoiceIds(voiceId));

  if (!keyManager.current()) {
    throw new Error('Missing ELEVENLABS_API_KEY');
  }
  if (!voiceManager.current()) {
    throw new Error('Missing ELEVENLABS_VOICE_ID');
  }

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
  while (true) {
    const currentKey = keyManager.current();
    const currentVoiceId = voiceManager.current();
    if (!currentKey) {
      const baseMessage = 'All ElevenLabs API keys failed';
      if (lastError instanceof Error) {
        throw new Error(`${baseMessage}: ${formatFetchError(lastError)}`, { cause: lastError });
      }
      throw new Error(baseMessage);
    }
    if (!currentVoiceId) {
      const baseMessage = 'All ElevenLabs voice IDs were rejected';
      if (lastError instanceof Error) {
        throw new Error(`${baseMessage}: ${formatFetchError(lastError)}`, { cause: lastError });
      }
      throw new Error(baseMessage);
    }

    let rotatedKey = false;
    let rotatedVoice = false;

    for (let attempt = 1; attempt <= MAX_TTS_ATTEMPTS; attempt += 1) {
      try {
        const requestUrl = `${ELEVENLABS_ENDPOINT}/text-to-speech/${currentVoiceId}?output_format=mp3_44100_128`;
        const response = await fetch(requestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': currentKey,
            Accept: 'audio/mpeg'
          },
          body: JSON.stringify(body),
          dispatcher: TTS_AGENT,
          signal: AbortSignal.timeout(70_000)
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const error = new Error(
            `ElevenLabs synthesis failed (${response.status}): ${text.slice(0, 200) || 'no details'}`
          );
          if (response.status === 401 || response.status === 403) {
            lastError = error;
            console.warn(
              `ElevenLabs API key rejected (${maskKey(currentKey)}): ${text.slice(0, 120) || 'no details'}`
            );
            keyManager.markInvalid(currentKey);
            rotatedKey = true;
            break;
          }
          if (response.status === 400 && text.includes('"voice_limit_reached"')) {
            lastError = error;
            console.warn(
              `ElevenLabs voice rejected (${currentVoiceId}): ${text.slice(0, 120) || 'no details'}`
            );
            voiceManager.markInvalid(currentVoiceId);
            rotatedVoice = true;
            break;
          }
          throw error;
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

        if (rotatedKey || rotatedVoice) {
          break;
        }

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

    if (rotatedKey || rotatedVoice) {
      continue;
    }

    throw new Error(
      `ElevenLabs synthesis request failed: ${formatFetchError(lastError || new Error('unknown error'))}`
    );
  }
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

function resolveElevenLabsKeys(primary) {
  const ordered = [];
  const add = (value) => {
    const sanitized = sanitizeKey(value);
    if (!sanitized) return;
    if (!ordered.includes(sanitized)) {
      ordered.push(sanitized);
    }
  };

  add(primary);
  add(process.env.ELEVENLABS_API_KEY);
  parseKeyList(process.env.ELEVENLABS_API_KEYS).forEach(add);

  return ordered;
}

function resolveElevenLabsVoiceIds(primary) {
  const ordered = [];
  const add = (value) => {
    const sanitized = sanitizeKey(value);
    if (!sanitized) return;
    if (!ordered.includes(sanitized)) {
      ordered.push(sanitized);
    }
  };

  add(primary);
  add(process.env.ELEVENLABS_VOICE_ID);
  parseKeyList(process.env.ELEVENLABS_FALLBACK_VOICE_IDS).forEach(add);

  const defaultVoices = ['21m00Tcm4TlvDq8ikWAM', 'EXAVITQu4vr4xnSDxMaL'];
  defaultVoices.forEach(add);

  return ordered;
}

function parseKeyList(value) {
  if (!value) return [];
  return String(value)
    .split(/[\s,;]+/)
    .map((entry) => sanitizeKey(entry))
    .filter(Boolean);
}

function sanitizeKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (!trimmed) return '';
  trimmed = trimmed.replace(/^[0-9]+\./, '').trim();
  return trimmed || '';
}

function createKeyManager(keys) {
  const pool = Array.from(
    new Set(
      (Array.isArray(keys) ? keys : [keys])
        .map((key) => sanitizeKey(key))
        .filter(Boolean)
    )
  );

  let index = 0;

  return {
    current() {
      if (!pool.length) return null;
      if (index >= pool.length) {
        index = 0;
      }
      return pool[index] ?? null;
    },
    markInvalid(key) {
      const sanitized = sanitizeKey(key);
      const position = pool.indexOf(sanitized);
      if (position === -1) {
        return this.current();
      }
      pool.splice(position, 1);
      if (!pool.length) {
        return null;
      }
      if (position <= index) {
        index = index % pool.length;
      }
      return this.current();
    }
  };
}

function createVoiceManager(ids) {
  return createKeyManager(ids);
}

function maskKey(key) {
  if (!key) return '(empty)';
  const sanitized = sanitizeKey(key);
  if (sanitized.length <= 8) {
    return `${sanitized.slice(0, 2)}***${sanitized.slice(-2)}`;
  }
  return `${sanitized.slice(0, 4)}...${sanitized.slice(-4)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
