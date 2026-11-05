import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Paylink storage. Two implementations share one async interface:
//   get(id)                         -> paylink | null
//   insert(paylink)                 -> false if the reference is already taken (atomic)
//   save(paylink)                   -> writes the paylink and indexes its provider sessions
//   findByReference(reference)      -> paylink | null
//   findBySession(provider, id)     -> paylink | null
//   withLock(key, fn)               -> runs fn while holding an exclusive lock on key
//
// MemoryStore (optionally file-backed) is for local development and tests on a single process.
// RedisStore uses Upstash's REST API and is what runs on Vercel, where many function instances
// can handle requests for the same paylink at once.

export class LockTimeoutError extends Error {
  status = 503;
  constructor(key) {
    super(`busy: another request is updating ${key}, try again`);
  }
}

const sessionKey = (provider, providerId) => `${provider}:${providerId}`;
const clone = (value) => (value ? structuredClone(value) : null);

export class MemoryStore {
  constructor(file = null) {
    this.file = file;
    this.items = new Map();
    this.references = new Map();
    this.sessions = new Map();
    this.locks = new Map();
    if (file && fs.existsSync(file)) {
      for (const item of JSON.parse(fs.readFileSync(file, 'utf8'))) this.#index(item);
    }
  }

  async get(id) {
    return clone(this.items.get(id));
  }

  async insert(paylink) {
    if (this.references.has(paylink.reference)) return false;
    this.#index(paylink);
    this.#flush();
    return true;
  }

  async save(paylink) {
    paylink.updatedAt = new Date().toISOString();
    this.#index(paylink);
    this.#flush();
    return paylink;
  }

  async findByReference(reference) {
    const id = this.references.get(reference);
    return id ? this.get(id) : null;
  }

  async findBySession(provider, providerId) {
    const id = this.sessions.get(sessionKey(provider, providerId));
    return id ? this.get(id) : null;
  }

  // Per-key promise chain: callers run one at a time, in arrival order.
  async withLock(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    this.locks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  #index(paylink) {
    this.items.set(paylink.id, clone(paylink));
    this.references.set(paylink.reference, paylink.id);
    for (const a of paylink.attempts || []) {
      if (a.providerId) this.sessions.set(sessionKey(a.provider, a.providerId), paylink.id);
    }
  }

  #flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// Compare-and-delete, so a lock is only released by the request that holds it.
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export class RedisStore {
  constructor({ url, token, prefix = 'trvst-pay', lockTtlMs = 30_000, lockWaitMs = 20_000, fetchImpl = fetch } = {}) {
    if (!url || !token) throw new Error('RedisStore needs a REST url and token');
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.prefix = prefix;
    this.lockTtlMs = lockTtlMs;
    this.lockWaitMs = lockWaitMs;
    this.fetch = fetchImpl;
  }

  #key(...parts) {
    return [this.prefix, ...parts].join(':');
  }

  async #call(path, body) {
    const response = await this.fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Redis HTTP ${response.status}: ${data?.error || 'request failed'}`);
    return data;
  }

  async #command(...args) {
    const data = await this.#call('', args);
    if (data?.error) throw new Error(`Redis: ${data.error}`);
    return data?.result ?? null;
  }

  async #pipeline(commands) {
    const results = await this.#call('/pipeline', commands);
    const failed = results.find((r) => r?.error);
    if (failed) throw new Error(`Redis: ${failed.error}`);
    return results.map((r) => r?.result ?? null);
  }

  async get(id) {
    const raw = await this.#command('GET', this.#key('pl', id));
    return raw ? JSON.parse(raw) : null;
  }

  async insert(paylink) {
    const claimed = await this.#command('SET', this.#key('ref', paylink.reference), paylink.id, 'NX');
    if (claimed !== 'OK') return false;
    await this.#command('SET', this.#key('pl', paylink.id), JSON.stringify(paylink));
    return true;
  }

  async save(paylink) {
    paylink.updatedAt = new Date().toISOString();
    const commands = [['SET', this.#key('pl', paylink.id), JSON.stringify(paylink)]];
    for (const a of paylink.attempts || []) {
      if (a.providerId) commands.push(['SET', this.#key('session', a.provider, a.providerId), paylink.id]);
    }
    await this.#pipeline(commands);
    return paylink;
  }

  async findByReference(reference) {
    const id = await this.#command('GET', this.#key('ref', reference));
    return id ? this.get(id) : null;
  }

  async findBySession(provider, providerId) {
    const id = await this.#command('GET', this.#key('session', provider, providerId));
    return id ? this.get(id) : null;
  }

  async withLock(key, fn) {
    const lockKey = this.#key('lock', key);
    const token = crypto.randomUUID();
    const deadline = Date.now() + this.lockWaitMs;
    let delay = 50;
    while ((await this.#command('SET', lockKey, token, 'NX', 'PX', String(this.lockTtlMs))) !== 'OK') {
      if (Date.now() >= deadline) throw new LockTimeoutError(key);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
    try {
      return await fn();
    } finally {
      await this.#command('EVAL', RELEASE_SCRIPT, '1', lockKey, token).catch(() => {});
    }
  }
}

// Picks the store from the environment: Redis when Upstash/Vercel KV credentials are present,
// otherwise a local file. On Vercel the filesystem isn't shared or durable, so refuse to start
// without Redis rather than silently losing paylinks.
export function storeFromEnv(env = process.env, storeFile = './data/paylinks.json') {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisStore({ url, token });
  if (env.VERCEL) {
    throw new Error('TRVST PAY on Vercel needs Redis: connect an Upstash Redis store so KV_REST_API_URL/KV_REST_API_TOKEN are set');
  }
  return new MemoryStore(storeFile);
}
