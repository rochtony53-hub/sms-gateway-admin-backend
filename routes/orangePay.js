/* ============================================================================
 * ORANGE MONEY WEB PAYMENT — depot par API
 * ----------------------------------------------------------------------------
 * Flux complet :
 *   1. Le client valide son ordre de depot sur la vitrine.
 *   2. Le core cree le Retrait (status pending) puis appelle initPaiement()
 *      ci-dessous : token OAuth Orange -> webpayment -> payment_url.
 *   3. Le client recoit /pay/go/:id (NOTRE url). Aucun jeton, aucune cle, aucun
 *      identifiant Orange ne quitte le serveur.
 *   4. /pay/go/:id repond 302 vers la page Orange. Le telephone ouvre alors
 *      l'application Orange Money si Orange a declare l'App Link, sinon la page
 *      web Orange. Le client saisit SON code secret chez Orange — jamais chez
 *      nous.
 *   5. Orange appelle POST /api/orange-pay/notif quand le paiement aboutit.
 *      On marque la reception, et la chaine d'auto-validation existante prend
 *      le relais (credit Deriv, puis status success).
 *
 * PRINCIPES DE SECURITE (argent reel) :
 *   - Le webhook est PUBLIC par necessite : il est authentifie par le
 *     notif_token remis a l'initialisation, compare a celui stocke.
 *   - Le MONTANT de la notification est verifie contre le montant enregistre.
 *     Sans ce controle, un paiement de 100 Ar pourrait crediter un ordre de
 *     100 000 Ar.
 *   - Le traitement est IDEMPOTENT : Orange rejoue ses notifications. Le
 *     premier appel gagne, les suivants sont acquittes sans rien recrediter.
 *   - Aucun basculement vers le TPE APRES redirection du client : il pourrait
 *     payer chez Orange malgre tout, et serait credite deux fois.
 * ==========================================================================*/

const router   = require('express').Router();
const crypto   = require('crypto');
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');
const Retrait  = require('../models/Retrait');

// Orange Developer fournit les identifiants sous DEUX formes selon le compte :
//   a) une "cle" deja prete = l'en-tete Authorization complet du type
//      "Basic <base64>"  -> om_auth_header  (cas le plus courant)
//   b) le couple client_id / client_secret, a encoder soi-meme
// Les deux sont acceptes. Si la cle est renseignee, elle a la priorite : elle
// est utilisee telle quelle, sans etre reconstruite — donc sans risque
// d'erreur d'encodage.
const KEYS = [
  'om_auth_header', 'om_client_id', 'om_client_secret', 'om_merchant_key',
  'om_env', 'om_return_url', 'om_cancel_url', 'om_notif_url'
];

/* ---------------------------------------------------------------- config --- */

async function getConfig() {
  const docs = await Settings.find({ key: { $in: KEYS } });
  const cfg = { om_env: 'sandbox' };
  // trim() indispensable : un espace colle lors d'un copier-coller casse
  // l'authentification alors que la valeur "parait" correcte dans l'admin.
  docs.forEach(d => { cfg[d.key] = String(d.value || '').trim(); });
  if (!cfg.om_env) cfg.om_env = 'sandbox';
  return cfg;
}

// Sandbox et production ne partagent ni le chemin ni la devise.
function endpoints(env) {
  const prod = env === 'prod';
  return {
    base:     'https://api.orange.com',
    webpay:   prod ? '/orange-money-webpay/mg/v1/webpayment'
                   : '/orange-money-webpay/dev/v1/webpayment',
    status:   prod ? '/orange-money-webpay/mg/v1/transactionstatus'
                   : '/orange-money-webpay/dev/v1/transactionstatus',
    currency: prod ? 'MGA' : 'OUV'
  };
}

