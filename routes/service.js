const router = require('express').Router();
const auth   = require('../middleware/auth');

// Commands pending ho an'ny APK
let pendingCommands = [];

// POST — admin mandefa command
router.post('/restart',     auth, (req, res) => { pendingCommands.push('restart');     res.json({ ok: true }); });
router.post('/stop',        auth, (req, res) => { pendingCommands.push('stop');        res.json({ ok: true }); });
router.post('/sync',        auth, (req, res) => { pendingCommands.push('sync');        res.json({ ok: true }); });
router.post('/update',      auth, (req, res) => { pendingCommands.push('update');      res.json({ ok: true }); });

// GET — APK manampy commands
router.get('/commands', (req, res) => {
  const cmds = [...pendingCommands];
  pendingCommands = [];
  res.json({ commands: cmds });
});

module.exports = router;
module.exports.getPendingCommands = () => pendingCommands;
module.exports.clearCommands = () => { pendingCommands = []; };
