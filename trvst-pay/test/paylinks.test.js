import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { createApp } from '../src/server.js';
import { PaylinkStore } from '../src/store.js';
import { createGlobalPayments } from '../src/providers/globalPayments.js';
import { createOpenPayd } from '../src/providers/openpayd.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

function baseConfig(extra = {}) {
  return {
    port: 0, publicUrl: 'http://pay.test', allowedOrigins: ['http://shop.test'], mode: 'mock',
    storeFile: null, store: new PaylinkStore(null), apiKey: 'k_test', ...extra,
  };
}

async function startApp(extra) {
  const app = createApp(baseConfig(extra));
  const url = await listen(app.server);
  return { ...app, url, close: () => app.server.close() };
}

const auth = { Authorization: 'Bearer k_test', 'Content-Type': 'application/json' };

test('creates a paylink and pays it by card in mock mode', async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await fetch(`${app.url}/api/paylinks`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ amount: 4999, currency: 'gbp', reference: 'ORDER-1', description: 'Order 1' }),
  });
  assert.equal(res.status, 201);
  const link = await res.json();
  assert.match(link.id, /^pl_/);
  assert.equal(link.url, `http://pay.test/pay/${link.id}`);
  assert.equal(link.currency, 'GBP');
  assert.deepEqual(link.methods, ['card', 'bank']);

  const page = await fetch(`${app.url}/pay/${link.id}`);
  const body = await page.text();
  assert.match(body, /£49\.99/);
  assert.match(body, /Pay by card/);
  assert.match(body, /Pay by bank/);

  const start = await fetch(`${app.url}/pay/${link.id}/card`, { method: 'POST', redirect: 'manual' });
  assert.equal(start.status, 303);
  assert.equal(start.headers.get('location'), `http://pay.test/mock/card/${link.id}`);

  await fetch(`${app.url}/mock/card/${link.id}/paid`, { method: 'POST', redirect: 'manual' });
  const status = await (await fetch(`${app.url}/pay/${link.id}/status`)).json();
  assert.deepEqual(status, { id: link.id, status: 'paid', paidWith: 'globalpayments' });
  await assert.rejects(app.service.startPayment(link.id, 'bank'), /paylink is paid/);
});

