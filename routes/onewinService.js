/**
 * 1WIN — API caisse publique.
 *
 * Beaucoup plus simple que le reseau Cashdesk (Betwinner / 1XBET) : aucune
 * signature a calculer, une seule cle transmise dans l'en-tete X-API-KEY.
 *
 * Une SEULE caisse, en USD. Les montants Ariary ou Franc comorien vus par le
 * client sont une conversion faite chez nous, exactement comme pour Deriv :
 * l'API 1WIN, elle, ne connait que des dollars.
 */
const Settings = require('../models/Settings');

const BASE = 'https://api.1win.win';
const CLES = ['onewin_apikey'];

async function getOnewinConfig() {
  const docs = await Settings.find({ key: { $in: CLES } });
  const cfg = {};
  // trim() indispensable : un espace colle lors d'un copier-coller invalide la
  // cle alors qu'elle "parait" correcte dans l'admin.
  docs.forEach(d => { cfg[d.key] = String(d.value || '').trim(); });
  return cfg;
}

async function onewinFetch(chemin, corps) {
  const cfg = await getOnewinConfig();
  const cle = cfg.onewin_apikey;
  if (!cle) {
    const e = new Error('1WIN non configure (cle API manquante)');
    e.code = 'OnewinNotConfigured';
    throw e;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let r, txt;
  try {
    r = await fetch(BASE + chemin, {
      method: 'POST',
      headers: { 'X-API-KEY': cle, 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
      signal: ctrl.signal
    });
    txt = await r.text();
  } finally { clearTimeout(t); }

  console.log('1WIN POST ' + chemin + ' -> HTTP ' + r.status + ' ' + String(txt).slice(0, 200));

  let data = null;
  try { data = JSON.parse(txt); } catch (_) { /* reponse non JSON */ }

  if (!r.ok) {
    // Le message de l'API est plus parlant que le code seul : on le remonte.
    const msg = (data && (data.message || data.error)) || ('HTTP ' + r.status);
    const e = new Error('1WIN: ' + msg);
    e.code = 'Onewin' + r.status;
    e.http = r.status;
    throw e;
  }
  return data || {};
}

/**
 * Crediter le compte d'un joueur.
 * @param userId identifiant du joueur chez 1WIN
 * @param montantUsd montant EN DOLLARS (la conversion est faite en amont)
 */
async function onewinDeposit(userId, montantUsd) {
  const d = await onewinFetch('/v1/client/deposit', {
    userId: Number(userId),
    amount: Number(montantUsd)
  });
  return { ok: true, id: d.id || '', amount: Number(d.amount) || 0, userId: d.userId || userId, raw: d };
}

/**
 * Valider un retrait a partir du code communique par le joueur.
 * Le montant n'est PAS choisi par le client : il vient de la reponse.
 *
 * Le mode d'emploi se contredit sur le nom du champ (userId dans le tableau,
 * withdrawalId dans l'exemple JSON). On envoie donc les deux : le champ inutile
 * est ignore par l'API, et l'appel fonctionne quelle que soit la version.
 */
async function onewinWithdrawal(userId, code) {
  const d = await onewinFetch('/v1/client/withdrawal', {
    userId: Number(userId),
    withdrawalId: Number(userId),
    code: Number(code)
  });
  const montant = Number(d.amount);
  if (!isFinite(montant) || montant <= 0) {
    const e = new Error('1WIN: montant de retrait absent de la reponse');
    e.code = 'OnewinNoAmount';
    throw e;
  }
  return { ok: true, id: d.id || '', amountUsd: montant, userId: d.userId || userId, raw: d };
}

module.exports = { onewinDeposit, onewinWithdrawal, getOnewinConfig, CLES_ONEWIN: CLES };
