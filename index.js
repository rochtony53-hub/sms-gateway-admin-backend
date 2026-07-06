const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/auth/passkey', require('./routes/passkey'));
app.use('/api/sms',     require('./routes/sms'));
app.use('/api/device',  require('./routes/device'));
app.use('/api/retrait', require('./routes/retrait'));
app.use('/api/numero', require('./routes/numero'));
app.use('/api/template', require('./routes/template'));
app.use('/api/ussd',    require('./routes/ussd'));
app.use('/api/rate',    require('./routes/rate'));
app.use('/api/stats',   require('./routes/stats'));
app.use('/api/service', require('./routes/service'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/solde',   require('./routes/solde'));
app.use('/api/deriv',   require('./routes/deriv'));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.1.0', time: new Date().toISOString() }));

// Keepalive endpoint pour UptimeRobot - leger, pas de DB query
app.get('/keepalive', (req, res) => res.json({ alive: true, uptime: process.uptime() }));
// Alias ultra-leger (repond aussi aux HEAD d'UptimeRobot)
app.get('/ping', (req, res) => res.status(200).send('pong'));

/* ============================================================
 * ANTI-SLEEP RENDER (triple filet de securite)
 *  1. UptimeRobot (externe)          -> /keepalive isaky 5 min
 *  2. SELF-PING (interne -> URL publique) isaky 10 min
 *     Render manome RENDER_EXTERNAL_URL automatique.
 *  3. CROSS-PING: mifampitsidika amin'ny services hafa
 *     (env PEER_PING_URLS, separee par virgules)
 * ============================================================ */
const SELF_URL  = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const PEER_URLS = (process.env.PEER_PING_URLS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

async function pingUrl(url, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url + '/keepalive', { signal: ctrl.signal });
    if (!r.ok) console.error(`[keepalive] ${label} HTTP ${r.status}`);
  } catch (e) {
    console.error(`[keepalive] ${label} echec:`, e.name === 'AbortError' ? 'timeout' : e.message);
  } finally { clearTimeout(t); }
}
function startKeepalivePings() {
  const run = () => {
    if (SELF_URL) pingUrl(SELF_URL, 'self');
    PEER_URLS.forEach((u, i) => setTimeout(() => pingUrl(u, 'peer:' + u), 2000 * (i + 1)));
  };
  // Jitter kely mba tsy hitovy segondra foana
  setInterval(run, 10 * 60 * 1000 + Math.floor(Math.random() * 30000));
  setTimeout(run, 15000); // ping voalohany 15s aorian'ny demarrage
  console.log('[keepalive] self:', SELF_URL || '(non configure)', '| peers:', PEER_URLS.length);
}
startKeepalivePings();

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connecté');
    app.listen(process.env.PORT || 3000, () =>
      console.log('Backend démarré port', process.env.PORT || 3000));

    // Auto-refuse les transactions pending depuis plus de 24h
    const Retrait = require('./models/Retrait');
    const DELAY_MS = 24 * 60 * 60 * 1000;
    setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - DELAY_MS);
        const expired = await Retrait.find({ status: 'pending', createdAt: { $lte: cutoff } });
        for (const r of expired) {
          await Retrait.findByIdAndUpdate(r._id, {
            status: 'failed',
            updatedAt: new Date(),
            response: 'Refusé automatiquement — délai de 24h dépassé sans validation solde'
          });
          console.log('Auto-refuse retrait', r._id, r.operator, r.numero, r.montant);
        }
      } catch (e) {
        console.error('Auto-refuse cron error:', e.message);
      }
    }, 10 * 60 * 1000); // vérifie toutes les 10 minutes
  })
  .catch(err => { console.error('MongoDB error:', err); process.exit(1); });
