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

    // Build balances object
    const balances = { orange: 0, mvola: 0, airtel: 0 };
    soldes.forEach(s => {
      if(s.operator === 'mvola' || s.operator === 'yas') balances.mvola = s.montant;
      else balances[s.operator] = s.montant;
    });
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
    await require('../models/Solde').updateMany({}, { montant: 0 });
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

module.exports = router;

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

    const s = await Solde.findOneAndUpdate(
      { operator: opKey },
      { montant, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ ok: true, operator: opKey, montant: s.montant });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
