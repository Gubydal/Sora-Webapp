const DEFAULT_LONGCAT_KEY = 'ak_1Co58b18G06O1Av6hD1X43Gw00k5J';
const DEFAULT_BASE_URL = 'https://api.longcat.chat';
const OPENAI_STYLE_PATH = '/openai/v1/chat/completions';
const DEFAULT_MODEL = 'LongCat-Flash-Chat';

function resolveKey(explicit) {
  return explicit || process.env.LONGCAT_API_KEY || DEFAULT_LONGCAT_KEY;
}

export function createLongcatClient(options = {}) {
  const apiKey = resolveKey(options.apiKey);
  const baseURL = options.baseURL || process.env.LONGCAT_API_BASE || DEFAULT_BASE_URL;
  const model = options.model || process.env.LONGCAT_MODEL || DEFAULT_MODEL;
  const timeout = options.timeout ?? 90_000;

  async function post(path, payload) {
    const url = `${baseURL}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Longcat request failed (${response.status}): ${detail.slice(0, 200) || 'no details'}`
      );
    }

    return response.json();
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
