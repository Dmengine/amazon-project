import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RedisStore, MemoryStore, LockTimeoutError, storeFromEnv } from '../src/store.js';
import { createApp } from '../src/server.js';

// Minimal stand-in for Upstash's REST API: POST / with a command array, POST /pipeline with an
// array of commands. Implements just the commands RedisStore uses.
function fakeUpstash(token = 'tok') {
  const data = new Map();
  const expiries = new Map();
  const commands = [];
  const live = (k) => {
    if (expiries.has(k) && expiries.get(k) <= Date.now()) { data.delete(k); expiries.delete(k); }
    return data.has(k);
  };
  function run([cmd, ...args]) {
    commands.push(cmd);
    switch (cmd.toUpperCase()) {
      case 'GET': return live(args[0]) ? data.get(args[0]) : null;
      case 'SET': {
        const [k, v, ...opts] = args;
        const upper = opts.map((o) => String(o).toUpperCase());
        if (upper.includes('NX') && live(k)) return null;
        data.set(k, v);
        expiries.delete(k);
        const px = upper.indexOf('PX');
        if (px >= 0) expiries.set(k, Date.now() + Number(opts[px + 1]));
        return 'OK';
      }
      case 'EVAL': {
        const [, , key, expected] = args;
        if (live(key) && data.get(key) === expected) { data.delete(key); expiries.delete(key); return 1; }
        return 0;
      }
      default: throw new Error(`unsupported ${cmd}`);
    }
  }
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      const body = JSON.parse(raw);
      try {
        if (req.url === '/pipeline') return res.end(JSON.stringify(body.map((c) => ({ result: run(c) }))));
        res.end(JSON.stringify({ result: run(body) }));
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });
  return { server, data, commands };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function upstash(t) {
  const fake = fakeUpstash();
  const url = await listen(fake.server);
  t.after(() => fake.server.close());
  return { ...fake, url, store: (opts) => new RedisStore({ url, token: 'tok', ...opts }) };
}

test('RedisStore: insert claims the reference, save indexes sessions', async (t) => {
  const r = await upstash(t);
  const store = r.store();
  const paylink = { id: 'pl_1', reference: 'R-1', attempts: [] };
  assert.equal(await store.insert(paylink), true);
  assert.equal(await store.insert({ id: 'pl_2', reference: 'R-1', attempts: [] }), false, 'reference is unique');
  assert.equal((await store.get('pl_1')).reference, 'R-1');
  assert.equal(await store.get('pl_2'), null);

  paylink.attempts.push({ provider: 'globalpayments', providerId: 'LNK_1' });
  await store.save(paylink);
  assert.equal((await store.findBySession('globalpayments', 'LNK_1')).id, 'pl_1');
  assert.equal(await store.findBySession('openpayd', 'LNK_1'), null);
  assert.equal((await store.findByReference('R-1')).id, 'pl_1');
});

