const router      = require('express').Router();
const settings    = require('./settings');
const auth        = require('../middleware/auth');
const apikey      = require('../middleware/apikey');
const Retrait     = require('../models/Retrait');
const UssdConfig  = require('../models/UssdConfig');
const Solde       = require('../models/Solde');
const SmsTemplate = require('../models/SmsTemplate');

// USSD codes par défaut
const DEFAULTS = {
  orange: {
    gp:  { depot: '#144*1', retrait: '#145*' },
    tpe: { depot: '#144#',  retrait: '#145*' },
    subIdPrefix: ['032','037']
  },
  mvola: {
    gp:  { depot: '#111*',  retrait: '#144#' },
    tpe: { depot: '#144#',  retrait: '#144*' },
    subIdPrefix: ['034','038']
  },
  airtel: {
    gp:  { depot: '#144#',  retrait: '#144*' },
    tpe: { depot: '#144#',  retrait: '#144*' },
    subIdPrefix: ['033']
  }
};

function getOpKey(operator) {
  const op = (operator||'').toLowerCase();
  if (op.includes('orange')) return 'orange';
  if (op.includes('yas') || op.includes('telma') || op.includes('mvola')) return 'mvola';
  if (op.includes('airtel')) return 'airtel';
  return null;
}

async function getUssdCode(operator, type, channel='gp') {
  const key = getOpKey(operator);
  if (!key) return null;
  const config = await UssdConfig.findOne({ operator: key });
  if (config && config[channel] && config[channel][type]) {
    return config[channel][type];
  }
  return DEFAULTS[key]?.[channel]?.[type] || null;
}

async function checkSmsMatch(operator, message) {
  const key = getOpKey(operator);
  if (!key) return false;
  const templates = await SmsTemplate.find({ operator: key });
  if (!templates.length) return true;
  const msg = message.toLowerCase();
  for (const t of templates) {
    const allMatch = t.keywords.every(kw => msg.includes(kw.toLowerCase()));
    if (allMatch) return true;
  }
  return false;
}

async function updateSolde(operator, montant, type) {
  const key = getOpKey(operator);
  if (!key) return;
  const inc = type === 'depot' ? montant : -montant;
  await Solde.findOneAndUpdate(
    { operator: key },
    { $inc: { montant: inc }, updatedAt: new Date() },
    { upsert: true }
  );
}

// POST /api/retrait — mamorona retrait/depot
router.post('/', auth, async (req, res) => {
  try {
    const opts = settings.getOptions();
    const { operator, numero, montant, type='retrait', channel='gp' } = req.body;
    if (!operator || !numero || !montant)
      return res.status(400).json({ error: 'operator, numero, montant requis' });
    if (!opts.ret_aut)
      return res.status(403).json({ error: 'Retrait desactive' });
    if (!opts.ussd)
      return res.status(403).json({ error: 'USSD desactive' });

    // Check solde raha retrait
    if (type === 'retrait') {
      const key = getOpKey(operator);
      const solde = await Solde.findOne({ operator: key });
      const balance = solde?.montant || 0;
      if (balance < montant)
        return res.status(400).json({ error: `Solde insuffisant (${balance} Ar disponible)` });
    }

    const ussdCode = await getUssdCode(operator, type, channel);
    if (!ussdCode)
      return res.status(400).json({ error: 'Operateur non supporte' });

    const retrait = new Retrait({
      operator, numero, montant, ussdCode,
      type, channel, status: 'pending',
      createdBy: req.user.username
    });
    await retrait.save();
    res.json({ id: retrait._id, ussdCode, type, channel, status: 'pending' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/retrait/result — APK mampiditra valiny USSD
router.post('/result', apikey, async (req, res) => {
  try {
    const { retraitId, success, response, smsMatcher } = req.body;
    const retrait = await Retrait.findById(retraitId);
    if (!retrait) return res.status(404).json({ error: 'Retrait introuvable' });

    let validated = success;
    if (smsMatcher) {
      validated = await checkSmsMatch(retrait.operator, smsMatcher);
    }

    await Retrait.findByIdAndUpdate(retraitId, {
      status: validated ? 'success' : 'failed',
      response, updatedAt: new Date()
    });

    if (validated) {
      await updateSolde(retrait.operator, retrait.montant, retrait.type);
    }

    res.json({ ok: true, status: validated ? 'success' : 'failed' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ussd-config — config USSD rehetra
router.get('/ussd-config', auth, async (req, res) => {
  try {
    const configs = await UssdConfig.find();
    const result = {};
    ['orange','mvola','airtel'].forEach(op => {
      const cfg = configs.find(c => c.operator === op);
      result[op] = cfg ? {
        gp:  { depot: cfg.gp?.depot  || DEFAULTS[op].gp.depot,  retrait: cfg.gp?.retrait  || DEFAULTS[op].gp.retrait  },
        tpe: { depot: cfg.tpe?.depot || DEFAULTS[op].tpe.depot, retrait: cfg.tpe?.retrait || DEFAULTS[op].tpe.retrait },
        subIdPrefix: cfg.subIdPrefix?.length ? cfg.subIdPrefix : DEFAULTS[op].subIdPrefix
      } : DEFAULTS[op];
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/retrait/ussd-config — update config USSD
router.post('/ussd-config', auth, async (req, res) => {
  try {
    const { operator, gp, tpe, subIdPrefix } = req.body;
    const key = getOpKey(operator);
    if (!key) return res.status(400).json({ error: 'Operateur invalide' });
    await UssdConfig.findOneAndUpdate(
      { operator: key },
      { gp, tpe, subIdPrefix, updatedBy: req.user.username, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/retrait/:id — manual validation
router.patch('/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['success','failed'].includes(status))
      return res.status(400).json({ error: 'status doit etre success ou failed' });
    const retrait = await Retrait.findById(req.params.id);
    if (!retrait) return res.status(404).json({ error: 'Retrait introuvable' });
    if (retrait.status === 'success') return res.status(400).json({ error: 'Deja valide' });
    await Retrait.findByIdAndUpdate(req.params.id, { status, updatedAt: new Date() });
    if (status === 'success') {
      await updateSolde(retrait.operator, retrait.montant, retrait.type);
    }
    res.json({ ok: true, status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/retrait
router.get('/', auth, async (req, res) => {
  try {
    const { page=1, limit=50, status, type, channel } = req.query;
    const filter = {};
    if (status)  filter.status  = status;
    if (type)    filter.type    = type;
    if (channel) filter.channel = channel;
    const total = await Retrait.countDocuments(filter);
    const data  = await Retrait.find(filter)
      .sort({ createdAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit));
    res.json({ total, page: Number(page), data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/retrait/clear
router.delete('/clear', auth, async (req, res) => {
  try {
    await Retrait.deleteMany({});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/retrait/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await Retrait.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
