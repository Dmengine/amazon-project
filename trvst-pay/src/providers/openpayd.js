import crypto from 'node:crypto';
import { requestJson, tokenCache, ProviderError } from './http.js';
import { safeEqual } from './globalPayments.js';

const NAME = 'OpenPayd';

// OpenPayd: OAuth client-credentials login, then a PayIn (open banking) that returns a bank
// authorisation URL the payer is redirected to.
export function createOpenPayd(cfg) {
  let accountHolderId = cfg.accountHolderId;

  const getToken = tokenCache(async () => {
    const basic = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    const data = await requestJson(NAME, `${cfg.baseUrl}${cfg.tokenPath}?grant_type=client_credentials`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!data?.access_token) throw new ProviderError(NAME, 'access_token missing from response', { body: data });
    if (!accountHolderId && data.accountHolderId) accountHolderId = data.accountHolderId;
    return { value: data.access_token, expiresInSeconds: data.expires_in };
  });

  async function headers() {
    const token = await getToken();
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (accountHolderId) h['x-account-holder-id'] = accountHolderId;
    return h;
  }

  return {
    name: NAME,
    method: 'bank',

    async createPayIn(paylink, urls) {
      const body = {
        accountId: cfg.accountId,
        amount: { value: (paylink.amount / 100).toFixed(2), currency: paylink.currency },
        reference: paylink.reference,
        description: paylink.description || undefined,
        redirectUrl: urls.returnUrl,
        callbackUrl: urls.webhookUrl,
        payer: paylink.customer?.name || paylink.customer?.email
          ? { name: paylink.customer?.name, email: paylink.customer?.email }
          : undefined,
      };
      const data = await requestJson(NAME, `${cfg.baseUrl}${cfg.payinPath}`, {
        method: 'POST',
        headers: await headers(),
        body,
      });
      const url = data?.authorisationUrl || data?.authorizationUrl || data?.redirectUrl || data?.paymentUrl || data?.url;
      if (!url) throw new ProviderError(NAME, 'bank authorisation URL missing from PayIn response', { body: data });
      return { providerId: data.id || data.payinId || data.transactionId, url, status: data.status };
    },

    async getPayIn(payinId) {
      return requestJson(NAME, `${cfg.baseUrl}${cfg.payinPath}/${encodeURIComponent(payinId)}`, {
        headers: await headers(),
      });
    },

    // Verified with a shared secret: hex HMAC-SHA256 of the raw body in X-Signature.
    // Without a secret the handler re-reads the PayIn from OpenPayd instead of trusting the body.
    verifyWebhook(rawBody, headers) {
      if (!cfg.webhookSecret) return null;
      const signature = headers['x-signature'] || headers['x-openpayd-signature'];
      if (!signature) return false;
      const expected = crypto.createHmac('sha256', cfg.webhookSecret).update(rawBody).digest('hex');
      return safeEqual(signature, expected);
    },

    parseWebhook(payload) {
      return {
        payinId: payload?.id || payload?.payinId || payload?.transactionId,
        reference: payload?.reference,
        status: mapStatus(payload?.status),
      };
    },

    mapStatus,
  };
}

function mapStatus(status) {
  const s = String(status || '').toUpperCase();
  if (['COMPLETED', 'SETTLED', 'PROCESSED', 'SUCCESS', 'EXECUTED'].includes(s)) return 'paid';
  if (['FAILED', 'REJECTED', 'CANCELLED', 'DECLINED'].includes(s)) return 'failed';
  if (['EXPIRED'].includes(s)) return 'expired';
  return null;
}
