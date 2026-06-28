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
      // FIX: receptionStatus = rejete (SMS niditra fa tsy mitovy template)
      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed', receptionStatus: 'rejete', lastUssdResponse: message, updatedAt: new Date()
      });
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
    // FIX: receptionStatus = verification (SMS niditra fa mbola tsy voamarina)
    await Retrait.findByIdAndUpdate(retrait._id, {
      status: 'processing', receptionStatus: 'verification', lastUssdResponse: message, updatedAt: new Date()
    });
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'processing', retraitId: retrait._id });
    return;
  }

  if (Math.round(montantSms) !== Math.round(retrait.montant)) {
    // FIX: receptionStatus = rejete (montant diso)
    await Retrait.findByIdAndUpdate(retrait._id, {
      status: 'failed', receptionStatus: 'rejete', lastUssdResponse: message, updatedAt: new Date()
    });
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'failed', retraitId: retrait._id });
    return;
  }

  // FIX: CLAIM ATOMIQUE -- raha SMS hafa (dupliqué tafita ny dedup, na cron
  // relance) dia mitady ity retrait ity indray mihoatra mandritra izao, ny
  // iray ihany no "mahazo" azy. Ny hafa dia tsy hikasika Solde na hiantso
  // Deriv intsony, fa hijanona eto fotsiny.
  // FIX: "stale lock" (2 min) -- raha tojo crash ny serveur teo am-pandraisana
  // ka locked:true tsy voavela mihitsy, dia azo raisina indray io retrait io
  // taorian'ny 2 minitra (ela be noho ny timeout Deriv 15s).
  const staleLockCutoff = new Date(Date.now() - 2 * 60 * 1000);
  const claimed = await Retrait.findOneAndUpdate(
    {
      _id: retrait._id,
      status: { $in: ['pending', 'processing'] },
      $or: [ { locked: { $ne: true } }, { locked: true, updatedAt: { $lt: staleLockCutoff } } ]
    },
    { $set: { locked: true, updatedAt: new Date() } },
    { new: true }
  );
  if (!claimed) {
    console.warn('autoValidate: retrait', retrait._id, 'efa an-dalam-pandraisana (dupliqué) -- ignoré');
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'duplicate', retraitId: retrait._id });
    return;
  }

  if (type === 'retrait') {
    // RETRAIT : vola alefa amin'ny client. SMS niditra = voaray ny client -> success.
    const solde = await Solde.findOne({ operator: opKey });
    const balance = solde?.montant || 0;
    if (balance < claimed.montant) {
      await Retrait.findByIdAndUpdate(claimed._id, {
        status: 'processing', receptionStatus: 'verification', lastUssdResponse: message,
        locked: false, updatedAt: new Date()
      });
      if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'processing', retraitId: claimed._id });
      return;
    }
    await Solde.findOneAndUpdate(
      { operator: opKey },
      { $inc: { montant: -claimed.montant, montantOff: -claimed.montant }, updatedAt: new Date() }
    );
    await Retrait.findByIdAndUpdate(claimed._id, {
      status: 'success', receptionStatus: 'confirme', lastUssdResponse: message,
      locked: false, updatedAt: new Date()
    });
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'matched', retraitId: claimed._id });
    return;
  }

  // DEPOT : vola voaray (solde miakatra). FA status tsy 'success' raha tsy VOARAY ny Deriv.
  await Solde.findOneAndUpdate(
    { operator: opKey },
    { $inc: { montant: claimed.montant, montantOff: claimed.montant }, updatedAt: new Date() },
    { upsert: true }
  );

  let depotStatus = 'processing';
  let derivErr = '';
  let derivTxnId = '';
  if (claimed.providerId) {
    try {
      const { derivTransferToClient } = require('./derivService');
      const r = await derivTransferToClient(claimed.providerId, claimed.montantUsd || claimed.montant);
      // FIX: jereo tena ny r.ok -- aza atao success raha tsy nisy exception
      // fotsiny (mety ho reponse Deriv tsy nahomby nefa tsy nanome erreur).
      if (r && r.ok) {
        depotStatus = 'success';
        derivTxnId = r.transaction_id || '';
      } else {
        depotStatus = 'processing';
        derivErr = 'Deriv: reponse non confirmee (ok=false)';
      }
    } catch(e) {
      console.error('derivTransferToClient error pour depot', claimed._id, ':', e.message);
      depotStatus = 'processing';
      derivErr = e.message;
    }
  } else {
    depotStatus = 'processing';
    derivErr = 'providerId (CR Deriv) manquant';
  }

  // FIX: providerId (CR Deriv lasibatra) TSY soratana indray intsony -- mijanona
  // ho azy marina foana izy mba ho azo amin'ny relance raha tsy nahomby ny
  // andrana voalohany. Ny vokatra transaction dia ao amin'ny derivTxnId.
  // FIX: locked:false -- alefa indray hovana (relance cron) raha mbola 'processing'.
  await Retrait.findByIdAndUpdate(claimed._id, {
    status: depotStatus, receptionStatus: 'confirme',
    derivTxnId: derivTxnId || claimed.derivTxnId || '', response: derivErr,
    lastUssdResponse: message,
    locked: false, updatedAt: new Date()
  });
  if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'matched', retraitId: claimed._id });
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

    // FIX: DEDUP SMS -- raha SMS mitovy marina tokoa (operator + message) efa
    // niditra tao anatin'ny 3 minitra lasa (ohatra: SIM roa mamaky SMS iray,
    // na ny APK mandefa indroa noho ny retry réseau), dia heverina ho
    // dupliqué: tahirizina ihany fa TSY mandalo autoValidate (tsy hisy
    // double appel Deriv / double Solde).
    const dedupWindow = new Date(Date.now() - 3 * 60 * 1000);
    const dup = await Sms.findOne({
      operator, message, receivedAt: { $gte: dedupWindow }
    }).sort({ receivedAt: -1 });

    const sms = new Sms({
      from, message, sim, simSlot, operator, deviceId,
      status: dup ? 'duplicate' : 'sent'
    });
    await sms.save();

    await Device.findOneAndUpdate(
      { deviceId },
      { $inc: { smsReceived: 1 }, lastSeen: new Date(), online: true },
      { upsert: true }
    );

    if (dup) {
      console.warn('SMS dupliqué ignoré (déjà reçu <3min):', String(message).slice(0, 60));
    } else {
      autoValidate(operator, message, sms._id).catch(e => console.error('autoValidate:', e));
    }
    res.json({ id: sms._id, status: dup ? 'duplicate' : 'received' });
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

