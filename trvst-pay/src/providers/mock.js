// Offline stand-ins for the two providers. The "hosted page" is a TRVST PAY route that simulates
// the payer finishing the payment, so the whole flow can be tried without credentials.
export function createMockProviders(publicUrl) {
  const simulate = (kind) => async (paylink) => ({
    providerId: `mock_${kind}_${paylink.id}`,
    url: `${publicUrl}/mock/${kind}/${paylink.id}`,
    status: 'ACTIVE',
  });

  return {
    globalPayments: {
      name: 'Global Payments (mock)',
      method: 'card',
      createLink: simulate('card'),
      verifyWebhook: () => true,
      parseWebhook: (p) => ({ linkId: p.linkId, status: p.status }),
    },
    openpayd: {
      name: 'OpenPayd (mock)',
      method: 'bank',
      createPayIn: simulate('bank'),
      getPayIn: async (id) => ({ id, status: 'PENDING' }),
      verifyWebhook: () => true,
      parseWebhook: (p) => ({ payinId: p.payinId, status: p.status }),
      mapStatus: (s) => s,
    },
  };
}
