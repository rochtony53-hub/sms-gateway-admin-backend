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

function buildUssd(template, numero, montant) {
  if (!template) return null;
  return template
    .replace('{numero}', numero)
    .replace('{montant}', montant);
}

// POST /api/retrait — créer un retrait
router.post('/', auth, async (req, res) => {
  try {
    const { operator, numero, montant, type='retrait' } = req.body;
    if (!operator||!numero||!montant)
      return res.status(400).json({ error: 'operator, numero, montant requis' });

    const template = await getUssdCode(operator, type);
    const ussdCode = buildUssd(template, numero, montant);
    const opts     = require('./settings').getOptions();
    const channel  = (type==='depot' ? opts.tpe_depot : opts.tpe_ret) ? 'TPE' : 'Grand Public';

    const retrait = new Retrait({
      operator: getOpKey(operator)||operator,
      numero, montant: Number(montant),
      type, ussdCode, channel,
      status: 'pending'
    });
    await retrait.save();

    res.json({ ok: true, ussdCode, channel, id: retrait._id });
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
    const r = await Retrait.findByIdAndUpdate(
      req.params.id,
      { status, updatedAt: new Date() },
      { returnDocument: 'after' }
    );
    if (!r) return res.status(404).json({ error: 'Retrait non trouvé' });
    res.json({ ok: true, retrait: r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
