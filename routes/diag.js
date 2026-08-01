const router = require('express').Router();
const auth   = require('../middleware/auth');
const role   = require('../middleware/role');

/* ============================================================
 * GET /api/diag/ip
 * ------------------------------------------------------------
 * Renvoie l'adresse IP par laquelle CE serveur sort sur Internet.
 * C'est cette adresse que voient les partenaires (Betwinner, Deriv) et
 * c'est elle qu'il faut leur declarer, pas celle du telephone de l'admin.
 *
 * Utile quand la console d'hebergement n'affiche pas les IP sortantes.
 * ============================================================ */

// Plusieurs services : si l'un est indisponible, on essaie le suivant.
const SERVICES = [
  { url: 'https://api.ipify.org?format=json',        champ: 'ip' },
  { url: 'https://ifconfig.co/json',                 champ: 'ip' },
  { url: 'https://api.myip.com',                     champ: 'ip' },
  { url: 'https://ipinfo.io/json',                   champ: 'ip' }
];

async function ipSortante() {
  const essais = [];
  for (const s of SERVICES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(s.url, { signal: ctrl.signal });
      const j = await r.json();
      const ip = j && j[s.champ];
      if (ip) return { ip: String(ip), source: s.url, essais };
      essais.push({ service: s.url, resultat: 'reponse sans champ ' + s.champ });
    } catch (e) {
      essais.push({ service: s.url, resultat: e.name === 'AbortError' ? 'delai depasse' : e.message });
    } finally { clearTimeout(t); }
  }
  return { ip: null, essais };
}

router.get('/ip', auth, role('admin', 'superadmin'), async (req, res) => {
  try {
    const r = await ipSortante();
    if (!r.ip) {
      return res.status(502).json({
        ok: false,
        message: 'Impossible de determiner l\'IP sortante. Consultez la console '
               + 'de l\'hebergeur (Render > Settings > Outbound IP Addresses).',
        essais: r.essais
      });
    }
    res.json({
      ok: true,
      ip_sortante: r.ip,
      source: r.source,
      note: 'Adresse a declarer chez Betwinner. Attention : sur un hebergement '
          + 'mutualise, elle peut changer et il y en a souvent plusieurs. '
          + 'Rechargez cette page plusieurs fois pour toutes les relever.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
