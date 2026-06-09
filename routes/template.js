const router      = require('express').Router();
const auth        = require('../middleware/auth');
const SmsTemplate = require('../models/SmsTemplate');

// GET tous les templates
router.get('/', auth, async (req, res) => {
  try {
    const { operator, type } = req.query;
    const filter = {};
    if (operator) filter.operator = operator;
    if (type) filter.type = type;
    const data = await SmsTemplate.find(filter).sort({ createdAt: -1 });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST ajouter template
router.post('/', auth, async (req, res) => {
  try {
    const { operator, type, keywords, exemple } = req.body;
    if (!operator || !type || !keywords?.length)
      return res.status(400).json({ error: 'operator, type, keywords requis' });
    const t = new SmsTemplate({ operator, type, keywords, exemple, createdBy: req.user.username });
    await t.save();
    res.json({ id: t._id, ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE template
router.delete('/:id', auth, async (req, res) => {
  try {
    await SmsTemplate.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
