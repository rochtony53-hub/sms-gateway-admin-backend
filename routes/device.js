const router = require('express').Router();
const apikey = require('../middleware/apikey');
const auth   = require('../middleware/auth');
const Device = require('../models/Device');

router.post('/heartbeat', apikey, async (req, res) => {
  try {
    const { deviceId, sims, battery, smsReceived, smsSent } = req.body;
    await Device.findOneAndUpdate(
      { deviceId },
      { sims, battery, smsReceived, smsSent, online: true, lastSeen: new Date() },
      { upsert: true, new: true }
    );
    const Retrait = require('../models/Retrait');
    const pending = await Retrait.find({ status: 'pending' }).limit(5);
    res.json({ status: 'ok', commands: pending });
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
    const result = devices.map(d => ({
      ...d.toObject(),
      online: (now - new Date(d.lastSeen).getTime()) < 120000
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
