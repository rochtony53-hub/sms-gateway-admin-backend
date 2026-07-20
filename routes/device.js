const router = require('express').Router();
const apikey = require('../middleware/apikey');
const auth   = require('../middleware/auth');
const Device = require('../models/Device');
const Sms = require('../models/Sms');

router.post('/heartbeat', apikey, async (req, res) => {
  try {
    const { deviceId, sims, battery, smsReceived, smsSent, ussdCheckEnabled, networkType, signalLevel } = req.body;
    const setFields = { sims, battery, online: true, lastSeen: new Date() };
    if (ussdCheckEnabled !== undefined) setFields.ussdCheckEnabled = ussdCheckEnabled;
    if (networkType !== undefined) setFields.networkType = networkType;
    if (signalLevel !== undefined) setFields.signalLevel = signalLevel;
    await Device.findOneAndUpdate(
      { deviceId },
      { $set: setFields, $inc: { smsReceived: smsReceived||0, smsSent: smsSent||0 } },
      { upsert: true, new: true }
    );
    const Retrait = require('../models/Retrait');
    // 1) Ancien canal : retraits en attente (flux manuel / mobile money direct)
    const pending = await Retrait.find({ status: 'pending' }).limit(5);

    // 2) Nouveau canal : commandes USSD poussees par dispatchUssdRetrait()
    //    (retrait Deriv / Betwinner, deja encaisse cote fournisseur -> status
    //    'processing'). Sans ceci, elles restaient dans Device.pendingCmds et
    //    n'etaient JAMAIS envoyees au gateway => retrait bloque "en attente".
    //    Livraison AT-MOST-ONCE : on vide la file des qu'on l'a renvoyee, pour
    //    ne jamais risquer d'envoyer l'argent deux fois.
    let extra = [];
    try {
      const dev = await Device.findOne({ deviceId });
      const cmds = (dev && Array.isArray(dev.pendingCmds)) ? dev.pendingCmds : [];
      if (cmds.length) {
        const ids = cmds
          .filter(c => c && typeof c === 'object' && c.retraitId)
          .map(c => String(c.retraitId));
        if (ids.length) extra = await Retrait.find({ _id: { $in: ids } });
        await Device.updateOne({ _id: dev._id }, { $set: { pendingCmds: [] } });
        console.log('heartbeat ' + deviceId + ': ' + ids.length + ' commande(s) USSD livree(s)');
      }
    } catch (e2) { console.error('heartbeat pendingCmds:', e2.message); }

    // Fusion sans doublon
    const seen = new Set(pending.map(r => String(r._id)));
    const commands = pending.concat(extra.filter(r => !seen.has(String(r._id))));
    res.json({ status: 'ok', commands });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

function flexAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key && key === process.env.API_KEY) return next();
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Auth requise: x-api-key ou Bearer token' });
  try {
    const jwt = require('jsonwebtoken');
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

router.get('/stats', flexAuth, async (req, res) => {
  try {
    const { deviceId } = req.query;
    const filter = deviceId ? { deviceId } : {};
    const devices = await Device.find(filter).sort({ lastSeen: -1 });
    const now = Date.now();
    const result = await Promise.all(devices.map(async d => {
      const obj = d.toObject();
      try {
        obj.smsReceived = await Sms.countDocuments({ deviceId: d.deviceId });
        obj.smsSent     = await Sms.countDocuments({ deviceId: d.deviceId, status: { $in: ['sent','matched'] } });
      } catch(e){}
      return {
        ...obj,
        online: (now - new Date(d.lastSeen).getTime()) < 120000
      };
    }));
    if (deviceId && result.length === 1) return res.json(result[0]);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/device/:id — supprimer un device
router.delete('/:id', auth, async (req, res) => {
  try {
    const deleted = await Device.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Device introuvable' });
    res.json({ ok: true, deleted: deleted.deviceId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