test('rejects bad input and missing API key', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const post = (body, headers = auth) => fetch(`${app.url}/api/paylinks`, { method: 'POST', headers, body: JSON.stringify(body) });

  assert.equal((await post({ amount: 10, currency: 'GBP', reference: 'R1' }, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post({ amount: 12.5, currency: 'GBP', reference: 'R1' })).status, 400);
  assert.equal((await post({ amount: 100, currency: 'JPY', reference: 'R1' })).status, 400);
  assert.equal((await post({ amount: 100, currency: 'GBP', reference: 'has space' })).status, 400);
  assert.equal((await post({ amount: 100, currency: 'GBP', reference: 'R1', returnUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await post({ amount: 100, currency: 'GBP', reference: 'R1' })).status, 201);
  assert.equal((await post({ amount: 100, currency: 'GBP', reference: 'R1' })).status, 400, 'duplicate reference');
});

test('CORS allows only configured origins', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const ok = await fetch(`${app.url}/api/paylinks`, { method: 'OPTIONS', headers: { Origin: 'http://shop.test' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://shop.test');
  const no = await fetch(`${app.url}/api/paylinks`, { method: 'OPTIONS', headers: { Origin: 'http://evil.test' } });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('expired links cannot be paid', async () => {
  let now = new Date('2026-01-01T00:00:00Z');
  const app = createApp(baseConfig());
  app.service.now = () => now;
  const link = app.service.create({ amount: 100, currency: 'EUR', reference: 'EXP', expiresInHours: 1 });
  now = new Date('2026-01-01T02:00:00Z');
  await assert.rejects(app.service.startPayment(link.id, 'card'), /expired/);
});

// --- Provider adapters against a fake provider API ---

function fakeProvider(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      calls.push(call);
      const [status, data] = handler(call);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  return { server, calls };
}

test('Global Payments adapter: access token then Pay by Link', async (t) => {
  const fake = fakeProvider((call) => {
    if (call.url === '/ucp/accesstoken') return [200, { token: 'gp_tok', seconds_to_expire: 600 }];
    if (call.url === '/ucp/links') return [200, { id: 'LNK_1', url: 'https://pay.gp.test/LNK_1', status: 'ACTIVE' }];
    return [404, {}];
  });
  const base = await listen(fake.server);
  t.after(() => fake.server.close());

  const gp = createGlobalPayments({ baseUrl: `${base}/ucp`, appId: 'app', appKey: 'key', apiVersion: '2021-03-22', accountName: 'transaction_processing', channel: 'CNP', country: 'GB' });
  const paylink = { id: 'pl_1', reference: 'ORDER-9', amount: 1999, currency: 'GBP', description: 'Shoes', expiresAt: '2026-12-01T00:00:00.000Z' };
  const result = await gp.createLink(paylink, { returnUrl: 'r', cancelUrl: 'c', webhookUrl: 'w' });
  assert.deepEqual(result, { providerId: 'LNK_1', url: 'https://pay.gp.test/LNK_1', status: 'ACTIVE' });

  const [tokenCall, linkCall] = fake.calls;
  assert.equal(tokenCall.body.app_id, 'app');
  assert.equal(tokenCall.body.secret, crypto.createHash('sha512').update(tokenCall.body.nonce + 'key').digest('hex'));
  assert.equal(linkCall.headers.authorization, 'Bearer gp_tok');
  assert.equal(linkCall.headers['x-gp-version'], '2021-03-22');
  assert.equal(linkCall.body.transactions.amount, '1999');
  assert.equal(linkCall.body.transactions.currency, 'GBP');
  assert.deepEqual(linkCall.body.transactions.allowed_payment_methods, ['CARD']);
  assert.equal(linkCall.body.notifications.status_url, 'w');

  const raw = JSON.stringify({ status: 'CAPTURED' });
  const sig = crypto.createHash('sha512').update(raw + 'key').digest('hex');
  assert.equal(gp.verifyWebhook(raw, { 'x-gp-signature': sig }), true);
  assert.equal(gp.verifyWebhook(raw, { 'x-gp-signature': 'nope' }), false);
});

test('OpenPayd adapter: OAuth token then PayIn', async (t) => {
  const fake = fakeProvider((call) => {
    if (call.url.startsWith('/api/oauth/token')) return [200, { access_token: 'op_tok', expires_in: 300, accountHolderId: 'AH-1' }];
    if (call.url === '/api/transactions/open-banking/payins') return [201, { id: 'PI_1', status: 'PENDING', authorisationUrl: 'https://bank.test/auth' }];
    return [404, {}];
  });
  const base = await listen(fake.server);
  t.after(() => fake.server.close());

  const op = createOpenPayd({ baseUrl: base, username: 'u', password: 'p', accountId: 'ACC-1', tokenPath: '/api/oauth/token', payinPath: '/api/transactions/open-banking/payins' });
  const result = await op.createPayIn({ reference: 'ORDER-9', amount: 1999, currency: 'EUR', customer: { name: 'Ada' } }, { returnUrl: 'r', webhookUrl: 'w' });
  assert.deepEqual(result, { providerId: 'PI_1', url: 'https://bank.test/auth', status: 'PENDING' });

  const [tokenCall, payinCall] = fake.calls;
  assert.equal(tokenCall.url, '/api/oauth/token?grant_type=client_credentials');
  assert.equal(tokenCall.headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(payinCall.headers.authorization, 'Bearer op_tok');
  assert.equal(payinCall.headers['x-account-holder-id'], 'AH-1');
  assert.deepEqual(payinCall.body.amount, { value: '19.99', currency: 'EUR' });
  assert.equal(payinCall.body.accountId, 'ACC-1');
});

test('webhooks update paylink status in live wiring', async (t) => {
  const appKey = 'gp_key';
  const providers = {
    globalPayments: { ...createGlobalPayments({ appKey }), createLink: async () => ({ providerId: 'LNK_9', url: 'https://gp/x' }) },
    openpayd: {
      ...createOpenPayd({ webhookSecret: '' }),
      createPayIn: async () => ({ providerId: 'PI_9', url: 'https://bank/x' }),
      getPayIn: async (id) => ({ id, status: 'COMPLETED', reference: 'B-1' }),
    },
  };
  const app = await startApp({ mode: 'live', providers });
  t.after(app.close);

  const card = app.service.create({ amount: 500, currency: 'GBP', reference: 'C-1' });
  await app.service.startPayment(card.id, 'card');
  const raw = JSON.stringify({ id: 'TRN_1', status: 'CAPTURED', link_data: { id: 'LNK_9' } });
  const bad = await fetch(`${app.url}/webhooks/globalpayments`, { method: 'POST', body: raw, headers: { 'x-gp-signature': 'x' } });
  assert.equal(bad.status, 401);
  const sig = crypto.createHash('sha512').update(raw + appKey).digest('hex');
  const good = await fetch(`${app.url}/webhooks/globalpayments`, { method: 'POST', body: raw, headers: { 'x-gp-signature': sig } });
  assert.deepEqual(await good.json(), { received: true, matched: true });
  assert.equal(app.service.get(card.id).status, 'paid');

  // OpenPayd without a shared secret: the body's status is ignored and the PayIn is re-read.
  const bank = app.service.create({ amount: 500, currency: 'GBP', reference: 'B-1' });
  await app.service.startPayment(bank.id, 'bank');
  const res = await fetch(`${app.url}/webhooks/openpayd`, { method: 'POST', body: JSON.stringify({ id: 'PI_9', status: 'FAILED' }) });
  assert.deepEqual(await res.json(), { received: true, matched: true });
  assert.equal(app.service.get(bank.id).status, 'paid');
});

test('paylink exposes a button and QR code, and the share page renders them', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const link = await (await fetch(`${app.url}/api/paylinks`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ amount: 2500, currency: 'EUR', reference: 'QR-1', description: 'Coffee' }),
  })).json();

  assert.equal(link.qrCodeUrl, `${link.url}/qr.svg`);
  assert.equal(link.qrCodePngUrl, `${link.url}/qr.png`);
  assert.equal(link.shareUrl, `${link.url}/share`);
  assert.match(link.buttonHtml, new RegExp(`href="${link.url}"`));
  assert.match(link.buttonHtml, /Pay €25\.00 with TRVST PAY/);
  assert.match(link.buttonHtml, new RegExp(`src="${link.url}/qr.png"`));

  const svg = await fetch(`${app.url}/pay/${link.id}/qr.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(await svg.text(), /^<svg[^>]*viewBox/);

  const png = await fetch(`${app.url}/pay/${link.id}/qr.png?size=256`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 256, 'PNG width honours ?size');

  assert.equal((await fetch(`${app.url}/pay/pl_missing/qr.svg`)).status, 404);

  const share = await fetch(`${app.url}/pay/${link.id}/share`);
  const csp = share.headers.get('content-security-policy');
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  const page = await share.text();
  assert.match(page, /<svg/);
  assert.match(page, /Copy embed code/);
  assert.ok(page.includes(`<script nonce="${nonce}">`), 'inline script carries the CSP nonce');
  assert.ok(page.includes('&lt;a href='), 'embed code is HTML-escaped in the textarea');

  const pay = await (await fetch(`${app.url}/pay/${link.id}`)).text();
  assert.match(pay, /Pay on your phone instead/);
});

test('status endpoint is readable from the storefront origin', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const link = app.service.create({ amount: 100, currency: 'GBP', reference: 'ST-1' });
  const res = await fetch(`${app.url}/pay/${link.id}/status`, { headers: { Origin: 'http://shop.test' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://shop.test');
});

// --- Regression tests for review findings ---

function countingProviders() {
  const calls = { card: 0, bank: 0 };
  let release;
  const gate = new Promise((r) => { release = r; });
  return {
    calls,
    release: () => release(),
    providers: {
      globalPayments: {
        ...createGlobalPayments({ appKey: 'k' }),
        createLink: async (p) => { calls.card++; await gate; return { providerId: `LNK_${calls.card}`, url: `https://gp/${calls.card}` }; },
      },
      openpayd: {
        ...createOpenPayd({}),
        createPayIn: async () => { calls.bank++; return { providerId: `PI_${calls.bank}`, url: `https://bank/${calls.bank}` }; },
      },
    },
  };
}

test('concurrent starts for one paylink create a single provider session', async () => {
  const fake = countingProviders();
  const { service } = createApp(baseConfig({ providers: fake.providers }));
  const link = service.create({ amount: 100, currency: 'GBP', reference: 'CC-1' });
  const both = Promise.all([service.startPayment(link.id, 'card'), service.startPayment(link.id, 'card')]);
  fake.release();
  const [a, b] = await both;
  assert.equal(fake.calls.card, 1);
  assert.equal(a, b);
  assert.equal(service.get(link.id).attempts.length, 1);
});

test('only one payable session per paylink: switching method while pending is refused', async (t) => {
  const fake = countingProviders();
  fake.release();
  const app = await startApp({ providers: fake.providers });
  t.after(app.close);
  const link = app.service.create({ amount: 100, currency: 'GBP', reference: 'SW-1' });
  await app.service.startPayment(link.id, 'card');
  await assert.rejects(app.service.startPayment(link.id, 'bank'), (e) => e.status === 409);
  assert.equal(fake.calls.bank, 0);

  const page = await (await fetch(`${app.url}/pay/${link.id}`)).text();
  assert.match(page, /Continue paying by card/);
  assert.doesNotMatch(page, /Pay by bank/);

  // Once the card attempt has failed the payer may choose again.
  app.service.applyProviderUpdate({ provider: 'globalpayments', providerId: 'LNK_1', status: 'failed' });
  assert.equal(await app.service.startPayment(link.id, 'bank'), 'https://bank/1');
});

test('provider events must correlate to the recorded session', async () => {
  const fake = countingProviders();
  fake.release();
  const { service } = createApp(baseConfig({ providers: fake.providers }));
  const link = service.create({ amount: 1234, currency: 'EUR', reference: 'COR-1' });
  await service.startPayment(link.id, 'card');

  // A different provider ID with the same reference must not settle this link.
  assert.equal(service.applyProviderUpdate({ provider: 'globalpayments', providerId: 'LNK_OTHER', reference: 'COR-1', status: 'paid' }), null);
  // No provider ID: reference fallback needs amount and currency to match.
  assert.equal(service.applyProviderUpdate({ provider: 'globalpayments', reference: 'COR-1', amount: 1, currency: 'EUR', status: 'paid' }), null);
  assert.equal(service.applyProviderUpdate({ provider: 'openpayd', reference: 'COR-1', amount: 1234, currency: 'EUR', status: 'paid' }), null, 'no attempt with that provider');
  assert.equal(service.get(link.id).status, 'open');
  service.applyProviderUpdate({ provider: 'globalpayments', reference: 'COR-1', amount: 1234, currency: 'eur', status: 'paid' });
  assert.equal(service.get(link.id).status, 'paid');
});

test('a confirmed payment is recorded even after the link expired locally', async () => {
  let now = new Date('2026-01-01T00:00:00Z');
  const fake = countingProviders();
  fake.release();
  const { service } = createApp(baseConfig({ providers: fake.providers }));
  service.now = () => now;
  const link = service.create({ amount: 100, currency: 'GBP', reference: 'LATE-1', expiresInHours: 1 });
  await service.startPayment(link.id, 'card');
  now = new Date('2026-01-01T02:00:00Z');
  assert.equal(service.get(link.id).status, 'expired');
  service.applyProviderUpdate({ provider: 'globalpayments', providerId: 'LNK_1', status: 'paid' });
  const after = service.get(link.id);
  assert.equal(after.status, 'paid');
  assert.equal(after.settledAfter, 'expired');
  // A late "failed" for the same session doesn't undo the success.
  service.applyProviderUpdate({ provider: 'globalpayments', providerId: 'LNK_1', status: 'failed' });
  assert.equal(service.get(link.id).attempts[0].status, 'succeeded');
});

test('a second successful session is flagged for refund', async () => {
  const fake = countingProviders();
  fake.release();
  const { service } = createApp(baseConfig({ providers: fake.providers }));
  const link = service.create({ amount: 100, currency: 'GBP', reference: 'DUP-1' });
  await service.startPayment(link.id, 'card');
  service.applyProviderUpdate({ provider: 'globalpayments', providerId: 'LNK_1', status: 'failed' });
  await service.startPayment(link.id, 'bank');
  service.applyProviderUpdate({ provider: 'openpayd', providerId: 'PI_1', status: 'paid' });
  // The "failed" card session later turns out to have been captured after all.
  service.applyProviderUpdate({ provider: 'globalpayments', providerId: 'LNK_1', status: 'paid' });
  const after = service.get(link.id);
  assert.equal(after.paidWith, 'openpayd');
  assert.equal(after.needsRefund, true);
});

test('cancel is refused while a provider session is open', async (t) => {
  const fake = countingProviders();
  fake.release();
  const app = await startApp({ providers: fake.providers });
  t.after(app.close);
  const busy = app.service.create({ amount: 100, currency: 'GBP', reference: 'CAN-1' });
  await app.service.startPayment(busy.id, 'card');
  const res = await fetch(`${app.url}/api/paylinks/${busy.id}/cancel`, { method: 'POST', headers: auth });
  assert.equal(res.status, 409);
  assert.equal(app.service.get(busy.id).status, 'open');

  const idle = app.service.create({ amount: 100, currency: 'GBP', reference: 'CAN-2' });
  const ok = await fetch(`${app.url}/api/paylinks/${idle.id}/cancel`, { method: 'POST', headers: auth });
  assert.equal((await ok.json()).status, 'cancelled');
});

test('GP preauthorisations are not treated as paid', () => {
  const gp = createGlobalPayments({ appKey: 'k' });
  assert.equal(gp.parseWebhook({ status: 'PREAUTHORIZED', link_data: { id: 'L' } }).status, null);
  assert.equal(gp.parseWebhook({ status: 'CAPTURED', link_data: { id: 'L' } }).status, 'paid');
});

test('methods must be an array', async (t) => {
  const app = await startApp();
  t.after(app.close);
  for (const methods of ['card', { length: 1 }, [], ['cash']]) {
    const res = await fetch(`${app.url}/api/paylinks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ amount: 100, currency: 'GBP', reference: `M-${Math.random().toString(36).slice(2, 8)}`, methods }),
    });
    assert.equal(res.status, 400, JSON.stringify(methods));
  }
});

test('a malformed request target returns 400 and the server keeps running', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const { port } = new URL(app.url);
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', (c) => { data += c; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  assert.equal((await fetch(`${app.url}/health`)).status, 200);
});
