import { Agent, ProxyAgent } from 'undici';
import dns from 'node:dns';

const DEFAULT_LONGCAT_KEY = 'ak_1Co58b18G06O1Av6hD1X43Gw00k5J';
const DEFAULT_KEY_POOL = [DEFAULT_LONGCAT_KEY];
const DEFAULT_BASE_URL = 'https://api.longcat.chat';
const OPENAI_STYLE_PATH = '/openai/v1/chat/completions';
const DEFAULT_MODEL = 'LongCat-Flash-Chat';
const DEFAULT_CONNECT_TIMEOUT = 15_000;
const MAX_ATTEMPTS = 3;

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CAUSE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ENOTFOUND'
]);

try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch {
  // harmless if unsupported
}

function resolveKeys(explicitKey, explicitList) {
  const ordered = [];
  const add = (value) => {
    const sanitized = sanitizeKey(value);
    if (!sanitized) return;
    if (!ordered.includes(sanitized)) {
      ordered.push(sanitized);
    }
  };

  if (Array.isArray(explicitList)) {
    explicitList.forEach(add);
  } else {
    add(explicitList);
  }

  add(explicitKey);

  parseKeyList(process.env.LONGCAT_API_KEYS).forEach(add);
  add(process.env.LONGCAT_API_KEY);

  DEFAULT_KEY_POOL.forEach(add);

  return ordered.length ? ordered : [DEFAULT_LONGCAT_KEY];
}

export function createLongcatClient(options = {}) {
  const keyManager = createKeyManager(resolveKeys(options.apiKey, options.apiKeys));
  const baseURL = options.baseURL || process.env.LONGCAT_API_BASE || DEFAULT_BASE_URL;
  const model = options.model || process.env.LONGCAT_MODEL || DEFAULT_MODEL;
  const timeout = options.timeout ?? 90_000;
  const dispatcher = resolveDispatcher(options);
  const proxyConfigured = Boolean(resolveProxy(options.proxy));

  async function post(path, payload) {
    const url = `${baseURL}${path}`;
    let lastError = null;

    while (true) {
      const apiKey = keyManager.current();
      if (!apiKey) {
        throw new Error(
          lastError?.message
            ? `Longcat request failed after exhausting all API keys: ${lastError.message}`
            : 'Longcat request failed: no API keys available',
          { cause: lastError }
        );
      }

      let rotated = false;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeout),
            dispatcher
          });
        } catch (err) {
          const error = toError(err);
          lastError = error;

          if (!isRetryableFetchError(error) || attempt === MAX_ATTEMPTS) {
            const prefix = proxyConfigured
              ? 'Longcat request failed (check proxy settings)'
              : 'Longcat request failed';
            throw new Error(`${prefix}: ${formatFetchError(error)}`, { cause: error });
          }

          await delay(backoffMs(attempt));
          continue;
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          const error = new Error(
            `Longcat request failed (${response.status}): ${detail.slice(0, 200) || 'no details'}`
          );

          if (response.status === 401 || response.status === 403) {
            lastError = error;
            const masked = maskKey(apiKey);
            console.warn(
              `Longcat API key rejected (${masked}): ${detail.slice(0, 120) || 'no additional details'}`
            );
            const nextKey = keyManager.markInvalid(apiKey);
            rotated = true;
            if (!nextKey) {
              throw new Error('All Longcat API keys were rejected by the server', { cause: error });
            }
            break;
          }

          if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === MAX_ATTEMPTS) {
            throw error;
          }

          lastError = error;
          await delay(backoffMs(attempt));
          continue;
        }

        try {
          return await response.json();
        } catch (err) {
          const error = toError(err);
          lastError = error;
          if (attempt === MAX_ATTEMPTS) {
            throw new Error('Longcat returned an unreadable response body', { cause: error });
          }
          await delay(backoffMs(attempt));
        }
      }

      if (!rotated) {
        throw new Error('Longcat request failed', { cause: lastError });
      }
    }
  }

  return {
    async jsonCompletion({ system, user, schema, temperature = 0.3, maxTokens = 1800 }) {
      const messages = [];
      if (system) {
        messages.push({ role: 'system', content: system });
      }
      messages.push({ role: 'user', content: user });

      const payload = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      };

      if (schema) {
        payload.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'StructuredResponse',
            schema,
            strict: true
          }
        };
      }

      const data = await post(OPENAI_STYLE_PATH, payload);
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Longcat returned no content');
      }
      return content;
    }
  };
}

function resolveDispatcher(options) {
  if (options.dispatcher) return options.dispatcher;

  const proxy = resolveProxy(options.proxy);
  if (proxy) {
    return new ProxyAgent(proxy);
  }

  const connectTimeout = normalizeTimeout(
    options.connectTimeout ?? process.env.LONGCAT_CONNECT_TIMEOUT,
    DEFAULT_CONNECT_TIMEOUT
  );

  return new Agent({
    connect: {
      timeout: connectTimeout,
      rejectUnauthorized: options.rejectUnauthorized ?? true
    }
  });
}

function resolveProxy(explicit) {
  return (
    explicit ||
    process.env.LONGCAT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    null
  );
}

function normalizeTimeout(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function isRetryableFetchError(error) {
  const cause = error?.cause ?? error;
  const code = cause?.code || cause?.errno;

  if (code && RETRYABLE_CAUSE_CODES.has(code)) {
    return true;
  }

  if (error?.name === 'AbortError' || cause?.name === 'AbortError') {
    return true;
  }

  const message = [error?.message, cause?.message].filter(Boolean).join(' ').toLowerCase();
  return message.includes('timeout') || message.includes('temporarily') || message.includes('socket');
}

function backoffMs(attempt) {
  return 300 * attempt;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFetchError(error) {
  const parts = [];
  if (error?.message) parts.push(error.message);
  const cause = error?.cause;
  if (cause?.code) parts.push(`code=${cause.code}`);
  if (cause?.message && cause?.message !== error.message) {
    parts.push(cause.message);
  }
  return parts.filter(Boolean).join(' | ') || 'unknown error';
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
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

function maskKey(key) {
  if (!key) return '(empty)';
  const sanitized = sanitizeKey(key);
  if (sanitized.length <= 8) {
    return `${sanitized.slice(0, 2)}***${sanitized.slice(-2)}`;
  }
  return `${sanitized.slice(0, 4)}...${sanitized.slice(-4)}`;
}
