/**
 * Annonces affichees aux clients (cloche du site vitrine).
 *
 * GET /api/announcements est PUBLIC : le site l'appelle sans jeton, et ne
 * recoit que les annonces actives et non expirees.
 * Les autres routes exigent un compte admin.
 */
const express = require('express');
const Announcement = require('../models/Announcement');
const auth = require('../middleware/auth');

const router = express.Router();

function estAdmin(req) {
  return req.user && ['admin','superadmin'].includes(req.user.role);
}

// GET /api/announcements — public, lecture seule
router.get('/', async (req, res) => {
  try {
    const now = new Date();
    const list = await Announcement.find({
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ ok: true, announcements: list.map(a => ({
      id: a._id, title: a.title || '', body: a.body,
      level: a.level || 'info', createdAt: a.createdAt
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/announcements/all — admin : y compris inactives et expirees
router.get('/all', auth, async (req, res) => {
  try {
    if (!estAdmin(req)) return res.status(403).json({ error: 'Acces refuse' });
    const list = await Announcement.find({}).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ ok: true, announcements: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/announcements — admin
router.post('/', auth, async (req, res) => {
  try {
    if (!estAdmin(req)) return res.status(403).json({ error: 'Acces refuse' });
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message requis' });
    const a = await Announcement.create({
      title: String(req.body.title || '').trim(),
      body,
      level: ['info','success','warning'].includes(req.body.level) ? req.body.level : 'info',
      expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null
    });
    res.json({ ok: true, id: a._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/announcements/:id — admin (activer / desactiver)
router.patch('/:id', auth, async (req, res) => {
  try {
    if (!estAdmin(req)) return res.status(403).json({ error: 'Acces refuse' });
    const maj = {};
    if (typeof req.body.active === 'boolean') maj.active = req.body.active;
    if (typeof req.body.body === 'string' && req.body.body.trim()) maj.body = req.body.body.trim();
    if (typeof req.body.title === 'string') maj.title = req.body.title.trim();
    const a = await Announcement.findByIdAndUpdate(req.params.id, maj, { new: true });
    if (!a) return res.status(404).json({ error: 'Annonce introuvable' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/announcements/:id — admin
router.delete('/:id', auth, async (req, res) => {
  try {
    if (!estAdmin(req)) return res.status(403).json({ error: 'Acces refuse' });
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
