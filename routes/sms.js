const router      = require('express').Router();
const settings    = require('./settings');
const apikey      = require('../middleware/apikey');
const auth        = require('../middleware/auth');
const Sms         = require('../models/Sms');
const Device      = require('../models/Device');
const Retrait     = require('../models/Retrait');
const SmsTemplate = require('../models/SmsTemplate');
const Solde       = require('../models/Solde');

function getOpKey(op) {
  const o = (op||'').toLowerCase();
  if (o.includes('orange')) return 'orange';
  if (o.includes('yas')||o.includes('telma')||o.includes('mvola')) return 'mvola';
  if (o.includes('airtel')) return 'airtel';
  return null;
}

async function checkTemplate(opKey, message) {
  const templates = await SmsTemplate.find({ operator: opKey });
  if (!templates.length) return null; // tsy misy template → tsy auto-validate
  const msg = message.toLowerCase();
  for (const t of templates) {
    const allMatch = t.keywords.every(kw => msg.includes(kw.toLowerCase()));
    if (allMatch) return t.type; // 'retrait' na 'depot'
  }
  return false; // tsy mitovy
}


function parseSolde(opKey, message) {
  const msg = message || '';
  let montant = null;
  if (opKey === 'mvola') {
    const m = msg.match(/solde[^0-9]*([0-9][0-9\s,\.]*?)\s*[Aa]r/i)
           || msg.match(/([0-9][0-9\s,\.]*?)\s*[Aa]r/i);
    if (m) montant = parseFloat(m[1].replace(/[\s,]/g,''));
  }
  if (opKey === 'orange') {
    const m = msg.match(/solde[^0-9]*([0-9][0-9\s,\.]*?)\s*(?:Ar|MGA)/i)
           || msg.match(/([0-9][0-9\s,\.]*?)\s*(?:Ar|MGA)/i);
    if (m) montant = parseFloat(m[1].replace(/[\s,]/g,''));
  }
  if (opKey === 'airtel') {
    const m = msg.match(/balance[^0-9]*([0-9][0-9\s,\.]*)/i)
           || msg.match(/solde[^0-9]*([0-9][0-9\s,\.]*)/i);
    if (m) montant = parseFloat(m[1].replace(/[\s,]/g,''));
  }
  return (montant !== null && !isNaN(montant)) ? montant : null;
}

async function autoValidate(operator, message, smsId) {
  const opts = settings.getOptions();
  if (!opts.ret_aut) return;
  const opKey = getOpKey(operator);
  if (!opKey) return;

  const matchType = await checkTemplate(opKey, message);
  if (matchType === null) { if(smsId) await Sms.findByIdAndUpdate(smsId,{status:"ignored"}); return; }
  
  // Tsy mitovy → refusé ny retrait pending tranainy indrindra fotsiny
  if (matchType === false) { if(smsId) await Sms.findByIdAndUpdate(smsId,{status:"ignored"});
    const oldest = await Retrait.find({
      operator: { $regex: new RegExp(opKey, 'i') }, status: 'pending'
    }).sort({ createdAt: 1 }).limit(1);
    if (oldest.length) {
      await Retrait.findByIdAndUpdate(oldest[0]._id, { status: 'failed', updatedAt: new Date() });
    }
    return;
  }

  // Mitovy → check solde sy validate
  const pending = await Retrait.find({
    operator: { $regex: new RegExp(opKey, 'i') },
    status: 'pending',
    type: matchType
  }).sort({ createdAt: 1 }).limit(1);

  if (!pending.length) { if(smsId) await Sms.findByIdAndUpdate(smsId,{status:'matched'}); return; }
  const retrait = pending[0];

  // Check solde raha retrait
  if (matchType === 'retrait') {
    const solde = await Solde.findOne({ operator: opKey });
    const balance = solde?.montant || 0;
    if (balance < retrait.montant) {
      await Retrait.findByIdAndUpdate(retrait._id, { status: 'failed', updatedAt: new Date() });
      if(smsId) await Sms.findByIdAndUpdate(smsId,{status:'pending'});
      return;
    }
    await Solde.findOneAndUpdate({ operator: opKey }, { $inc: { montant: -retrait.montant }, updatedAt: new Date() });
  } else {
    await Solde.findOneAndUpdate({ operator: opKey }, { $inc: { montant: retrait.montant }, updatedAt: new Date() }, { upsert: true });
  }

  await Retrait.findByIdAndUpdate(retrait._id, { status: "success", updatedAt: new Date() }); if(smsId) await Sms.findByIdAndUpdate(smsId,{status:"matched"});
}

// Reçoit SMS depuis APK Android
router.post('/receive', apikey, async (req, res) => {
  try {
    const { from, message, sim, simSlot, deviceId, operator: opBody } = req.body;
    // Détection opérateur
    let operator = opBody || 'Inconnu';
    if (!opBody && sim) {
      const s = sim.toUpperCase();
      if (s.includes('ORANGE')) operator = 'Orange Money';
      else if (s.includes('YAS') || s.includes('TELMA') || s.includes('MVOLA')) operator = 'YAS (Telma)';
      else if (s.includes('AIRTEL')) operator = 'Airtel Money';
    }
    const sms = new Sms({ from, message, sim, simSlot, operator, status: 'sent', deviceId });
    await sms.save();
    // Update device stats
    await Device.findOneAndUpdate(
      { deviceId },
      { $inc: { smsReceived: 1 }, lastSeen: new Date(), online: true },
      { upsert: true }
    );
    // Auto-validate retrait/depot selon SMS template
    autoValidate(operator, message, sms._id).catch(e => console.error('autoValidate:', e));
    // Parse sy update solde avy amin'ny SMS
    const opKey2 = getOpKey(operator);
    if (opKey2) {
      const montant = parseSolde(opKey2, message);
      if (montant !== null) {
        Solde.findOneAndUpdate(
          { operator: opKey2 },
          { montant, updatedAt: new Date() },
          { upsert: true }
        ).catch(e => console.error('solde update:', e));
      }
    }
    res.json({ id: sms._id, status: 'received' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Liste SMS (admin)
router.get('/', auth, async (req, res) => {
  try {
    const { page=1, limit=50, operator, status } = req.query;
    const filter = {};
    if (operator) filter.operator = operator;
    if (status)   filter.status   = status;
    const total = await Sms.countDocuments(filter);
    const sms   = await Sms.find(filter)
      .sort({ receivedAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit));
    res.json({ total, page: Number(page), data: sms });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/sms/clear — vider tout
router.delete('/clear', auth, async (req, res) => {
  try {
    await Sms.deleteMany({});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/sms/:id — supprimer un SMS
router.delete('/:id', auth, async (req, res) => {
  try {
    await Sms.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
