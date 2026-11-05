import crypto from 'node:crypto';
import { buttonHtml } from './pages.js';

export const CURRENCIES = new Set(['GBP', 'EUR', 'USD']);
const FINAL = new Set(['paid', 'expired', 'cancelled']);

export class ValidationError extends Error {}

// A TRVST PAY paylink is one shareable URL. The payer picks card (Global Payments) or bank
// (OpenPayd PayIn) on the TRVST PAY page; the provider session is created only at that point.
export class PaylinkService {
  constructor({ store, providers, publicUrl, now = () => new Date() }) {
    this.store = store;
    this.providers = providers;
    this.publicUrl = publicUrl;
    this.now = now;
  }

  create(input) {
    const amount = Number(input?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ValidationError('amount must be a positive integer in minor units (e.g. 1999 for 19.99)');
    }
    const currency = String(input.currency || '').toUpperCase();
    if (!CURRENCIES.has(currency)) {
      throw new ValidationError(`currency must be one of ${[...CURRENCIES].join(', ')}`);
    }
    const reference = String(input.reference || '').trim();
    if (!/^[A-Za-z0-9\-_.]{1,35}$/.test(reference)) {
      throw new ValidationError('reference is required: 1-35 letters, digits, - _ or .');
    }
    if (this.store.findBy((p) => p.reference === reference)) {
      throw new ValidationError(`a paylink with reference ${reference} already exists`);
    }
    const methods = input.methods?.length ? input.methods : ['card', 'bank'];
    if (!methods.every((m) => m === 'card' || m === 'bank')) {
      throw new ValidationError('methods may only contain "card" and "bank"');
    }
    const hours = Number(input.expiresInHours ?? 72);
    if (!(hours > 0 && hours <= 24 * 30)) throw new ValidationError('expiresInHours must be between 0 and 720');

    if (input.returnUrl && !/^https?:\/\//i.test(String(input.returnUrl))) {
      throw new ValidationError('returnUrl must be an http(s) URL');
    }

    const id = `pl_${crypto.randomBytes(12).toString('base64url')}`;
    const created = this.now();
    const paylink = {
      id,
      reference,
      amount,
      currency,
      description: String(input.description || '').slice(0, 140),
      customer: input.customer ? { name: input.customer.name, email: input.customer.email } : null,
      methods,
      returnUrl: input.returnUrl || null,
      status: 'open',
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + hours * 3600_000).toISOString(),
      attempts: [],
      url: `${this.publicUrl}/pay/${id}`,
    };
    return this.store.save(paylink);
  }

  get(id) {
    const paylink = this.store.get(id);
    if (paylink && paylink.status === 'open' && new Date(paylink.expiresAt) <= this.now()) {
      paylink.status = 'expired';
      this.store.save(paylink);
    }
    return paylink;
  }

  // Starts (or reuses) a provider session and returns the URL to redirect the payer to.
  async startPayment(id, method) {
    const paylink = this.get(id);
    if (!paylink) throw new ValidationError('paylink not found');
    if (paylink.status !== 'open') throw new ValidationError(`paylink is ${paylink.status}`);
    if (!paylink.methods.includes(method)) throw new ValidationError(`${method} is not enabled for this paylink`);

    const existing = paylink.attempts.find((a) => a.method === method && a.status === 'pending');
    if (existing) return existing.url;

    const urls = {
      returnUrl: `${this.publicUrl}/pay/${id}/return?method=${method}`,
      cancelUrl: `${this.publicUrl}/pay/${id}`,
      webhookUrl: `${this.publicUrl}/webhooks/${method === 'card' ? 'globalpayments' : 'openpayd'}`,
    };
    const session = method === 'card'
      ? await this.providers.globalPayments.createLink(paylink, urls)
      : await this.providers.openpayd.createPayIn(paylink, urls);

    paylink.attempts.push({
      method,
      provider: method === 'card' ? 'globalpayments' : 'openpayd',
      providerId: session.providerId,
      url: session.url,
      status: 'pending',
      createdAt: this.now().toISOString(),
    });
    this.store.save(paylink);
    return session.url;
  }

  // Applies a provider status update. Returns the paylink, or null if nothing matched.
  applyProviderUpdate({ provider, providerId, reference, status, transactionId }) {
    const paylink = this.store.findBy((p) =>
      p.attempts.some((a) => a.provider === provider && a.providerId === providerId) ||
      (reference && p.reference === reference));
    if (!paylink) return null;
    if (!status) return paylink;

    const attempt = paylink.attempts.find((a) => a.provider === provider && (!providerId || a.providerId === providerId));
    if (attempt) {
      attempt.status = status === 'paid' ? 'succeeded' : status;
      if (transactionId) attempt.transactionId = transactionId;
    }
    if (!FINAL.has(paylink.status) && status === 'paid') {
      paylink.status = 'paid';
      paylink.paidAt = this.now().toISOString();
      paylink.paidWith = provider;
    }
    return this.store.save(paylink);
  }

  cancel(id) {
    const paylink = this.get(id);
    if (!paylink) return null;
    if (paylink.status === 'open') {
      paylink.status = 'cancelled';
      this.store.save(paylink);
    }
    return paylink;
  }
}

export function publicView(p) {
  return {
    id: p.id,
    url: p.url,
    reference: p.reference,
    amount: p.amount,
    currency: p.currency,
    description: p.description,
    methods: p.methods,
    status: p.status,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    paidAt: p.paidAt || null,
    paidWith: p.paidWith || null,
    qrCodeUrl: `${p.url}/qr.svg`,
    qrCodePngUrl: `${p.url}/qr.png`,
    shareUrl: `${p.url}/share`,
    buttonHtml: buttonHtml(p),
    attempts: p.attempts.map(({ method, provider, providerId, status, createdAt }) =>
      ({ method, provider, providerId, status, createdAt })),
  };
}
