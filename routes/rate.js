const router   = require('express').Router();
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');

// Les affilies disposent de leurs propres taux, depot comme retrait : un seul
// jeu de cours ne permettait pas de leur reserver de meilleures conditions.
const KEYS_BASE = ['rate_depot', 'rate_retrait', 'rate_depot_km', 'rate_retrait_km'];
const KEYS = KEYS_BASE.concat(KEYS_BASE.map(k => k + '_aff'));

function cfgVide() {
  const c = {};
  KEYS.forEach(k => { c[k] = 0; });
  return c;
}

// GET /api/rate — PUBLIC (ho an'ny site vitrine + admin)
router.get('/', async (req, res) => {
  try {
    const docs = await Settings.find({ key: { $in: KEYS } });
    const cfg = cfgVide();
    docs.forEach(d => { cfg[d.key] = Number(d.value) || 0; });
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/rate — admin (Enregistrer)
router.post('/', auth, async (req, res) => {
  try {
    for (const key of KEYS) {
      const v = req.body[key];
      if (v !== undefined && v !== '') {
        await Settings.findOneAndUpdate({ key }, { value: Number(v) || 0 }, { upsert: true });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Cours applicables a un ordre.
 *
 * Pour un affilie, les taux dedies remplacent les taux publics — mais
 * seulement s'ils sont renseignes : un cours a zero bloquerait l'ordre, mieux
 * vaut alors le cours ordinaire.
 */
async function getRates(affilie) {
  const docs = await Settings.find({ key: { $in: KEYS } });
  const cfg = cfgVide();
  docs.forEach(d => { cfg[d.key] = Number(d.value) || 0; });
  if (affilie) {
    for (const base of KEYS_BASE) {
      if (cfg[base + '_aff'] > 0) cfg[base] = cfg[base + '_aff'];
    }
  }
  return cfg;
}

module.exports = router;
module.exports.getRates = getRates;
