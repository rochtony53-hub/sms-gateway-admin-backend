const router = require('express').Router();
const auth   = require('../middleware/auth');
const apikey = require('../middleware/apikey');
const Device = require('../models/Device');

// POST — admin mandefa command (requires auth)
router.post('/restart', auth, async (req, res) => {
  await Device.updateMany({ online: true }, { $push: { pendingCmds: 'restart' } });
  res.json({ ok: true });
});
router.post('/stop', auth, async (req, res) => {
  await Device.updateMany({ online: true }, { $push: { pendingCmds: 'stop' } });
  res.json({ ok: true });
});
router.post('/sync', auth, async (req, res) => {
  await Device.updateMany({ online: true }, { $push: { pendingCmds: 'sync' } });
  res.json({ ok: true });
});
router.post('/update', auth, async (req, res) => {
  await Device.updateMany({ online: true }, { $push: { pendingCmds: 'update' } });
  res.json({ ok: true });
});

// GET — APK manampy commands puis efface
router.get('/commands', apikey, async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.json({ commands: [] });
  const device = await Device.findOneAndUpdate(
    { deviceId },
    { $set: { pendingCmds: [] } },
    { new: false }
  );
  res.json({ commands: device?.pendingCmds || [] });
});

module.exports = router;
