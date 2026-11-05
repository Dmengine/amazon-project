const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function formatAmount(amount, currency) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount / 100);
}

function layout(title, body, { refresh } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)} · TRVST PAY</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --ink:#14171f; --muted:#5d6472; --line:#e3e6ea; --brand:#0f5c4c; --brand-ink:#fff; --bad:#a3261f; --good:#17663a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b22; --ink:#eef0f3; --muted:#a2a9b5; --line:#2a2f39; --brand:#3fb592; --brand-ink:#08130f; --bad:#ff8a80; --good:#6fdc9c; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:440px; margin:48px auto; padding:0 16px; }
  .brand { font-weight:700; letter-spacing:.08em; font-size:13px; color:var(--muted); margin-bottom:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  .amount { font-size:34px; font-weight:700; margin:4px 0 2px; font-variant-numeric: tabular-nums; }
  .muted { color:var(--muted); font-size:14px; }
  form { margin:0; }
  button { width:100%; margin-top:12px; padding:14px 16px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); font:inherit; font-weight:600; cursor:pointer; text-align:left; }
  button.primary { background:var(--brand); color:var(--brand-ink); border-color:var(--brand); }
  button small { display:block; font-weight:400; opacity:.8; font-size:13px; }
  .error { color:var(--bad); background:color-mix(in srgb, var(--bad) 10%, transparent); padding:10px 12px; border-radius:8px; font-size:14px; margin-top:16px; }
  .ok { color:var(--good); }
  .bad { color:var(--bad); }
  a { color:var(--brand); }
  hr { border:0; border-top:1px solid var(--line); margin:20px 0 8px; }
  .center { text-align:center; }
  details { margin-top:16px; } summary { cursor:pointer; }
  .qr { width:220px; max-width:100%; margin:12px auto 0; padding:8px; background:#fff; border-radius:8px; }
  .qr svg { display:block; width:100%; height:auto; }
  a.button { display:block; text-align:center; text-decoration:none; padding:14px 16px; border-radius:8px; font-weight:600; margin-top:12px; }
  a.button.primary { background:var(--brand); color:var(--brand-ink); }
  label { display:block; font-size:14px; font-weight:600; margin:20px 0 6px; }
  .row { display:flex; gap:8px; }
  input, textarea { width:100%; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); font:13px/1.4 ui-monospace, Menlo, monospace; }
  textarea { resize:vertical; }
  button.copy { width:auto; margin-top:0; padding:8px 14px; text-align:center; white-space:nowrap; }
  textarea + button.copy { margin-top:8px; }
