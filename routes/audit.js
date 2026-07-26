const router   = require('express').Router();
const auth     = require('../middleware/auth');
const role     = require('../middleware/role');
const AuditLog = require('../models/AuditLog');

/* GET /api/audit?action=login_echec&gravite=critique&limit=100
 * Journal de securite. Reserve au superadmin : savoir qui a tente quoi est
 * en soi une information sensible. */
router.get('/', auth, role('superadmin'), async (req, res) => {
  try {
    const filtre = {};
    if (req.query.action)  filtre.action  = String(req.query.action);
    if (req.query.gravite) filtre.gravite = String(req.query.gravite);
    if (req.query.ip)      filtre.ip      = String(req.query.ip);
    if (req.query.username) filtre.username = String(req.query.username);

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const logs = await AuditLog.find(filtre).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /api/audit/resume — vue d'ensemble des dernieres 24 h.
 * Repond a "est-ce que quelqu'un essaie d'entrer en ce moment ?" */
router.get('/resume', auth, role('superadmin'), async (req, res) => {
  try {
    const depuis = new Date(Date.now() - 24 * 3600 * 1000);
    const logs = await AuditLog.find({ createdAt: { $gte: depuis } }).lean();

    const parAction = {};
    const ipsEchec  = {};
    for (const l of logs) {
      parAction[l.action] = (parAction[l.action] || 0) + 1;
      if (l.action === 'login_echec' || l.action === 'login_bloque') {
        ipsEchec[l.ip] = (ipsEchec[l.ip] || 0) + 1;
      }
    }

    const suspectes = Object.entries(ipsEchec)
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .map(([ip, n]) => ({ ip, echecs: n }));

    res.json({
      periode: '24 dernieres heures',
      total: logs.length,
      parAction,
      critiques: logs.filter(l => l.gravite === 'critique').length,
      ipsSuspectes: suspectes,
      connexionsReussies: logs
        .filter(l => l.action === 'login_ok')
        .map(l => ({ username: l.username, ip: l.ip, date: l.createdAt }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
