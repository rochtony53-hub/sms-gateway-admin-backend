const router      = require('express').Router();
const auth        = require('../middleware/auth');
const apikey      = require('../middleware/apikey');
const Retrait     = require('../models/Retrait');
const UssdConfig  = require('../models/UssdConfig');
const Solde       = require('../models/Solde');

const DEFAULTS = {
  orange: { gp_depot:'*111*2*{numero}*{montant}#', gp_retrait:'*111*1*{numero}*{montant}#', tpe_depot:'', tpe_retrait:'' },
  mvola:  { gp_depot:'*155*2*{numero}*{montant}#', gp_retrait:'*155*1*{numero}*{montant}#', tpe_depot:'', tpe_retrait:'' },
  airtel: { gp_depot:'*123*2*{numero}*{montant}#', gp_retrait:'*123*1*{numero}*{montant}#', tpe_depot:'', tpe_retrait:'' },
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

function buildUssd(template, numero, montant) {
  if (!template) return null;
  return template
    .replace('{numero}', numero)
    .replace('{montant}', montant);
}

// POST /api/retrait — créer un retrait
router.post('/', auth, async (req, res) => {
  try {
    const { operator, numero, montant, type='retrait', clientId='', provider='', providerId='' } = req.body;
    if (!operator||!numero||!montant)
      return res.status(400).json({ error: 'operator, numero, montant requis' });

    const template = await getUssdCode(operator, type);
    // DEPOT: ny code USSD mampiasa ny numéro Gateway (mandray vola), fa tsy ny client.
    let ussdNumero = numero;
    if (type === 'depot') {
      const cfg = await UssdConfig.findOne({ operator: getOpKey(operator) });
      if (cfg && cfg.gatewayNumero) ussdNumero = cfg.gatewayNumero;
    }
    const ussdCode = buildUssd(template, ussdNumero, montant);
    const opts     = require('./settings').getOptions();
    const channel  = (type==='depot' ? opts.tpe_depot : opts.tpe_ret) ? 'TPE' : 'Grand Public';

    const opKey = getOpKey(operator) || operator;
    const montantNum = Number(montant);

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
      status: 'pending'
    });
    await retrait.save();

    res.json({ ok: true, ussdCode, channel, id: retrait._id, sessionId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/retrait — liste retraits
router.get('/', auth, async (req, res) => {
  try {
    const { page=1, limit=50, status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const total = await Retrait.countDocuments(filter);
    const data  = await Retrait.find(filter)
      .sort({ createdAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit));
    res.json({ total, page: Number(page), data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/retrait/:id/status
router.patch('/:id/status', auth, async (req, res) => {
  try {
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

module.exports = router;
