const env = process.env;

const list = (value) =>
  (value || '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(overrides = {}) {
  const config = {
    port: Number(env.PORT || 4242),
    publicUrl: (env.TRVST_PAY_PUBLIC_URL || 'http://localhost:4242').replace(/\/$/, ''),
    allowedOrigins: list(env.TRVST_PAY_ALLOWED_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500'),
    mode: env.TRVST_PAY_MODE === 'live' ? 'live' : 'mock',
    storeFile: env.TRVST_PAY_STORE_FILE || './data/paylinks.json',
    apiKey: env.TRVST_PAY_API_KEY || '',

    openpayd: {
      baseUrl: (env.OPENPAYD_BASE_URL || 'https://sandbox.openpayd.com').replace(/\/$/, ''),
      username: env.OPENPAYD_USERNAME || '',
      password: env.OPENPAYD_PASSWORD || '',
      accountHolderId: env.OPENPAYD_ACCOUNT_HOLDER_ID || '',
      accountId: env.OPENPAYD_ACCOUNT_ID || '',
      tokenPath: env.OPENPAYD_TOKEN_PATH || '/api/oauth/token',
      payinPath: env.OPENPAYD_PAYIN_PATH || '/api/transactions/open-banking/payins',
      webhookSecret: env.OPENPAYD_WEBHOOK_SECRET || '',
    },

    globalPayments: {
      baseUrl: (env.GP_BASE_URL || 'https://apis.sandbox.globalpay.com/ucp').replace(/\/$/, ''),
      appId: env.GP_APP_ID || '',
      appKey: env.GP_APP_KEY || '',
      apiVersion: env.GP_API_VERSION || '2021-03-22',
      accountName: env.GP_ACCOUNT_NAME || 'transaction_processing',
      channel: env.GP_CHANNEL || 'CNP',
      country: env.GP_COUNTRY || 'GB',
    },
    ...overrides,
  };

  if (config.mode === 'live') {
    const missing = [];
    if (!config.openpayd.username) missing.push('OPENPAYD_USERNAME');
    if (!config.openpayd.password) missing.push('OPENPAYD_PASSWORD');
    if (!config.openpayd.accountId) missing.push('OPENPAYD_ACCOUNT_ID');
    if (!config.globalPayments.appId) missing.push('GP_APP_ID');
    if (!config.globalPayments.appKey) missing.push('GP_APP_KEY');
    if (missing.length) {
      throw new Error(`TRVST_PAY_MODE=live but these are not set: ${missing.join(', ')}`);
    }
  }
  return config;
}
