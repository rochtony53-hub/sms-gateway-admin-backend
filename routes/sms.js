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

// Maka numero malgache ao anatin'ny SMS (0XX XXXXXXX)
function extractNumeroFromSms(message) {
  const m = (message||'').replace(/[\s.\-]/g,'').match(/(0(?:32|33|34|37|38)\d{7})/);
  return m ? m[1] : null;
}

// Mizaha raha mitovy ny SMS amin'ny template ho an'ity operator ity.
// Mamerina { type, template } raha mitovy, na null raha tsy misy template configured,
// na false raha misy template configured fa tsy mitovy.
async function checkTemplate(opKey, message) {
  const templates = await SmsTemplate.find({ operator: opKey });
  if (!templates.length) return null;
  const msg = message.toLowerCase();
  for (const t of templates) {
    const allMatch = (t.keywords||[]).every(kw => msg.includes(kw.toLowerCase()));
    if (allMatch) return { type: t.type, template: t };
  }
  return false;
}

// Maka ny MONTANT TRANSACTION (montant voalohany), TSY ny solde
function parseMontant(message) {
  const msg = (message || '');
  const cut = msg.replace(/(nouveau\s+)?solde[^.]*\.?/ig,' ').replace(/balance[^.]*\.?/ig,' ');
  let m = cut.match(/(?:ar|mga)\s*([0-9][0-9\s.,]*)/i)
        || cut.match(/([0-9][0-9\s.,]*?)\s*(?:ar|mga)/i);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/[\s,]/g,''));
  return (isNaN(val)) ? null : val;
}

// Mitady Retrait pending/processing mifanaraka amin'ny NUMERO hita ao amin'ny SMS.
// FIX: matching amin'ny numero client (araka ny exemple ao amin'ny template),
// tsy "pending tranainy indrindra" fotsiny.
async function findMatchingRetrait(opKey, type, message) {
  const numero = extractNumeroFromSms(message);
  const filter = { operator: opKey, status: { $in: ['pending','processing'] }, type };
  if (numero) filter.numero = numero;

  let candidates = await Retrait.find(filter).sort({ createdAt: 1 });

  if (!candidates.length && numero) {
    candidates = await Retrait.find({
      operator: opKey, status: { $in: ['pending','processing'] }, type
    }).sort({ createdAt: 1 });
  }
  return candidates[0] || null;
}

// FIX: 1h timeout - raha tafahoatra 1h ny pending/processing -> failed
async function expireOldRetraits(opKey) {
  const oneHourAgo = new Date(Date.now() - 60*60*1000);
  await Retrait.updateMany(
    { operator: opKey, status: { $in: ['pending','processing'] }, createdAt: { $lt: oneHourAgo } },
    { status: 'failed', updatedAt: new Date() }
  );
}

// FLOW FENO:
// 1. SMS tsy mitovy template configured -> ignore (pas de retrait touche)
// 2. SMS mitovy template fa tsy misy retrait mifanaraka -> "matched"
// 3. SMS mitovy template + misy retrait mifanaraka (numero):
//    a. tafahoatra 1h -> deja "failed" (expireOldRetraits)
//    b. montant != ordre -> "failed", admin garde valide/refuse manuel
//    c. montant exact + solde ampy (retrait) -> "success" auto, solde miova
//    d. montant exact fa solde tsy azo hamarinina -> "processing" (EN ATTENTE admin)
// 4. SMS misy template fa TSY mitovy keywords -> "failed" avy hatrany,
//    admin mahazo mbola valide/refuse manuel.
async function autoValidate(operator, message, smsId) {
  const opts = settings.getOptions();
  if (!opts.ret_aut) return;
  const opKey = getOpKey(operator);
  if (!opKey) return;

  await expireOldRetraits(opKey);

  const result = await checkTemplate(opKey, message);

  if (result === null) {
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'pending' });
    return;
  }

  if (result === false) {
    const retrait = await findMatchingRetrait(opKey, 'retrait', message)
                 || await findMatchingRetrait(opKey, 'depot', message);
    if (retrait) {
      await Retrait.findByIdAndUpdate(retrait._id, { status: 'failed', updatedAt: new Date() });
      if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'failed', retraitId: retrait._id });
    } else {
      if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'failed' });
    }
    return;
  }

  const { type } = result;
  const retrait = await findMatchingRetrait(opKey, type, message);

  if (!retrait) {
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'matched' });
    return;
  }

  const montantSms = parseMontant(message);

  if (montantSms === null) {
    await Retrait.findByIdAndUpdate(retrait._id, { status: 'processing', updatedAt: new Date() });
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'processing', retraitId: retrait._id });
    return;
  }

  if (Math.round(montantSms) !== Math.round(retrait.montant)) {
    await Retrait.findByIdAndUpdate(retrait._id, { status: 'failed', updatedAt: new Date() });
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'failed', retraitId: retrait._id });
    return;
  }

  if (type === 'retrait') {
    const solde = await Solde.findOne({ operator: opKey });
    const balance = solde?.montant || 0;
    if (balance < retrait.montant) {
      await Retrait.findByIdAndUpdate(retrait._id, { status: 'processing', updatedAt: new Date() });
      if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'processing', retraitId: retrait._id });
      return;
    }
    await Solde.findOneAndUpdate(
      { operator: opKey },
      { $inc: { montant: -retrait.montant, montantOff: -retrait.montant }, updatedAt: new Date() }
    );
  } else {
    await Solde.findOneAndUpdate(
      { operator: opKey },
      { $inc: { montant: retrait.montant, montantOff: retrait.montant }, updatedAt: new Date() },
      { upsert: true }
    );

    // FIX: DEPOT valide -- mandefa deriv (transfert API Deriv) any amin'ny
    // CR client (retrait.clientId). Tsy mampijanona ny flow raha tsy mahomby
    // (logged ihany, ny depot dia efa valide ao amin'ny Mobile Money).
    if (retrait.clientId) {
      try {
        const { derivTransferToClient } = require('./derivService');
        await derivTransferToClient(retrait.clientId, retrait.montant);
      } catch(e) {
        console.error('derivTransferToClient error pour retrait', retrait._id, ':', e.message);
      }
    }
  }

  await Retrait.findByIdAndUpdate(retrait._id, { status: 'success', updatedAt: new Date() });
  if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'matched', retraitId: retrait._id });
}

// Recoit SMS depuis APK Android
router.post('/receive', apikey, async (req, res) => {
  try {
    const { from, message, sim, simSlot, deviceId, operator: opBody } = req.body;
    let operator = opBody || 'Inconnu';
    if (!opBody && sim) {
      const s = sim.toUpperCase();
      if (s.includes('ORANGE')) operator = 'Orange Money';
      else if (s.includes('YAS') || s.includes('TELMA') || s.includes('MVOLA')) operator = 'YAS (Telma)';
      else if (s.includes('AIRTEL')) operator = 'Airtel Money';
    }
    const sms = new Sms({ from, message, sim, simSlot, operator, status: 'sent', deviceId });
    await sms.save();

    await Device.findOneAndUpdate(
      { deviceId },
      { $inc: { smsReceived: 1 }, lastSeen: new Date(), online: true },
      { upsert: true }
    );

    autoValidate(operator, message, sms._id).catch(e => console.error('autoValidate:', e));
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
      .limit(Number(limit))
      .populate('retraitId');
    res.json({ total, page: Number(page), data: sms });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/clear', auth, async (req, res) => {
  try {
    await Sms.deleteMany({});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await Sms.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
