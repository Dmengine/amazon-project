// Where the TRVST PAY service (trvst-pay/) is running: the separate local server during
// development, or the same origin when the storefront and service are deployed together.
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port !== '4242';
export const TRVST_PAY_URL = isLocal ? 'http://localhost:4242' : window.location.origin;

// Creates a TRVST PAY paylink for an order total and returns it ({ id, url, ... }).
// Dev only: in production the merchant's own backend should create paylinks with its
// API key, so the key never reaches the browser.
export async function createPaylink({ amountCents, currency = 'USD', reference, description }) {
  const response = await fetch(`${TRVST_PAY_URL}/api/paylinks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(amountCents),
      currency,
      reference,
      description,
      returnUrl: new URL('orders.html', window.location.href).href,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `TRVST PAY returned ${response.status}`);
  }
  return data;
}

// Public status of a paylink: { id, status: 'open' | 'paid' | 'expired' | 'cancelled', paidWith }.
export async function getPaylinkStatus(id) {
  const response = await fetch(`${TRVST_PAY_URL}/pay/${encodeURIComponent(id)}/status`);
  if (!response.ok) {
    throw new Error(`TRVST PAY returned ${response.status}`);
  }
  return response.json();
}

// Renders a "pay by button or QR code" panel into `container` and polls until the paylink is paid,
// then calls onPaid. Returns a stop() function that cancels the polling.
export function showPaylinkPanel(container, paylink, { onPaid, intervalMs = 3000 } = {}) {
  container.innerHTML = `
    <div class="trvst-pay-panel">
      <div class="trvst-pay-title">Scan to pay with your phone</div>
      <img class="trvst-pay-qr" src="${paylink.qrCodeUrl}" width="180" height="180"
        alt="QR code for the TRVST PAY payment link">
      <a class="trvst-pay-open button-primary" href="${paylink.url}">
        Pay in this browser
      </a>
      <div class="trvst-pay-status js-trvst-pay-status" role="status">
        Waiting for payment…
      </div>
    </div>
  `;
  const statusEl = container.querySelector('.js-trvst-pay-status');

  let stopped = false;
  async function poll() {
    if (stopped) return;
    try {
      const { status } = await getPaylinkStatus(paylink.id);
      if (status === 'paid') {
        statusEl.textContent = 'Payment received ✓';
        onPaid?.(paylink);
        return;
      }
      if (status !== 'open') {
        statusEl.textContent = `This payment link is ${status}.`;
        return;
      }
    } catch {
      // Network blip: keep polling.
    }
    setTimeout(poll, intervalMs);
  }
  setTimeout(poll, intervalMs);
  return () => { stopped = true; };
}
