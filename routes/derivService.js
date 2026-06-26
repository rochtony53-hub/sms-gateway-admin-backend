// Service Deriv — WebSocket API (wss://ws.derivws.com/websockets/v3)
const WebSocket = require('ws');
const { getDerivConfig } = require('./deriv');

const WS_URL = (appId) => 'wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(appId);
const TIMEOUT_MS = 15000;

function derivCall(cfg, request) {
  return new Promise((resolve, reject) => {
    if (!cfg.deriv_app_id || !cfg.deriv_token) {
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
    ws.on('open', () => ws.send(JSON.stringify({ authorize: cfg.deriv_token })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch(_) { return; }
      if (msg.error) { clearTimeout(timer); return finish(new Error(msg.error.message || msg.error.code)); }
      if (msg.msg_type === 'authorize') {
        ws.send(JSON.stringify(request));
      } else {
        clearTimeout(timer); finish(null, msg);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); finish(e); });
    ws.on('close', () => { if (!done) { clearTimeout(timer); finish(new Error('Deriv connection fermee')); } });
  });
}

async function derivTransferToClient(crClient, montantUsd) {
  const cfg = await getDerivConfig();
  const r = await derivCall(cfg, {
    paymentagent_transfer: 1, transfer_to: crClient,
    amount: Number(montantUsd), currency: 'USD'
  });
  return { ok: r.paymentagent_transfer === 1 || r.paymentagent_transfer === 2,
           transaction_id: r.transaction_id || '', raw: r };
}

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

async function derivSendWithdrawOtp(email) {
  const cfg = await getDerivConfig();
  const r = await derivCall(cfg, { verify_email: email, type: 'paymentagent_withdraw' });
  return { ok: r.verify_email === 1, raw: r };
}

module.exports = { derivTransferToClient, derivCheckCredited, derivSendWithdrawOtp, getDerivConfig };
