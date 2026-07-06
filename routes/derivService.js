// Service Deriv — HYBRIDE :
//   * DEPOT  : WebSocket API (efa mandeha tsara, tsy kasihina)
//   * RETRAIT: REST Payment Agent API (https://api.derivws.com) — flux OTP officiel
// Doc REST : /payment-agents/v1/* — auth = Deriv-App-ID + Bearer token (scope `payment`)
const WebSocket = require('ws');
const { getDerivConfig } = require('./deriv');

/* ============================================================
 * PARTIE 1 — WebSocket (LEGACY, dépôt + statement uniquement)
 * ============================================================ */
const WS_URL = (appId) => 'wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(appId);
const TIMEOUT_MS = 15000;

function derivCall(cfg, request, tokenOverride) {
  return new Promise((resolve, reject) => {
    const authToken = tokenOverride || cfg.deriv_token;
    if (!cfg.deriv_app_id || !authToken) {
      return reject(new Error('Configuration API Deriv tsy feno (App ID / Token)'));
    }
    let done = false;
    const ws = new WebSocket(WS_URL(cfg.deriv_app_id));
    const finish = (err, data) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch(_) {}
      err ? reject(err) : resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('Deriv timeout')), TIMEOUT_MS);
    ws.on('open', () => ws.send(JSON.stringify({ authorize: authToken })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch(_) { return; }
      if (msg.error) { clearTimeout(timer); return finish(new Error(msg.error.message || msg.error.code)); }
      if (msg.msg_type === 'authorize') { ws.send(JSON.stringify(request)); }
      else { clearTimeout(timer); finish(null, msg); }
    });
    ws.on('error', (e) => { clearTimeout(timer); finish(e); });
    ws.on('close', () => { if (!done) { clearTimeout(timer); finish(new Error('Deriv connection fermee')); } });
  });
}

// DEPOT (agent -> client) — WS, efa mandeha, TSY OVAINA
async function derivTransferToClient(crClient, montantUsd) {
  const cfg = await getDerivConfig();
  const r = await derivCall(cfg, { paymentagent_transfer: 1, transfer_to: crClient, amount: Number(montantUsd), currency: 'USD' });
  return { ok: r.paymentagent_transfer === 1 || r.paymentagent_transfer === 2, transaction_id: r.transaction_id || '', raw: r };
}

// Statement (legacy "Safidy 1") — WS
async function derivCheckCredited(crClient, montantUsd, sinceEpoch) {
  const cfg = await getDerivConfig();
  const r = await derivCall(cfg, { statement: 1, description: 1, limit: 50 });
  const txs = r?.statement?.transactions || [];
  const target = Math.round(Number(montantUsd) * 100) / 100;
  const cr = String(crClient || '').toUpperCase();
  for (const t of txs) {
    const amt = Number(t.amount) || 0;
    const when = Number(t.transaction_time) || 0;
    const isDeposit = (t.action_type === 'deposit') && amt > 0;
    const amountMatch = Math.abs(amt - target) < 0.001;
    const timeOk = !sinceEpoch || when >= (sinceEpoch - 120);
    const longcode = String(t.longcode || '').toUpperCase();
    const fromClient = !cr || longcode.includes(cr);
    if (isDeposit && amountMatch && timeOk && fromClient) {
      return { credited: true, transaction_id: t.transaction_id || '', raw: t };
    }
  }
  return { credited: false };
}

/* ============================================================
 * PARTIE 2 — REST Payment Agent API (RETRAIT — flux OTP officiel)
 * ============================================================ */
const REST_BASE = 'https://api.derivws.com/payment-agents/v1';
const REST_TIMEOUT_MS = 20000;

