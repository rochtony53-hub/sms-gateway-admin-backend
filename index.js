const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

/* ============================================================
 * CORS — AVANT : app.use(cors()) autorisait TOUTE origine a appeler l'API.
 * MAINTENANT : liste blanche via la variable d'environnement CORS_ORIGINS
 * (origines separees par des virgules).
 *
 *   CORS_ORIGINS=https://mon-admin.pages.dev,https://matulmad.com
 *
 * Si CORS_ORIGINS est absent, on reste PERMISSIF pour ne pas couper le service
 * en production par surprise — mais un avertissement est affiche a chaque
 * demarrage. Definissez-la des que possible.
 *
 * A noter : les appels de l'APK et des scripts ne passent pas par CORS (ce
 * controle ne s'applique qu'aux navigateurs). CORS reduit la surface d'attaque
 * depuis un site tiers, il ne remplace pas l'authentification.
 * ============================================================ */
const ORIGINES = String(process.env.CORS_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

if (!ORIGINES.length) {
  console.warn('[SECURITE] CORS_ORIGINS non definie : toutes les origines sont acceptees. '
             + 'Definissez CORS_ORIGINS pour restreindre l\'acces depuis les navigateurs.');
  app.use(cors());
} else {
  console.log('[SECURITE] CORS limite a : ' + ORIGINES.join(', '));
  app.use(cors({
    origin: (origin, cb) => {
      // Pas d'en-tete Origin = appel hors navigateur (APK, curl) : laisse passer,
      // l'authentification par cle API ou jeton fait le tri.
      if (!origin) return cb(null, true);
      if (ORIGINES.includes(origin)) return cb(null, true);
      console.warn('[SECURITE] origine refusee : ' + origin);
      return cb(new Error('Origine non autorisee'));
    },
    credentials: true
  }));
}

// Render est derriere un proxy : necessaire pour lire la vraie IP du client
// (sinon toutes les tentatives de connexion semblent venir de la meme adresse
// et la limitation par IP devient inoperante).
app.set('trust proxy', 1);

// Limite la taille du corps : evite qu'une requete enorme sature la memoire.
app.use(express.json({ limit: '1mb' }));

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
app.use('/api/betwinner', require('./routes/betwinner'));
// Annonces affichees aux clients (cloche du site vitrine).
app.use('/api/announcements', require('./routes/announcement'));
// Orange Money Web Payment. /pay/go est monte a la RACINE (pas sous /api) :
// c'est l'url donnee au client, elle doit rester courte et neutre.
app.use('/api/orange-pay', require('./routes/orangePay'));
// Seule la redirection est publique a la racine : url courte donnee au client,
// sans exposer une seconde fois le webhook ni la configuration.
app.use('/pay/go',         require('./routes/orangePay').goRouter);
app.use('/api/alert', require('./routes/alert'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/diag',  require('./routes/diag'));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.1.0', time: new Date().toISOString() }));

// Keepalive endpoint pour UptimeRobot - leger, pas de DB query
app.get('/keepalive', (req, res) => res.json({ alive: true, uptime: process.uptime() }));
// Alias ultra-leger
app.get('/ping', (req, res) => res.status(200).send('pong'));

/* ============================================================
 * ANTI-SLEEP RENDER (triple filet de securite)
 *  1. UptimeRobot (externe)          -> /keepalive isaky 5 min
 *  2. SELF-PING (interne -> URL publique) isaky 10 min
 *     Render manome RENDER_EXTERNAL_URL automatique.
 *  3. CROSS-PING: PEER_PING_URLS (URLs separees par virgules)
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
(function startKeepalivePings() {
  const run = () => {
    if (SELF_URL) pingUrl(SELF_URL, 'self');
    PEER_URLS.forEach((u, i) => setTimeout(() => pingUrl(u, 'peer:' + u), 2000 * (i + 1)));
  };
  setInterval(run, 10 * 60 * 1000 + Math.floor(Math.random() * 30000));
  setTimeout(run, 15000);
  console.log('[keepalive] self:', SELF_URL || '(non configure)', '| peers:', PEER_URLS.length);
})();

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
