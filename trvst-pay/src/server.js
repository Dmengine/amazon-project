import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { PaylinkStore } from './store.js';
import { PaylinkService, ValidationError, publicView } from './paylinks.js';
import { createGlobalPayments, safeEqual } from './providers/globalPayments.js';
import { createOpenPayd } from './providers/openpayd.js';
import { createMockProviders } from './providers/mock.js';
import { ProviderError } from './providers/http.js';
import * as pages from './pages.js';
import { qrSvg, qrPng } from './qr.js';
import crypto from 'node:crypto';

const MAX_BODY = 64 * 1024;

export function createApp(config = loadConfig()) {
  const providers = config.providers || (config.mode === 'live'
    ? { globalPayments: createGlobalPayments(config.globalPayments), openpayd: createOpenPayd(config.openpayd) }
    : createMockProviders(config.publicUrl));
  const service = new PaylinkService({
    store: config.store || new PaylinkStore(config.storeFile),
    providers,
    publicUrl: config.publicUrl,
  });

  const routes = [
    ['OPTIONS', /^\/api\/.*$/, (req, res) => send(res, 204)],
    ['GET', /^\/health$/, (req, res) => json(res, 200, { ok: true, mode: config.mode })],

    // --- Merchant API ---
    ['POST', /^\/api\/paylinks$/, async (req, res) => {
      if (!authorised(req)) return json(res, 401, { error: 'unauthorised' });
      const paylink = service.create(parseJson(await readBody(req)));
      json(res, 201, publicView(paylink));
    }],
    ['GET', /^\/api\/paylinks\/([\w-]+)$/, (req, res, [id]) => {
      if (!authorised(req)) return json(res, 401, { error: 'unauthorised' });
      const paylink = service.get(id);
      return paylink ? json(res, 200, publicView(paylink)) : json(res, 404, { error: 'not found' });
    }],
    ['POST', /^\/api\/paylinks\/([\w-]+)\/cancel$/, (req, res, [id]) => {
      if (!authorised(req)) return json(res, 401, { error: 'unauthorised' });
      const paylink = service.cancel(id);
      return paylink ? json(res, 200, publicView(paylink)) : json(res, 404, { error: 'not found' });
    }],

    // --- Payer-facing hosted page ---
    ['GET', /^\/pay\/([\w-]+)$/, async (req, res, [id]) => {
      const paylink = service.get(id);
      if (!paylink) return html(res, 404, pages.notFound());
      const error = new URL(req.url, 'http://x').searchParams.get('error');
      const qr = paylink.status === 'open' ? await qrSvg(paylink.url) : null;
      html(res, 200, pages.payPage(paylink, error, qr));
    }],
    ['POST', /^\/pay\/([\w-]+)\/(card|bank)$/, async (req, res, [id, method]) => {
      try {
        redirect(res, await service.startPayment(id, method));
      } catch (error) {
        if (!(error instanceof ValidationError || error instanceof ProviderError)) throw error;
        console.error(`[trvst-pay] start ${method} payment for ${id}:`, error.message);
        const message = error instanceof ProviderError
          ? `We couldn't start the ${method === 'card' ? 'card' : 'bank'} payment. Please try again or choose another method.`
          : error.message;
        redirect(res, `/pay/${id}?error=${encodeURIComponent(message)}`);
      }
    }],
    ['GET', /^\/pay\/([\w-]+)\/return$/, (req, res, [id]) => {
      const paylink = service.get(id);
      if (!paylink) return html(res, 404, pages.notFound());
      html(res, 200, pages.returnPage(paylink));
    }],
    ['GET', /^\/pay\/([\w-]+)\/qr\.svg$/, async (req, res, [id]) => {
      const paylink = service.get(id);
      if (!paylink) return json(res, 404, { error: 'not found' });
      res.setHeader('Cache-Control', 'public, max-age=86400');
      send(res, 200, await qrSvg(paylink.url), 'image/svg+xml');
    }],
    ['GET', /^\/pay\/([\w-]+)\/qr\.png$/, async (req, res, [id]) => {
      const paylink = service.get(id);
      if (!paylink) return json(res, 404, { error: 'not found' });
      const size = new URL(req.url, 'http://x').searchParams.get('size');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      send(res, 200, await qrPng(paylink.url, size), 'image/png');
    }],
    ['GET', /^\/pay\/([\w-]+)\/share$/, async (req, res, [id]) => {
      const paylink = service.get(id);
      if (!paylink) return html(res, 404, pages.notFound());
      const nonce = crypto.randomBytes(16).toString('base64');
      html(res, 200, pages.sharePage(paylink, await qrSvg(paylink.url), nonce), nonce);
    }],
    ['GET', /^\/pay\/([\w-]+)\/status$/, (req, res, [id]) => {
      const paylink = service.get(id);
      if (!paylink) return json(res, 404, { error: 'not found' });
      json(res, 200, { id: paylink.id, status: paylink.status, paidWith: paylink.paidWith || null });
    }],

    // --- Provider webhooks ---
    ['POST', /^\/webhooks\/globalpayments$/, async (req, res) => {
      const raw = await readBody(req);
      if (!providers.globalPayments.verifyWebhook(raw, req.headers)) return json(res, 401, { error: 'bad signature' });
      const update = providers.globalPayments.parseWebhook(parseJson(raw));
      const paylink = service.applyProviderUpdate({
        provider: 'globalpayments', providerId: update.linkId, reference: update.reference,
        status: update.status, transactionId: update.transactionId,
      });
      json(res, 200, { received: true, matched: Boolean(paylink) });
    }],
    ['POST', /^\/webhooks\/openpayd$/, async (req, res) => {
      const raw = await readBody(req);
      const verified = providers.openpayd.verifyWebhook(raw, req.headers);
      if (verified === false) return json(res, 401, { error: 'bad signature' });
      let update = providers.openpayd.parseWebhook(parseJson(raw));
      if (verified === null) {
        // No shared secret: don't trust the body, read the PayIn back from OpenPayd.
        if (!update.payinId) return json(res, 400, { error: 'missing pay-in id' });
        const payin = await providers.openpayd.getPayIn(update.payinId);
        update = { payinId: update.payinId, reference: payin?.reference, status: providers.openpayd.mapStatus(payin?.status) };
      }
      const paylink = service.applyProviderUpdate({
        provider: 'openpayd', providerId: update.payinId, reference: update.reference, status: update.status,
      });
      json(res, 200, { received: true, matched: Boolean(paylink) });
    }],
  ];

  if (config.mode === 'mock') {
    routes.push(
      ['GET', /^\/mock\/(card|bank)\/([\w-]+)$/, (req, res, [kind, id]) => {
        const paylink = service.get(id);
        if (!paylink) return html(res, 404, pages.notFound());
        html(res, 200, pages.mockProviderPage(paylink, kind));
      }],
      ['POST', /^\/mock\/(card|bank)\/([\w-]+)\/(paid|failed)$/, (req, res, [kind, id, outcome]) => {
        const paylink = service.get(id);
        const attempt = paylink?.attempts.find((a) => a.method === kind && a.status === 'pending');
        if (attempt) {
          service.applyProviderUpdate({ provider: attempt.provider, providerId: attempt.providerId, status: outcome });
        }
        redirect(res, `/pay/${id}/return?method=${kind}`);
      }],
    );
  }

  function authorised(req) {
    if (!config.apiKey) return true;
    const header = req.headers.authorization || '';
    return safeEqual(header, `Bearer ${config.apiKey}`);
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname.startsWith('/api/') || /^\/pay\/[\w-]+\/status$/.test(pathname)) cors(req, res);
    try {
      for (const [method, pattern, handler] of routes) {
        const match = req.method === method && pathname.match(pattern);
        if (match) return await handler(req, res, match.slice(1));
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof ValidationError) return json(res, 400, { error: error.message });
      if (error instanceof ProviderError) {
        console.error('[trvst-pay]', error.message);
        return json(res, 502, { error: error.message });
      }
      if (error.status) return json(res, error.status, { error: error.message });
      console.error('[trvst-pay] unexpected error', error);
      json(res, 500, { error: 'internal error' });
    }
  });

  return { server, service };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ValidationError('body must be valid JSON');
  }
}

function send(res, status, body = '', type) {
  res.statusCode = status;
  if (type) res.setHeader('Content-Type', type);
  res.end(body);
}
const json = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json');
function html(res, status, body, nonce) {
  const script = nonce ? ` script-src 'nonce-${nonce}';` : '';
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline';${script} form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'`);
  send(res, status, body, 'text/html; charset=utf-8');
}
function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.end();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const { server } = createApp(config);
  server.listen(config.port, () => {
    console.log(`TRVST PAY listening on ${config.publicUrl} (mode: ${config.mode})`);
  });
}
