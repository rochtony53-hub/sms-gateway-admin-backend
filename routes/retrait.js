const router      = require('express').Router();
const auth        = require('../middleware/auth');
const apikey      = require('../middleware/apikey');
const Retrait     = require('../models/Retrait');
const UssdConfig  = require('../models/UssdConfig');
const Solde       = require('../models/Solde');
const Sms         = require('../models/Sms');
const { getRates } = require('./rate');

const DEFAULTS = {
  orange: { gp_depot:'', gp_retrait:'', tpe_depot:'', tpe_retrait:'' },
  mvola:  { gp_depot:'', gp_retrait:'', tpe_depot:'', tpe_retrait:'' },
  mvola_km: { gp_depot:'', gp_retrait:'', tpe_depot:'', tpe_retrait:'' },
  airtel: { gp_depot:'', gp_retrait:'', tpe_depot:'', tpe_retrait:'' },
};

function getOpKey(op) {
  const o = (op||'').toLowerCase();
    if (o.includes('comor') || o.includes('mvola_km') || o.includes('telma_km')) return 'mvola_km';
  if (o.includes('orange')) return 'orange';
  if (o.includes('yas')||o.includes('telma')||o.includes('mvola')) return 'mvola';
  if (o.includes('airtel')) return 'airtel';
  return null;
}

async function getUssdCode(operator, type) {
  const key = getOpKey(operator);
  if (!key) return null;

  const opts   = require('./settings').getOptions();
  const config = await UssdConfig.findOne({ operator: key });
  const def    = DEFAULTS[key] || {};
  let template = null;

  if (type === 'depot') {
    // tpe_depot ON → TPE, sinon GP
    template = (opts.tpe_depot && templateUtilisable(config?.tpe_depot || def.tpe_depot, 'depot', key))
      ? (config?.tpe_depot || def.tpe_depot)
      : (config?.gp_depot  || def.gp_depot || '');
  } else {
    // tpe_ret ON → TPE, sinon GP
    template = (opts.tpe_ret && templateUtilisable(config?.tpe_retrait || def.tpe_retrait, 'retrait', key))
      ? (config?.tpe_retrait || def.tpe_retrait)
      : (config?.gp_retrait  || def.gp_retrait || '');
  }
  return template || null;
}

/* ============================================================
 * VALIDATION DES MODELES USSD  (protection TPE)
 * ------------------------------------------------------------
 * Les champs TPE du panel sont pre-remplis avec des valeurs INCOMPLETES
 * ("#144#", "#145*") qui ne contiennent aucun marqueur {numero}/{montant}.
 * Enregistrees telles quelles, elles produisaient un code USSD qui ouvre
 * simplement le MENU de l'operateur au lieu d'executer la transaction.
 *
 * Le danger va plus loin qu'une transaction ratee : en mode retrait, le
 * service d'accessibilite est arme et aurait tape le code PIN dans le
 * premier champ de saisie du menu — donc a un endroit imprevisible.
 *
 * On refuse donc tout modele TPE incomplet et on retombe sur le Grand
 * Public, qui est connu pour fonctionner. Le refus est journalise pour
 * que l'administrateur sache exactement quoi corriger.
 * ============================================================ */
/* ============================================================
 * MODE DE SAISIE DU PIN, PAR OPERATEUR
 * ------------------------------------------------------------
 * Regle constatee sur le terrain, identique en Grand Public ET en TPE :
 *
 *   orange    : le PIN est demande A PART, dans une boite de dialogue.
 *               Le modele USSD ne doit donc PAS contenir {pin}.
 *   mvola     : tout part en une seule fois, PIN compris.
 *               Le modele DOIT contenir {pin}.
 *   mvola_km  : comme mvola.
 *
 * Un modele mal configure ne provoque pas une simple erreur, il bloque :
 *   - Orange avec {pin}  -> le PIN part dans le code, l'operateur affiche
 *     quand meme son invite, personne n'y repond, l'ecran reste fige.
 *   - MVola sans {pin}   -> la passerelle arme la saisie interactive et
 *     attend une invite de PIN qui n'arrivera jamais.
 * On refuse donc le modele et on le signale, plutot que de composer.
 * ============================================================ */
const PIN_DANS_LE_CODE = { orange: false, mvola: true, mvola_km: true };

/**
 * @returns null si le modele est coherent, sinon le motif du refus.
 */
function verifierModePin(template, opKey) {
  if (!template || !(opKey in PIN_DANS_LE_CODE)) return null;
  const attendu = PIN_DANS_LE_CODE[opKey];
  const present = String(template).includes('{pin}');
  if (attendu && !present)
    return 'le modele ' + opKey + ' doit contenir {pin} (le PIN part avec le code)';
  if (!attendu && present)
    return 'le modele ' + opKey + ' ne doit PAS contenir {pin} '
         + '(le PIN est saisi a part dans la boite de dialogue)';
  return null;
}

function templateUtilisable(template, type, opKey) {
  const t = String(template == null ? '' : template).trim();
  if (!t) return false;

  // La regle sur {pin} ne vaut que pour les RETRAITS : c'est la passerelle qui
  // compose et doit saisir le code secret. Un depot est tape par le CLIENT sur
  // son propre telephone, avec son propre code : le modele ne contient jamais
  // {pin}. Appliquer la regle au depot faisait rejeter tous les modeles de
  // depot MVola, qui retombaient silencieusement sur le Grand Public.
  if (opKey && type !== 'depot') {
    const souci = verifierModePin(t, opKey);
    if (souci) {
      console.warn('modele USSD ' + type + ' ignore : ' + souci + ' — "' + t
                 + '" — repli sur l\'autre canal');
      return false;
    }
  }

  // Un modele exploitable doit au minimum savoir OU envoyer et COMBIEN.
  const aMontant = t.includes('{montant}');
  const aCible   = t.includes('{numero}') || t.includes('{numeroGateway}');

  if (!aMontant || !aCible) {
    console.warn('modele USSD ' + type + ' ignore (incomplet, il manque '
      + (!aCible ? '{numero} ' : '') + (!aMontant ? '{montant}' : '')
      + ') : "' + t + '" — repli sur le Grand Public');
    return false;
  }
  return true;
}

function genSession(){ return 'S'+Date.now().toString(36).toUpperCase()+Math.floor(Math.random()*9000+1000); }

// PIN mobile money par operateur, stocke dans Settings (cle: ussd_pin_<operateur>).
// Sans PIN, le menu USSD s'arrete a la confirmation => le retrait reste "en attente".
async function getUssdPin(opKey) {
  try {
    const Settings = require('../models/Settings');
    // Orange double portefeuille : si le portefeuille "marchand" est actif, on
    // utilise le PIN dedie (ussd_pin_orange_marchand). Fallback sur le PIN
    // "tsotra" (ussd_pin_orange) si le PIN marchand n'est pas renseigne.
    if (String(opKey || '').toLowerCase() === 'orange'
        && String(await getSetting('orange_wallet_active', 'tsotra')).toLowerCase() === 'marchand') {
      const dm = await Settings.findOne({ key: 'ussd_pin_orange_marchand' });
      if (dm && dm.value && String(dm.value).trim() !== '') return String(dm.value).trim();
    }
    const d = await Settings.findOne({ key: 'ussd_pin_' + String(opKey || '').toLowerCase() });
    return (d && d.value) ? String(d.value).trim() : '';
  } catch (e) { return ''; }
}

/**
 * Orange double portefeuille : true si le portefeuille "marchand" est actif.
 * Concerne UNIQUEMENT Orange (les autres operateurs renvoient toujours false).
 * Piloté par le Setting global "orange_wallet_active" (tsotra | marchand).
 */
async function orangeMarchandActif(opKey) {
  if (String(opKey || '').toLowerCase() !== 'orange') return false;
  return String(await getSetting('orange_wallet_active', 'tsotra')).toLowerCase() === 'marchand';
}

// PIN a saisir SEPAREMENT par le gateway.
// Regle simple et sans reglage supplementaire :
//   - le modele contient {pin}  -> le PIN est integre au code (ancien mode)
//   - le modele ne contient PAS {pin} -> le PIN est renvoye a part, le gateway
//     le tape quand l'operateur affiche "Entrez votre code secret" (cas Orange,
//     qui refuse un code USSD complet contenant deja le PIN).
async function getSeparatePin(template, opKey) {
  if (!opKey || !template || String(template).includes('{pin}')) return '';
  return await getUssdPin(opKey);
}

/* ============================================================
 * MATRICE OPERATEURS (retrait)
 * ------------------------------------------------------------
 *   orange    : PIN tape a l'invite, DEUX ecrans de saisie
 *   mvola     : PIN concatene dans le code USSD ({pin}), un seul envoi
 *   mvola_km  : idem mvola (Comores)
 *   airtel    : AUCUN service de retrait
 * ============================================================ */
const RETRAIT_INTERDIT = ['airtel'];

/** Nombre d'ecrans de saisie que le gateway doit remplir. */
const ETAPES_DEFAUT = { orange: 2, mvola: 1, mvola_km: 1 };

async function getSetting(cle, defaut) {
  try {
    const Settings = require('../models/Settings');
    const d = await Settings.findOne({ key: cle });
    return (d && d.value !== undefined && d.value !== null && String(d.value) !== '')
      ? String(d.value).trim() : defaut;
  } catch (e) { return defaut; }
}

/**
 * Nombre d'ecrans attendus, surchargeable par operateur via Settings
 * (cle: ussd_steps_<operateur>) sans nouvelle mise en production.
 */
async function getMaxSteps(opKey) {
  const defaut = ETAPES_DEFAUT[opKey] || 1;
  const v = parseInt(await getSetting('ussd_steps_' + opKey, String(defaut)), 10);
  if (!Number.isFinite(v) || v < 1 || v > 4) return defaut;
  return v;
}

/**
 * Reponse a taper sur un ecran de saisie qui n'est PAS une demande de code
 * secret (menu de confirmation). Vide par defaut : le gateway ne tape alors
 * rien et remonte le texte de l'ecran, pour que l'admin voie quoi configurer
 * plutot que d'envoyer une valeur au hasard.
 */
