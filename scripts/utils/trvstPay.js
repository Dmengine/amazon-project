// Where the TRVST PAY service (trvst-pay/) is running.
export const TRVST_PAY_URL = 'http://localhost:4242';

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
