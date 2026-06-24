const router   = require('express').Router();
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');

const KEYS = ['deriv_app_id', 'deriv_token', 'deriv_cr_agent'];

// GET /api/deriv/config — admin maka ny config Deriv ankehitriny
router.get('/config', auth, async (req, res) => {
  try {
    const docs = await Settings.find({ key: { $in: KEYS } });
    const cfg = { deriv_app_id: '', deriv_token: '', deriv_cr_agent: '' };
    docs.forEach(d => { cfg[d.key] = d.value || ''; });
    res.json(cfg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/deriv/config — admin manova ny config Deriv (bouton Enregistrer)
router.post('/config', auth, async (req, res) => {
  try {
    const { deriv_app_id, deriv_token, deriv_cr_agent } = req.body;
    const updates = { deriv_app_id, deriv_token, deriv_cr_agent };
    for (const key of KEYS) {
      if (updates[key] !== undefined) {
        await Settings.findOneAndUpdate(
          { key }, { value: updates[key] }, { upsert: true }
        );
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Helper interne — maka ny config Deriv (ampiasaina amin'ny routes hafa)
async function getDerivConfig() {
  const docs = await Settings.find({ key: { $in: KEYS } });
  const cfg = { deriv_app_id: '', deriv_token: '', deriv_cr_agent: '' };
  docs.forEach(d => { cfg[d.key] = d.value || ''; });
  return cfg;
}

module.exports = router;
module.exports.getDerivConfig = getDerivConfig;