/**
 * Pause entre deux retraits USSD, en millisecondes (cle: ussd_gap_ms).
 * Les limites de cadence des operateurs malgaches ne sont pas publiees :
 * on reste large par defaut (3 s) et on garde la possibilite de ralentir
 * sans redeployer si un refus lie au rythme est constate.
 */
async function getGapMs() {
  const v = parseInt(await getSetting('ussd_gap_ms', '3000'), 10);
  if (!Number.isFinite(v) || v < 1000 || v > 60000) return 3000;
  return v;
}

async function getMenuReply(opKey) {
  const v = await getSetting('ussd_menu_' + opKey, '');
  return /^[0-9]{1,3}$/.test(v) ? v : '';
}

async function buildUssd(template, numero, montant, numeroGateway, opKey) {
  if (!template) return null;
  const pin = opKey ? await getUssdPin(opKey) : '';
  return template
    .split('{numeroGateway}').join(numeroGateway || '')
    .split('{numero}').join(numero)
    .split('{montant}').join(montant)
    .split('{pin}').join(pin);
}

// POST /api/retrait — créer un retrait
router.post('/', auth, async (req, res) => {
  try {
    const { operator, numero, montant, type='retrait', clientId='', provider='', providerId='', clientRef='' } = req.body;
    if (!operator||!numero||!montant)
      return res.status(400).json({ error: 'operator, numero, montant requis' });
    // VIRGULE: "1,50" -> 1.50 (saisie FR mahazatra)
    const montantSaisi = Number(String(montant).replace(/\s/g,'').replace(',','.'));
    if (!montantSaisi || montantSaisi <= 0)
      return res.status(400).json({ error: 'montant invalide' });

    // Idempotence : raha efa nisy ordre mitovy clientRef (retry client-api),
    // averina ilay efa voaforona fa tsy mamorona vaovao (tsy doublon).
    if (clientRef) {
      const dup = await Retrait.findOne({ clientRef });
      if (dup) return res.json({ ok: true, ussdCode: dup.ussdCode, channel: dup.channel, id: dup._id, sessionId: dup.sessionId, dedup: true });
    }

    // === Conversion USD -> Ar/Fc (raha fournisseur Deriv) ===
    // Comores (mvola_km): cours manokana (1 USD = ? Fc) + devise Fc
    const isKm = getOpKey(operator) === 'mvola_km';
    let montantUsd = 0, rate = 0, devise = isKm ? 'Fc' : 'Ar';
    let montantFinal = montantSaisi;
    if (provider && provider.toLowerCase() === 'deriv') {
      const rates = await getRates();
      rate = (type === 'depot')
        ? (isKm ? rates.rate_depot_km : rates.rate_depot)
        : (isKm ? rates.rate_retrait_km : rates.rate_retrait);
      if (isKm && !rate)
        return res.status(400).json({ error: 'Cours Comores (Fc) non configuré — voir Paramètres admin' });
      montantUsd = montantSaisi;
      montantFinal = Math.round(montantUsd * rate);
      devise = 'USD';
    }
    const template = await getUssdCode(operator, type);
    // DEPOT: ny code USSD mampiasa ny numéro Gateway (mandray vola), fa tsy ny client.
    let ussdNumero = numero;
    let numeroGateway = null;
    if (type === 'depot') {
      const cfg = await UssdConfig.findOne({ operator: getOpKey(operator) });
      if (cfg && cfg.gatewayNumero) {
        ussdNumero = cfg.gatewayNumero;
        numeroGateway = cfg.gatewayNumero;
      }
    }
    // Le numero de la passerelle doit alimenter LES DEUX marqueurs. Avant, seul
    // {numero} etait renseigne : un modele de depot ecrit avec {numeroGateway}
    // — pourtant accepte par la validation — produisait un code tronque du type
    // "#144*1**5000#", que l'operateur rejette. Le depot ne fonctionnait alors
    // pas du tout, sans message d'erreur.
    const ussdCode = await buildUssd(template, ussdNumero, montantFinal,
                                     numeroGateway, getOpKey(operator));
    // PIN separe : le gateway le tape a l'invite operateur (Orange). Vide si {pin}
    // est deja dans le modele (PIN integre au code).
    const ussdPin = await getSeparatePin(template, getOpKey(operator));
    const opts     = require('./settings').getOptions();
    // FIX: Airtel tsy misy TPE/GP -- channel = null (esorina ny badge)
  const opKeyForChannel = getOpKey(operator);
  const channel = opKeyForChannel === 'airtel'
    ? null
    : ((type==='depot' ? opts.tpe_depot : opts.tpe_ret) ? 'TPE' : 'Grand Public');

    const opKey = getOpKey(operator) || operator;
    const montantNum = montantFinal;

    // Validation: mihazo montant (solde tena izy) FOANA na ON na OFF
    if (type === 'retrait') {
      const solde = await Solde.findOne({ operator: opKey });
      const soldeTenaIzy = solde ? (solde.montant || 0) : 0;
      if (soldeTenaIzy < montantNum) {
        return res.status(400).json({ error: 'Solde insuffisant', solde: soldeTenaIzy, demande: montantNum });
      }
    }

    const sessionId = genSession();
    const retrait = new Retrait({
      operator: opKey,
      numero, montant: montantNum,
      type, ussdCode, ussdPin, channel, sessionId,
      clientId, provider, providerId, clientRef,
      montantUsd, rate, devise,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60*60*1000) // FIX: 1h limite de validite
    });
    await retrait.save();

    // ===== FENETRE 1h: vola nalefa MIALOHA ny ordre =====
    // Raha nisy SMS "matched" (template OK fa tsy nisy ordre tamin'izay) tao
    // anatin'ny 1 ora farany, mitovy numero mpandefa sy montant (tolerance
    // +10%), dia avy hatrany no manamarina ity ordre depot ity.
    if (type === 'depot') {
      (async () => {
        try {
          const smsMod = require('./sms');
          const Sms = require('../models/Sms');
          const oneHourAgo = new Date(Date.now() - 60*60*1000);
          const orphans = await Sms.find({
            status: 'matched',
            $or: [ { retraitId: null }, { retraitId: { $exists: false } } ],
            receivedAt: { $gte: oneHourAgo }
          }).sort({ receivedAt: -1 }).limit(20).lean();
          for (const sm of orphans) {
            if (smsMod.getOpKeySms(sm.operator) !== opKey) continue;
            const numSms = smsMod.extractNumeroFromSms(sm.message);
            if (numSms && numSms !== numero) continue;
            const mSms = smsMod.parseMontant(sm.message);
            if (mSms == null) continue;
            if (!smsMod.montantDepotOk("depot", mSms, montantFinal)) continue;
            console.log('[FENETRE 1h] SMS kamboty mifanandrify -> validation ordre', String(retrait._id));
            await smsMod.autoValidate(sm.operator, sm.message, sm._id);
            break;
          }
        } catch(eW) { console.error('fenetre 1h:', eW.message); }
      })();
    }

    // FIX: RETRAIT = serveur mandefa command USSD any amin'ny APK gateway
    // (server-side automatique, tsy webview/client). DEPOT = client mandefa
    // USSD ny tenany (numeroGateway efa hita ao amin'ny ussdCode).
    if (type === 'retrait') {
      if (provider && provider.toLowerCase() === 'deriv') {
        // Safidy 1: miandry credited (poll statement) vao mandefa Mobile Money.
      } else {
        dispatchUssdRetrait(retrait).catch(e => console.error('dispatchUssdRetrait:', e));
      }
    }

    res.json({ ok: true, ussdCode, channel, id: retrait._id, sessionId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/retrait — liste retraits
router.get('/', auth, async (req, res) => {
  try {
    const { page=1, limit=50, status, type, operator } = req.query;
    const filter = {};
    if (status)   filter.status   = status;
    if (type)     filter.type     = type;     // FIX: 'depot' ou 'retrait'
    if (operator) filter.operator = operator;
    const total = await Retrait.countDocuments(filter);
    let data  = await Retrait.find(filter)
      .sort({ createdAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit))
      .lean();
    const ids = data.map(d => d._id);
    const smsList = await Sms.find({ retraitId: { $in: ids } }).select('retraitId message').lean();
    const smsMap = {};
    smsList.forEach(sm => { if (sm.retraitId) smsMap[String(sm.retraitId)] = sm.message; });
    data = data.map(d => ({ ...d, smsTemplate: smsMap[String(d._id)] || '' }));
    res.json({ total, page: Number(page), data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/retrait/:id/status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    if (!req.user || !['admin','superadmin'].includes(req.user.role))
      return res.status(403).json({ error: 'Acces refuse: admin requis' });
    const { status } = req.body;
    // Ampiharo ny solde rehefa VALIDÉ (success) ihany — indray mandeha
    if (status === 'success') {
      const cur = await Retrait.findById(req.params.id);
      if (cur && cur.status !== 'success') {
        // Cle normalisee obligatoire : l'operateur brut ("yas", "Orange Money")
        // creait un document Solde parallele, et le total devenait faux.
        const delta = cur.type === 'depot' ? cur.montant : -cur.montant;
        await require('./soldeService')
          .soldeMouvement(cur.operator, delta, 'validation manuelle');
      }
    }
    const r = await Retrait.findByIdAndUpdate(
      req.params.id,
      { status, updatedAt: new Date() },
      { returnDocument: 'after' }
    );
    if (!r) return res.status(404).json({ error: 'Retrait non trouvé' });
    res.json({ ok: true, retrait: r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// GET /api/retrait/deriv-diag — DIAGNOSTIC connexion agent Deriv (admin).
// Vérifie : config, agent_id (GET /agents/me), limites min/max USD. Sert à
// valider que le retrait FONCTIONNERA avant tout retrait client réel.
router.get('/deriv-diag', auth, async (req, res) => {
  // DIAGNOSTIC — teste l'endpoint RÉEL /transfer/{id} (confirmé par Deriv/Amy),
  // avec un request_id bidon => NE DÉPLACE AUCUN ARGENT. Distingue clairement :
  //  • 404/introuvable   -> base URL + auth + scope OK  => 🟢 prêt
  //  • 401/403           -> token invalide ou scope "Payments" manquant
  //  • erreur réseau/DNS -> base URL Deriv injoignable (DERIV_REST_BASE)
  const out = { config: {}, base: null, ok: false };
  try {
    const { getDerivConfig } = require('./deriv');
    const { restTransferStatus, getRestBase } = require('./derivRest');
    const cfg = await getDerivConfig();
    out.config = {
      app_id: cfg.deriv_app_id ? 'OK' : 'MANQUANT',
      token: cfg.deriv_token ? ('OK (' + String(cfg.deriv_token).slice(0, 4) + '…)') : 'MANQUANT'
    };
    out.base = (typeof getRestBase === 'function') ? getRestBase() : '(inconnu)';
    if (!cfg.deriv_app_id || !cfg.deriv_token) {
      out.error = 'App ID ou Token Deriv manquant (Réglages admin).';
      return res.status(400).json(out);
    }
    try {
      // request_id volontairement inexistant : lecture seule, aucun transfert créé
      await restTransferStatus('DIAG-' + Date.now());
      out.ok = true;
      out.detail = 'Connexion + authentification Deriv OK (le transfert est prêt).';
    } catch (e) {
      const st = e.httpStatus, code = String(e.code || ''), msg = String(e.message || '');
      const blob = (code + ' ' + msg).toLowerCase();
      // "request_id introuvable" (RequestIDNotFound, HTTP 400) = SUCCÈS : l'endpoint
      // répond, l'auth passe, le scope est bon — seul notre request_id bidon n'existe pas.
      const notFound = st === 404 || /requestidnotfound|request.?id.?not.?found|not.?found|introuvable|no.?such|unknown.?request|invalid.?request.?id/i.test(blob);
      if (st === 401 || st === 403) {
        out.error = 'Token invalide ou scope "Payments" manquant. Créez un jeton API sur le compte Payment Agent AVEC le scope Payments.';
      } else if (!st && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|réseau|network|fetch failed|getaddrinfo/i.test(msg)) {
        // erreur réseau (pas de httpStatus) => base URL injoignable
        out.error = 'Base URL Deriv injoignable (' + out.base + '). Vérifiez l\'URL REST auprès de Deriv (variable DERIV_REST_BASE).';
      } else if (notFound) {
        out.ok = true;  // endpoint + auth + scope OK, request_id bidon absent => PARFAIT
        out.detail = 'Connexion + authentification Deriv OK (scope Payments valide). Le dépôt/retrait est prêt !';
      } else if (st) {
        out.error = 'Réponse Deriv inattendue [HTTP ' + st + ']: ' + (code || msg);
      } else {
        out.error = 'Réponse Deriv inattendue: ' + msg;
      }
    }
    // Toujours 200/400 — JAMAIS 401/403 (sinon l'admin se déconnecte).
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e) {
    out.error = 'Erreur diagnostic: ' + (e.message || '');
    res.status(400).json(out);
  }
});

// GET /api/retrait/:id/diag-ussd — DIAGNOSTIC (admin).
// Parcourt TOUTE la chaine d'un retrait et dit exactement ou elle se bloque,
// au lieu de laisser un retrait "processing" sans explication.
router.get('/:id/diag-ussd', auth, async (req, res) => {
  const out = { etapes: [], bloque: null };
  const ok   = (t, d) => out.etapes.push({ etape: t, statut: 'OK',      detail: d || '' });
  const ko   = (t, d) => { out.etapes.push({ etape: t, statut: 'BLOQUE', detail: d || '' });
                           if (!out.bloque) out.bloque = t + ' — ' + (d || ''); };
  const info = (t, d) => out.etapes.push({ etape: t, statut: 'INFO',    detail: d || '' });
  try {
    const r = await Retrait.findById(req.params.id);
    if (!r) return res.status(400).json({ error: 'Retrait introuvable' });
    out.retrait = {
      id: String(r._id), status: r.status, receptionStatus: r.receptionStatus,
      operator: r.operator, numero: r.numero, montant: r.montant,
      provider: r.provider, ussdCode: r.ussdCode || '(vide)',
      ussdPin: r.ussdPin ? ('fourni (' + String(r.ussdPin).length + ' chiffres)') : '(aucun)',
      response: r.response || '(vide)', createdAt: r.createdAt, updatedAt: r.updatedAt
    };

    // 1) Fournisseur
    if (r.status === 'pending') ko('1. Fournisseur (Deriv/Betwinner)',
      'Toujours en attente de confirmation — aucun mobile money ne doit partir.');
    else ok('1. Fournisseur (Deriv/Betwinner)', 'Confirme (statut: ' + r.status + ')');

    // 2) Operateur reconnu
    const opKey = getOpKey(r.operator) || r.operator;
    const keyword = operatorNameToKeyword(opKey);
    if (!keyword) ko('2. Operateur reconnu', 'operator="' + r.operator + '" non reconnu');
    else ok('2. Operateur reconnu', opKey + ' -> SIM recherchee: "' + keyword + '"');

    // 3) Code USSD configure
    const config = await UssdConfig.findOne({ operator: opKey });
    const opts   = require('./settings').getOptions();
    const def    = DEFAULTS[opKey] || {};
    // Meme validation que dans getUssdCode : un modele TPE incomplet ne doit
    // jamais etre compose, surtout ici ou le PIN est arme.
    const template = (opts.tpe_ret && templateUtilisable(config?.tpe_retrait || def.tpe_retrait, 'retrait', opKey))
      ? (config?.tpe_retrait || def.tpe_retrait)
      : (config?.gp_retrait  || def.gp_retrait || '');
    if (!template) ko('3. Code USSD de retrait', 'Aucun code configure (Admin > Codes USSD)');
    else {
      ok('3. Code USSD de retrait', template);
      const pinDb = await getUssdPin(opKey);
      if (template.includes('{pin}')) {
        if (!pinDb) ko('4. PIN Mobile Money',
          'Le code contient {pin} mais AUCUN PIN enregistre -> le PIN sera vide et le menu USSD s\'arretera.');
        else ok('4. PIN Mobile Money', 'PIN integre au code (' + pinDb.length + ' chiffres)');
      } else if (!pinDb) {
        if (opKey === 'orange' || opKey === 'mvola' || opKey === 'mvola_km') ko('4. PIN Mobile Money',
          'AUCUN PIN enregistre. ' + opKey.toUpperCase() + ' demande le code secret pour valider l\'envoi : '
          + 'le menu USSD s\'arretera a l\'invite et l\'argent ne partira pas. '
          + 'Renseignez le PIN dans Admin > Codes USSD.');
        else info('4. PIN Mobile Money',
          'Aucun PIN enregistre et pas de {pin} dans le code. OK seulement si l\'operateur n\'en demande pas.');
      } else {
        ok('4. PIN Mobile Money',
          'Mode separe : le gateway tapera le PIN a l\'invite (' + pinDb.length + ' chiffres). ' +
          'Le service d\'accessibilite doit etre ACTIVE sur le telephone.');
      }
    }

    // 5) Appareil gateway
    const Device = require('../models/Device');
    const tous = await Device.find({}).select('deviceId online sims lastSeen pendingCmds').sort({ lastSeen: -1 }).limit(10);
    const VIVANT_MS = 3 * 60 * 1000;
    const minutesDepuis = d => d.lastSeen
      ? Math.round((Date.now() - new Date(d.lastSeen)) / 60000) : null;
    out.appareils = tous.map(d => {
      const min = minutesDepuis(d);
      return {
        deviceId: d.deviceId,
        actif: !!(d.online && min !== null && min * 60000 < VIVANT_MS),
        dernierContact: min === null ? 'jamais' : ('il y a ' + min + ' min'),
        sims: d.sims || '(aucune)',
        commandesEnAttente: Array.isArray(d.pendingCmds) ? d.pendingCmds.length : 0
      };
    });
    if (!tous.length) ko('5. Appareil gateway', 'Aucun appareil enregistre.');
    else {
      let dev = tous.filter(d => {
        const min = minutesDepuis(d);
        return d.online && min !== null && min * 60000 < VIVANT_MS
               && keyword && new RegExp(keyword, 'i').test(d.sims || '');
      });
      dev = dev.filter(d => (opKey === 'mvola_km')
        ? KM_DEVICE_REGEX.test(d.deviceId || '')
        : !KM_DEVICE_REGEX.test(d.deviceId || ''));
      if (!dev.length) ko('5. Passerelle active',
        'Aucune passerelle ayant contacte le serveur depuis moins de 3 min avec une SIM "'
        + keyword + '". Ouvrez l\'application sur le telephone et demarrez le service.');
      else ok('5. Passerelle active',
        dev.map(d => d.deviceId + ' (' + (minutesDepuis(d)) + ' min)').join(', '));
    }

    // 6) Commande deja transmise ?
    const enFile = tous.some(d => (d.pendingCmds || []).some(c =>
      c && typeof c === 'object' && String(c.retraitId) === String(r._id)));
    if (enFile) {
      const porteur = tous.find(d => (d.pendingCmds || []).some(c =>
        c && typeof c === 'object' && String(c.retraitId) === String(r._id)));
      const min = porteur ? minutesDepuis(porteur) : null;
      if (min === null || min * 60000 >= VIVANT_MS) ko('6. Commande USSD',
        'La commande attend sur ' + (porteur ? porteur.deviceId : '?')
        + ', qui n\'a pas contacte le serveur depuis ' + (min === null ? 'toujours' : (min + ' min'))
        + '. La passerelle recupere ses commandes a chaque heartbeat (30 s) : elle est donc arretee.');
      else info('6. Commande USSD',
        'En file sur ' + porteur.deviceId + ' (contact il y a ' + min + ' min) — livraison au prochain heartbeat.');
    }
    else if (r.ussdCode) ok('6. Commande USSD', 'Deja transmise a la passerelle.');
    else info('6. Commande USSD', 'Jamais construite — voir les etapes bloquees ci-dessus.');

    // 7) Solde operateur (piege classique : bloque le passage en succes)
    try {
      const Solde = require('../models/Solde');
      const sol = await Solde.findOne({ operator: opKey });
      const bal = sol?.montant || 0;
      if (bal < r.montant) ko('7. Solde operateur (admin)',
        'Solde enregistre ' + bal + ' < montant ' + r.montant +
        ' -> meme si le SMS arrive, le retrait NE passera PAS en succes. Corrigez le solde dans l\'admin.');
      else ok('7. Solde operateur (admin)', bal + ' >= ' + r.montant);
    } catch (e) { info('7. Solde operateur (admin)', 'Non verifiable: ' + e.message); }

    if (!out.bloque) out.bloque = 'Aucun blocage detecte — en attente du SMS de l\'operateur.';
    res.json(out);
  } catch (e) {
    out.error = e.message;
    res.status(400).json(out);   // jamais 401/403 : sinon l'admin se deconnecte
  }
});

// GET /api/retrait/:id/public-status — suivi PUBLIC (vitrine/webview).
// Ne renvoie aucune donnee sensible : juste l'avancement pour afficher
// "en attente" jusqu'au succes du mobile money.
router.get('/:id/public-status', async (req, res) => {
  try {
    const r = await Retrait.findById(req.params.id)
      .select('status receptionStatus montant devise operator provider response createdAt updatedAt');
    if (!r) return res.status(404).json({ error: 'introuvable' });
    const st = String(r.status || '');
    // etape lisible par le client
    let etape = 'attente', msg = 'Traitement en cours…';
    if (st === 'pending')          { etape = 'deriv';    msg = 'Confirmation ' + (r.provider || 'fournisseur') + ' en cours…'; }
    else if (st === 'processing')  { etape = 'envoi';    msg = 'Envoi du mobile money en cours…'; }
    else if (st === 'success')     { etape = 'succes';   msg = 'Mobile money envoye avec succes.'; }
    else if (st === 'failed')      { etape = 'echec';    msg = r.response || 'Echec du retrait.'; }
    res.json({
      ok: true, id: String(r._id), status: st, etape, message: msg,
      montant: r.montant, devise: r.devise || 'Ar', operator: r.operator,
      done: (st === 'success' || st === 'failed'),
      updatedAt: r.updatedAt || r.createdAt
    });
  } catch (e) { res.status(400).json({ error: 'id invalide' }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const r = await Retrait.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Commande non trouvee' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/retrait/clear — vider tout l'historique
router.delete('/clear', auth, async (req, res) => {
  try {
    await Retrait.deleteMany({});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/retrait/:id — supprimer un retrait
router.delete('/:id', auth, async (req, res) => {
  try {
    const r = await Retrait.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ error: 'Retrait non trouvé' });
    res.json({ ok: true, deleted: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/retrait/public/:id — lecture limitee WebView (sans token)
router.get('/public/:id', async (req, res) => {
  try {
    const r = await Retrait.findById(req.params.id)
      .select('type operator numero montant montantUsd rate devise ussdCode channel status createdAt sessionId');
    if (!r) return res.status(404).json({ error: 'Commande non trouvee' });
    let gatewayNumero = '';
    try { const cfg = await UssdConfig.findOne({ operator: getOpKey(r.operator) }); if (cfg) gatewayNumero = cfg.gatewayNumero || ''; } catch(_){}
    const out = r.toObject(); out.gatewayNumero = gatewayNumero;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/retrait/public/:id/processing — pending -> processing
router.post('/public/:id/processing', async (req, res) => {
  try {
    const r = await Retrait.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { status: 'processing', updatedAt: new Date() },
      { returnDocument: 'after' }
    );
    if (!r) return res.status(409).json({ error: 'Etat non modifiable' });
    res.json({ ok: true, status: r.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// FIX: mitady appareil online izay manana SIM mifanaraka amin'ny operateur
function operatorNameToKeyword(opKey) {
  if (opKey === 'orange') return 'Orange';
  if (opKey === 'mvola')  return 'MVola';
  if (opKey === 'mvola_km') return 'MVola'; // SIM Telma Comores dia "Telma/MVola" ihany
  if (opKey === 'airtel') return 'Airtel';
  return null;
}

// Appareil COMORES = deviceId misy "KM" na "COMOR" (apetraky ny admin ao
// amin'ny APK). Izay no manavaka azy amin'ny appareil Madagasikara.
const KM_DEVICE_REGEX = /(km|comor)/i;

// Ecrit la raison d'un blocage dans le retrait : sans cela, un retrait reste
// "processing" sans aucune explication visible dans l'admin.
async function traceRetrait(retraitId, message) {
  console.error('dispatchUssdRetrait:', message);
  try {
    await Retrait.findByIdAndUpdate(retraitId, { response: message, updatedAt: new Date() });
  } catch (e) { /* la trace ne doit jamais casser le flux */ }
}

async function dispatchUssdRetrait(retrait) {
  try {
    const opKey = getOpKey(retrait.operator) || retrait.operator;

    // Airtel n'offre aucun service de retrait : ne jamais composer de code,
    // et le dire clairement plutot que de laisser le retrait en attente.
    if (RETRAIT_INTERDIT.includes(opKey) && retrait.type !== 'depot') {
      // traceRetrait ecrit dans le meme champ "response" : on le laisse d'abord
      // journaliser, puis on ecrit le motif definitif vu par le client.
      await traceRetrait(retrait._id,
        'BLOQUE: aucun service de retrait pour ' + opKey.toUpperCase());
      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed',
        response: 'Retrait indisponible pour ' + opKey.toUpperCase()
                + ' : cet operateur n\'offre pas de service de retrait.',
        updatedAt: new Date()
      });
      return;
    }

    const keyword = operatorNameToKeyword(opKey);
    if (!keyword) {
      await traceRetrait(retrait._id,
        'BLOQUE: operateur "' + retrait.operator + '" non reconnu (attendu: orange / mvola / airtel / mvola_km)');
      return;
    }

    const config = await UssdConfig.findOne({ operator: opKey });
    const opts   = require('./settings').getOptions();
    const def    = DEFAULTS[opKey] || {};
    // Orange double portefeuille : si "marchand" actif, modele + numero gateway
    // dedies (Settings), avec fallback sur "tsotra". N'affecte QUE Orange.
    const marchand = await orangeMarchandActif(opKey);
    let gpRetrait = config?.gp_retrait || def.gp_retrait || '';
    let gwNumero  = config?.gatewayNumero;
    if (marchand) {
      const mTpl = await getSetting('orange_marchand_gp_retrait', '');
      if (mTpl) gpRetrait = mTpl;
      const mGw = await getSetting('orange_marchand_gateway', '');
      if (mGw) gwNumero = mGw;
    }
    // Meme validation que dans getUssdCode : un modele TPE incomplet ne doit
    // jamais etre compose, surtout ici ou le PIN est arme.
    const template = (opts.tpe_ret && templateUtilisable(config?.tpe_retrait || def.tpe_retrait, 'retrait', opKey))
      ? (config?.tpe_retrait || def.tpe_retrait)
      : gpRetrait;
    if (!template) {
      await traceRetrait(retrait._id,
        'BLOQUE: aucun code USSD de retrait configure pour ' + opKey + ' (Admin > Codes USSD)');
      return;
    }

    // numero CLIENT (mahazo vola) -- TSY numeroGateway, satria retrait = vola
    // mankany amin'ny client
    const ussdCode = await buildUssd(template, retrait.numero, retrait.montant, gwNumero, opKey);
    // PIN separe (Orange) : non concatene au code, saisi a l'invite par le gateway
    const ussdPin = await getSeparatePin(template, opKey);

    // ------------------------------------------------------------------
    // GARDE-FOU : operateur a PIN separe, mais aucun PIN enregistre.
    // ------------------------------------------------------------------
    // Sans ce controle, ussdPin part vide, l'APK bascule en mode one-shot
    // (TelephonyManager.sendUssdRequest) qui ne sait PAS repondre a l'invite
    // "Ampidiro ny kaody miafina". L'operateur affiche sa boite, personne n'y
    // repond, et le retrait reste fige — exactement le bug d'origine, ramene
    // cette fois par un simple oubli de configuration.
    // On refuse donc d'envoyer, avec un message qui dit quoi corriger.
    // ------------------------------------------------------------------
    if (PIN_DANS_LE_CODE[opKey] === false && !ussdPin) {
      const motif = 'PIN Mobile Money non enregistre pour ' + opKey.toUpperCase()
                  + ' — enregistrez-le dans Admin > Codes USSD avant tout retrait.';
      await traceRetrait(retrait._id, 'BLOQUE: ' + motif);
      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed', response: motif, updatedAt: new Date()
      });
      return;
    }

    // Symetrique : operateur a PIN integre, mais aucun PIN enregistre ->
    // le code partirait tronque (".. *500*#") et l'operateur le rejetterait.
    // On interroge le PIN directement : chercher un motif dans le code final
    // est fragile, car le separateur varie selon le modele.
    const pinIntegre = PIN_DANS_LE_CODE[opKey] === true
                       ? await getUssdPin(opKey) : null;
    if (PIN_DANS_LE_CODE[opKey] === true && !pinIntegre) {
      const motif = 'PIN Mobile Money non enregistre pour ' + opKey.toUpperCase()
                  + ' — le code USSD serait incomplet. Enregistrez-le dans '
                  + 'Admin > Codes USSD.';
      await traceRetrait(retrait._id, 'BLOQUE: ' + motif);
      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed', response: motif, updatedAt: new Date()
      });
      return;
    }

    // Mitady appareil ONLINE izay manana SIM mifanaraka (sims contient le keyword)
    const Device = require('../models/Device');
    // "online" seul ne suffit pas : rien ne le repasse a false quand le telephone
    // se deconnecte. Un appareil mort resterait "en ligne" et recevrait les
    // commandes dans le vide. On exige donc un heartbeat RECENT.
    const VIVANT_MS = 3 * 60 * 1000;   // heartbeat toutes les 30 s cote APK
    const limite = new Date(Date.now() - VIVANT_MS);
    let devices = await Device.find({
      online: true,
      lastSeen: { $gte: limite },
      sims: { $regex: keyword, $options: 'i' }
    }).sort({ lastSeen: -1 });
    // Comores: appareil KM ihany ; Madagasikara: esorina ny appareil KM
    devices = devices.filter(dv => (opKey === 'mvola_km')
      ? KM_DEVICE_REGEX.test(dv.deviceId || '')
      : !KM_DEVICE_REGEX.test(dv.deviceId || ''));

    if (!devices.length) {
      // On liste ce qui EXISTE pour que l'admin voie pourquoi rien ne correspond
      let vus = '';
      try {
        const tous = await Device.find({}).select('deviceId online sims lastSeen').limit(10);
        vus = tous.map(d => {
          const min = d.lastSeen ? Math.round((Date.now() - new Date(d.lastSeen)) / 60000) : null;
          return (d.deviceId || '?') + '[sims=' + (d.sims || 'aucune')
               + ', dernier contact ' + (min === null ? 'jamais' : ('il y a ' + min + ' min')) + ']';
        }).join(' ; ') || 'aucun appareil enregistre';
      } catch (e5) {}
      const motif = 'Aucune passerelle ACTIVE avec une SIM "' + keyword + '" pour ' + opKey
        + '. Ouvrez l\'application sur le telephone gateway et demarrez le service. Appareils: ' + vus;
      await traceRetrait(retrait._id, 'BLOQUE: ' + motif);
      // ------------------------------------------------------------------
      // Le retrait doit passer en 'failed', pas rester en 'processing'.
      // Sinon il reste indefiniment en attente d'un SMS qui n'arrivera
      // jamais : aucun code USSD n'a ete compose, aucun argent n'est parti.
      // Le laisser en 'processing' le rendait invisible — c'est exactement
      // le symptome d'origine, sous une autre cause.
      // ------------------------------------------------------------------
      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed', response: motif, updatedAt: new Date()
      });
      return;
    }

    // Mandefa amin'ny appareil VOALOHANY hita ihany (tsy ny rehetra, mba tsy
    // hisy appareil roa samy manatanteraka ny code USSD mitovy)
    const device = devices[0];
    // Persiste le code REELLEMENT envoye (visible dans l'admin pour diagnostic)
    try {
      await Retrait.findByIdAndUpdate(retrait._id, { ussdCode, ussdPin, updatedAt: new Date() });
    } catch (e4) {}
    const maxSteps  = await getMaxSteps(opKey);
    const menuReply = await getMenuReply(opKey);
    await Device.findByIdAndUpdate(device._id, {
      $push: {
        pendingCmds: {
          type: 'ussd_retrait',
          retraitId: String(retrait._id),
          ussdCode,
          ussdPin,          // '' = PIN deja dans ussdCode ; sinon a taper a l'invite
          operator: opKey,
          // Orange Money demande DEUX saisies successives ; MVola une seule
          // (PIN deja concatene). Sans cette information le gateway s'arretait
          // apres le premier ecran et la transaction ne partait jamais.
          maxSteps,
          menuReply,
          gapMs: await getGapMs()
        }
      }
    });
    // Trace de succes : l'admin voit que la commande est partie, vers quel
    // appareil, et si un PIN separe l'accompagne.
    await traceRetrait(retrait._id,
      'USSD envoye a ' + (device.deviceId || device._id) + ' : ' + ussdCode
      + (ussdPin ? ' [PIN separe fourni]' : ' [PIN inclus ou non requis]')
      + ' — en attente du SMS operateur');
  } catch(e) {
    console.error('dispatchUssdRetrait error:', e.message);
  }
}


// POST /api/retrait/:id/ussd-result -- APK mandefa ny vokatry ny USSD retrait
// (apikey, tsy auth -- ny APK no miantso ity)
/* ============================================================
 * Analyse du texte renvoye par l'operateur apres un code USSD.
 * On ne conclut JAMAIS au succes ici : seul le SMS operateur fait foi
 * (autoValidate dans routes/sms.js). Le but est uniquement de ne plus
 * laisser passer pour "en cours" une invite PIN restee sans reponse.
 * ============================================================ */
const PIN_PROMPT_PATTERNS = [
  /kaody\s*miafina/i,        // mg : "Ampidiro ny kaody miafina"
  /code\s*(secret|pin)/i,    // fr : "entrer votre code secret"
  /\bpin\b/i,
  /mot\s*de\s*passe/i,
  /enter\s+your\s+(pin|code)/i,
  /ampidiro/i
];

const ERREUR_PATTERNS = [
  // "Votre solde est insuffisant" : le motif d'origine exigeait "solde" et
  // "insuffisant" COLLES, il ne reconnaissait donc pas la formulation reelle
  // des operateurs. L'echec etait bien detecte (repli 'inconnu'), mais affiche
  // comme "ecran non reconnu" au lieu du vrai motif.
  /solde[^.\n]{0,30}insuffisant/i,
  /insuffisant[^.\n]{0,30}solde/i,
  /solde\s*(insuffisant|tsy\s*ampy)/i,
  /tsy\s*ampy/i,
  /insufficient/i,
  /incorrect|invalide|invalid|erreur|error|diso/i,
  /echec|echoue|failed|tsy\s*nahomby/i,
  /expire|expired|lany\s*daty/i,
  /numero\s*(invalide|inconnu)/i,
  /service\s*(indisponible|unavailable)/i,
  /USSD failed/i,
  /Aucune boite de dialogue USSD detectee/i,
  /Service d'accessibilite/i,
  /Autorisation .*par-dessus/i,
  /application Telephone par defaut/i,
  /PIN manquant/i
];

/* Ecrans confirmant que l'operateur a bien PRIS la transaction.
 * Cas reel Orange Money : apres le PIN, une derniere boite affiche
 * "Transfert initie. Vous allez recevoir une confirmation par SMS." suivie d'un
 * menu de repertoire telephonique. Cette boite contient les mots "1: enregistrer
 * ... 2: ne pas enregistrer", ce qui faisait tomber la reponse dans les motifs
 * d'erreur : le retrait passait en 'failed' ALORS QUE LE CLIENT AVAIT RECU SON
 * ARGENT. Ce test passe donc AVANT les motifs d'erreur. */
const DEPART_CONFIRME_PATTERNS = [
  // --- Orange Money ---
  /transfert\s*initi/i,
  /vous\s*allez\s*recevoir\s*une\s*confirmation/i,
  /est\s*r[eé]ussi/i,
  // --- MVola / Telma (releve sur telephone) ---
  // "Votre transaction a reussi, pour enregistrer 0380990983 dans votre
  //  repertoire MVola, Entrer le nom correspondant ou ignorer :"
  /transaction\s+a\s+r[eé]ussi/i,
  /r[eé]pertoire\s+mvola/i,
  // --- commun ---
  /transaction\s*en\s*cours/i,
  /nahomby/i
];

/* Formulations d'ECHEC contenant malgre tout un mot de succes.
 * Exemple : "la transaction n'a pas reussi" contient "reussi".
 * Ces motifs sont testes AVANT la liste de confirmation : sans cela, un echec
 * serait pris pour un succes et le retrait passerait en 'processing' alors que
 * le client n'a rien recu.
 * NE JAMAIS y mettre "annul" : les libelles des boutons ("ANNULER | ENVOYER")
 * font partie du texte lu a l'ecran et declencheraient un faux echec. */
const ECHEC_MALGRE_MOT_POSITIF = [
  /n'?\s*a\s+pas\s+r[eé]ussi/i,
  /pas\s+r[eé]ussi/i,
  /non\s+r[eé]ussi/i,
  /n'?\s*a\s+pas\s+about/i,
  /[eé]chou[eé]?/i,
  /tsy\s*nahomby/i
];

/* Messages internes de l'APK signifiant "aucun texte operateur n'a pu etre lu".
 * Ils contiennent le mot "PIN" et tombaient donc dans les motifs d'invite PIN :
 * combines a pinSubmitted=true, ils passaient a tort en 'processing'. Or ne rien
 * avoir lu ne prouve RIEN sur le sort de l'argent. */
const NON_CONFIRME_PATTERNS = [
  /pas de texte lu/i,
  /aucun texte/i
];

/* Solde annonce par l'operateur DANS un message d'echec.
 * Cas reel MVola : "Votre solde MVola est insuffisant. Votre solde est de
 * 5 692Ar. ..." — l'operateur donne le solde EXACT. Si le solde enregistre
 * differe, c'est justement pourquoi le retrait a ete tente a tort. On le
 * recale : sans cela, les tentatives echouent en boucle sur une valeur fausse.
 */
function lireSoldeDansEchec(texte) {
  const t = String(texte == null ? '' : texte);
  const m = t.match(/votre\s*solde\s*(?:[a-z]+\s*)?est\s*(?:de)?\s*[:=]?\s*([0-9][0-9\s.,]{0,15})/i);
  if (!m) return null;
  let brut = m[1].replace(/[.,](\d{2})\s*$/, '').replace(/[^0-9]/g, '');
  if (!brut) return null;
  const n = parseInt(brut, 10);
  return (Number.isFinite(n) && n >= 0 && n < 1e12) ? n : null;
}

function analyseUssdResponse(texte) {
  const t = String(texte == null ? '' : texte).trim();
  if (!t) return { type: 'vide', message: 'Reponse USSD vide' };
  for (const re of NON_CONFIRME_PATTERNS) {
    if (re.test(t)) return {
      type: 'inconnu',
      message: 'Aucun texte operateur n\'a pu etre lu — transaction NON confirmee. '
             + 'Verifiez le solde de la SIM et le SMS operateur AVANT toute relance.'
    };
  }
  // Un echec formule avec un mot positif doit etre reconnu AVANT la confirmation.
  for (const re of ECHEC_MALGRE_MOT_POSITIF) {
    if (re.test(t))
      return { type: 'erreur', message: 'Echec USSD operateur : ' + t.slice(0, 300) };
  }
  for (const re of DEPART_CONFIRME_PATTERNS) {
    if (re.test(t)) return { type: 'en_cours', message: t.slice(0, 300) };
  }
  for (const re of ERREUR_PATTERNS) {
    if (re.test(t)) return { type: 'erreur', message: 'Echec USSD operateur : ' + t.slice(0, 300) };
  }
  for (const re of PIN_PROMPT_PATTERNS) {
    if (re.test(t)) return {
      type: 'pin_prompt',
      message: 'Transaction NON envoyee : l\'operateur attend toujours le code secret. '
             + 'Verifiez (1) l\'application Telephone par defaut du gateway, '
             + '(2) le service d\'accessibilite MATULMADA, '
             + '(3) l\'affichage par-dessus les autres applications, '
             + '(4) le PIN dans Admin > Codes USSD. Texte operateur : ' + t.slice(0, 200)
    };
  }

  // ------------------------------------------------------------------
  // LISTE BLANCHE, PAS LISTE NOIRE.
  // ------------------------------------------------------------------
  // Regle metier confirmee par l'exploitation : le SEUL dernier ecran qui
  // signifie "l'argent est parti" est le message de confirmation de
  // l'operateur. TOUT autre dernier ecran est une anomalie.
  //
  // Le code retournait ici 'en_cours' par defaut : un texte inconnu passait
  // donc en 'processing' et le retrait restait fige pour toujours — exactement
  // le bug d'origine, sous une autre forme. On inverse : inconnu = anomalie
  // signalee, visible dans l'admin avec le texte complet.
  //
  // Ce choix est sur parce qu'aucune relance automatique n'existe : un
  // 'failed' est examine par un humain, il ne declenche jamais un second
  // envoi. Ajouter un operateur = ajouter son message a
  // DEPART_CONFIRME_PATTERNS, jamais retirer un motif d'erreur.
  // ------------------------------------------------------------------
  return {
    type: 'inconnu',
    message: 'Dernier ecran USSD non reconnu — transaction NON confirmee. '
           + 'Verifiez le solde de la SIM et le SMS operateur AVANT toute relance. '
           + 'Texte : ' + t.slice(0, 300)
  };
}

router.post('/:id/ussd-result', apikey, async (req, res) => {
  try {
    // 'response' = texte operateur BRUT (affiche tel quel dans l'admin)
    // 'motif'    = explication technique de la passerelle (jamais melangee au texte)
    const { success, response, pinSubmitted, motif } = req.body;
    const retrait = await Retrait.findById(req.params.id);
    if (!retrait) return res.status(404).json({ error: 'Retrait non trouve' });

    // FIX: lastUssdResponse -- dernier message USSD voarakitra foana
    // lastUssdResponse = TOUJOURS le dernier texte operateur brut : c'est ce
    // que l'admin lit dans la colonne "message flash". L'explication va dans
    // 'response'. Les melanger rendait le vrai message de l'operateur illisible.
    const texteBrut = String(response == null ? '' : response).trim();

    if (!success) {
      // ------------------------------------------------------------------
      // ISSUE INCONNUE ≠ ECHEC.
      // ------------------------------------------------------------------
      // Quand l'API one-shot (MVola) ne rend aucun texte, la passerelle ne
      // peut pas savoir si l'argent est parti. Or MVola renvoie, APRES un
      // transfert reussi, un ecran qui redemande une saisie : sur certains
      // telephones la session remonte en echec alors que le client a ete paye.
      //
      // Marquer 'failed' serait definitif : autoValidate (routes/sms.js) ne
      // rattrape QUE les statuts 'pending' et 'processing'. Le SMS de
      // confirmation arriverait ensuite et serait ignore — argent parti,
      // retrait declare perdu, aucune correction possible.
      //
      // On laisse donc en 'processing' : le SMS operateur tranchera. S'il
      // n'arrive pas, expireOldRetraits le basculera en 'failed' au bout
      // d'une heure. Le doute profite a la tracabilite, jamais au silence.
      // ------------------------------------------------------------------
      const issueInconnue = /USSD_ISSUE_INCONNUE/i.test(String(texteBrut))
                         || /USSD_ISSUE_INCONNUE/i.test(String(motif || ''));

      if (issueInconnue) {
        const note = 'Issue INCONNUE : aucune reponse lisible de l\'operateur. '
                   + 'Le transfert a peut-etre abouti. En attente du SMS de '
                   + 'confirmation — NE PAS relancer sans avoir verifie le solde.';
        await Retrait.findByIdAndUpdate(retrait._id, {
          status: 'processing',
          response: note,
          lastUssdResponse: texteBrut || 'Aucun texte operateur',
          updatedAt: new Date()
        });
        try { await traceRetrait(retrait._id, note); } catch(_) {}
        return res.json({ ok: true, status: 'processing', motif: 'inconnu' });
      }

      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed',
        response: (motif && String(motif).trim()) || texteBrut || 'USSD echec',
        lastUssdResponse: texteBrut || 'Aucun texte operateur',
        updatedAt: new Date()
      });
      return res.json({ ok: true, status: 'failed' });
    }

    // ------------------------------------------------------------------
    // "success = true" ne signifie QUE "la requete USSD est partie".
    // Le texte peut etre l'invite PIN restee sans reponse, ou une erreur.
    // En marquant systematiquement 'processing' on transformait un echec
    // silencieux en retrait fige, alors que le fournisseur a deja encaisse.
    //
    // NUANCE : Orange/MVola affichent le recapitulatif ET demandent le PIN
    // dans la MEME boite ("Handefa vola ... Ampidiro ny kaody miafina").
    // Si la passerelle a bien tape le PIN, ce texte est simplement le
    // dernier ecran capture -- ce n'est PAS un echec. Le drapeau
    // pinSubmitted envoye par l'APK distingue les deux cas.
    // ------------------------------------------------------------------
    const verdict = analyseUssdResponse(response);
    const pinTape = pinSubmitted === true || pinSubmitted === 'true';

    // 'inconnu' est traite comme une anomalie : mieux vaut un retrait signale
    // qu'un retrait fige que personne ne regarde.
    if (verdict.type === 'erreur' || verdict.type === 'inconnu' || verdict.type === 'vide'
        || (verdict.type === 'pin_prompt' && !pinTape)) {
      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed',
        response: verdict.message,
        lastUssdResponse: texteBrut || 'Aucun texte operateur',
        updatedAt: new Date()
      });
      try { await traceRetrait(retrait._id, verdict.message); } catch(_) {}

      // Recalage du solde quand l'operateur l'annonce dans son refus.
      const soldeReel = lireSoldeDansEchec(texteBrut);
      if (soldeReel != null) {
        try {
          // L'operateur annonce le solde exact dans son refus : c'est un
          // constat REEL, pas une estimation.
          await require('./soldeService')
            .soldeVerifie(retrait.operator, soldeReel, 'refus operateur', texteBrut);
        } catch (e) { console.error('recalage solde:', e.message); }
      }

      return res.json({ ok: true, status: 'failed', motif: verdict.type });
    }

    // Validation finale (montant/solde) via le SMS de confirmation operateur
    // (autoValidate dans routes/sms.js), jamais ici.
    await Retrait.findByIdAndUpdate(retrait._id, {
      status: 'processing',
      response: (motif && String(motif).trim()) || texteBrut,
      lastUssdResponse: texteBrut,
      updatedAt: new Date()
    });
    res.json({ ok: true, status: 'processing' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// POST /api/retrait/:id/relancer -- bouton "Relancer" amin'ny admin panel
// (manuel) -- mandefa indray ny command ussd_retrait amin'ny appareil mifanaraka
router.post('/:id/relancer', auth, async (req, res) => {
  try {
    const retrait = await Retrait.findById(req.params.id);
    if (!retrait) return res.status(404).json({ error: 'Retrait non trouve' });
    if (retrait.type !== 'retrait')
      return res.status(400).json({ error: 'Relance disponible uniquement pour les retraits' });

    await Retrait.findByIdAndUpdate(retrait._id, {
      $inc: { relanceCount: 1 },
      lastRelanceAt: new Date(),
      status: 'pending',
      updatedAt: new Date()
    });

    const updated = await Retrait.findById(retrait._id);
    dispatchUssdRetrait(updated).catch(e => console.error('relancer dispatchUssdRetrait:', e));

    res.json({ ok: true, relanceCount: updated.relanceCount + 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FIX: relance automatique isaky 15 min raha mbola "failed" ny retrait
// (mihaja hatrany mandra-pahomby na efa namarana ny admin manuel "refuser")
async function autoRelanceFailedRetraits() {
  try {
    const fifteenMinAgo = new Date(Date.now() - 15*60*1000);
    const candidates = await Retrait.find({
      type: 'retrait',
      status: 'failed',
      $or: [
        { lastRelanceAt: null },
        { lastRelanceAt: { $lt: fifteenMinAgo } }
      ],
      // FIX: tsy relance raha efa expired (1h tafahoatra)
      expiresAt: { $gt: new Date() }
    });

    for (const r of candidates) {
      await Retrait.findByIdAndUpdate(r._id, {
        $inc: { relanceCount: 1 },
        lastRelanceAt: new Date(),
        status: 'pending',
        updatedAt: new Date()
      });
      const updated = await Retrait.findById(r._id);
      dispatchUssdRetrait(updated).catch(e => console.error('autoRelance dispatchUssdRetrait:', e));
    }
    if (candidates.length) {
      console.log('autoRelanceFailedRetraits: ' + candidates.length + ' retrait(s) relance(s)');
    }
  } catch(e) {
    console.error('autoRelanceFailedRetraits error:', e.message);
  }
}
// DESACTIVE: relance manuel ihany (bouton "Relancer" admin), tsy automatique
// setInterval(autoRelanceFailedRetraits, 5*60*1000);

// RETRAIT DERIV (Safidy 1): poll statement isaky 30s -> credited -> Mobile Money.
async function autoPollRetraitsDeriv() {
  try {
    const { derivCheckCredited } = require('./derivService');
    const list = await Retrait.find({
      type: 'retrait', status: 'pending',
      provider: { $regex: /deriv/i }, providerId: { $nin: [null, ''] }
    }).lean();
    for (const r of list) {
      if (r.expiresAt && new Date(r.expiresAt) < new Date()) {
        await Retrait.findByIdAndUpdate(r._id, { status: 'failed', response: 'Deriv timeout (non credite)', updatedAt: new Date() });
        continue;
      }
      try {
        const since = r.createdAt ? Math.floor(new Date(r.createdAt).getTime()/1000) : 0;
        const chk = await derivCheckCredited(r.providerId, r.montantUsd || r.montant, since);
        if (chk.credited) {
          await Retrait.findByIdAndUpdate(r._id, { status: 'processing', receptionStatus: 'confirme', updatedAt: new Date() });
          const full = await Retrait.findById(r._id);
          dispatchUssdRetrait(full).catch(e => console.error('dispatchUssdRetrait (deriv):', e));
        }
      } catch(e) { console.error('autoPollRetraitsDeriv check:', e.message); }
    }
  } catch(e) { console.error('autoPollRetraitsDeriv:', e.message); }
}
// DESACTIVE: derivCheckCredited passe par l'ancien WebSocket/CR, abandonne par
// Deriv. Remplace par autoPollDerivWithdrawRest() ci-dessous (API REST officielle).
// setInterval(autoPollRetraitsDeriv, 30 * 1000);

// ============================================================================
// POLLER OFFICIEL — GET /payment-agents/v1/withdraw/{request_id}
// Un retrait Deriv revient presque toujours "pending" : c'est Deriv qui le fait
// passer a "complete". Tant que ce n'est pas complete, AUCUN mobile money n'est
// envoye (jamais d'avance de tresorerie). Des que c'est complete -> dispatch USSD.
// ============================================================================
async function autoPollDerivWithdrawRest() {
  try {
    const { restWithdrawStatusAgent, restWithdrawStatus } = require('./derivRest');
    const list = await Retrait.find({
      type: 'retrait', status: 'pending',
      provider: { $regex: /deriv/i },
      derivRequestId: { $nin: [null, ''] }
    }).limit(20);

    for (const r of list) {
      let st = null, lastErr = '';
      // 1) token AGENT (toujours dispo)
      try { st = await restWithdrawStatusAgent(r.derivRequestId); }
      catch (e) { lastErr = e.message || ''; }
      // 2) repli : token CLIENT enregistre a la soumission
      if (!st && r.derivClientToken) {
        try { st = await restWithdrawStatus(r.derivClientToken, r.derivRequestId); }
        catch (e) { lastErr = e.message || lastErr; }
      }

      if (!st) {
        // Pas de reponse exploitable : on expire seulement au bout de 24h
        if (r.expiresAt && new Date(r.expiresAt) < new Date()) {
          await Retrait.findByIdAndUpdate(r._id, {
            status: 'failed', derivClientToken: '',
            response: 'Deriv: statut indisponible apres expiration (' + (lastErr || 'sans detail') + ')',
            updatedAt: new Date()
          });
        }
        continue;
      }

      const s = String(st.status || '').toLowerCase();
      if (s === 'complete') {
        await Retrait.findByIdAndUpdate(r._id, {
          status: 'processing', receptionStatus: 'confirme', derivClientToken: '',
          derivTxnId: st.transaction_id ? String(st.transaction_id) : (r.derivTxnId || ''),
          response: 'Deriv withdraw complete' + (st.transaction_id ? (' #' + st.transaction_id) : ''),
          updatedAt: new Date()
        });
        const full = await Retrait.findById(r._id);
        dispatchUssdRetrait(full).catch(e => console.error('dispatchUssdRetrait (deriv poll):', e));
        console.log('Deriv withdraw complete -> dispatch USSD retrait ' + r._id);
      } else if (s === 'rejected' || s === 'failed') {
        await Retrait.findByIdAndUpdate(r._id, {
          status: 'failed', derivClientToken: '',
          response: 'Deriv withdraw ' + s + ' (aucun mobile money envoye)',
          updatedAt: new Date()
        });
      } else if (r.expiresAt && new Date(r.expiresAt) < new Date()) {
        await Retrait.findByIdAndUpdate(r._id, {
          status: 'failed', derivClientToken: '',
          response: 'Deriv withdraw toujours ' + (s || 'pending') + ' apres 24h',
          updatedAt: new Date()
        });
      }
    }
  } catch (e) { console.error('autoPollDerivWithdrawRest:', e.message); }
}
setInterval(autoPollDerivWithdrawRest, 30 * 1000);

// RETRAIT OAuth Deriv
/* ============================================================
 * FLUX BETWINNER (Cashdesk API) — tsotra: tsy misy OAuth/OTP email
 *   Retrait: client manome ID + code (4 car.) -> Payout -> ny montant
 *   dia avy amin'ny reponse (summa, Ariary/Fc direct) -> Mobile Money.
 * ============================================================ */
// POST /api/retrait/betwinner-user  { userId } -> validation ID + anaran'ny joueur
router.post('/betwinner-user', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || !/^[0-9]+$/.test(String(userId).trim()))
      return res.status(400).json({ error: 'ID Betwinner invalide (chiffres uniquement)' });
    const { betwinnerFindUser } = require('./betwinnerService');
    const u = await betwinnerFindUser(String(userId).trim());
    res.json({ ok: true, userId: u.userId, name: u.name, currencyId: u.currencyId });
  } catch(e) {
    console.error('betwinner-user:', e.code || '', e.message);
    res.status(400).json({ error: e.message, code: e.code || '' });
  }
});

// POST /api/retrait/betwinner-withdraw  { userId, code, numero, operator }
// Payout aloha (mahazo ny montant avy amin'ny summa) -> Retrait Mobile Money
router.post('/betwinner-withdraw', async (req, res) => {
  try {
    const { userId, code, numero, operator } = req.body;
    if (!userId || !code || !numero || !operator)
      return res.status(400).json({ error: 'champs requis: userId, code, numero, operator' });
    if (!/^[0-9]+$/.test(String(userId).trim()))
      return res.status(400).json({ error: 'ID Betwinner invalide' });
    const codeStr = String(code).trim();
    if (codeStr.length < 3 || codeStr.length > 12)
      return res.status(400).json({ error: 'Code Betwinner invalide' });

    const { betwinnerPayout } = require('./betwinnerService');
    // 1) Payout Betwinner — raha mahomby dia azo ny montant
    const p = await betwinnerPayout(String(userId).trim(), codeStr);
    const montantAr = Math.round(p.summa);

    // 2) Retrait Mobile Money (vola efa tafiditra amin'ny caisse -> alefa avy hatrany)
    const opKey = getOpKey(operator) || operator;
    const template = await getUssdCode(operator, 'retrait');
    const ussdCode = await buildUssd(template, numero, montantAr, null, opKey);
    const ussdPin  = await getSeparatePin(template, opKey);
    const sessionId = genSession();
    const retrait = new Retrait({
      operator: opKey, numero, montant: montantAr, ussdPin,
      type: 'retrait', ussdCode, sessionId,
      provider: 'Betwinner', providerId: String(userId).trim(),
      montantUsd: 0, rate: 0, devise: (opKey === 'mvola_km' ? 'Fc' : 'Ar'),
      status: 'processing', receptionStatus: 'confirme',
      response: 'Betwinner payout OK (code ' + codeStr.slice(0,2) + '**): ' + montantAr,
      expiresAt: new Date(Date.now() + 60*60*1000)
    });
    await retrait.save();
    dispatchUssdRetrait(retrait).catch(e2 => console.error('dispatchUssdRetrait (betwinner):', e2));

    res.json({ ok: true, id: retrait._id, sessionId, montantAr });
  } catch(e) {
    console.error('betwinner-withdraw:', e.code || '', e.message);
    res.status(400).json({ error: e.message, code: e.code || '' });
  }
});

// Traduction des erreurs Deriv en messages clairs (client + admin)
// Traduction des codes d'erreur OFFICIELS Deriv (doc Payment Agent REST)
// en messages clairs pour le client et l'admin.
const DERIV_ERRORS = {
  invalidotp:                    'Code de vérification incorrect — vérifiez le code reçu par email.',
  otpvalidationfailed:           'Vérification du code échouée — redemandez un nouveau code.',
  verificationcodeformatinvalid: 'Le code doit contenir exactement 6 chiffres.',
  otpratelimitexceeded:          'Trop de demandes de code — patientez quelques minutes.',
  otpvalidationratelimitexceeded:'Trop de tentatives — patientez quelques minutes.',
  withdrawalamountminimum:       'Montant en dessous du minimum autorisé par l\'agent.',
  withdrawalamountmaximum:       'Montant au-dessus du maximum autorisé par l\'agent.',
  dailywithdrawalcountlimit:     'Limite quotidienne du nombre de retraits atteinte.',
  dailywithdrawalamountlimit:    'Limite quotidienne du montant de retrait atteinte.',
  walletfundsinsufficient:       'Solde insuffisant pour ce retrait.',
  clientwithdrawdisabled:        'Les retraits par agent sont désactivés sur ce compte Deriv.',
  agentdepositdisabled:          'Les dépôts par agent sont désactivés sur ce compte Deriv.',
  noclientwallet:                'Aucun portefeuille Deriv trouvé pour ce compte.',
  clientcountryunsupported:      'Pays non pris en charge par cet agent.',
  nicknamenotfound:              'Nickname Deriv introuvable — vérifiez l\'orthographe exacte.',
  nicknamelookupfailed:          'Recherche du nickname échouée — réessayez.',
  agentselfwithdraw:             'Impossible de retirer vers le compte de l\'agent lui-même.',
  agentselftransfer:             'Impossible de transférer vers le compte de l\'agent lui-même.',
  agentcurrencyunsupported:      'Devise non prise en charge par cet agent.',
  agentinactive:                 'Compte agent inactif chez Deriv.',
  agentnotfound:                 'Agent introuvable.',
  agentidnotfound:               'Agent introuvable (agent_id).',
  agentidinvalid:                'Identifiant agent invalide.',
  invalidagentid:                'Identifiant agent invalide.',
  requestidused:                 'Cette demande a déjà été soumise (doublon évité).',
  requestidnotfound:             'Demande introuvable chez Deriv.',
  invalidrequestidformat:        'Format de référence de demande invalide.',
  withdrawalfailed:              'Le retrait a échoué chez Deriv — réessayez plus tard.',
  transferfailed:                'Le transfert a échoué chez Deriv — réessayez plus tard.',
  invalidamount:                 'Montant invalide.',
  invalidcurrency:               'Devise invalide.',
  inputerror:                    'Données envoyées invalides.'
};

function derivErrMsg(e) {
  const code = String((e && e.code) || '').toLowerCase();
  const raw  = String((e && e.message) || '');
  if (DERIV_ERRORS[code]) return DERIV_ERRORS[code];
  if (e && e.httpStatus === 403) return 'Autorisation Deriv insuffisante (scope "payment" manquant) — reconnectez-vous.';
  if (e && e.httpStatus === 401) return 'Session Deriv expirée — reconnectez-vous à Deriv.';
  if (code.includes('otp') || code.includes('verification')) return 'Code de vérification invalide ou expiré — redemandez un nouveau code.';
  if (code.includes('minimum')) return raw || 'Montant en dessous du minimum autorisé.';
  if (code.includes('maximum')) return raw || 'Montant au-dessus du maximum autorisé.';
  if (code.includes('insufficient') || code.includes('funds')) return 'Solde insuffisant — réessayez plus tard.';
  if (code.includes('nickname')) return 'Nickname Deriv introuvable — vérifiez l\'orthographe exacte.';
  if (code.includes('agent')) return raw || 'Erreur Payment Agent Deriv.';
  return raw || 'Erreur Deriv inconnue.';
}

router.post('/deriv-otp', async (req, res) => {
  try {
    const { tokenClient, montant } = req.body;
    if (!tokenClient || !montant) return res.status(400).json({ error: 'tokenClient + montant requis' });
    const montantUsd = Number(montant);
    if (!montantUsd || montantUsd <= 0) return res.status(400).json({ error: 'montant (USD) requis' });
    const { restSendWithdrawOtp, restGetMyAgent, agentUsdLimits } = require('./derivRest');
    // Validation min/max mialoha (hafatra mazava ho an'ny client fa tsy erreur Deriv miafina)
    try {
      const lim = agentUsdLimits(await restGetMyAgent());
      if (lim.min != null && montantUsd < lim.min)
        return res.status(400).json({ error: 'Montant minimum: ' + lim.min + ' USD', code: 'WithdrawalAmountMinimum' });
      if (lim.max != null && montantUsd > lim.max)
        return res.status(400).json({ error: 'Montant maximum: ' + lim.max + ' USD', code: 'WithdrawalAmountMaximum' });
    } catch (eLim) { console.error('deriv-otp limites agent (non bloquant):', eLim.message); }
    const r = await restSendWithdrawOtp(tokenClient, montantUsd, 'USD');
    res.json({ ok: true, expires_at: r.expires_at, next_request_at: r.next_request_at });
  } catch(e) { res.status(e.httpStatus === 401 || e.httpStatus === 403 ? e.httpStatus : 400).json({ error: derivErrMsg(e), code: e.code || '' }); }
});
router.post('/deriv-withdraw', async (req, res) => {
  try {
    const { tokenClient, otp, montant, numero, operator, providerId = '' } = req.body;
    if (!tokenClient || !otp || !montant || !numero || !operator)
      return res.status(400).json({ error: 'champs requis manquants' });
    if (!/^[0-9]{6}$/.test(String(otp).trim()))
      return res.status(400).json({ error: 'Code à 6 chiffres requis' });

    const { getRates } = require('./rate');
    const rates = await getRates();
    const _isKmWd = getOpKey(operator) === 'mvola_km';
    const rate = _isKmWd ? rates.rate_retrait_km : rates.rate_retrait;
    const montantUsd = Number(montant);
    const montantAr = Math.round(montantUsd * rate);

    // 1) Soumission du retrait Deriv (REST Payment Agent — token client OAuth, scope payment)
    const { restSubmitWithdraw, restWithdrawStatus } = require('./derivRest');
    const w = await restSubmitWithdraw(tokenClient, otp, montantUsd, 'USD');
    let status = (w.status || '').toLowerCase();

    if (status === 'rejected' || status === 'failed')
      return res.status(400).json({ error: 'Retrait Deriv ' + status });

    // 2) Court poll (~8s) pour capter une complétion rapide
    for (let i = 0; i < 4 && status !== 'complete'; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const st = await restWithdrawStatus(tokenClient, w.request_id);
        status = (st.status || '').toLowerCase();
        if (status === 'rejected' || status === 'failed')
          return res.status(400).json({ error: 'Retrait Deriv ' + status });
      } catch (e) { /* on retente / on bascule en autoPoll */ }
    }

    const opKey     = getOpKey(operator) || operator;
    const template  = await getUssdCode(operator, 'retrait');
    const ussdCode  = await buildUssd(template, numero, montantAr, null, opKey);
    const sessionId = genSession();

    // Path A : complété → on paie tout de suite (status 'processing' = ignoré par autoPoll)
    // Path B : encore pending → status 'pending' → autoPollRetraitsDeriv confirmera (statement agent) puis paiera
    const confirmed = (status === 'complete');
    const retrait = new Retrait({
      operator: opKey, numero, montant: montantAr,
      type: 'retrait', ussdCode, sessionId,
      provider: 'Deriv', providerId,
      montantUsd, rate, devise: (_isKmWd ? 'Fc' : 'Ar'),
      derivRequestId: w.request_id,
      // Token client garde UNIQUEMENT tant que le retrait n'est pas regle
      // (permet d'interroger le statut si le token agent est refuse).
      derivClientToken: confirmed ? '' : String(tokenClient || ''),
      status: confirmed ? 'processing' : 'pending',
      receptionStatus: confirmed ? 'confirme' : 'en_attente',
      response: 'Deriv withdraw ' + status + (w.transaction_id ? (' #' + w.transaction_id) : ''),
      // Deriv peut mettre du temps a passer de "pending" a "complete" :
      // 24h avant d'abandonner (au lieu de 1h).
      expiresAt: new Date(Date.now() + 24*60*60*1000)
    });
    await retrait.save();
    if (confirmed) dispatchUssdRetrait(retrait).catch(e => console.error('dispatchUssdRetrait (oauth):', e));

    res.json({ ok: true, id: retrait._id, sessionId, montantAr, status, pending: !confirmed });
  } catch(e) {
    console.error('deriv-withdraw error:', e.code || '', e.message);
    res.status(e.httpStatus === 401 || e.httpStatus === 403 ? e.httpStatus : 400).json({ error: derivErrMsg(e), code: e.code || '' });
  }
});

// POST /api/retrait/deriv-oauth-token — echange le code OAuth2 (PKCE) contre un
// access_token client. Appele par la vitrine au retour de auth.deriv.com.
// PUBLIC : le code n'est utilisable qu'une fois et vient de Deriv lui-meme.
router.post('/deriv-oauth-token', async (req, res) => {
  try {
    const { code, code_verifier, redirect_uri } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code d\'autorisation manquant.' });
    const { getDerivConfig } = require('./deriv');
    const cfg = await getDerivConfig();
    const clientId = String(cfg.deriv_oauth_app_id || '').trim();
    if (!clientId) return res.status(400).json({ error: 'App ID OAuth non configure (Reglages admin).' });

    const url = process.env.DERIV_OAUTH_TOKEN_URL || 'https://auth.deriv.com/oauth2/token';
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: String(code),
      redirect_uri: String(redirect_uri || '')
    });
    if (code_verifier) form.set('code_verifier', String(code_verifier));

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: form.toString()
    });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch (e) {}
    if (!r.ok || !j.access_token) {
      console.error('deriv-oauth-token FAIL', r.status, String(txt).slice(0, 300));
      return res.status(400).json({
        error: j.error_description || j.error || ('Echec de l\'echange de token [HTTP ' + r.status + ']')
      });
    }
    res.json({ ok: true, token: j.access_token, expires_in: j.expires_in || null });
  } catch (e) {
    console.error('deriv-oauth-token error', e.message);
    res.status(400).json({ error: 'Echange de token echoue: ' + (e.message || '') });
  }
});

module.exports = router;

// POST /api/retrait/:id/valider — bouton VALIDÉ amin'ny admin panel
router.post('/:id/valider', auth, async (req, res) => {
  try {
    if (!req.user || !['admin','superadmin'].includes(req.user.role))
      return res.status(403).json({ error: 'Acces refuse: admin requis' });
    const cur = await Retrait.findById(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Retrait non trouve' });
    if (cur.status !== 'success') {
      const delta = cur.type === 'depot' ? cur.montant : -cur.montant;
      await require('./soldeService')
        .soldeMouvement(cur.operator, delta, 'bouton Valider');
    }
    const r = await Retrait.findByIdAndUpdate(
      req.params.id, { status: 'success', updatedAt: new Date() }, { returnDocument: 'after' }
    );
    res.json({ ok: true, retrait: r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/retrait/:id/refuser — bouton REFUSÉ amin'ny admin panel
router.post('/:id/refuser', auth, async (req, res) => {
  try {
    if (!req.user || !['admin','superadmin'].includes(req.user.role))
      return res.status(403).json({ error: 'Acces refuse: admin requis' });
    const r = await Retrait.findByIdAndUpdate(
      req.params.id, { status: 'failed', updatedAt: new Date() }, { returnDocument: 'after' }
    );
    if (!r) return res.status(404).json({ error: 'Retrait non trouve' });
    res.json({ ok: true, retrait: r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fonctions internes exposees pour les tests automatises (aucune route montee).
module.exports.__test = {
  dispatchUssdRetrait, analyseUssdResponse, getMaxSteps, getMenuReply,
  getOpKey, buildUssd, getSeparatePin, RETRAIT_INTERDIT, ETAPES_DEFAUT, getGapMs,
  templateUtilisable, verifierModePin, PIN_DANS_LE_CODE,
  lireSoldeDansEchec, autoPollDerivWithdrawRest
};