test('RedisStore: the lock is exclusive across store instances and times out', async (t) => {
  const r = await upstash(t);
  const a = r.store({ lockWaitMs: 300 });
  const b = r.store({ lockWaitMs: 300 });
  let release;
  const held = a.withLock('pl_1', () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(b.withLock('pl_1', async () => 'never'), LockTimeoutError);
  release();
  await held;
  assert.equal(await b.withLock('pl_1', async () => 'ok'), 'ok', 'free again after release');
});

test('RedisStore: wrong token surfaces an error', async (t) => {
  const r = await upstash(t);
  const store = new RedisStore({ url: r.url, token: 'wrong' });
  await assert.rejects(store.get('pl_1'), /Redis HTTP 401/);
});

test('two service instances sharing Redis open only one provider session', async (t) => {
  const r = await upstash(t);
  let calls = 0;
  const providers = {
    globalPayments: { createLink: async () => { calls++; await new Promise((x) => setTimeout(x, 50)); return { providerId: `LNK_${calls}`, url: `https://gp/${calls}` }; } },
    openpayd: { createPayIn: async () => ({ providerId: 'PI_1', url: 'https://bank/1' }) },
  };
  const config = (store) => ({ publicUrl: 'https://pay.test', allowedOrigins: [], mode: 'live', apiKey: '', store, providers });
  const one = createApp(config(r.store())).service;
  const two = createApp(config(r.store())).service;

  const link = await one.create({ amount: 999, currency: 'GBP', reference: 'MULTI-1' });
  const [u1, u2] = await Promise.all([one.startPayment(link.id, 'card'), two.startPayment(link.id, 'card')]);
  assert.equal(calls, 1);
  assert.equal(u1, u2);
  await assert.rejects(two.startPayment(link.id, 'bank'), (e) => e.status === 409);

  // A webhook handled by the other instance settles the link.
  await two.applyProviderUpdate({ provider: 'globalpayments', providerId: 'LNK_1', status: 'paid' });
  const after = await one.get(link.id);
  assert.equal(after.status, 'paid');
  assert.equal(after.paidWith, 'globalpayments');
});

test('full HTTP flow works on Redis', async (t) => {
  const r = await upstash(t);
  const app = createApp({ publicUrl: 'https://pay.test', allowedOrigins: [], mode: 'mock', apiKey: '', store: r.store() });
  const base = await listen(app.server);
  t.after(() => app.server.close());

  const link = await (await fetch(`${base}/api/paylinks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 1500, currency: 'EUR', reference: 'HTTP-R' }),
  })).json();
  assert.equal((await fetch(`${base}/pay/${link.id}/bank`, { method: 'POST', redirect: 'manual' })).status, 303);
  await fetch(`${base}/mock/bank/${link.id}/paid`, { method: 'POST', redirect: 'manual' });
  assert.deepEqual(await (await fetch(`${base}/pay/${link.id}/status`)).json(), { id: link.id, status: 'paid', paidWith: 'openpayd' });
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.store, 'RedisStore');
});

test('storeFromEnv picks Redis from Vercel KV or Upstash variables, and refuses files on Vercel', () => {
  assert.ok(storeFromEnv({ KV_REST_API_URL: 'https://r', KV_REST_API_TOKEN: 't' }) instanceof RedisStore);
  assert.ok(storeFromEnv({ UPSTASH_REDIS_REST_URL: 'https://r', UPSTASH_REDIS_REST_TOKEN: 't' }) instanceof RedisStore);
  assert.ok(storeFromEnv({}, null) instanceof MemoryStore);
  assert.throws(() => storeFromEnv({ VERCEL: '1' }), /needs Redis/);
});

test('Vercel entry point serves the service and reports missing Redis clearly', async (t) => {
  const r = await upstash(t);
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });

  // Without Redis on Vercel: a clear 500, not a crash.
  process.env = { ...saved, VERCEL: '1' };
  delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
  const bad = (await import(`../../api/index.mjs?no-redis=${Date.now()}`)).default;
  const badServer = http.createServer(bad);
  const badUrl = await listen(badServer);
  t.after(() => badServer.close());
  const res = await fetch(`${badUrl}/health`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).detail, /needs Redis/);

  // With Redis: routes work through the entry point, with the public URL from Vercel's env.
  process.env = { ...saved, VERCEL: '1', KV_REST_API_URL: r.url, KV_REST_API_TOKEN: 'tok', VERCEL_PROJECT_PRODUCTION_URL: 'trvst.example.app' };
  const good = (await import(`../../api/index.mjs?redis=${Date.now()}`)).default;
  const goodServer = http.createServer(good);
  const goodUrl = await listen(goodServer);
  t.after(() => goodServer.close());
  const health = await (await fetch(`${goodUrl}/health`)).json();
  assert.equal(health.store, 'RedisStore');
  assert.equal(health.publicUrl, 'https://trvst.example.app');
  const link = await (await fetch(`${goodUrl}/api/paylinks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 100, currency: 'GBP', reference: 'VERCEL-1' }),
  })).json();
  assert.equal(link.url, `https://trvst.example.app/pay/${link.id}`);
});
