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
    /* ------------------------------------------------------------------
     * ARGENT — deux corrections critiques ici.
     * ------------------------------------------------------------------
     * 1) DOUBLE PAIEMENT (course entre deux canaux)
     *    Cette route lisait Device.pendingCmds puis la vidait en DEUX temps :
     *        const dev = await Device.findOne(...)      <-- lecture
     *        ... await Retrait.find(...) ...            <-- fenetre ouverte
     *        await Device.updateOne(... pendingCmds: [])<-- vidage
     *    Pendant cette fenetre, GET /api/service/commands (appele par l'APK
     *    dans le MEME cycle de heartbeat, ligne 129 de GatewayService) pouvait
     *    lire les MEMES commandes et les vider de son cote. Les deux canaux
     *    livraient alors le meme retrait : le code USSD partait DEUX FOIS et
     *    le client etait paye deux fois.
     *    -> La livraison passe desormais uniquement par
     *       GET /api/service/commands, dont le findOneAndUpdate lit et vide de
     *       maniere ATOMIQUE. Un seul canal, aucune course possible.
     *
     * 2) RELANCE EN BOUCLE TOUTES LES 30 s
     *    On renvoyait aussi TOUS les retraits status:'pending', a TOUS les
     *    telephones, sans filtre d'operateur ni de destinataire. Comme l'APK
     *    postait son resultat sur /api/retrait/result (route inexistante ->
     *    404), le statut ne changeait jamais : le meme retrait repartait a
     *    chaque heartbeat, indefiniment, et sur chaque telephone a la fois.
     *    -> Plus aucune diffusion ici. La relance est MANUELLE (bouton
     *       "Relancer" de l'admin), conformement au fonctionnement voulu.
     * ------------------------------------------------------------------ */
    res.json({ status: 'ok', commands: [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Un appareil qui ne donne plus signe de vie doit repasser "hors ligne" :
// sinon il reste "en ligne" pour toujours et continue de recevoir des commandes
// USSD qui ne seront jamais executees (retrait bloque en "processing").
setInterval(async () => {
  try {
    const limite = new Date(Date.now() - 3 * 60 * 1000);
    const r = await Device.updateMany(
      { online: true, lastSeen: { $lt: limite } },
      { $set: { online: false } }
    );
    const n = r.modifiedCount || r.nModified || 0;
    if (n) console.log('Appareils repasses hors ligne (silence > 3 min): ' + n);
  } catch (e) { console.error('sweeper appareils:', e.message); }
}, 60 * 1000);

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