/* ----------------------------------------------------------------- token --- */
// Le token Orange vit longtemps (~90 jours). On le garde en memoire avec une
// marge de securite : le redemander a chaque paiement ajouterait un aller-retour
// reseau — donc du delai — a chaque ordre client.
let tokenCache = { valeur: '', expire: 0, empreinte: '' };
// Forme d'en-tete Authorization qui a fonctionne (voir variantesAuth).
let varianteOk = '';

/**
 * Construit l'en-tete Authorization de la demande de jeton.
 * - cle fournie par Orange : utilisee TELLE QUELLE. On ajoute seulement le
 *   prefixe "Basic " s'il manque, car la console Orange l'affiche parfois sans.
 * - sinon : encodage classique de client_id:client_secret.
 */
function variantesAuth(cfg) {
  const cle = String(cfg.om_auth_header || '').trim();
  const out = [];
  if (cle) {
    // Deja prefixe par un schema : Orange a fourni l'en-tete complet, on n'y
    // touche pas.
    if (/^(basic|bearer)\s/i.test(cle)) {
      out.push({ nom: 'en-tete fourni tel quel', valeur: cle });
    } else {
      // Orange communique la cle sous plusieurs formes selon le compte et on ne
      // peut pas la distinguer a l'oeil : base64 de client_id:client_secret,
      // en-tete sans prefixe, ou jeton. On essaie donc les formes plausibles
      // DANS L'ORDRE, une seule fois, uniquement sur la demande de jeton — une
      // requete sans effet et sans argent. La forme qui marche est memorisee.
      out.push({ nom: 'Basic <cle>',  valeur: 'Basic ' + cle });
      out.push({ nom: 'cle brute',    valeur: cle });
      out.push({ nom: 'Bearer <cle>', valeur: 'Bearer ' + cle });
    }
  }
  if (cfg.om_client_id && cfg.om_client_secret) {
    out.push({
      nom: 'Basic base64(client_id:client_secret)',
      valeur: 'Basic ' + Buffer.from(cfg.om_client_id + ':' + cfg.om_client_secret).toString('base64')
    });
  }
  return out;
}

/** Compatibilite : premiere variante, utilisee pour l'empreinte de cache. */
function enteteAuth(cfg) {
  const v = variantesAuth(cfg);
  return v.length ? v[0].valeur : '';
}

async function getToken(cfg) {
  const variantes = variantesAuth(cfg);
  const empreinte = crypto.createHash('sha256')
    .update((variantes[0] ? variantes[0].valeur : '') + '|' + cfg.om_env)
    .digest('hex').slice(0, 16);
  // Identifiants changes dans l'admin => l'ancien token n'a plus cours.
  if (tokenCache.valeur && tokenCache.expire > Date.now()
      && tokenCache.empreinte === empreinte) {
    return tokenCache.valeur;
  }
  if (!variantes.length) {
    throw new Error('Cle API Orange absente : renseignez la cle (en-tete '
      + 'Authorization) OU le couple Client ID / Client Secret '
      + '(Admin > API Orange Money)');
  }

  const url = endpoints(cfg.om_env).base + '/oauth/v3/token';
  const echecs = [];
  // Une variante deja validee est retentee EN PREMIER : en regime normal il n'y
  // a donc qu'un seul appel.
  if (varianteOk) {
    const i = variantes.findIndex(v => v.nom === varianteOk);
    if (i > 0) variantes.unshift(variantes.splice(i, 1)[0]);
  }

  for (const v of variantes) {
    try {
      const r = await fetchTimeout(url, {
        method: 'POST',
        headers: {
          'Authorization': v.valeur,
          'Content-Type':  'application/x-www-form-urlencoded',
          'Accept':        'application/json'
        },
        body: 'grant_type=client_credentials'
      }, 10000);
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.access_token) {
        const dureeS = Number(data.expires_in || 3600);
        varianteOk = v.nom;
        tokenCache = {
          valeur: data.access_token,
          // 5 min de marge : ne jamais presenter un token qui expire en vol.
          expire: Date.now() + Math.max(60, dureeS - 300) * 1000,
          empreinte
        };
        console.log('[orange-pay] token obtenu via "' + v.nom + '"');
        return tokenCache.valeur;
      }
      echecs.push(v.nom + ' -> HTTP ' + r.status
        + (data.error_description ? ' ' + String(data.error_description).slice(0, 80)
          : (data.error ? ' ' + String(data.error).slice(0, 80) : '')));
      // 403 = refus reseau (IP non autorisee) : changer de variante n'y fera
      // rien, on arrete tout de suite.
      if (r.status === 403) break;
    } catch (e) {
      echecs.push(v.nom + ' -> ' + e.message);
    }
  }
  throw new Error('Token Orange refuse. Essais : ' + echecs.join(' | '));
}

function fetchTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

/* ------------------------------------------------------- circuit breaker --- */
// Si l'API Orange tombe, chaque client attendrait le timeout avant de basculer
// sur le TPE. On memorise les echecs : au-dela du seuil, on passe directement
// au TPE pendant une periode de repos, puis on retente automatiquement.
const BREAKER = { echecs: [], ouvertJusqua: 0 };
const BREAKER_SEUIL   = 3;
const BREAKER_FENETRE = 5 * 60 * 1000;
const BREAKER_REPOS   = 10 * 60 * 1000;

function breakerOuvert() {
  return Date.now() < BREAKER.ouvertJusqua;
}
function noterEchec() {
  const now = Date.now();
  BREAKER.echecs = BREAKER.echecs.filter(t => now - t < BREAKER_FENETRE);
  BREAKER.echecs.push(now);
  if (BREAKER.echecs.length >= BREAKER_SEUIL) {
    BREAKER.ouvertJusqua = now + BREAKER_REPOS;
    BREAKER.echecs = [];
    console.warn('[orange-pay] circuit ouvert ' + (BREAKER_REPOS / 60000)
      + ' min — les depots Orange passent en TPE');
  }
}
function noterSucces() { BREAKER.echecs = []; BREAKER.ouvertJusqua = 0; }

/* ------------------------------------------------------------ init paiement */

function baseUrl(req) {
  // Utilisee pour /pay/go et le webhook quand l'admin ne les a pas fixes.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return proto + '://' + req.get('host');
}

/**
 * Initialise un paiement Orange pour un Retrait de type depot deja enregistre.
 * Ne LEVE JAMAIS vers l'appelant : renvoie null en cas d'echec, pour que le
 * core puisse retomber proprement sur le code USSD (TPE). Un depot doit
 * toujours rester possible, meme si Orange est indisponible.
 *
 * @returns {Promise<{payUrl:string, omOrderId:string}|null>}
 */
