const router   = require('express').Router();
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');

const DEFAULTS = { tpe: true, tpe_ret: true, cash: false, ret_aut: true, ussd: true };
const ALLOWED  = ['tpe','tpe_ret','cash','ret_aut','ussd'];

// Options in-memory cache
let options = { ...DEFAULTS };

// Initialise depuis MongoDB au démarrage
async function loadOptions() {
  try {
    const docs = await Settings.find({ key: { $in: ALLOWED } });
    docs.forEach(d => { options[d.key] = d.value; });
  } catch(e) { console.error('loadOptions:', e.message); }
}
loadOptions();

// GET
router.get('/options', auth, (req, res) => {
  res.json(options);
});

// POST
router.post('/options', auth, async (req, res) => {
  try {
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        options[key] = !!req.body[key];
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