// Appel REST générique. `token` = client OU agent selon l'endpoint.
async function derivRest(method, path, token, body) {
  const cfg = await getDerivConfig();
  if (!cfg.deriv_app_id) throw new Error('deriv_app_id non configuré');
  if (!token) throw new Error('Token Deriv manquant');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REST_TIMEOUT_MS);
  try {
    const headers = {
      'Deriv-App-ID': String(cfg.deriv_app_id),
      'Authorization': 'Bearer ' + token
    };
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(REST_BASE + path, {
      method, headers,
      body: body ? JSON.stringify({ data: body }) : undefined,
      signal: ctrl.signal
    });
    const json = await r.json().catch(() => ({}));
    const apiErr = Array.isArray(json.errors) && json.errors.length ? json.errors[0] : null;
    if (!r.ok || apiErr) {
      const code = (apiErr && apiErr.code) || String(r.status);
      const msg  = (apiErr && apiErr.detail && apiErr.detail.message) || code;
      const e = new Error(msg);
      e.code = code;
      e.httpStatus = r.status;
      e.raw = json;
      // Message mazava kokoa ho an'ny cas mahazatra
      if (r.status === 403) e.message = 'Token sans scope `payment` (403) — vérifier les scopes OAuth Deriv';
      if (r.status === 401) e.message = 'Token Deriv invalide ou expiré (401)';
      throw e;
    }
    return json.data || {};
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('Deriv REST timeout'); t.code = 'Timeout'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

// --- Cache agent_id (GET /agents/me avec le token AGENT) ---
let _agentCache = { id: null, profile: null, at: 0 };
const AGENT_CACHE_MS = 10 * 60 * 1000;

async function derivGetAgentProfile(force = false) {
  const now = Date.now();
  if (!force && _agentCache.id && (now - _agentCache.at) < AGENT_CACHE_MS) return _agentCache.profile;
  const cfg = await getDerivConfig();
  const data = await derivRest('GET', '/agents/me', cfg.deriv_token);
  if (!data || data.id == null) throw new Error('Profil agent Deriv introuvable (/agents/me)');
  _agentCache = { id: Number(data.id), profile: data, at: now };
  return data;
}
async function derivGetAgentId() {
  const p = await derivGetAgentProfile();
  return Number(p.id);
}

// Limites min/max USD de l'agent (mba hisorohana WithdrawalAmountMinimum/Maximum)
function agentUsdLimits(profile) {
  const cur = Array.isArray(profile.currencies)
    ? profile.currencies.find(c => (c.currency || '').toUpperCase() === 'USD')
    : null;
  return {
    min: cur ? Number(cur.withdrawal_minimum) : (profile.withdrawal_minimum ? Number(profile.withdrawal_minimum) : null),
    max: cur ? Number(cur.withdrawal_maximum) : (profile.withdrawal_maximum ? Number(profile.withdrawal_maximum) : null)
  };
}

// OTP retrait — REST. Token CLIENT. Deriv mandefa ny code any amin'ny
// email/téléphone VOASORATRA ao amin'ny compte client (tsy mila email param!).
async function derivSendWithdrawOtpRest(tokenClient, montantUsd) {
  const agentId = await derivGetAgentId();
  const data = await derivRest('POST', '/withdraw/verification_code', tokenClient, {
    agent_id: agentId,
    amount: Number(montantUsd).toFixed(2),
    currency: 'USD'
  });
  return {
    ok: true,
    message: data.message || '',
    next_request_at: data.next_request_at || null,
    expires_at: data.expires_at || null
  };
}

// Retrait — REST. Token CLIENT + code 6 chiffres + request_id (suivi).
async function derivClientWithdrawRest(tokenClient, otp, montantUsd, requestId) {
  const agentId = await derivGetAgentId();
  const data = await derivRest('POST', '/withdraw', tokenClient, {
    agent_id: agentId,
    amount: Number(montantUsd).toFixed(2),
    currency: 'USD',
    verification_code: String(otp),
    request_id: requestId
  });
  return { ok: true, status: data.status || 'pending', transaction_id: data.transaction_id || null };
}

// Statut d'un retrait REST — token client (le retrait appartient au client)
async function derivWithdrawStatusRest(tokenClient, requestId) {
  const data = await derivRest('GET', '/withdraw/' + encodeURIComponent(requestId), tokenClient);
  return { status: data.status || 'pending', transaction_id: data.transaction_id || null };
}

module.exports = {
  // WS (legacy — dépôt)
  derivTransferToClient, derivCheckCredited,
  // REST (retrait)
  derivGetAgentProfile, derivGetAgentId, agentUsdLimits,
  derivSendWithdrawOtpRest, derivClientWithdrawRest, derivWithdrawStatusRest,
  getDerivConfig
};
