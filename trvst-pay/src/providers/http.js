export class ProviderError extends Error {
  constructor(provider, message, { status, body } = {}) {
    super(`${provider}: ${message}`);
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

export async function requestJson(provider, url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ProviderError(provider, `request to ${new URL(url).pathname} failed: ${error.message}`);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const detail = data?.error_description || data?.message || data?.detailed_error_description || response.statusText;
    throw new ProviderError(provider, `HTTP ${response.status} ${detail}`, { status: response.status, body: data });
  }
  return data;
}

// Caches a bearer token until shortly before it expires.
export function tokenCache(fetchToken) {
  let cached = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
    const { value, expiresInSeconds, extra } = await fetchToken();
    cached = { value, extra, expiresAt: Date.now() + (expiresInSeconds || 300) * 1000 };
    return value;
  };
}
