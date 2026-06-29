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
  airtel: { gp_depot:'', gp_retrait:'', tpe_depot:'', tpe_retrait:'' },
};

function getOpKey(op) {
  const o = (op||'').toLowerCase();
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

function buildUssd(template, numero, montant, numeroGateway) {
  if (!template) return null;
  return template
    .split('{numeroGateway}').join(numeroGateway || '')
    .split('{numero}').join(numero)
    .split('{montant}').join(montant)
    .split('{pin}').join('');
}

// POST /api/retrait — créer un retrait
router.post('/', auth, async (req, res) => {
  try {
    const { operator, numero, montant, type='retrait', clientId='', provider='', providerId='' } = req.body;
    if (!operator||!numero||!montant)
      return res.status(400).json({ error: 'operator, numero, montant requis' });

    // === Conversion USD -> Ar (raha fournisseur Deriv) ===
    let montantUsd = 0, rate = 0, devise = 'Ar';
    let montantFinal = Number(montant);
    if (provider && provider.toLowerCase() === 'deriv') {
      const rates = await getRates();
      rate = (type === 'depot') ? rates.rate_depot : rates.rate_retrait;
      montantUsd = Number(montant);
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
    const ussdCode = buildUssd(template, ussdNumero, montantFinal);
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
      clientId, provider, providerId,
      montantUsd, rate, devise,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60*60*1000) // FIX: 1h limite de validite
    });
    await retrait.save();

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
  if (opKey === 'airtel') return 'Airtel';
  return null;
}

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
    const ussdCode = buildUssd(template, retrait.numero, retrait.montant, config?.gatewayNumero);

    // Mitady appareil ONLINE izay manana SIM mifanaraka (sims contient le keyword)
    const Device = require('../models/Device');
    const devices = await Device.find({
      online: true,
      sims: { $regex: keyword, $options: 'i' }
    }).sort({ lastSeen: -1 });

    if (!devices.length) {
      console.error('dispatchUssdRetrait: aucun appareil online pour', opKey);
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

// NOUVEAU FLUX OTP EMAIL (sans OAuth, sans tokenClient)
// Front mandefa: { email }  — backend mampiasa token agent
router.post('/deriv-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email requis' });
    const { derivSendWithdrawOtp } = require('./derivService');
    const r = await derivSendWithdrawOtp(email);
    if (!r.ok) return res.status(400).json({ error: 'Deriv verify_email echec', raw: r.raw });
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.post('/deriv-withdraw', async (req, res) => {
  try {
    // tokenClient TSY ILAINA intsony — agent token no ampiasaina (ao derivService)
    const { otp, montant, numero, operator, providerId = '' } = req.body;
    if (!otp || !montant || !numero || !operator)
      return res.status(400).json({ error: 'champs requis manquants: otp, montant, numero, operator' });
    const cfg = await require('./deriv').getDerivConfig();
    const crAgent = cfg.deriv_cr_agent;
    if (!crAgent) return res.status(500).json({ error: 'CR agent non configure (deriv_cr_agent)' });
    const { getRates } = require('./rate');
    const rates = await getRates();
    const rate = rates.rate_retrait;
    const montantUsd = Number(montant);
    const montantAr = Math.round(montantUsd * rate);
    const { derivClientWithdraw } = require('./derivService');
    // derivClientWithdraw mampiasa token AGENT (tsy tokenClient intsony)
    const w = await derivClientWithdraw(crAgent, otp, montantUsd);
    if (!w.ok) return res.status(400).json({ error: 'Deriv withdraw echec', raw: w.raw });
    const opKey = getOpKey(operator) || operator;
    const template = await getUssdCode(operator, 'retrait');
    const ussdCode = buildUssd(template, numero, montantAr);
    const sessionId = genSession();
    const retrait = new Retrait({
      operator: opKey, numero, montant: montantAr,
      type: 'retrait', ussdCode, sessionId,
      provider: 'Deriv', providerId,
      montantUsd, rate, devise: 'USD',
      status: 'processing', receptionStatus: 'confirme',
      response: 'Deriv withdraw OK (OTP email): ' + (w.transaction_id || ''),
      expiresAt: new Date(Date.now() + 60*60*1000)
    });
    await retrait.save();
    dispatchUssdRetrait(retrait).catch(e => console.error('dispatchUssdRetrait (otp-email):', e));
    res.json({ ok: true, id: retrait._id, sessionId, montantAr });
  } catch(e) { res.status(400).json({ error: e.message }); }
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
