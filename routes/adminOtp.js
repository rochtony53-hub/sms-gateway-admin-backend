const router   = require('express').Router();
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const AdminOtp = require('../models/AdminOtp');
const User     = require('../models/User');

/**
 * Entree dans l'administration par code a usage unique.
 *
 * L'adresse qui recoit le code vit dans la configuration du serveur, jamais
 * dans une page : personne ne peut la lire ni en demander une autre. Une
 * demande ne dit donc rien de plus qu'elle est partie.
 */

const DUREE_MS   = 10 * 60 * 1000;   // le code vaut dix minutes
const MAX_ESSAIS = 5;                // au-dela, le code meurt

function empreinte(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

// POST /api/admin-otp/demander
router.post('/demander', async (req, res) => {
  try {
    const dest = process.env.ADMIN_OTP_EMAIL;
    if (!dest) return res.status(500).json({ error: 'Entree par code non configuree' });

    // Le code ne part qu'a qui connait deja le mot de passe. Sans ce controle,
    // n'importe qui pourrait remplir la boite aux lettres de codes et tenter
    // sa chance sur le second facteur.
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Identifiants requis' });

    const bcrypt = require('bcryptjs');
    const compte = await User.findOne({
      username: String(username).trim(),
      role: { $in: ['admin', 'superadmin'] }
    });
    // Meme reponse dans les deux cas : un message different dirait si le nom
    // existe, et aiderait a deviner le reste.
    const motOk = compte && await bcrypt.compare(String(password), compte.password || '');
    if (!motOk) return res.status(401).json({ error: 'Identifiants incorrects' });

    // Une demande en cours suffit : sans ce garde-fou, un clic repete
    // remplirait la boite et permettrait d'essayer plusieurs codes de front.
    const recent = await AdminOtp.findOne({
      utiliseLe: null, expireLe: { $gt: new Date() }
    }).sort({ _id: -1 });
    if (recent && Date.now() - recent.createdAt.getTime() < 60000) {
      return res.json({ ok: true, deja: true });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await AdminOtp.create({
      hash: empreinte(code),
      expireLe: new Date(Date.now() + DUREE_MS),
      username: compte.username,
      ip: req.ip || ''
    });

    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.MAIL_USER,
      to: dest,
      subject: 'Code administration MATULMADA',
      text: 'Code : ' + code + '\n\nValable dix minutes, une seule fois.\n'
          + 'Si vous n avez rien demande, ignorez ce message.'
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('[admin-otp] demande:', e.message);
    return res.status(500).json({ error: 'Envoi impossible' });
  }
});

// POST /api/admin-otp/verifier
router.post('/verifier', async (req, res) => {
  try {
    const code = String((req.body || {}).code || '').trim();
    if (!/^[0-9]{6}$/.test(code))
      return res.status(400).json({ error: 'Code invalide' });

    const otp = await AdminOtp.findOne({
      utiliseLe: null, expireLe: { $gt: new Date() }
    }).sort({ _id: -1 });

    if (otp.essais >= MAX_ESSAIS) {
      otp.utiliseLe = new Date();
      await otp.save();
      return res.status(429).json({ error: 'Trop d essais — redemandez un code' });
    }

    if (otp.hash !== empreinte(code)) {
      otp.essais += 1;
      await otp.save();
      return res.status(401).json({ error: 'Code incorrect' });
    }

    // Consomme avant de repondre : deux envois simultanes ne doivent pas
    // ouvrir deux sessions avec le meme code.
    otp.utiliseLe = new Date();
    await otp.save();

    const admin = otp.username
      ? await User.findOne({ username: otp.username, role: { $in: ['admin', 'superadmin'] } })
      : await User.findOne({ role: { $in: ['admin', 'superadmin'] } }).sort({ _id: 1 });

    const token = jwt.sign(
      { id: admin._id, username: admin.username, role: admin.role },
      process.env.JWT_SECRET, { expiresIn: '12h' }
    );
    return res.json({ ok: true, token, user: { username: admin.username, role: admin.role } });
  } catch (e) {
    console.error('[admin-otp] verif:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
