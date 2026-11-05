// Vercel Function entry point for the TRVST PAY service. vercel.json rewrites /api/*, /pay/*,
// /webhooks/*, /mock/* and /health here; req.url keeps the original path, so the service's own
// router handles them exactly as the standalone server does.
import { createApp } from '../trvst-pay/src/server.js';

let app;
let startupError;

export default async function handler(req, res) {
  if (!app && !startupError) {
    try {
      app = createApp();
    } catch (error) {
      startupError = error;
    }
  }
  if (startupError) {
    console.error('[trvst-pay] failed to start:', startupError.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'TRVST PAY is not configured', detail: startupError.message }));
    return;
  }
  return app.handler(req, res);
}
