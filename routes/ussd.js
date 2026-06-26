const router     = require('express').Router();
const auth       = require('../middleware/auth');
const apikey     = require('../middleware/apikey');
const UssdConfig = require('../models/UssdConfig');

const DEFAULTS = [
  { operator:'orange',
    gp_depot:'#144#1*1*{numero}*{numero}*{montant}*2#',
    gp_retrait:'#144#1*1*{numero}*{numero}*{montant}*2#',
    tpe_depot:'#144#3*2*228928*{montant}#',
    tpe_retrait:'#145#1*{numero}*{numero}*{montant}#' },
  { operator:'mvola',
    gp_depot:'#111*1*2*{numero}*{montant}*2*1#',
    gp_retrait:'#111*1*2*{numero}*{montant}*2*1#',
    tpe_depot:'#111*1*2*{numero}*{montant}*2#',
    tpe_retrait:'#111*1*2*{numero}*{montant}*2*1#' },
  { operator:'airtel',
    gp_depot:'*123*2*{numero}*{montant}#',
    gp_retrait:'*123*1*{numero}*{montant}#',
    tpe_depot:'',
    tpe_retrait:'' },
];

// GET — tous les codes USSD
router.get('/', auth, async (req, res) => {
  try {
    let configs = await UssdConfig.find();
    if (!configs.length) return res.json(DEFAULTS);
    res.json(configs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST — sauvegarde codes USSD
router.post('/', auth, async (req, res) => {
  try {
    const { operator, gp_depot, gp_retrait, tpe_depot, tpe_retrait, gatewayNumero } = req.body;
    if (!operator) return res.status(400).json({ error: 'operator requis' });

    const update = { updatedBy: req.user?.username||'admin', updatedAt: new Date() };
    if (gp_depot    !== undefined) update.gp_depot    = gp_depot;
    if (gp_retrait  !== undefined) update.gp_retrait  = gp_retrait;
    if (tpe_depot   !== undefined) update.tpe_depot   = tpe_depot;
    if (tpe_retrait !== undefined) update.tpe_retrait = tpe_retrait;
    if (gatewayNumero !== undefined) update.gatewayNumero = gatewayNumero;

    const config = await UssdConfig.findOneAndUpdate(
      { operator }, update, { upsert: true, new: true }
    );
    res.json({ ok: true, config });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /seed-defaults — manoratra DEFAULTS ao DB (upsert)
router.post('/seed-defaults', auth, async (req, res) => {
  try {
    const out = [];
    for (const d of DEFAULTS) {
      const c = await UssdConfig.findOneAndUpdate(
        { operator: d.operator },
        { gp_depot:d.gp_depot, gp_retrait:d.gp_retrait, tpe_depot:d.tpe_depot, tpe_retrait:d.tpe_retrait,
          updatedBy: req.user?.username||'admin', updatedAt: new Date() },
        { upsert: true, new: true }
      );
      out.push(c);
    }
    res.json({ ok: true, seeded: out.length, configs: out });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /build — APK appelle ça pour obtenir le bon code USSD selon toggle
// FIX: lit tpe_depot/tpe_ret depuis settings pour choisir GP ou TPE
router.post('/build', apikey, async (req, res) => {
  try {
    const { operator, type, numero, montant } = req.body;
    // type = 'depot' ou 'retrait'
    if (!operator || !type || !numero || !montant)
      return res.status(400).json({ error: 'operator, type, numero, montant requis' });

    const opKey = operator.toLowerCase()
      .replace('orange money','orange')
      .replace('yas (telma)','mvola').replace('mvola','mvola').replace('telma','mvola')
      .replace('airtel money','airtel');

    const config = await UssdConfig.findOne({ operator: opKey });
    const opts   = require('./settings').getOptions();

    // Choix GP ou TPE selon toggle
    let ussdTemplate = '';
    if (type === 'depot') {
      // tpe_depot toggle ON → TPE, sinon GP
      ussdTemplate = (opts.tpe_depot && config?.tpe_depot)
        ? config.tpe_depot
        : (config?.gp_depot || DEFAULTS.find(d=>d.operator===opKey)?.gp_depot || '');
    } else {
      // tpe_ret toggle ON → TPE, sinon GP
      ussdTemplate = (opts.tpe_ret && config?.tpe_retrait)
        ? config.tpe_retrait
        : (config?.gp_retrait || DEFAULTS.find(d=>d.operator===opKey)?.gp_retrait || '');
    }

    if (!ussdTemplate)
      return res.status(404).json({ error: 'Code USSD non configuré pour '+opKey });

    // Remplace placeholders
    const ussdCode = ussdTemplate
      .replace('{numero}', numero)
      .replace('{montant}', montant);

    res.json({ ok: true, ussdCode, channel: opts[type==='depot'?'tpe_depot':'tpe_ret'] ? 'TPE' : 'Grand Public' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE reset
router.delete('/reset', auth, async (req, res) => {
  try {
    await UssdConfig.deleteMany({});
    res.json({ ok: true, message: 'Codes réinitialisés' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
