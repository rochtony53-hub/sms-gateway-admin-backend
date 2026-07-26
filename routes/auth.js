const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const { audit, clientIp } = require('../middleware/audit');

/* ============================================================
 * LIMITATION DES TENTATIVES DE CONNEXION
 * ------------------------------------------------------------
 * AVANT : /login n'avait aucune limite. Un attaquant pouvait essayer des
 * millions de mots de passe sans jamais etre ralenti.
 *
 * Compteur en memoire, sans dependance nouvelle.
 * LIMITE CONNUE : le compteur est propre a chaque instance du serveur. Avec
 * plusieurs instances, la limite effective est multipliee par leur nombre. Sur
 * une seule instance (cas actuel sur Render) la protection est complete.
 * ============================================================ */
const MAX_ESSAIS       = 5;
const FENETRE_MS       = 15 * 60 * 1000;   // 15 min
const BLOCAGE_MS       = 30 * 60 * 1000;   // 30 min apres MAX_ESSAIS

const tentatives = new Map();   // cle -> { n, premier, bloqueJusqua }

function cle(req, username) {
  return clientIp(req) + '|' + String(username || '').toLowerCase();
}

function etat(k) {
  const t = tentatives.get(k);
  if (!t) return null;
  if (t.bloqueJusqua && Date.now() > t.bloqueJusqua) { tentatives.delete(k); return null; }
  if (!t.bloqueJusqua && Date.now() - t.premier > FENETRE_MS) { tentatives.delete(k); return null; }
  return t;
}

function compterEchec(k) {
  const t = etat(k) || { n: 0, premier: Date.now(), bloqueJusqua: 0 };
  t.n++;
  if (t.n >= MAX_ESSAIS) t.bloqueJusqua = Date.now() + BLOCAGE_MS;
  tentatives.set(k, t);
  return t;
}

/** Empeche la Map de grossir indefiniment. */
setInterval(() => {
  const maintenant = Date.now();
  for (const [k, t] of tentatives) {
    const expire = t.bloqueJusqua ? t.bloqueJusqua : t.premier + FENETRE_MS;
    if (maintenant > expire) tentatives.delete(k);
  }
}, 10 * 60 * 1000);

/* Duree de vie du jeton. AVANT : 365 jours — un jeton vole restait valable un
 * an, sans aucun moyen de le revoquer. Reglable par variable d'environnement. */
const DUREE_JETON = process.env.JWT_EXPIRES || '12h';

// ------------------------------------------------------------------ Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const k = cle(req, username);

  try {
    const bloc = etat(k);
    if (bloc && bloc.bloqueJusqua) {
      const minutes = Math.ceil((bloc.bloqueJusqua - Date.now()) / 60000);
      await audit(req, 'login_bloque', 'utilisateur=' + username + ' reste ' + minutes + ' min', 'alerte');
      return res.status(429).json({
        error: 'Trop de tentatives. Reessayez dans ' + minutes + ' minute(s).'
      });
    }

    if (!username || !password) {
      compterEchec(k);
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const user = await User.findOne({ username });
    if (!user || !(await user.comparePassword(password))) {
      const t = compterEchec(k);
      // Message volontairement identique dans les deux cas : ne pas reveler
      // si le nom d'utilisateur existe.
      await audit(req, 'login_echec',
        'utilisateur=' + username + ' tentative ' + t.n + '/' + MAX_ESSAIS,
        t.n >= MAX_ESSAIS ? 'critique' : 'alerte');
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    tentatives.delete(k);
    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role },
      process.env.JWT_SECRET, { expiresIn: DUREE_JETON }
    );
    await audit(req, 'login_ok', 'role=' + user.role, 'info');
    res.json({ token, user: { username: user.username, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ Setup
 * AVANT : la seule protection etait "aucun utilisateur en base". Si la
 * collection User etait vidée — accidentellement ou par un attaquant ayant
 * touche la base — n'importe qui pouvait se creer un compte superadmin.
 * MAINTENANT : il faut EN PLUS activer explicitement ALLOW_SETUP=true dans
 * l'environnement, le temps de la creation, puis le retirer.
 */
router.post('/setup', async (req, res) => {
  try {
    if (String(process.env.ALLOW_SETUP || '').toLowerCase() !== 'true') {
      await audit(req, 'setup_refuse', 'ALLOW_SETUP absent', 'critique');
      return res.status(403).json({
        error: 'Setup desactive. Definissez ALLOW_SETUP=true pour l\'autoriser temporairement.'
      });
    }
    const count = await User.countDocuments();
    if (count > 0) {
      await audit(req, 'setup_refuse', 'des utilisateurs existent deja', 'critique');
      return res.status(403).json({ error: 'Setup deja effectue' });
    }
    const user = new User({ ...req.body, role: 'superadmin' });
    await user.save();
    await audit(req, 'setup_ok', 'superadmin=' + user.username, 'critique');
    res.json({ message: 'Admin cree' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------------ Verif jeton
router.get('/me', require('../middleware/auth'), (req, res) => {
  res.json(req.user);
});

module.exports = router;
