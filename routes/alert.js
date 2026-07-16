// Alertes admin — vola tonga (solde niakatra) nefa tsy nisy SMS
const router  = require('express').Router();
const auth    = require('../middleware/auth');
const Alert   = require('../models/Alert');
const Retrait = require('../models/Retrait');

// GET /api/alert — lisitra (pending aloha)
router.get('/', auth, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const alerts = await Alert.find(filter).sort({ status: 1, createdAt: -1 }).limit(200).populate('retraitId');
    res.json(alerts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/alert/count — badge nav (pending)
router.get('/count', auth, async (req, res) => {
  try { res.json({ count: await Alert.countDocuments({ status: 'pending' }) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alert/:id/verifier — mampitaha ny ordre sy ny vola hita (info fotsiny)
router.post('/:id/verifier', auth, async (req, res) => {
  try {
    const a = await Alert.findById(req.params.id).populate('retraitId');
    if (!a) return res.status(404).json({ error: 'Alerte introuvable' });
    const r = a.retraitId;
    const tolMax = Math.round(a.montantAttendu * 1.10);
    const coherent = a.montantRecu >= a.montantAttendu && a.montantRecu <= tolMax;
    res.json({
      ok: true, coherent,
      ordre: r ? { id: r._id, montant: r.montant, numero: r.numero, operator: r.operator, provider: r.provider, providerId: r.providerId, status: r.status, createdAt: r.createdAt } : null,
      montantAttendu: a.montantAttendu, montantRecu: a.montantRecu, toleranceMax: tolMax,
      verdict: coherent ? 'Montant reçu cohérent avec l\'ordre (dans la tolérance +10%)' : 'Montant reçu HORS tolérance — vérifier manuellement'
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alert/:id/valider — manamarina ny dépôt (credit fournisseur)
router.post('/:id/valider', auth, async (req, res) => {
  try {
    const a = await Alert.findById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alerte introuvable' });
    if (a.status !== 'pending') return res.status(400).json({ error: 'Alerte déjà traitée' });
    const r = await Retrait.findById(a.retraitId);
    if (!r) return res.status(404).json({ error: 'Ordre introuvable' });

    let depotStatus = 'processing', err = '', txnId = '';
    if (r.providerId) {
      try {
        if (/betwinner/i.test(r.provider || '')) {
          const { betwinnerDeposit } = require('./betwinnerService');
          const b = await betwinnerDeposit(r.providerId, r.montant);
          if (b && b.ok) depotStatus = 'success';
        } else {
          // DEPOT DERIV via NICKNAME (REST) — request_id STABLE = idempotence
          // (partagé avec autoValidate/cron : même 'dep'+_id -> pas de double-crédit).
          const { restTransferToClient } = require('./derivRest');
          const reqId = 'dep' + String(r._id);
          const d = await restTransferToClient(r.providerId, r.montantUsd || r.montant, 'USD', reqId);
          if (d && d.ok) { depotStatus = 'success'; txnId = d.transaction_id || ''; }
          else err = 'Deriv: transfert ' + ((d && d.status) ? d.status : 'non confirme');
        }
      } catch(e2) { err = e2.message; }
    } else err = 'providerId manquant';

    await Retrait.findByIdAndUpdate(r._id, {
      status: depotStatus, receptionStatus: 'confirme',
      derivTxnId: txnId || r.derivTxnId || '', response: err || 'Validé via alerte admin (sans SMS)',
      updatedAt: new Date()
    });
    await Alert.findByIdAndUpdate(a._id, { status: 'valide', resolvedAt: new Date() });
    res.json({ ok: true, depotStatus, error: err || undefined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alert/:id/refuser
router.post('/:id/refuser', auth, async (req, res) => {
  try {
    const a = await Alert.findById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alerte introuvable' });
    if (a.status !== 'pending') return res.status(400).json({ error: 'Alerte déjà traitée' });
    await Retrait.findByIdAndUpdate(a.retraitId, {
      status: 'failed', receptionStatus: 'rejete',
      response: 'Refusé via alerte admin', updatedAt: new Date()
    });
    await Alert.findByIdAndUpdate(a._id, { status: 'refuse', resolvedAt: new Date() });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
