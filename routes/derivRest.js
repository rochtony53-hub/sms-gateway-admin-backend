// Service Deriv — Payment Agent REST API (https://api.derivws.com/payment-agents/v1)
// Remplace l'ancien WebSocket paymentagent_withdraw. Scope OAuth requis : "payment".
const { getDerivConfig } = require('./deriv');

const BASE = process.env.DERIV_REST_BASE || 'https://api.derivws.com';

// Appel REST générique. Renvoie data ; lève une Error (avec .code) si erreur.
async function restCall(method, path, token, appId, body) {
  if (!appId || !token) throw new Error('Config Deriv incomplète (App ID / Token)');
  const headers = {
    'Deriv-App-ID': String(appId),
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json'
  };
  if (body) headers['Content-Type'] = 'application/json';
  let res, json;
  try {
    res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    throw new Error('Réseau Deriv: ' + e.message);
  }
  const errs = json && json.errors;
  if (!res.ok || (Array.isArray(errs) && errs.length)) {
    const er = (Array.isArray(errs) && errs[0]) || {};
    const msg = (er.detail && er.detail.message) || er.code || ('HTTP ' + res.status);
    const e = new Error(msg);
    e.code = er.code;
    e.httpStatus = res.status;
    throw e;
  }
  return (json && json.data) || {};
}

// ── agent_id (numérique) auto via GET /agents/me — mis en cache 1h ──
let _agentCache = { id: null, at: 0 };
async function getAgentId(cfg) {
  cfg = cfg || await getDerivConfig();
  // Override manuel possible (deriv_agent_id) sinon auto-découverte
  if (cfg.deriv_agent_id && /^\d+$/.test(String(cfg.deriv_agent_id))) {
    return Number(cfg.deriv_agent_id);
  }
  if (_agentCache.id && (Date.now() - _agentCache.at) < 3600000) return _agentCache.id;
  const data = await restCall('GET', '/payment-agents/v1/agents/me', cfg.deriv_token, cfg.deriv_app_id);
  const id = data && data.id;
  if (!id) throw new Error("agent_id introuvable (compte non payment-agent ?)");
  _agentCache = { id, at: Date.now() };
  return id;
}
function clearAgentCache() { _agentCache = { id: null, at: 0 }; }

function fmtAmount(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }

// 1) Demande du code OTP (envoyé au contact enregistré du client). Token = CLIENT.
async function restSendWithdrawOtp(tokenClient, montantUsd, currency = 'USD') {
  const cfg = await getDerivConfig();
  const agent_id = await getAgentId(cfg);
  const data = await restCall('POST', '/payment-agents/v1/withdraw/verification_code',
    tokenClient, cfg.deriv_app_id,
    { data: { agent_id, amount: fmtAmount(montantUsd), currency } });
  return { ok: true, agent_id, expires_at: data.expires_at, next_request_at: data.next_request_at };
}

// 2) Soumission du retrait. Token = CLIENT. Renvoie {status, transaction_id, request_id}.
async function restSubmitWithdraw(tokenClient, otp, montantUsd, currency = 'USD') {
  const cfg = await getDerivConfig();
  const agent_id = await getAgentId(cfg);
  const request_id = 'mm' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const data = await restCall('POST', '/payment-agents/v1/withdraw',
    tokenClient, cfg.deriv_app_id,
    { data: { agent_id, amount: fmtAmount(montantUsd), currency, verification_code: String(otp).trim(), request_id } });
  return { status: data.status, transaction_id: data.transaction_id, request_id, agent_id };
}

// 3) Statut d'un retrait (poll). Token = CLIENT.
async function restWithdrawStatus(tokenClient, request_id) {
  const cfg = await getDerivConfig();
  const data = await restCall('GET', '/payment-agents/v1/withdraw/' + encodeURIComponent(request_id),
    tokenClient, cfg.deriv_app_id);
  return { status: data.status, transaction_id: data.transaction_id };
}

// (DÉPÔT) transfert agent → client via NICKNAME. Token = AGENT.
// request_id STABLE (idempotence) : un relance avec le même request_id ne
// double-crédite pas — Deriv déduplique côté serveur. Fourni par l'appelant
// (dérivé de l'_id de l'ordre) ou généré si absent.
async function restTransferToClient(toNickname, montantUsd, currency = 'USD', requestId, notes) {
  const cfg = await getDerivConfig();
  const request_id = (requestId && String(requestId).trim())
    ? String(requestId).trim()
    : ('dep' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
  const body = { data: { to_nickname: toNickname, amount: fmtAmount(montantUsd), currency, request_id } };
  if (notes) body.data.notes = String(notes).slice(0, 200);
  const data = await restCall('POST', '/payment-agents/v1/transfer', cfg.deriv_token, cfg.deriv_app_id, body);
  const status = (data.status || '').toLowerCase();
  return { ok: status === 'complete', status: data.status, transaction_id: data.transaction_id, request_id };
}

// (DÉPÔT) statut d'un transfert — idempotence/suivi via le MÊME request_id.
// Sert au cron de relance : vérifier si le transfert est déjà 'complete'
// AVANT de (re)tenter, pour éviter tout double-crédit.
async function restTransferStatus(request_id) {
  const cfg = await getDerivConfig();
  const data = await restCall('GET', '/payment-agents/v1/transfer/' + encodeURIComponent(request_id),
    cfg.deriv_token, cfg.deriv_app_id);
  return { status: data.status, transaction_id: data.transaction_id };
}

// Limites min/max USD de l'agent (mba hisorohana WithdrawalAmountMinimum/Maximum)
function agentUsdLimits(profile) {
  if (!profile) return { min: null, max: null };
  const cur = Array.isArray(profile.currencies)
    ? profile.currencies.find(c => (c.currency || '').toUpperCase() === 'USD')
    : null;
  return {
    min: cur && cur.withdrawal_minimum != null ? Number(cur.withdrawal_minimum)
         : (profile.withdrawal_minimum != null ? Number(profile.withdrawal_minimum) : null),
    max: cur && cur.withdrawal_maximum != null ? Number(cur.withdrawal_maximum)
         : (profile.withdrawal_maximum != null ? Number(profile.withdrawal_maximum) : null)
  };
}

// (Optionnel) profil de l'agent courant (limites, commissions, currencies)
async function restGetMyAgent() {
  const cfg = await getDerivConfig();
  return await restCall('GET', '/payment-agents/v1/agents/me', cfg.deriv_token, cfg.deriv_app_id);
}

module.exports = {
  getAgentId, clearAgentCache, fmtAmount,
  restSendWithdrawOtp, restSubmitWithdraw, restWithdrawStatus,
  restTransferToClient, restTransferStatus, restGetMyAgent, agentUsdLimits
};
