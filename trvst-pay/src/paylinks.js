import crypto from 'node:crypto';
import { buttonHtml } from './pages.js';

export const CURRENCIES = new Set(['GBP', 'EUR', 'USD']);
export class ValidationError extends Error {
  status = 400;
}

export class ConflictError extends ValidationError {
  status = 409;
}

// A TRVST PAY paylink is one shareable URL. The payer picks card (Global Payments) or bank
// (OpenPayd PayIn) on the TRVST PAY page; the provider session is created only at that point.
export class PaylinkService {
  constructor({ store, providers, publicUrl, now = () => new Date() }) {
    this.store = store;
    this.providers = providers;
    this.publicUrl = publicUrl;
    this.now = now;
    // Provider sessions being created right now, per paylink, so a double-click or a second tab
    // waits for the first request instead of opening a second chargeable session.
    this.inflight = new Map();
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
    const methods = input.methods === undefined || input.methods === null ? ['card', 'bank'] : input.methods;
    if (!Array.isArray(methods) || methods.length === 0 || !methods.every((m) => m === 'card' || m === 'bank')) {
      throw new ValidationError('methods must be a non-empty array containing only "card" and/or "bank"');
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

  // The provider session the payer has already opened and not finished, if any.
  pendingAttempt(paylink) {
    return paylink.attempts.find((a) => a.status === 'pending') || null;
  }

  // Starts (or reuses) a provider session and returns the URL to redirect the payer to.
  // A paylink has at most one payable provider session at a time: while one is pending the payer
  // can only continue it, so they can't end up paying by card and by bank.
  async startPayment(id, method) {
    const running = this.inflight.get(id);
    if (running) {
      const result = await running.catch(() => null);
      if (result?.method === method) return result.url;
    }

    const paylink = this.get(id);
    if (!paylink) throw new ValidationError('paylink not found');
    if (paylink.status !== 'open') throw new ValidationError(`paylink is ${paylink.status}`);
    if (!paylink.methods.includes(method)) throw new ValidationError(`${method} is not enabled for this paylink`);

    const pending = this.pendingAttempt(paylink);
    if (pending) {
      if (pending.method === method) return pending.url;
      throw new ConflictError(
        `A ${pending.method} payment is already in progress for this link. Finish it, or ask the merchant for a new link.`);
    }

    const work = this.#createSession(paylink, method);
    this.inflight.set(id, work);
    try {
      return (await work).url;
    } finally {
      this.inflight.delete(id);
    }
  }

  async #createSession(paylink, method) {
    const urls = {
      returnUrl: `${this.publicUrl}/pay/${paylink.id}/return?method=${method}`,
      cancelUrl: `${this.publicUrl}/pay/${paylink.id}`,
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
    return { method, url: session.url };
  }

  // Finds the paylink and attempt a provider event belongs to. Events are matched on the provider
  // session ID we recorded. Only when the event carries no session ID at all do we fall back to the
  // reference, and then the amount and currency must match too.
  #correlate({ provider, providerId, reference, amount, currency }) {
    if (providerId) {
      const paylink = this.store.findBy((p) =>
        p.attempts.some((a) => a.provider === provider && a.providerId === providerId));
      if (!paylink) return null;
      return { paylink, attempt: paylink.attempts.find((a) => a.provider === provider && a.providerId === providerId) };
    }
    if (!reference) return null;
    const paylink = this.store.findBy((p) => p.reference === reference);
    if (!paylink || paylink.amount !== Number(amount) || paylink.currency !== String(currency || '').toUpperCase()) {
      return null;
    }
    const candidates = paylink.attempts.filter((a) => a.provider === provider);
    return candidates.length === 1 ? { paylink, attempt: candidates[0] } : null;
  }

  // Applies a provider status update. Returns the paylink, or null if the event matched nothing.
  applyProviderUpdate(update) {
    const match = this.#correlate(update);
    if (!match) return null;
    const { paylink, attempt } = match;
    const { provider, status, transactionId } = update;
    if (!status) return paylink;

    // A confirmed success is final for that attempt; a late "failed" must not overwrite it.
    if (attempt.status !== 'succeeded') attempt.status = status === 'paid' ? 'succeeded' : status;
    if (transactionId) attempt.transactionId = transactionId;

    if (status === 'paid' && attempt.status === 'succeeded') {
      if (paylink.status === 'paid' && paylink.paidAttempt !== attempt.providerId) {
        // Money arrived twice for one link. Flag it so the merchant can refund one of them.
        attempt.duplicate = true;
        paylink.needsRefund = true;
      } else if (paylink.status !== 'paid') {
        // Funds that were confirmed by the provider are recorded even if the link has since
        // expired or been cancelled locally, so the merchant sees the money and can act on it.
        if (paylink.status !== 'open') paylink.settledAfter = paylink.status;
        paylink.status = 'paid';
        paylink.paidAt = this.now().toISOString();
        paylink.paidWith = provider;
        paylink.paidAttempt = attempt.providerId;
      }
    }
    return this.store.save(paylink);
  }

  // Cancels an open link. Refused while the payer has a provider session open, because that
  // session could still take money after we report the link cancelled.
  cancel(id) {
    const paylink = this.get(id);
    if (!paylink) return null;
    if (paylink.status !== 'open') return paylink;
    const pending = this.pendingAttempt(paylink);
    if (pending) {
      throw new ConflictError(
        `a ${pending.method} payment is in progress with ${pending.provider}; it can't be cancelled until that session completes, fails or the link expires`);
    }
    paylink.status = 'cancelled';
    return this.store.save(paylink);
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
    settledAfter: p.settledAfter || null,
    needsRefund: Boolean(p.needsRefund),
    qrCodeUrl: `${p.url}/qr.svg`,
    qrCodePngUrl: `${p.url}/qr.png`,
    shareUrl: `${p.url}/share`,
    buttonHtml: buttonHtml(p),
    attempts: p.attempts.map(({ method, provider, providerId, status, createdAt, duplicate }) =>
      ({ method, provider, providerId, status, createdAt, duplicate: Boolean(duplicate) })),
  };
}
