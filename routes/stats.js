const router = require('express').Router();
const auth   = require('../middleware/auth');
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

module.exports = router;
