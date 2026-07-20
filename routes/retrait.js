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
    template = (opts.tpe_depot && (config?.tpe_depot || def.tpe_depot))
      ? (config?.tpe_depot || def.tpe_depot)
      : (config?.gp_depot  || def.gp_depot || '');
  } else {
    // tpe_ret ON → TPE, sinon GP
    template = (opts.tpe_ret && (config?.tpe_retrait || def.tpe_retrait))
      ? (config?.tpe_retrait || def.tpe_retrait)
      : (config?.gp_retrait  || def.gp_retrait || '');
  }
  return template || null;
}

function genSession(){ return 'S'+Date.now().toString(36).toUpperCase()+Math.floor(Math.random()*9000+1000); }

// PIN mobile money par operateur, stocke dans Settings (cle: ussd_pin_<operateur>).
// Sans PIN, le menu USSD s'arrete a la confirmation => le retrait reste "en attente".
async function getUssdPin(opKey) {
  try {
    const Settings = require('../models/Settings');
    const d = await Settings.findOne({ key: 'ussd_pin_' + String(opKey || '').toLowerCase() });
    return (d && d.value) ? String(d.value).trim() : '';
  } catch (e) { return ''; }
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
    if (type === 'depot') {
      const cfg = await UssdConfig.findOne({ operator: getOpKey(operator) });
      if (cfg && cfg.gatewayNumero) ussdNumero = cfg.gatewayNumero;
    }
    const ussdCode = await buildUssd(template, ussdNumero, montantFinal, null, getOpKey(operator));
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
      type, ussdCode, channel, sessionId,
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
        const opKey = (cur.operator||'').toLowerCase();
        const delta = cur.type === 'depot' ? cur.montant : -cur.montant;
        await Solde.findOneAndUpdate(
          { operator: opKey },
          { $inc: { montant: delta, montantOff: delta }, updatedAt: new Date() },
          { upsert: true }
        );
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

async function dispatchUssdRetrait(retrait) {
  try {
    const opKey = getOpKey(retrait.operator) || retrait.operator;
    const keyword = operatorNameToKeyword(opKey);
    if (!keyword) return;

    const config = await UssdConfig.findOne({ operator: opKey });
    const opts   = require('./settings').getOptions();
    const def    = DEFAULTS[opKey] || {};
    const template = (opts.tpe_ret && (config?.tpe_retrait || def.tpe_retrait))
      ? (config?.tpe_retrait || def.tpe_retrait)
      : (config?.gp_retrait  || def.gp_retrait || '');
    if (!template) return;

    // numero CLIENT (mahazo vola) -- TSY numeroGateway, satria retrait = vola
    // mankany amin'ny client
    const ussdCode = await buildUssd(template, retrait.numero, retrait.montant, config?.gatewayNumero, getOpKey(retrait.operator));

    // Mitady appareil ONLINE izay manana SIM mifanaraka (sims contient le keyword)
    const Device = require('../models/Device');
    let devices = await Device.find({
      online: true,
      sims: { $regex: keyword, $options: 'i' }
    }).sort({ lastSeen: -1 });
    // Comores: appareil KM ihany ; Madagasikara: esorina ny appareil KM
    devices = devices.filter(dv => (opKey === 'mvola_km')
      ? KM_DEVICE_REGEX.test(dv.deviceId || '')
      : !KM_DEVICE_REGEX.test(dv.deviceId || ''));

    if (!devices.length) {
      console.error('dispatchUssdRetrait: aucun appareil online pour', opKey);
      // Visible dans l'admin : sinon le retrait reste "en attente" sans explication
      try {
        await Retrait.findByIdAndUpdate(retrait._id, {
          response: 'En attente: aucun appareil gateway en ligne pour ' + opKey + ' (relancer depuis l\'admin)',
          updatedAt: new Date()
        });
      } catch (e3) {}
      return;
    }

    // Mandefa amin'ny appareil VOALOHANY hita ihany (tsy ny rehetra, mba tsy
    // hisy appareil roa samy manatanteraka ny code USSD mitovy)
    const device = devices[0];
    await Device.findByIdAndUpdate(device._id, {
      $push: {
        pendingCmds: {
          type: 'ussd_retrait',
          retraitId: String(retrait._id),
          ussdCode,
          operator: opKey
        }
      }
    });
  } catch(e) {
    console.error('dispatchUssdRetrait error:', e.message);
  }
}


// POST /api/retrait/:id/ussd-result -- APK mandefa ny vokatry ny USSD retrait
// (apikey, tsy auth -- ny APK no miantso ity)
router.post('/:id/ussd-result', apikey, async (req, res) => {
  try {
    const { success, response } = req.body;
    const retrait = await Retrait.findById(req.params.id);
    if (!retrait) return res.status(404).json({ error: 'Retrait non trouve' });

    // FIX: lastUssdResponse -- dernier message USSD voarakitra foana
    if (!success) {
      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed', response: response || 'USSD echec',
        lastUssdResponse: response || 'USSD echec', updatedAt: new Date()
      });
      return res.json({ ok: true, status: 'failed' });
    }

    // USSD reussi -- response brut sauvegarde. Validation finale (montant/solde)
    // se fait via le SMS de confirmation envoye par l'operateur (autoValidate
    // dans routes/sms.js), pas ici directement.
    await Retrait.findByIdAndUpdate(retrait._id, {
      status: 'processing', response: response || '',
      lastUssdResponse: response || '', updatedAt: new Date()
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
setInterval(autoPollRetraitsDeriv, 30 * 1000);

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
    const sessionId = genSession();
    const retrait = new Retrait({
      operator: opKey, numero, montant: montantAr,
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
      status: confirmed ? 'processing' : 'pending',
      receptionStatus: confirmed ? 'confirme' : 'en_attente',
      response: 'Deriv withdraw ' + status + (w.transaction_id ? (' #' + w.transaction_id) : ''),
      expiresAt: new Date(Date.now() + 60*60*1000)
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
      const opKey = (cur.operator||'').toLowerCase();
      const delta = cur.type === 'depot' ? cur.montant : -cur.montant;
      await Solde.findOneAndUpdate(
        { operator: opKey },
        { $inc: { montant: delta, montantOff: delta }, updatedAt: new Date() },
        { upsert: true }
      );
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