async function initPaiement(retrait, req) {
  try {
    if (breakerOuvert()) {
      console.warn('[orange-pay] circuit ouvert — bascule TPE immediate');
      return null;
    }
    const cfg = await getConfig();
    if (!cfg.om_merchant_key) throw new Error('Merchant key Orange absente');

    const ep = endpoints(cfg.om_env);
    const token = await getToken(cfg);

    // order_id : unique, non devinable, et retrouvable. Le suffixe aleatoire
    // evite qu'une relance sur le meme retrait reutilise un identifiant deja
    // consomme chez Orange.
    const omOrderId = 'MM' + String(retrait._id) + '-'
      + crypto.randomBytes(3).toString('hex');
    const racine  = baseUrl(req);
    const retour  = cfg.om_return_url || (racine + '/api/orange-pay/retour');
    const annule  = cfg.om_cancel_url || (racine + '/api/orange-pay/annule');
    const notif   = cfg.om_notif_url  || (racine + '/api/orange-pay/notif');

    const corps = {
      merchant_key: cfg.om_merchant_key,
      currency:     ep.currency,
      order_id:     omOrderId,
      // Orange attend un entier dans l'unite de la devise.
      amount:       Math.round(Number(retrait.montant) || 0),
      return_url:   retour + (retour.includes('?') ? '&' : '?') + 'order=' + retrait._id,
      cancel_url:   annule + (annule.includes('?') ? '&' : '?') + 'order=' + retrait._id,
      notif_url:    notif,
      lang:         'fr',
      reference:    'MATULMADA'
    };
    if (!corps.amount || corps.amount < 1) throw new Error('Montant invalide');

    const r = await fetchTimeout(ep.base + ep.webpay, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      body: JSON.stringify(corps)
    }, 8000);                       // 8 s : au-dela, le client attend trop
    const data = await r.json().catch(() => ({}));
    const payUrl = data.payment_url || data.paymentUrl || '';
    if (!r.ok || !payUrl) {
      throw new Error('webpayment HTTP ' + r.status + ' '
        + JSON.stringify(data).slice(0, 200));
    }

    retrait.omOrderId    = omOrderId;
    retrait.omPayToken   = data.pay_token || '';
    retrait.omNotifToken = data.notif_token || '';
    retrait.omPayUrl     = payUrl;
    retrait.omMontant    = corps.amount;
    retrait.omStatus     = 'awaiting_payment';
    // Le code USSD manuel n'a plus de sens sur ce depot : le laisser afficherait
    // deux chemins de paiement pour un meme ordre, avec un risque de double
    // paiement par le client.
    retrait.ussdCode     = '';
    await retrait.save();

    noterSucces();
    console.log('[orange-pay] init OK ' + omOrderId + ' montant=' + corps.amount);
    return { payUrl: racine + '/pay/go/' + retrait._id, omOrderId };
  } catch (e) {
    noterEchec();
    console.error('[orange-pay] init KO:', e.message);
    return null;                    // -> le core retombe sur le TPE
  }
}

/* --------------------------------------------------------- redirection 302 */
// Le client n'obtient JAMAIS payment_url : il recoit cette url, sur notre
// domaine. Aucun jeton visible, rien a masquer dans une page intermediaire.
router.get('/go/:id', async (req, res) => {
  try {
    const r = await Retrait.findById(req.params.id).select('omPayUrl omStatus type');
    if (!r || !r.omPayUrl) return res.status(404).send('Paiement introuvable');
    if (r.omStatus === 'paid') return res.status(409).send('Paiement deja regle');
    return res.redirect(302, r.omPayUrl);
  } catch (e) {
    return res.status(500).send('Erreur');
  }
});

