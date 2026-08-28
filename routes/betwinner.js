// Config Betwinner (Cashdesk API) — mitovy pattern amin'ny deriv.js
const router   = require('express').Router();
const auth     = require('../middleware/auth');
const Settings = require('../models/Settings');

const KEYS = ['betwinner_hash', 'betwinner_cashierpass', 'betwinner_cashdeskid', 'betwinner_login', 'betwinner_lng'];

// GET /api/betwinner/config — admin maka ny config
router.get('/config', auth, async (req, res) => {
  try {
    const docs = await Settings.find({ key: { $in: KEYS } });
    const cfg = {};
    KEYS.forEach(k => cfg[k] = '');
    docs.forEach(d => { cfg[d.key] = d.value || ''; });
    res.json(cfg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/betwinner/config — admin manova ny config
router.post('/config', auth, async (req, res) => {
  try {
    for (const key of KEYS) {
      if (req.body[key] !== undefined) {
        await Settings.findOneAndUpdate({ key }, { value: req.body[key] }, { upsert: true });
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Helper interne
async function getBetwinnerConfig() {
  const docs = await Settings.find({ key: { $in: KEYS } });
  const cfg = { betwinner_lng: 'fr' };
  // trim() indispensable : un espace colle lors d'un copier-coller casse la
  // signature (401) alors que la valeur "parait" correcte dans l'admin.
  docs.forEach(d => { cfg[d.key] = String(d.value || cfg[d.key] || '').trim(); });
  return cfg;
}

// GET /api/betwinner/diag[?userId=123] — DIAGNOSTIC (admin).
// 1) config presente ?  2) solde caisse (valide creds + formule de signature)
// 3) si userId fourni : essaie plusieurs variantes de signature pour /Users/{id}
//    et indique laquelle Betwinner accepte (evite de deviner la casse).
/* Adresse IP par laquelle ce serveur sort vers Internet.
 * Betwinner filtre l'acces par IP : un 403 identique sur TOUTES les variantes
 * de signature signifie que la requete est refusee avant tout calcul, donc au
 * niveau de l'autorisation. Connaitre cette IP permet de la comparer a celle
 * de la passerelle qui fonctionne, et de la faire declarer chez Betwinner. */
async function ipSortante() {
  const sources = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  for (const url of sources) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const ip = (await r.text()).trim();
        if (/^[0-9a-fA-F:.]{7,45}$/.test(ip)) return ip;
      }
    } catch (_) { /* source suivante */ }
  }
  return null;
}

// GET /api/betwinner/ip — adresse IP sortante du serveur (admin)
router.get('/ip', auth, async (req, res) => {
  try {
    if (!req.user || !['admin','superadmin'].includes(req.user.role))
      return res.status(403).json({ error: 'Acces refuse: admin requis' });
    const ip = await ipSortante();
    res.json({
      ok: !!ip,
      ip: ip || null,
      note: ip
        ? 'Communiquez cette adresse a Betwinner pour la caisse concernee, '
        + 'et comparez-la a celle de la passerelle qui fonctionne deja.'
        : 'Adresse sortante indeterminee (aucun service joignable).'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/diag', auth, async (req, res) => {
  const crypto = require('crypto');
  const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
  const md5    = v => crypto.createHash('md5').update(String(v)).digest('hex');
  const BASE   = 'https://partners.servcul.com/CashdeskBotAPI';
  const out = { config: {}, balance: null, variants: [], ok: false };
  try {
    // Adresse IP sortante : element decisif quand toutes les variantes de
    // signature renvoient le meme code. A comparer avec la passerelle qui
    // fonctionne deja, et a faire declarer chez Betwinner.
    out.ipSortante = await ipSortante();
    const cfg = await getBetwinnerConfig();
    const H = cfg.betwinner_hash, P = cfg.betwinner_cashierpass, C = cfg.betwinner_cashdeskid;
    const L = cfg.betwinner_lng || 'fr';
    out.config = {
      hash:        H ? ('OK (' + String(H).slice(0, 4) + '…)') : 'MANQUANT',
      cashierpass: P ? 'OK' : 'MANQUANT',
      cashdeskid:  C ? String(C) : 'MANQUANT',
      lng:         L
    };
    if (!H || !P || !C) {
      out.error = 'Configuration Betwinner incomplete (hash / cashierpass / cashdeskid).';
      return res.status(400).json(out);
    }

    // --- 1) Solde caisse : valide les identifiants + la formule generale ---
    try {
      const { betwinnerBalance } = require('./betwinnerService');
      const b = await betwinnerBalance();
      out.balance = b;
      out.ok = true;
      out.detail = 'Identifiants et signature valides (solde caisse lu avec succes).';
    } catch (e) {
      out.balanceError = e.message || String(e);
      if (e.httpStatus === 401) {
        out.error = 'Signature refusee sur le solde caisse : hash / cashierpass / cashdeskid probablement incorrects.';
      }
    }

    // --- 1bis) Variantes pour le solde caisse (si l'appel standard a echoue) ---
    if (out.balanceError) {
      const d = new Date(); const pad = n => String(n).padStart(2, '0');
      const dt = d.getUTCFullYear() + '.' + pad(d.getUTCMonth()+1) + '.' + pad(d.getUTCDate())
               + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
      const confirmB = md5(C + ':' + H);
      const balVariants = [
        { nom: 'A doc (cashdeskid minuscule)', s1: 'hash=' + H + '&cashdeskid=' + C + '&dt=' + dt,
          s2: 'dt=' + dt + '&cashierpass=' + P + '&cashdeskid=' + C },
        { nom: 'B cashdeskId camel',           s1: 'hash=' + H + '&cashdeskId=' + C + '&dt=' + dt,
          s2: 'dt=' + dt + '&cashierpass=' + P + '&cashdeskId=' + C },
        { nom: 'C avec lng',                   s1: 'hash=' + H + '&lng=' + L + '&cashdeskid=' + C + '&dt=' + dt,
          s2: 'dt=' + dt + '&cashierpass=' + P + '&cashdeskid=' + C },
        { nom: 'D s2 avec hash',               s1: 'hash=' + H + '&cashdeskid=' + C + '&dt=' + dt,
          s2: 'dt=' + dt + '&cashierpass=' + P + '&hash=' + H }
      ];
      // Les 4 variantes ci-dessus ne font varier que le SIGN : le confirm y
      // reste identique. Un confirm errone produirait donc le meme 403 partout,
      // exactement comme un filtrage par IP. Pour distinguer les deux causes on
      // essaie aussi plusieurs formules de confirm : si l'une passe, le probleme
      // est dans le code ; si toutes echouent avec le meme 403, l'appel est
      // refuse avant tout controle -- c'est alors une question d'autorisation.
      const confirmVariants = [
        { nom: 'cashdeskid:hash', val: md5(C + ':' + H) },
        { nom: 'hash:cashdeskid', val: md5(H + ':' + C) },
        { nom: 'cashdeskid:cashierpass', val: md5(C + ':' + P) },
        { nom: 'hash seul', val: md5(String(H)) },
        { nom: 'cashdeskid seul', val: md5(String(C)) }
      ];
      out.confirmVariants = [];
      for (const cv of confirmVariants) {
        const s1c = sha256('hash=' + H + '&cashdeskid=' + C + '&dt=' + dt);
        const s2c = md5('dt=' + dt + '&cashierpass=' + P + '&cashdeskid=' + C);
        const signc = sha256(s1c + s2c);
        try {
          const r = await fetch(BASE + '/Cashdesk/' + encodeURIComponent(C) +
            '/Balance?confirm=' + cv.val + '&dt=' + encodeURIComponent(dt), { headers: { sign: signc } });
          const txt = await r.text();
          out.confirmVariants.push({
            confirm: cv.nom, http: r.status,
            resultat: r.status === 200 ? 'ACCEPTEE' : 'HTTP ' + r.status,
            apercu: String(txt).slice(0, 100)
          });
          if (r.status === 200) { out.confirmValide = cv.nom; break; }
        } catch (e) {
          out.confirmVariants.push({ confirm: cv.nom, resultat: 'erreur reseau: ' + (e.message || '') });
        }
      }

      out.balanceVariants = [];
      for (const v of balVariants) {
        const sign = sha256(sha256(v.s1) + md5(v.s2));
        try {
          const r = await fetch(BASE + '/Cashdesk/' + encodeURIComponent(C) +
            '/Balance?confirm=' + confirmB + '&dt=' + encodeURIComponent(dt), { headers: { sign } });
          const txt = await r.text();
          out.balanceVariants.push({
            variante: v.nom, http: r.status,
            resultat: r.status === 200 ? '✅ ACCEPTEE' : (r.status === 401 ? 'signature refusee' : 'HTTP ' + r.status),
            apercu: String(txt).slice(0, 100)
          });
          if (r.status === 200) { out.balanceVarianteValide = v.nom; break; }
        } catch (e) {
          out.balanceVariants.push({ variante: v.nom, resultat: 'erreur reseau: ' + (e.message || '') });
        }
      }
    }

    // --- 2) Variantes de signature pour la recherche joueur ---
    const uid = String(req.query.userId || '').trim();
    if (uid) {
      const confirm = md5(uid + ':' + H);
      const variants = [
        { nom: 'A userId + cashdeskid',  s1: 'hash=' + H + '&userId=' + uid + '&cashdeskid=' + C, s2: 'userId=' + uid + '&cashierpass=' + P + '&hash=' + H, q: 'cashdeskid' },
        { nom: 'B userid minuscule',     s1: 'hash=' + H + '&userid=' + uid + '&cashdeskid=' + C, s2: 'userid=' + uid + '&cashierpass=' + P + '&hash=' + H, q: 'cashdeskid' },
        { nom: 'C cashdeskId camel',     s1: 'hash=' + H + '&userId=' + uid + '&cashdeskId=' + C, s2: 'userId=' + uid + '&cashierpass=' + P + '&hash=' + H, q: 'cashdeskId' },
        { nom: 'D avec lng',             s1: 'hash=' + H + '&lng=' + L + '&userid=' + uid,        s2: 'userId=' + uid + '&cashierpass=' + P + '&hash=' + H, q: 'cashdeskid' },
        { nom: 'E s2 sans hash',         s1: 'hash=' + H + '&userId=' + uid + '&cashdeskid=' + C, s2: 'userId=' + uid + '&cashierpass=' + P,                q: 'cashdeskid' }
      ];
      for (const v of variants) {
        const sign = sha256(sha256(v.s1) + md5(v.s2));
        try {
          const r = await fetch(BASE + '/Users/' + encodeURIComponent(uid) +
            '?confirm=' + confirm + '&' + v.q + '=' + encodeURIComponent(C), { headers: { sign } });
          const txt = await r.text();
          out.variants.push({
            variante: v.nom, http: r.status,
            resultat: r.status === 200 ? '✅ ACCEPTEE' : (r.status === 401 ? 'signature refusee' : 'HTTP ' + r.status),
            apercu: String(txt).slice(0, 120)
          });
          if (r.status === 200) { out.varianteValide = v.nom; break; }
        } catch (e) {
          out.variants.push({ variante: v.nom, resultat: 'erreur reseau: ' + (e.message || '') });
        }
      }
    }
    res.status(out.ok || out.varianteValide ? 200 : 400).json(out);
  } catch (e) {
    out.error = e.message || String(e);
    res.status(400).json(out);   // jamais 401/403 : sinon l'admin se deconnecte
  }
});

module.exports = router;
module.exports.getBetwinnerConfig = getBetwinnerConfig;
