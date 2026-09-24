const router = require('express').Router();
const role = require('../middleware/role');
const auth   = require('../middleware/auth');
const Settings = require('../models/Settings');
const apikey = require('../middleware/apikey');
const Sms    = require('../models/Sms');
const Retrait= require('../models/Retrait');
const Device = require('../models/Device');
const Solde  = require('../models/Solde');

router.get('/dashboard', auth, role('admin','superadmin'), async (req, res) => {
  try {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      smsTotal, smsToday,
      retraitTotal, retraitSuccess, retraitPending,
      depotPending, retraitSeulPending,
      devices,
      byOperator,
      soldes
    ] = await Promise.all([
      Sms.countDocuments(),
      Sms.countDocuments({ receivedAt: { $gte: today } }),
      Retrait.countDocuments(),
      Retrait.countDocuments({ status: 'success' }),
      Retrait.countDocuments({ status: 'pending' }),
      // La collection Retrait porte les DEUX sens (champ type). Un compteur
      // global "pending" melange donc depots et retraits : le badge lateral
      // "SMS Retrait" affichait le nombre de DEPOTS en attente. On separe.
      Retrait.countDocuments({ status: 'pending', type: 'depot' }),
      Retrait.countDocuments({ status: 'pending', type: { $ne: 'depot' } }),
      Device.find().sort({ lastSeen: -1 }).limit(10),
      Sms.aggregate([{ $group: { _id: '$operator', count: { $sum: 1 } } }]),
      Solde.find()
    ]);

    // Détermine si la vérification USSD est active (au moins un device online avec le toggle ON)
    // Meme seuil que routes/device.js : 12 minutes. Android met la passerelle
    // en veille et son battement arrive par a-coups ; a 2 minutes, le tableau
    // de bord declarait les telephones hors ligne et masquait les soldes alors
    // que les SMS et les retraits passaient.
    const onlineDevices = devices.filter(d => (Date.now() - new Date(d.lastSeen).getTime()) < 12 * 60 * 1000);
    const ussdCheckEnabled = onlineDevices.some(d => d.ussdCheckEnabled);

    // Build balances object — mihazo montant (verified) raha ON, montantOff raha OFF
    // Lecture par le service unique : Telma = YAS = MVola, et les eventuels
    // documents en double sont fusionnes au lieu de s'ecraser l'un l'autre
    // (l'ancien code faisait "balances[key] = ...", donc le dernier lu gagnait).
    const vueSolde = await require('./soldeService').lireSoldes();
    const balances = { orange: 0, mvola: 0, airtel: 0, mvola_km: 0 };
    const balancesVerified = { orange: null, mvola: null, airtel: null, mvola_km: null };
    for (const [key, v] of Object.entries(vueSolde)) {
      balances[key] = ussdCheckEnabled ? v.montant : v.montantOff;
      balancesVerified[key] = ussdCheckEnabled ? (v.baseTimestamp || null) : null;
    }
    // Total = Ariary IHANY (mvola_km en Fc tsy tafiditra amin'ny total Ar)
    const total = balances.orange + balances.mvola + balances.airtel;

    const devNow = Date.now();
    res.json({
      sms: { total: smsTotal, today: smsToday },
      // pending reste le total (compatibilite avec l'existant) ; les deux
      // nouveaux champs permettent d'afficher le bon nombre sur chaque menu.
      retrait: {
        total: retraitTotal, success: retraitSuccess, pending: retraitPending,
        pendingRetrait: retraitSeulPending,
      // Encaissements bookmaker dont le Mobile Money n'est jamais parti :
      // l'argent est sorti de la caisse et attend un remboursement.
      aRembourser: await Retrait.countDocuments({
        type: 'retrait', status: 'failed', rembourseLe: null,
        provider: { $in: ['Betwinner', '1XBET', '1WIN'] },
        montant: { $gt: 0 }
      }), pendingDepot: depotPending
      },
      devices: devices.map(d => ({
        ...d.toObject(),
        online: (devNow - new Date(d.lastSeen).getTime()) < 12 * 60 * 1000
      })),
      byOperator,
      week: await (async () => {
        const days = [];
        for(let i=6; i>=0; i--) {
          const start = new Date(now); start.setDate(start.getDate()-i); start.setHours(0,0,0,0);
          const end = new Date(start); end.setHours(23,59,59,999);
          const count = await Sms.countDocuments({ receivedAt: { $gte: start, $lte: end } });
          days.push(count);
        }
        return days;
      })(),
      balances,
      balancesVerified,
      soldeTotal: total
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/stats/solde — manova solde mivantana
router.patch('/solde', auth, async (req, res) => {
  try {
    const { operator, montant } = req.body;
    if (!operator || montant === undefined)
      return res.status(400).json({ error: 'operator sy montant requis' });
    const s = await Solde.findOneAndUpdate(
      { operator },
      { montant, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ ok: true, operator, montant: s.montant });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/stats/reset — réinitialiser toutes les stats
router.delete('/reset', auth, async (req, res) => {
  try {
    await require('../models/Sms').deleteMany({});
    await require('../models/Retrait').deleteMany({});
    await require('../models/Solde').updateMany({}, { montant: 0, montantOff: 0, baseAmount: 0, baseTimestamp: null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stats/solde-all — debug: voir tous les soldes (incl. debug entries)
router.get('/solde-all', auth, role('admin','superadmin'), async (req, res) => {
  try {
    const all = await Solde.find();
    res.json(all);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stats/balance — APK mandefa balance avy amin'ny USSD
router.post('/balance', apikey, async (req, res) => {
  try {
    const { operator, montant } = req.body;
    if (!operator || montant === undefined)
      return res.status(400).json({ error: 'operator sy montant requis' });
    const opKey = operator.toLowerCase().includes('orange') ? 'orange'
                : operator.toLowerCase().includes('mvola') || operator.toLowerCase().includes('yas') || operator.toLowerCase().includes('telma') ? 'mvola'
                : operator.toLowerCase().includes('airtel') ? 'airtel' : null;
    if (!opKey) return res.status(400).json({ error: 'operator tsy fantatra' });

    // Une lecture USSD mal decoupee renvoie parfois un chiffre isole : le
    // solde tombait alors a 1 Ar et bloquait tous les retraits, alors que la
    // caisse etait pleine. On refuse une chute brutale vers une valeur
    // invraisemblable ; l'APK reessaiera au prochain relev\u00e9.
    const nouveau = Number(montant);
    if (!Number.isFinite(nouveau) || nouveau < 0)
      return res.status(400).json({ error: 'montant invalide' });

    const actuel = await Solde.findOne({ operator: opKey }).lean();
    const avant = actuel ? Number(actuel.montant || 0) : 0;
    if (avant >= 10000 && nouveau < 100) {
      console.warn('[BALANCE] lecture suspecte ignoree : ' + opKey
                 + ' ' + avant + ' -> ' + nouveau);
      return res.json({ ok: true, operator: opKey, montant: avant, ignore: true });
    }

    const s = await Solde.findOneAndUpdate(
      { operator: opKey },
      { montant: nouveau, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ ok: true, operator: opKey, montant: s.montant });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
 * Numeros ecartes
 * ------------------------------------------------------------
 * Un numero inscrit ici ne peut plus servir a creer d'ordre, quel que soit
 * le compte qui l'emploie.
 * ============================================================ */
router.get('/numeros-bloques', auth, async (req, res) => {
  try {
    const NumeroBloque = require('../models/NumeroBloque');
    const l = await NumeroBloque.find({}).sort({ createdAt: -1 }).limit(300).lean();
    res.json({ ok: true, numeros: l });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/numeros-bloques', auth, async (req, res) => {
  try {
    if (!req.user || !['admin','superadmin'].includes(req.user.role))
      return res.status(403).json({ error: 'Acces refuse: admin requis' });
    const NumeroBloque = require('../models/NumeroBloque');
    const numero = String((req.body || {}).numero || '').trim();
    if (!numero) return res.status(400).json({ error: 'numero requis' });
    const deja = await NumeroBloque.findOne({ numero });
    if (deja) return res.status(409).json({ error: 'Numero deja ecarte' });
    const n = await NumeroBloque.create({
      numero, motif: String((req.body || {}).motif || '').trim(),
      parQui: req.user.username || ''
    });
    res.json({ ok: true, numero: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/numeros-bloques/:id', auth, async (req, res) => {
  try {
    if (!req.user || !['admin','superadmin'].includes(req.user.role))
      return res.status(403).json({ error: 'Acces refuse: admin requis' });
    const NumeroBloque = require('../models/NumeroBloque');
    const r = await NumeroBloque.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ error: 'Introuvable' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
 * Maintenance depot / retrait
 * ------------------------------------------------------------
 * Coupe la CREATION d'ordres neufs. Les ordres deja en cours poursuivent
 * leur chemin : un client qui a paye doit etre servi, meme si le service
 * ferme juste apres.
 * ============================================================ */
const CLES_MAINT = ['maintenance_depot', 'maintenance_retrait',
                    'maintenance_depot_message', 'maintenance_retrait_message'];

router.get('/maintenance', auth, async (req, res) => {
  try {
    const docs = await Settings.find({ key: { $in: CLES_MAINT } });
    const m = {}; docs.forEach(d => { m[d.key] = d.value; });
    res.json({
      ok: true,
      depot:   m.maintenance_depot === true || m.maintenance_depot === 'true',
      retrait: m.maintenance_retrait === true || m.maintenance_retrait === 'true',
      depot_message:   m.maintenance_depot_message || '',
      retrait_message: m.maintenance_retrait_message || ''
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/maintenance', auth, async (req, res) => {
  try {
    if (!req.user || !['admin','superadmin'].includes(req.user.role))
      return res.status(403).json({ error: 'Acces refuse: admin requis' });
    const b = req.body || {};
    const maj = [];
    for (const t of ['depot', 'retrait']) {
      if (t in b) {
        const on = b[t] === true || b[t] === 'true';
        await Settings.findOneAndUpdate({ key: 'maintenance_' + t },
          { $set: { value: on } }, { upsert: true });
        maj.push(t + '=' + (on ? 'ON' : 'OFF'));
        // Canal maintenance : la coupure doit se voir sans ouvrir le panneau.
        try {
          require('../utils/telegram').notifierMaintenance(
            (t === 'depot' ? 'Depots clients' : 'Retraits clients'),
            on ? 'hs' : 'ok',
            on ? 'Suspendus manuellement depuis le panneau admin.'
               : 'Reouverts depuis le panneau admin.',
            { impact: on ? 'Aucun nouvel ordre ' + t + ' ne peut etre cree. '
                         + 'Les ordres en cours se poursuivent.' : '' });
        } catch (e) {}
      }
      const cm = t + '_message';
      if (cm in b) {
        await Settings.findOneAndUpdate({ key: 'maintenance_' + cm },
          { $set: { value: String(b[cm] || '').trim() } }, { upsert: true });
      }
    }
    res.json({ ok: true, maj });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
