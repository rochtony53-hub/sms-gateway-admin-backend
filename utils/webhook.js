/**
 * Avis au partenaire quand un de ses ordres se termine.
 *
 * Jusqu'ici le partenaire interrogeait nos ordres en boucle. Chaque lecture
 * d'un "success" pouvait declencher chez lui un nouveau credit : le meme
 * depot etait crédite deux ou trois fois sur le compte de son client.
 *
 * Desormais nous le prevenons nous-memes, UNE fois par ordre. Cette tache
 * tourne a part et ne fait que lire les ordres termines : elle ne touche ni
 * a la reception des SMS, ni a la validation, ni a l'envoi d'argent.
 */
const crypto   = require('crypto');
const Retrait  = require('../models/Retrait');
const Settings = require('../models/Settings');

// Ecart avant chaque nouvelle tentative quand le partenaire ne repond pas.
const DELAIS_MIN = [1, 2, 5, 15, 60];
const MAX_ESSAIS = DELAIS_MIN.length;
const TOUR_MS    = 30 * 1000;

async function reglages() {
  const docs = await Settings.find({ key: { $in: [
    'partenaire_webhook_url', 'partenaire_webhook_url_km',
    'partenaire_webhook_secret', 'partenaire_webhook_depuis'
  ] } });
  const r = {};
  docs.forEach(d => { r[d.key] = d.value; });
  return r;
}

// Le partenaire a deux sites : Madagascar et Comores. Un ordre comorien
// (operateur suffixe _km, ou devise Fc/KMF) part vers l'adresse Comores ;
// faute d'adresse Comores, vers l'adresse principale pour ne rien perdre.
function estComores(o) {
  return /_km$/i.test(String(o.operator || '')) || /^(fc|kmf)$/i.test(String(o.devise || ''));
}
function adressePour(o, cfg) {
  const mg = String(cfg.partenaire_webhook_url || '').trim();
  const km = String(cfg.partenaire_webhook_url_km || '').trim();
  const u = (estComores(o) && km) ? km : mg;
  return /^https:\/\//i.test(u) ? u : '';
}

function signer(secret, corps) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret || '')).update(corps).digest('hex');
}

function contenu(o) {
  return {
    id: String(o._id),
    clientRef: o.clientRef || '',
    type: o.type,
    status: o.status,
    montant: o.montant,
    devise: o.devise || 'Ar',
    operator: o.operator,
    numero: o.numero,
    sessionId: o.sessionId || '',
    dateValidation: (o.updatedAt || new Date()).toISOString()
  };
}

async function livrer(url, secret, o) {
  const corps = JSON.stringify(contenu(o));
  const ctrl  = new AbortController();
  const t     = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MM-Signature': signer(secret, corps),
        // Le partenaire peut s'en servir pour ignorer un avis deja traite.
        'X-MM-Event-Id': String(o._id)
      },
      body: corps,
      signal: ctrl.signal
    });
    return { ok: r.status >= 200 && r.status < 300, code: r.status };
  } catch (e) {
    return { ok: false, code: 0, erreur: e.name === 'AbortError' ? 'delai depasse' : e.message };
  } finally { clearTimeout(t); }
}

let enCours = false;

async function tour() {
  if (enCours) return;
  enCours = true;
  try {
    const cfg = await reglages();
    const aucune = !/^https:\/\//i.test(String(cfg.partenaire_webhook_url || '').trim())
                && !/^https:\/\//i.test(String(cfg.partenaire_webhook_url_km || '').trim());
    if (aucune) return;                               // rien de configure

    // Seuls les ordres termines APRES l'activation : ne pas rejouer
    // l'historique, deja traite par le partenaire a sa facon.
    const depuis = cfg.partenaire_webhook_depuis ? new Date(cfg.partenaire_webhook_depuis) : new Date();
    const maintenant = new Date();

    const filtre = {
      clientRef: { $nin: [null, ''] },
      status: { $in: ['success', 'failed'] },
      webhookEnvoyeLe: null,
      webhookEssais: { $lt: MAX_ESSAIS },
      updatedAt: { $gte: depuis },
      $or: [ { webhookProchainLe: null }, { webhookProchainLe: { $lte: maintenant } } ]
    };

    for (let i = 0; i < 20; i++) {
      // Reservation atomique : deux tours simultanes ne peuvent pas prendre
      // le meme ordre, donc pas de double avis.
      const o = await Retrait.findOneAndUpdate(
        filtre,
        { $set: { webhookProchainLe: new Date(Date.now() + 5 * 60 * 1000) } },
        { new: true, sort: { updatedAt: 1 } }
      );
      if (!o) break;

      const url = adressePour(o, cfg);
      if (!url) continue;                             // pas d'adresse pour ce pays
      const res = await livrer(url, cfg.partenaire_webhook_secret, o);
      if (res.ok) {
        await Retrait.updateOne({ _id: o._id },
          { $set: { webhookEnvoyeLe: new Date(), webhookErreur: '' } });
      } else {
        const essais = (o.webhookEssais || 0) + 1;
        const delai  = DELAIS_MIN[Math.min(essais, MAX_ESSAIS) - 1] * 60 * 1000;
        await Retrait.updateOne({ _id: o._id }, { $set: {
          webhookEssais: essais,
          webhookProchainLe: new Date(Date.now() + delai),
          webhookErreur: (res.erreur || ('HTTP ' + res.code)).slice(0, 200)
        } });
        if (essais >= MAX_ESSAIS)
          console.error('[webhook] abandon apres ' + essais + ' essais :', String(o._id), res.erreur || res.code);
      }
    }
  } catch (e) {
    console.error('[webhook] tour:', e.message);
  } finally { enCours = false; }
}

function demarrer() {
  setInterval(tour, TOUR_MS);
  setTimeout(tour, 10 * 1000);
  console.log('[webhook] avis partenaire actifs (toutes les 30 s)');
}

module.exports = { demarrer, tour, contenu, signer, livrer, estComores, adressePour };
