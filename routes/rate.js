const router   = require('express').Router();
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');

const KEYS = ['rate_depot', 'rate_retrait', 'rate_depot_km', 'rate_retrait_km'];

// GET /api/rate — PUBLIC (ho an'ny site vitrine + admin)
router.get('/', async (req, res) => {
  try {
    const docs = await Settings.find({ key: { $in: KEYS } });
    const cfg = { rate_depot: 0, rate_retrait: 0, rate_depot_km: 0, rate_retrait_km: 0 };
    docs.forEach(d => { cfg[d.key] = Number(d.value) || 0; });
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/rate — admin (Enregistrer)
router.post('/', auth, async (req, res) => {
  try {
    const updates = { rate_depot: req.body.rate_depot, rate_retrait: req.body.rate_retrait, rate_depot_km: req.body.rate_depot_km, rate_retrait_km: req.body.rate_retrait_km };
    for (const key of KEYS) {
      if (updates[key] !== undefined && updates[key] !== '') {
        await Settings.findOneAndUpdate({ key }, { value: Number(updates[key]) || 0 }, { upsert: true });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function getRates() {
  const docs = await Settings.find({ key: { $in: KEYS } });
  const cfg = { rate_depot: 0, rate_retrait: 0, rate_depot_km: 0, rate_retrait_km: 0 };
  docs.forEach(d => { cfg[d.key] = Number(d.value) || 0; });
  return cfg;
}
module.exports = router;
module.exports.getRates = getRates;
