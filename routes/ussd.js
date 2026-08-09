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
  { operator:'mvola_km',
    gp_depot:'', gp_retrait:'', tpe_depot:'', tpe_retrait:'' },
  { operator:'airtel',
    gp_depot:'*123*2*{numero}*{montant}#',
    gp_retrait:'*123*1*{numero}*{montant}#',
    tpe_depot:'',
    tpe_retrait:'' },
];

const Settings = require('../models/Settings');
const PIN_OPS = ['orange', 'mvola', 'mvola_km', 'airtel'];

// Lecture simple d'un Setting (fallback si absent/vide).
async function getSetting(cle, defaut) {
  try {
    const d = await Settings.findOne({ key: cle });
    return (d && d.value !== undefined && d.value !== null && String(d.value) !== '')
      ? String(d.value).trim() : defaut;
  } catch (e) { return defaut; }
}

// Orange double portefeuille : true si le portefeuille "marchand" est actif
// (Setting global "orange_wallet_active"). N'affecte QUE Orange.
async function orangeMarchandActif(opKey) {
  if (String(opKey || '').toLowerCase() !== 'orange') return false;
  return String(await getSetting('orange_wallet_active', 'tsotra')).toLowerCase() === 'marchand';
}

// GET /api/ussd/pins — PIN mobile money par operateur (admin).
// Renvoie masque par defaut ; ?reveal=1 pour la valeur reelle (pre-remplissage).
router.get('/pins', auth, async (req, res) => {
  try {
    const reveal = String(req.query.reveal || '') === '1';
    const docs = await Settings.find({ key: { $in: PIN_OPS.map(o => 'ussd_pin_' + o) } });
    const out = {};
    PIN_OPS.forEach(o => { out[o] = ''; });
    docs.forEach(d => {
      const op = String(d.key).replace('ussd_pin_', '');
      const v = d.value || '';
      out[op] = reveal ? v : (v ? '•'.repeat(String(v).length) : '');
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ussd/pins — enregistre les PIN. Un champ vide/absent = inchange
// (evite d'effacer un PIN par megarde). Envoyer "-" pour effacer.
router.post('/pins', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const saved = [];
    for (const op of PIN_OPS) {
      if (body[op] === undefined) continue;
      const raw = String(body[op]).trim();
      if (!raw) continue;                    // vide => on ne touche pas
      const val = (raw === '-') ? '' : raw;  // "-" => effacer
      if (val && !/^[0-9]{3,8}$/.test(val))
        return res.status(400).json({ error: 'PIN ' + op + ' invalide (3 a 8 chiffres)' });
      await Settings.findOneAndUpdate({ key: 'ussd_pin_' + op }, { value: val }, { upsert: true });
      saved.push(op);
    }
    res.json({ ok: true, saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      .replace('mvola comores','mvola_km').replace('telma comores','mvola_km').replace('mvola_km','mvola_km')
      .replace('yas (telma)','mvola').replace('mvola','mvola').replace('telma','mvola')
      .replace('airtel money','airtel');

    const config = await UssdConfig.findOne({ operator: opKey });
    const opts   = require('./settings').getOptions();

    // Orange double portefeuille : si "marchand" actif, modele dedie (Settings),
    // fallback sur "tsotra" (config) si vide. N'affecte QUE Orange.
    const marchand = await orangeMarchandActif(opKey);

    // Choix GP ou TPE selon toggle
    let ussdTemplate = '';
    if (type === 'depot') {
      let gp = config?.gp_depot || DEFAULTS.find(d=>d.operator===opKey)?.gp_depot || '';
      if (marchand) { const m = await getSetting('orange_marchand_gp_depot', ''); if (m) gp = m; }
      // tpe_depot toggle ON → TPE, sinon GP
      ussdTemplate = (opts.tpe_depot && config?.tpe_depot)
        ? config.tpe_depot
        : gp;
    } else {
      let gp = config?.gp_retrait || DEFAULTS.find(d=>d.operator===opKey)?.gp_retrait || '';
      if (marchand) { const m = await getSetting('orange_marchand_gp_retrait', ''); if (m) gp = m; }
      // tpe_ret toggle ON → TPE, sinon GP
      ussdTemplate = (opts.tpe_ret && config?.tpe_retrait)
        ? config.tpe_retrait
        : gp;
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

// ============================================================
// Orange double portefeuille (tsotra / marchand)
// GET  /api/ussd/orange-wallet  -> lit la config (pre-remplissage admin)
// POST /api/ussd/orange-wallet  -> enregistre switch + config marchand
// Tout est stocke dans Settings (key-value), aucun changement de schema.
// ============================================================
router.get('/orange-wallet', auth, async (req, res) => {
  try {
    const active     = await getSetting('orange_wallet_active', 'tsotra');
    const gp_retrait = await getSetting('orange_marchand_gp_retrait', '');
    const gp_depot   = await getSetting('orange_marchand_gp_depot', '');
    const gateway    = await getSetting('orange_marchand_gateway', '');
    const pinDoc     = await Settings.findOne({ key: 'ussd_pin_orange_marchand' });
    const pin_set    = !!(pinDoc && pinDoc.value && String(pinDoc.value).trim() !== '');
    res.json({ ok: true, active, gp_retrait, gp_depot, gateway, pin_set });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orange-wallet', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const set = (key, value) =>
      Settings.findOneAndUpdate({ key }, { value }, { upsert: true });

    if (b.active !== undefined) {
      const a = String(b.active).toLowerCase() === 'marchand' ? 'marchand' : 'tsotra';
      await set('orange_wallet_active', a);
    }
    if (b.gp_retrait !== undefined) await set('orange_marchand_gp_retrait', String(b.gp_retrait).trim());
    if (b.gp_depot   !== undefined) await set('orange_marchand_gp_depot',   String(b.gp_depot).trim());
    if (b.gateway    !== undefined) await set('orange_marchand_gateway',    String(b.gateway).replace(/[\s.\-]/g, ''));
    if (b.pin !== undefined) {
      const raw = String(b.pin).trim();
      if (raw && raw !== '-' && !/^[0-9]{3,8}$/.test(raw))
        return res.status(400).json({ error: 'PIN marchand invalide (3 a 8 chiffres)' });
      await set('ussd_pin_orange_marchand', raw === '-' ? '' : raw);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
