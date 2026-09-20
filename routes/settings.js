const router   = require('express').Router();
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');

// FIX: tpe_depot sy tpe_ret = false par défaut (Grand Public)
// depot_api_orange : dep0t Orange via l'API Orange Money Web Payment au lieu
// du code USSD manuel. false par defaut — on n'active un chemin de paiement
// qu'explicitement, apres avoir renseigne les identifiants dans l'admin.
// Le choix TPE / Grand Public se fait par operateur : une SIM MVola peut
// servir en TPE pendant qu'une SIM Orange reste en Grand Public. Les deux
// anciens reglages restent la valeur de repli — un operateur sans reglage
// propre continue de suivre le reglage general, comme avant.
const DEFAULTS = { tpe_depot: false, tpe_ret: false, cash: false, ret_aut: true, ussd: true,
                   depot_api_orange: false,
                   tpe_depot_mvola: null, tpe_ret_mvola: null,
                   tpe_depot_orange: null, tpe_ret_orange: null };
const ALLOWED  = ['tpe_depot','tpe_ret','cash','ret_aut','ussd','depot_api_orange',
                  'tpe_depot_mvola','tpe_ret_mvola','tpe_depot_orange','tpe_ret_orange'];

/**
 * Le reglage TPE qui s'applique a cet operateur pour ce type d'ordre.
 * Un reglage propre l'emporte ; sinon on retombe sur le reglage general.
 * null signifie "pas de reglage propre", d'ou le test explicite.
 */
function tpeActif(operator, type) {
  const o = String(operator || '').toLowerCase();
  const base = (type === 'depot') ? 'tpe_depot' : 'tpe_ret';
  if (o === 'mvola' || o === 'orange') {
    const propre = options[base + '_' + o];
    if (propre === true || propre === false) return propre;
  }
  return !!options[base];
}

let options = { ...DEFAULTS };

async function loadOptions() {
  try {
    const docs = await Settings.find({ key: { $in: ALLOWED } });
    docs.forEach(d => { options[d.key] = d.value; });
  } catch(e) { console.error('loadOptions:', e.message); }
}
loadOptions();

router.get('/options', auth, (req, res) => {
  res.json(options);
});

router.post('/options', auth, async (req, res) => {
  try {
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        // null = revenir au reglage general ; sinon vrai ou faux.
        options[key] = (req.body[key] === null) ? null : !!req.body[key];
        await Settings.findOneAndUpdate(
          { key },
          { value: options[key] },
          { upsert: true }
        );
      }
    }
    res.json({ ok: true, options });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.getOptions = () => options;
module.exports.tpeActif = tpeActif;