// FIX: GET /api/sms/depot -- SMS dia mifandray amin'ny Retrait type=depot ihany
router.get('/depot', auth, async (req, res) => {
  try {
    const { page=1, limit=50, operator, status } = req.query;
    const depotRetraits = await Retrait.find({ type: 'depot' }).distinct('_id');
    const filter = { retraitId: { $in: depotRetraits } };
    if (operator) filter.operator = operator;
    if (status)   filter.status   = status;
    const total = await Sms.countDocuments(filter);
    const sms = await Sms.find(filter)
      .sort({ receivedAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit))
      .populate('retraitId');
    res.json({ total, page: Number(page), data: sms });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FIX: GET /api/sms/retrait -- SMS dia mifandray amin'ny Retrait type=retrait ihany
router.get('/retrait', auth, async (req, res) => {
  try {
    const { page=1, limit=50, operator, status } = req.query;
    const retraitRetraits = await Retrait.find({ type: 'retrait' }).distinct('_id');
    const filter = { retraitId: { $in: retraitRetraits } };
    if (operator) filter.operator = operator;
    if (status)   filter.status   = status;
    const total = await Sms.countDocuments(filter);
    const sms = await Sms.find(filter)
      .sort({ receivedAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit))
      .populate('retraitId');
    res.json({ total, page: Number(page), data: sms });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// RELANCE AUTO DEPOT (Deriv) isaky 15 min (manuel ihany ny RETRAIT). Timeout 30 min -> failed.
const DEPOT_DERIV_TIMEOUT_MS = 30 * 60 * 1000;
async function autoRelanceDepotsDeriv() {
  try {
    const cutoff = new Date(Date.now() - DEPOT_DERIV_TIMEOUT_MS);
    const staleLockCutoff0 = new Date(Date.now() - 2 * 60 * 1000);
    const depots = await Retrait.find({
      type: 'depot', status: 'processing', receptionStatus: 'confirme',
      providerId: { $nin: [null, ''] },
      // FIX: alaina ireo tsy locked NA ireo locked efa "stale" (>2 min) --
      // tsy ireo tena an-dalam-pandraisana ankehitriny.
      $or: [ { locked: { $ne: true } }, { locked: true, updatedAt: { $lt: staleLockCutoff0 } } ]
    }).lean();
    for (const d of depots) {
      if (d.createdAt && new Date(d.createdAt) < cutoff) {
        await Retrait.findByIdAndUpdate(d._id, { status: 'failed', updatedAt: new Date() });
        continue;
      }

      // FIX: CLAIM ATOMIQUE mialoha ny appel Deriv -- raha autoValidate (SMS)
      // efa mandray io retrait io amin'izao fotoana izao, dia ny cron tsy
      // hiantso Deriv intsony. "Stale lock" 2 min koa raha crash teo aloha.
      const staleLockCutoff = new Date(Date.now() - 2 * 60 * 1000);
      const claimed = await Retrait.findOneAndUpdate(
        {
          _id: d._id, status: 'processing',
          $or: [ { locked: { $ne: true } }, { locked: true, updatedAt: { $lt: staleLockCutoff } } ]
        },
        { $set: { locked: true, updatedAt: new Date() } },
        { new: true }
      );
      if (!claimed) continue;

      try {
        const { derivTransferToClient, derivCheckTransferSent } = require('./derivService');

        // FIX: "RETOUR" Deriv -- mizaha ALOHA raha efa lasa tena izy ilay
        // transfer voalohany (valiny very fotsiny noho timeout/connexion),
        // alohan'ny hanao transfer VAOVAO. Tsy averina mandefa Deriv raha
        // efa hita fa lasa.
        const since = claimed.createdAt ? Math.floor(new Date(claimed.createdAt).getTime()/1000) : 0;
        let already = { sent: false };
        try {
          already = await derivCheckTransferSent(claimed.providerId, claimed.montantUsd || claimed.montant, since);
        } catch (eChk) {
          console.warn('derivCheckTransferSent verif tsy nahomby (tohizana ihany):', eChk.message);
        }

        // FIX: aza ekena raha io transaction Deriv io efa "an'ny" retrait
        // hafa (ohatra: depot mitovy montant avy amin'ny client mitovy,
        // efa nahazo confirme tamin'ny alalan'ny io transaction io koa).
        if (already.sent && already.transaction_id) {
          const dejaAttribue = await Retrait.findOne({ derivTxnId: already.transaction_id });
          if (dejaAttribue) already = { sent: false };
        }

        if (already.sent) {
          await Retrait.findByIdAndUpdate(claimed._id, {
            status: 'success', derivTxnId: already.transaction_id || '',
            response: 'Confirme via statement Deriv (relance, sans renvoyer)',
            relanceCount: (d.relanceCount||0)+1, lastRelanceAt: new Date(),
            locked: false, updatedAt: new Date()
          });
          continue;
        }

        const r = await derivTransferToClient(claimed.providerId, claimed.montantUsd || claimed.montant);
        if (r && r.ok) {
          await Retrait.findByIdAndUpdate(claimed._id, {
            status: 'success', derivTxnId: r.transaction_id || '', response: '',
            relanceCount: (d.relanceCount||0)+1, lastRelanceAt: new Date(),
            locked: false, updatedAt: new Date()
          });
        } else {
          await Retrait.findByIdAndUpdate(claimed._id, {
            response: 'Deriv: reponse non confirmee (ok=false)',
            relanceCount: (d.relanceCount||0)+1, lastRelanceAt: new Date(),
            locked: false, updatedAt: new Date()
          });
        }
      } catch(e) {
        await Retrait.findByIdAndUpdate(claimed._id, {
          response: e.message, relanceCount: (d.relanceCount||0)+1,
          lastRelanceAt: new Date(), locked: false, updatedAt: new Date()
        });
      }
    }
  } catch(e) { console.error('autoRelanceDepotsDeriv:', e.message); }
}
// FIX: isaky 15 minitra ny relance depot (araka ny voafaritra), tsy 5mn intsony.
setInterval(autoRelanceDepotsDeriv, 15 * 60 * 1000);
module.exports = router;
