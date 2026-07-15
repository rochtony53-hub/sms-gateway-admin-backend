// Config Betwinner (Cashdesk API) — mitovy pattern amin'ny deriv.js
const router   = require('express').Router();
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');

const KEYS = ['betwinner_hash', 'betwinner_cashierpass', 'betwinner_cashdeskid', 'betwinner_login', 'betwinner_lng'];

// GET /api/betwinner/config — admin maka ny config
router.get('/config', auth, async (req, res) => {
  try {
    const docs = await Settings.find({ key: { $in: KEYS } });
    const cfg = {};
    KEYS.forEach(k => cfg[k] = '');
    docs.forEach(d => { cfg[d.key] = d.value || ''; });
    res.json(cfg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/betwinner/config — admin manova ny config
router.post('/config', auth, async (req, res) => {
  try {
    for (const key of KEYS) {
      if (req.body[key] !== undefined) {
        await Settings.findOneAndUpdate({ key }, { value: req.body[key] }, { upsert: true });
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Helper interne
async function getBetwinnerConfig() {
  const docs = await Settings.find({ key: { $in: KEYS } });
  const cfg = { betwinner_lng: 'fr' };
  docs.forEach(d => { cfg[d.key] = d.value || cfg[d.key] || ''; });
  return cfg;
}

module.exports = router;
module.exports.getBetwinnerConfig = getBetwinnerConfig;
