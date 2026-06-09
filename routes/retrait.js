const router      = require('express').Router();
const auth        = require('../middleware/auth');
const apikey      = require('../middleware/apikey');
const Retrait     = require('../models/Retrait');
const UssdConfig  = require('../models/UssdConfig');
const Solde       = require('../models/Solde');
const SmsTemplate = require('../models/SmsTemplate');

const DEFAULTS = {
  orange: { retrait:'*111*1*{numero}*{montant}#', depot:'*111*2*{numero}*{montant}#' },
  mvola:  { retrait:'*155*1*{numero}*{montant}#', depot:'*155*2*{numero}*{montant}#' },
  airtel: { retrait:'*123*1*{numero}*{montant}#', depot:'*123*2*{numero}*{montant}#' },
};

function getOpKey(operator) {
  const op = operator.toLowerCase();
  if (op.includes('orange')) return 'orange';
  if (op.includes('yas') || op.includes('telma') || op.includes('mvola')) return 'mvola';
  if (op.includes('airtel')) return 'airtel';
  return null;
}

async function buildUssd(operator, type, numero, montant) {
  const key = getOpKey(operator);
  if (!key) return null;
  let config = await UssdConfig.findOne({ operator: key });
  const template = config ? config[type] : (DEFAULTS[key]?.[type] || null);
  if (!template) return null;
  return template.replace('{numero}', numero).replace('{montant}', montant);
}

// Vérifier si SMS match template operator
async function checkSmsMatch(operator, message) {
  const key = getOpKey(operator);
  if (!key) return false;
  const templates = await SmsTemplate.find({ operator: key });
  if (!templates.length) return true; // raha tsy misy template → accepté
  const msg = message.toLowerCase();
  for (const t of templates) {
    const allMatch = t.keywords.every(kw => msg.includes(kw.toLowerCase()));
    if (allMatch) return true;
  }
  return false;
}

// Manova solde
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

// POST /api/retrait — mamorona retrait
router.post('/', auth, async (req, res) => {
  try {
    const { operator, numero, montant, type='retrait' } = req.body;
    if (!operator || !numero || !montant)
      return res.status(400).json({ error: 'operator, numero, montant requis' });

    // Check solde raha retrait
    if (type === 'retrait') {
      const key = getOpKey(operator);
      const solde = await Solde.findOne({ operator: key });
      const balance = solde?.montant || 0;
      if (balance < montant)
        return res.status(400).json({ error: `Solde insuffisant (${balance} Ar disponible)` });
    }

    const ussdCode = await buildUssd(operator, type, numero, montant);
    if (!ussdCode)
      return res.status(400).json({ error: 'Opérateur non supporté' });

    const retrait = new Retrait({
      operator, numero, montant, ussdCode,
      type, status: 'pending', createdBy: req.user.username
    });
    await retrait.save();
    res.json({ id: retrait._id, ussdCode, type, status: 'pending' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/retrait/result — APK mampiditra valiny + automatic SMS check
router.post('/result', apikey, async (req, res) => {
  try {
    const { retraitId, success, response, smsMatcher } = req.body;
    const retrait = await Retrait.findById(retraitId);
    if (!retrait) return res.status(404).json({ error: 'Retrait introuvable' });

    let validated = success;

    // Raha misy smsMatcher → check amin'ny templates
    if (smsMatcher) {
      validated = await checkSmsMatch(retrait.operator, smsMatcher);
    }

    await Retrait.findByIdAndUpdate(retraitId, {
      status: validated ? 'success' : 'failed',
      response, updatedAt: new Date()
    });

    // Manova solde raha success
    if (validated) {
      await updateSolde(retrait.operator, retrait.montant, retrait.type);
    }

    res.json({ ok: true, status: validated ? 'success' : 'failed' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/retrait/:id — manual validation admin
router.patch('/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['success','failed'].includes(status))
      return res.status(400).json({ error: 'status doit etre success ou failed' });

    const retrait = await Retrait.findById(req.params.id);
    if (!retrait) return res.status(404).json({ error: 'Retrait introuvable' });

    await Retrait.findByIdAndUpdate(req.params.id, {
      status, updatedAt: new Date()
    });

    // Manova solde raha success
    if (status === 'success') {
      await updateSolde(retrait.operator, retrait.montant, retrait.type);
    }

    res.json({ ok: true, status });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/retrait
router.get('/', auth, async (req, res) => {
  try {
    const { page=1, limit=50, status, type } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (type)   filter.type   = type;
    const total = await Retrait.countDocuments(filter);
    const data  = await Retrait.find(filter)
      .sort({ createdAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit));
    res.json({ total, page: Number(page), data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
