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

// ====================================================================
// Avis au partenaire (webhook)
//
// L'adresse et la cle de signature vivent ici, reglables sans toucher au
// code. Reserve a l'administration : qui changerait l'adresse detournerait
// les avis de paiement.
// ====================================================================
function estAdmin(req) {
  return !!(req.user && ['admin', 'superadmin'].includes(req.user.role));
}

router.get('/webhook', auth, async (req, res) => {
  if (!estAdmin(req)) return res.status(403).json({ error: 'Acces refuse' });
  try {
    const docs = await Settings.find({ key: { $in: [
      'partenaire_webhook_url', 'partenaire_webhook_secret', 'partenaire_webhook_depuis'
    ] } });
    const c = {}; docs.forEach(d => { c[d.key] = d.value; });

    const Retrait = require('../models/Retrait');
    const jour = new Date(Date.now() - 86400000);
    const base = { clientRef: { $nin: [null, ''] }, status: { $in: ['success', 'failed'] }, updatedAt: { $gte: jour } };
    const [livres, attente, abandon] = await Promise.all([
      Retrait.countDocuments({ ...base, webhookEnvoyeLe: { $ne: null } }),
      Retrait.countDocuments({ ...base, webhookEnvoyeLe: null, webhookEssais: { $lt: 5 } }),
      Retrait.countDocuments({ ...base, webhookEnvoyeLe: null, webhookEssais: { $gte: 5 } })
    ]);

    // La cle n'est jamais relue : on dit seulement qu'elle existe.
    res.json({
      url: c.partenaire_webhook_url || '',
      secretDefini: !!c.partenaire_webhook_secret,
      depuis: c.partenaire_webhook_depuis || null,
      stats24h: { livres, attente, abandon }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/webhook', auth, async (req, res) => {
  if (!estAdmin(req)) return res.status(403).json({ error: 'Acces refuse' });
  try {
    const url = String((req.body || {}).url || '').trim();
    if (url && !/^https:\/\//i.test(url))
      return res.status(400).json({ error: 'Adresse https obligatoire' });

    const ancien = await Settings.findOne({ key: 'partenaire_webhook_url' });
    await Settings.findOneAndUpdate({ key: 'partenaire_webhook_url' }, { value: url }, { upsert: true });

    // Nouvelle adresse : on ne rejoue pas l'historique, seuls les ordres
    // termines a partir de maintenant seront annonces.
    if (url && (!ancien || ancien.value !== url)) {
      await Settings.findOneAndUpdate({ key: 'partenaire_webhook_depuis' },
        { value: new Date().toISOString() }, { upsert: true });
    }

    // Cle de signature : creee une fois, ou regeneree sur demande. Elle
    // n'est montree qu'a cet instant — a transmettre au partenaire.
    let secretNouveau = null;
    const existe = await Settings.findOne({ key: 'partenaire_webhook_secret' });
    if (!existe || (req.body || {}).regenerer === true) {
      secretNouveau = require('crypto').randomBytes(32).toString('hex');
      await Settings.findOneAndUpdate({ key: 'partenaire_webhook_secret' },
        { value: secretNouveau }, { upsert: true });
    }
    res.json({ ok: true, url, secret: secretNouveau });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envoi d'essai : un faux ordre, pour que le partenaire verifie sa reception
// sans attendre un vrai paiement.
router.post('/webhook/test', auth, async (req, res) => {
  if (!estAdmin(req)) return res.status(403).json({ error: 'Acces refuse' });
  try {
    const docs = await Settings.find({ key: { $in: ['partenaire_webhook_url', 'partenaire_webhook_secret'] } });
    const c = {}; docs.forEach(d => { c[d.key] = d.value; });
    if (!c.partenaire_webhook_url) return res.status(400).json({ error: 'Aucune adresse configuree' });
    const w = require('../utils/webhook');
    const faux = { _id: 'test-' + Date.now(), clientRef: 'test', type: 'depot', status: 'success',
                   montant: 100, devise: 'Ar', operator: 'mvola', numero: '0340000000',
                   sessionId: 'TEST', updatedAt: new Date() };
    const r = await w.livrer(c.partenaire_webhook_url, c.partenaire_webhook_secret, faux);
    res.json({ ok: r.ok, code: r.code, erreur: r.erreur || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.getOptions = () => options;
module.exports.tpeActif = tpeActif;
