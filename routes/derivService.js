// Service Deriv Payment Agent API — manatanteraka ny transfert dériv
// DEPOT: agent -> client (POST /payment-agents/v1/transfer)
// RETRAIT: client withdraw -> agent (POST /payment-agents/v1/withdraw)
const { getDerivConfig } = require('./deriv');

const BASE_URL = 'https://api.derivws.com';

async function derivFetch(path, method, body, cfg) {
  const url = BASE_URL + path;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Deriv-App-ID': cfg.deriv_app_id,
      'Authorization': 'Bearer ' + cfg.deriv_token
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.errors?.[0]?.detail?.message || data?.errors?.[0]?.code || ('HTTP ' + res.status);
    throw new Error(errMsg);
  }
  return data;
}

// DEPOT: rehefa client mandefa Mobile Money mankany amin'ny numero gateway
// ary backend validé -- mandefa "deriv" (transfer) mankany amin'ny CR client.
async function derivTransferToClient(crClient, montant) {
  const cfg = await getDerivConfig();
  if (!cfg.deriv_app_id || !cfg.deriv_token) {
    throw new Error('Configuration API Deriv tsy feno (App ID / Token)');
  }
  return derivFetch('/payment-agents/v1/transfer', 'POST', {
    transfer_to: crClient,
    amount: montant,
    currency: 'USD' // FIXME: ovaina raha mila devise hafa
  }, cfg);
}

// RETRAIT: client mandefa "deriv" amin'ny CR agent (fixe). Backend mizaha
// ny statut amin'ny request_id mba hahafantarana raha tonga ny vola.
async function derivCheckWithdrawStatus(requestId) {
  const cfg = await getDerivConfig();
  if (!cfg.deriv_app_id || !cfg.deriv_token) {
    throw new Error('Configuration API Deriv tsy feno (App ID / Token)');
  }
  return derivFetch('/payment-agents/v1/withdraw/' + requestId, 'GET', null, cfg);
}

module.exports = { derivTransferToClient, derivCheckWithdrawStatus, getDerivConfig };