/* -------------------------------------------------------------- webhook --- */
// PUBLIC (Orange doit pouvoir l'appeler) — authentifie par notif_token.
router.post('/notif', async (req, res) => {
  const b = req.body || {};
  const orderId = String(b.order_id || b.orderId || '').trim();
  const token   = String(b.notif_token || b.notifToken || '').trim();
  const statut  = String(b.status || b.txnstatus || '').toUpperCase();
  const montant = Math.round(Number(b.amount != null ? b.amount : b.montant) || 0);

  // Toujours repondre 200 a Orange une fois la notification comprise, sinon il
  // la rejoue indefiniment. Les refus de securite repondent 4xx.
  try {
    if (!orderId || !token) return res.status(400).json({ error: 'notification incomplete' });

    const r = await Retrait.findOne({ omOrderId: orderId });
    if (!r) {
      console.warn('[orange-pay] notif pour un ordre inconnu:', orderId);
      return res.status(404).json({ error: 'ordre inconnu' });
    }

    // 1) AUTHENTIFICATION du webhook
    if (!r.omNotifToken || token !== r.omNotifToken) {
      console.warn('[orange-pay] notif REFUSEE (jeton invalide) ordre=' + orderId);
      return res.status(403).json({ error: 'jeton invalide' });
    }

    // 2) IDEMPOTENCE : Orange rejoue ses notifications.
    if (r.omStatus === 'paid') {
      console.log('[orange-pay] notif deja traitee, ignoree:', orderId);
      return res.json({ ok: true, deja: true });
    }

    // 3) Statuts non finaux : on acquitte sans rien crediter.
    if (statut && !['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(statut)) {
      if (['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(statut)) {
        r.omStatus = statut.startsWith('CANCEL') ? 'cancelled'
                   : (statut === 'EXPIRED' ? 'expired' : 'failed');
        await r.save();
      }
      console.log('[orange-pay] notif statut=' + statut + ' ordre=' + orderId);
      return res.json({ ok: true, statut });
    }

    // 4) MONTANT : sans ce controle, un paiement de 100 Ar validerait un ordre
    //    de 100 000 Ar.
    const attendu = Math.round(Number(r.omMontant || r.montant) || 0);
    if (montant && attendu && montant !== attendu) {
      console.error('[orange-pay] MONTANT DIVERGENT ordre=' + orderId
        + ' recu=' + montant + ' attendu=' + attendu);
      r.omStatus = 'failed';
      r.response = 'Montant Orange different du montant commande ('
        + montant + ' vs ' + attendu + ')';
      await r.save();
      return res.status(409).json({ error: 'montant divergent' });
    }

    // 5) Paiement confirme.
    r.omStatus     = 'paid';
    r.omNotifiedAt = new Date();
    await r.save();
    console.log('[orange-pay] PAIEMENT CONFIRME ordre=' + orderId + ' montant=' + montant);

    // La suite (reception OK -> credit Deriv -> success) est deleguee a la
    // chaine existante, pour ne pas dupliquer la logique de validation.
    try {
      const smsMod = require('./sms');
      if (typeof smsMod.validerDepotOrangePay === 'function') {
        await smsMod.validerDepotOrangePay(r);
      } else if (typeof smsMod.autoValidateRetrait === 'function') {
        await smsMod.autoValidateRetrait(r);
      } else {
        // Aucun point d'entree disponible : on laisse l'ordre en reception
        // confirmee, l'admin le voit et peut valider. On ne credite JAMAIS
        // depuis ici a l'aveugle.
        console.warn('[orange-pay] aucune fonction de validation trouvee — '
          + 'ordre marque paid, validation a faire cote admin');
      }
    } catch (eV) {
      console.error('[orange-pay] validation:', eV.message);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[orange-pay] notif:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------- retour / annulation --- */
// Orange renvoie le client ici. On le repousse vers la vitrine, qui interroge
// le statut reel : la page de retour n'est JAMAIS une preuve de paiement.
router.get('/retour', async (req, res) => {
  const cfg = await getConfig().catch(() => ({}));
  const vitrine = (cfg.om_return_url || '').startsWith('http')
    ? cfg.om_return_url : 'https://matulmad.com/';
  const sep = vitrine.includes('?') ? '&' : '?';
  return res.redirect(302, vitrine + sep + 'pay=return&order='
    + encodeURIComponent(String(req.query.order || '')));
});

router.get('/annule', async (req, res) => {
  try {
    const id = String(req.query.order || '');
    if (id) {
      const r = await Retrait.findById(id);
      // On n'annule que si rien n'a encore ete paye.
      if (r && r.omStatus === 'awaiting_payment') {
        r.omStatus = 'cancelled';
        await r.save();
      }
    }
  } catch (_) {}
  const cfg = await getConfig().catch(() => ({}));
  const vitrine = (cfg.om_cancel_url || '').startsWith('http')
    ? cfg.om_cancel_url : 'https://matulmad.com/';
  const sep = vitrine.includes('?') ? '&' : '?';
  return res.redirect(302, vitrine + sep + 'pay=cancel&order='
    + encodeURIComponent(String(req.query.order || '')));
});

/* ------------------------------------------------------------- config API */

router.get('/config', auth, async (req, res) => {
  try {
    const cfg = await getConfig();
    // Les secrets ne ressortent JAMAIS en clair, meme pour un admin
    // authentifie : l'admin est une page web, donc un point de fuite.
    res.json({
      om_client_id:     cfg.om_client_id || '',
      om_env:           cfg.om_env || 'sandbox',
      om_return_url:    cfg.om_return_url || '',
      om_cancel_url:    cfg.om_cancel_url || '',
      om_notif_url:     cfg.om_notif_url || '',
      om_auth_present:     !!cfg.om_auth_header,
      om_secret_present:   !!cfg.om_client_secret,
      om_merchant_present: !!cfg.om_merchant_key,
      breaker_ouvert:   breakerOuvert()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/config', auth, async (req, res) => {
  try {
    for (const key of KEYS) {
      if (req.body[key] === undefined) continue;
      let v = String(req.body[key] || '').trim();
      // Convention identique au PIN Mobile Money : vide = inchange, "-" = effacer.
      if (v === '') continue;
      if (v === '-') v = '';
      await Settings.findOneAndUpdate({ key }, { value: v }, { upsert: true });
    }
    // Identifiants potentiellement changes : le token en cache n'a plus cours.
    tokenCache = { valeur: '', expire: 0, empreinte: '' };
    varianteOk = '';
    noterSucces();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --------------------------------------------------------------- diagnostic */
// Meme esprit que le diagnostic Betwinner : dire ce qui bloque, sans deviner.
router.get('/diag', auth, async (req, res) => {
  const out = { config: {}, token: null, ok: false, ipSortante: null };
  try {
    const cfg = await getConfig();
    out.config = {
      om_auth_header:   cfg.om_auth_header ? 'OK (cle fournie par Orange)' : 'absente',
      om_client_id:     cfg.om_client_id ? 'OK' : 'absent',
      om_client_secret: cfg.om_client_secret ? 'OK' : 'absent',
      mode_auth: cfg.om_auth_header ? 'cle directe'
               : ((cfg.om_client_id && cfg.om_client_secret) ? 'client_id/secret' : 'AUCUN'),
      om_merchant_key:  cfg.om_merchant_key ? 'OK' : 'MANQUANT',
      om_env: cfg.om_env,
      devise: endpoints(cfg.om_env).currency,
      webpay: endpoints(cfg.om_env).webpay,
      notif_url: cfg.om_notif_url || (baseUrl(req) + '/api/orange-pay/notif')
    };
    out.breaker_ouvert = breakerOuvert();
    try {
      const ipr = await fetchTimeout('https://api.ipify.org?format=json', {}, 6000);
      out.ipSortante = (await ipr.json()).ip;
    } catch (_) {}

    // On ne teste QUE le token : creer un vrai webpayment de test laisserait
    // une transaction fantome chez Orange.
    const t = await getToken(cfg);
    out.token = t ? 'obtenu (' + t.length + ' caracteres)' : null;
    out.variante_auth = varianteOk || null;
    out.ok = !!t;
  } catch (e) {
    out.erreur = e.message;
  }
  res.json(out);
});

/* --------------------------------------------------------------------------
 * Routeur SEPARE pour la redirection publique, monte a la racine (/pay/go).
 * On ne monte PAS le routeur complet deux fois : cela exposerait un second
 * webhook public (/pay/notif) et un second /pay/config — surface d'attaque
 * inutile pour un chemin qui touche a l'argent.
 * ------------------------------------------------------------------------*/
const goRouter = require('express').Router();
goRouter.get('/:id', async (req, res) => {
  try {
    const r = await Retrait.findById(req.params.id).select('omPayUrl omStatus');
    if (!r || !r.omPayUrl) return res.status(404).send('Paiement introuvable');
    if (r.omStatus === 'paid') return res.status(409).send('Paiement deja regle');
    return res.redirect(302, r.omPayUrl);
  } catch (e) {
    return res.status(500).send('Erreur');
  }
});

module.exports = router;
module.exports.goRouter      = goRouter;
module.exports.initPaiement  = initPaiement;
module.exports.getConfig     = getConfig;
