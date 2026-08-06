const router = require('express').Router();
const auth   = require('../middleware/auth');
const apikey = require('../middleware/apikey');
const Sms    = require('../models/Sms');
const Retrait= require('../models/Retrait');
const Device = require('../models/Device');
const Solde  = require('../models/Solde');

router.get('/dashboard', auth, async (req, res) => {
  try {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      smsTotal, smsToday,
      retraitTotal, retraitSuccess, retraitPending,
      devices,
      byOperator,
      soldes
    ] = await Promise.all([
      Sms.countDocuments(),
      Sms.countDocuments({ receivedAt: { $gte: today } }),
      Retrait.countDocuments(),
      Retrait.countDocuments({ status: 'success' }),
      Retrait.countDocuments({ status: 'pending' }),
      Device.find().sort({ lastSeen: -1 }).limit(10),
      Sms.aggregate([{ $group: { _id: '$operator', count: { $sum: 1 } } }]),
      Solde.find()
    ]);

    // Détermine si la vérification USSD est active (au moins un device online avec le toggle ON)
    const onlineDevices = devices.filter(d => (Date.now() - new Date(d.lastSeen).getTime()) < 120000);
    const ussdCheckEnabled = onlineDevices.some(d => d.ussdCheckEnabled);

    // Build balances object — mihazo montant (verified) raha ON, montantOff raha OFF.
    // On CANONICALISE la cle : sans cela, une entree "Orange Money" (au lieu de
    // "orange") creait une cle distincte -> solde Orange en double dans l'admin.
    // On ignore aussi les entrees garbage (operateur inconnu, montant negatif).
    const balances = { orange: 0, mvola: 0, airtel: 0, mvola_km: 0 };
    const balancesVerified = { orange: null, mvola: null, airtel: null, mvola_km: null };
    const canonOp = (op) => {
      const o = String(op || '').toLowerCase();
      if (o.includes('comor') || o.includes('mvola_km') || o.includes('telma_km')) return 'mvola_km';
      if (o.includes('orange')) return 'orange';
      if (o.includes('yas') || o.includes('telma') || o.includes('mvola')) return 'mvola';
      if (o.includes('airtel')) return 'airtel';
      return null;
    };
    soldes.forEach(s => {
      const key = canonOp(s.operator);
      if (!key) return;                                   // operateur inconnu / debug -> ignore
      const val = ussdCheckEnabled ? (s.montant || 0) : (s.montantOff || 0);
      if (typeof val === 'number' && val < 0) return;     // garbage negatif -> ignore
      balances[key] = val;
      balancesVerified[key] = ussdCheckEnabled ? (s.baseTimestamp || null) : null;
    });
    // Total en Ariary uniquement (mvola_km est en Fc comorien, hors total).
    const total = balances.orange + balances.mvola + balances.airtel;

    const devNow = Date.now();
    res.json({
      sms: { total: smsTotal, today: smsToday },
      retrait: { total: retraitTotal, success: retraitSuccess, pending: retraitPending },
      devices: devices.map(d => ({
        ...d.toObject(),
        online: (devNow - new Date(d.lastSeen).getTime()) < 120000
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
router.get('/solde-all', auth, async (req, res) => {
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

    // ----------------------------------------------------------------
    // GARDE-FOU ANTI-GARBAGE.
    // ----------------------------------------------------------------
    // L'ancien controle de solde "one-shot" cote APK (retire) envoyait ici
    // des valeurs inexploitables : montant -1 avec un operateur "debug_orange_
    // UNKNOWN_APPLICATION", qui ecrasaient le vrai solde. Meme si une ancienne
    // version de l'APK est encore installee quelque part, on refuse desormais :
    //   - tout operateur contenant "debug"
    //   - tout montant negatif ou non numerique
    // La lecture de solde fiable passe par /api/solde/check-result.
    // ----------------------------------------------------------------
    const opStr = String(operator).toLowerCase();
    if (opStr.includes('debug'))
      return res.status(400).json({ error: 'operator de debug refuse', operator });
    const montantNum = Number(montant);
    if (!Number.isFinite(montantNum) || montantNum < 0)
      return res.status(400).json({ error: 'montant invalide (negatif ou non numerique)', montant });

    const opKey = opStr.includes('orange') ? 'orange'
                : opStr.includes('mvola') || opStr.includes('yas') || opStr.includes('telma') ? 'mvola'
                : opStr.includes('airtel') ? 'airtel' : null;
    if (!opKey) return res.status(400).json({ error: 'operator tsy fantatra' });

    const s = await Solde.findOneAndUpdate(
      { operator: opKey },
      { montant: montantNum, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ ok: true, operator: opKey, montant: s.montant });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