</style>
</head>
<body><main><div class="brand">TRVST PAY</div>${body}</main></body>
</html>`;
}

function summary(p) {
  return `<div class="muted">Pay ${p.description ? esc(p.description) : 'merchant'}</div>
  <div class="amount">${esc(formatAmount(p.amount, p.currency))}</div>
  <div class="muted">Reference ${esc(p.reference)}</div>`;
}

export function payPage(p, error, qrSvgMarkup) {
  if (p.status === 'paid') return returnPage(p);
  if (p.status !== 'open') {
    return layout('Link unavailable', `<div class="card">${summary(p)}<hr>
      <p class="bad">This payment link has ${esc(p.status)}.</p><p class="muted">Ask the merchant for a new link.</p></div>`);
  }
  const card = p.methods.includes('card') ? `
    <form method="post" action="/pay/${esc(p.id)}/card">
      <button class="primary" type="submit">Pay by card<small>Visa, Mastercard, Amex · secured by Global Payments</small></button>
    </form>` : '';
  const bank = p.methods.includes('bank') ? `
    <form method="post" action="/pay/${esc(p.id)}/bank">
      <button class="${card ? '' : 'primary'}" type="submit">Pay by bank<small>Approve in your banking app · via OpenPayd</small></button>
    </form>` : '';
  return layout(`Pay ${formatAmount(p.amount, p.currency)}`, `<div class="card">${summary(p)}
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <hr>${card}${bank}
    ${qrSvgMarkup ? `<details><summary class="muted">Pay on your phone instead</summary>
      <div class="qr" role="img" aria-label="QR code for this payment link">${qrSvgMarkup}</div>
      <p class="muted center">Scan with your phone camera</p></details>` : ''}
    <p class="muted">Link expires ${esc(new Date(p.expiresAt).toUTCString())}.</p></div>`);
}

export function returnPage(p) {
  if (p.status === 'paid') {
    return layout('Payment received', `<div class="card">${summary(p)}<hr>
      <p class="ok"><strong>Payment received.</strong> Thank you.</p>
      ${p.returnUrl ? `<p><a href="${esc(p.returnUrl)}">Return to merchant</a></p>` : ''}</div>`);
  }
  const lastAttempt = p.attempts.at(-1);
  if (lastAttempt?.status === 'failed') {
    return layout('Payment not completed', `<div class="card">${summary(p)}<hr>
      <p class="bad">The payment was not completed.</p>
      <p><a href="/pay/${esc(p.id)}">Try again</a></p></div>`);
  }
  if (p.status !== 'open') return payPage(p);
  return layout('Confirming payment', `<div class="card">${summary(p)}<hr>
    <p>We're confirming your payment with the provider. This page refreshes automatically.</p>
    <p class="muted"><a href="/pay/${esc(p.id)}">Back to payment options</a></p></div>`, { refresh: 5 });
}

export function mockProviderPage(p, kind) {
  const label = kind === 'card' ? 'Global Payments card page (mock)' : 'OpenPayd bank authorisation (mock)';
  return layout(label, `<div class="card"><div class="muted">${label}</div>
    <div class="amount">${esc(formatAmount(p.amount, p.currency))}</div><hr>
    <form method="post" action="/mock/${kind}/${esc(p.id)}/paid"><button class="primary">Simulate successful payment</button></form>
    <form method="post" action="/mock/${kind}/${esc(p.id)}/failed"><button>Simulate failed payment</button></form></div>`);
}

// Self-contained HTML a merchant can paste into a website or HTML email: a pay button plus the
// QR code image. Inline styles only, so it renders the same in email clients.
export function buttonHtml(p) {
  const label = `Pay ${formatAmount(p.amount, p.currency)} with TRVST PAY`;
  return `<div style="display:inline-block;text-align:center;font-family:Arial,Helvetica,sans-serif">` +
    `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="display:inline-block;background:#0f5c4c;color:#ffffff;` +
    `text-decoration:none;font-weight:bold;font-size:16px;padding:12px 22px;border-radius:8px">${esc(label)}</a>` +
    `<br><img src="${esc(p.url)}/qr.png" width="160" height="160" alt="QR code: scan to pay ${esc(formatAmount(p.amount, p.currency))}" style="margin-top:10px">` +
    `<div style="font-size:12px;color:#5d6472">Scan to pay on your phone</div></div>`;
}

export function sharePage(p, qrSvgMarkup, nonce) {
  const amount = formatAmount(p.amount, p.currency);
  const unavailable = p.status !== 'open'
    ? `<p class="${p.status === 'paid' ? 'ok' : 'bad'}">This link is ${esc(p.status)}.</p>` : '';
  return layout(`Share ${amount} paylink`, `<div class="card">${summary(p)}${unavailable}<hr>
    <div class="qr" aria-label="QR code: scan to pay ${esc(amount)}" role="img">${qrSvgMarkup}</div>
    <p class="muted center">Scan with a phone camera to pay</p>
    <a class="button primary" href="${esc(p.url)}" target="_blank" rel="noopener">Pay ${esc(amount)} with TRVST PAY</a>

    <label for="link">Payment link</label>
    <div class="row"><input id="link" readonly value="${esc(p.url)}"><button type="button" class="copy" data-copy="link">Copy</button></div>

    <label for="embed">Button + QR code for your website or email</label>
    <textarea id="embed" readonly rows="5">${esc(buttonHtml(p))}</textarea>
    <button type="button" class="copy" data-copy="embed">Copy embed code</button>

    <p class="muted">Download QR code:
      <a href="/pay/${esc(p.id)}/qr.svg" download="trvst-pay-${esc(p.reference)}.svg">SVG</a> ·
      <a href="/pay/${esc(p.id)}/qr.png?size=1024" download="trvst-pay-${esc(p.reference)}.png">PNG</a></p>
  </div>
  <script nonce="${nonce}">
    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', async () => {
        const field = document.getElementById(button.dataset.copy);
        try { await navigator.clipboard.writeText(field.value); }
        catch { field.select(); document.execCommand('copy'); }
        const text = button.textContent;
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = text; }, 1500);
      });
    }
  </script>`);
}

export function notFound() {
  return layout('Not found', '<div class="card"><p>This payment link does not exist.</p></div>');
}
