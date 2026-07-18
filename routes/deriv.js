const router   = require('express').Router();
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');

const KEYS = ['deriv_app_id', 'deriv_token', 'deriv_cr_agent', 'deriv_oauth_app_id'];

// GET /api/deriv/config — admin maka ny config Deriv ankehitriny
router.get('/config', auth, async (req, res) => {
  try {
    const docs = await Settings.find({ key: { $in: KEYS } });
    const cfg = { deriv_app_id: '', deriv_token: '', deriv_cr_agent: '', deriv_oauth_app_id: '' };
    docs.forEach(d => { cfg[d.key] = d.value || ''; });
    res.json(cfg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/deriv/config — admin manova ny config Deriv (bouton Enregistrer)
router.post('/config', auth, async (req, res) => {
  try {
    const { deriv_app_id, deriv_token, deriv_cr_agent, deriv_oauth_app_id } = req.body;
    const updates = { deriv_app_id, deriv_token, deriv_cr_agent, deriv_oauth_app_id };
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

// GET /api/deriv/oauth-app — PUBLIC (vitrine). Renvoie SEULEMENT l'App ID de
// l'app OAuth utilisée pour le login client du retrait. Aucun secret exposé.
router.get('/oauth-app', async (req, res) => {
  try {
    const d = await Settings.findOne({ key: 'deriv_oauth_app_id' });
    res.json({ app_id: (d && d.value) ? String(d.value).trim() : '' });
  } catch(e) { res.json({ app_id: '' }); }
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
