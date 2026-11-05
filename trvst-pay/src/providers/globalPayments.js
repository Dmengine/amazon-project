import crypto from 'node:crypto';
import { requestJson, tokenCache, ProviderError } from './http.js';

const NAME = 'Global Payments';

// GP API (Unified Commerce Platform). Card payments are taken on a Global Payments hosted
// "Pay by Link" page, so card data never touches TRVST PAY.
export function createGlobalPayments(cfg) {
  const getToken = tokenCache(async () => {
    const nonce = new Date().toISOString();
    const secret = crypto.createHash('sha512').update(nonce + cfg.appKey).digest('hex');
    const data = await requestJson(NAME, `${cfg.baseUrl}/accesstoken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GP-Version': cfg.apiVersion },
      body: { app_id: cfg.appId, nonce, secret, grant_type: 'client_credentials' },
    });
    if (!data?.token) throw new ProviderError(NAME, 'access token missing from response', { body: data });
    return { value: data.token, expiresInSeconds: data.seconds_to_expire };
  });

  async function headers() {
    return {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json',
      'X-GP-Version': cfg.apiVersion,
    };
  }

  return {
    name: NAME,
    method: 'card',

    async createLink(paylink, urls) {
      const body = {
        account_name: cfg.accountName,
        type: 'PAYMENT',
        usage_mode: 'SINGLE',
        usage_limit: '1',
        reference: paylink.reference,
        name: paylink.description || paylink.reference,
        description: paylink.description || undefined,
        shippable: 'NO',
        expiration_date: paylink.expiresAt,
        transactions: {
          allowed_payment_methods: ['CARD'],
          channel: cfg.channel,
          country: cfg.country,
          amount: String(paylink.amount),
          currency: paylink.currency,
        },
        notifications: {
          return_url: urls.returnUrl,
          status_url: urls.webhookUrl,
          cancel_url: urls.cancelUrl,
        },
      };
      const data = await requestJson(NAME, `${cfg.baseUrl}/links`, {
        method: 'POST',
        headers: await headers(),
        body,
      });
      if (!data?.url) throw new ProviderError(NAME, 'link url missing from response', { body: data });
      return { providerId: data.id, url: data.url, status: data.status };
    },

    async getLink(linkId) {
      return requestJson(NAME, `${cfg.baseUrl}/links/${encodeURIComponent(linkId)}`, {
        headers: await headers(),
      });
    },

    // GP signs status_url callbacks: X-GP-Signature = SHA512(raw body + app key).
    verifyWebhook(rawBody, headers) {
      const signature = headers['x-gp-signature'];
      if (!signature) return false;
      const expected = crypto.createHash('sha512').update(rawBody + cfg.appKey).digest('hex');
      return safeEqual(signature, expected);
    },

    // Maps a GP transaction/link notification to a TRVST PAY status.
    parseWebhook(payload) {
      const linkId = payload?.link_data?.id || payload?.link_id || payload?.payment_method?.id;
      const status = String(payload?.status || payload?.action?.result_code || '').toUpperCase();
      let mapped = null;
      if (['CAPTURED', 'SUCCESS', 'COMPLETED', 'FUNDED', 'PREAUTHORIZED'].includes(status)) mapped = 'paid';
      else if (['DECLINED', 'FAILED', 'REJECTED'].includes(status)) mapped = 'failed';
      else if (['EXPIRED'].includes(status)) mapped = 'expired';
      return { linkId, reference: payload?.reference, transactionId: payload?.id, status: mapped };
    },
  };
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
