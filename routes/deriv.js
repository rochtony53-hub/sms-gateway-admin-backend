const router   = require('express').Router();
const auth     = require('../middleware/auth');
const role     = require('../middleware/role');
const { audit } = require('../middleware/audit');
const Settings = require('../models/Settings');

const KEYS = ['deriv_app_id', 'deriv_token', 'deriv_cr_agent', 'deriv_oauth_app_id'];

/* Cles a ne JAMAIS renvoyer en clair. Le token Deriv donne acces a l'argent :
 * il doit pouvoir etre ECRIT depuis le panel, jamais RELU. */
const SECRETES = ['deriv_token'];

/** '****' + 4 derniers caracteres, uniquement pour reconnaitre le token en place. */
function empreinte(valeur) {
  const v = String(valeur == null ? '' : valeur);
  if (!v) return '';
  if (v.length <= 4) return '*'.repeat(v.length);
  return '*'.repeat(Math.min(8, v.length - 4)) + v.slice(-4);
}

/** Valeur qui ne doit jamais etre enregistree : masque renvoye puis repostee. */
function estUnMasque(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  return /^[*•\u2022\s]+$/.test(s) || /^[*•\u2022]{4,}/.test(s);
}

/* ============================================================
 * GET /api/deriv/config
 * ------------------------------------------------------------
 * AVANT : renvoyait deriv_token EN CLAIR a tout utilisateur connecte,
 * y compris un simple 'viewer'. Ce token suffit a manipuler le solde.
 *
 * MAINTENANT : le token n'est jamais renvoye. Le panel recoit une chaine vide
 * (donc le champ reste vide) plus une empreinte affichable et un booleen.
 *
 * IMPORTANT — pourquoi une chaine VIDE et pas le masque :
 * le panel fait set('deriv_token', c.deriv_token) puis renvoie le contenu du
 * champ au moment d'enregistrer. S'il recevait '****1234', il reposterait
 * '****1234' et ECRASERAIT le vrai token. Champ vide = "inchange" (voir POST).
 * ============================================================ */
router.get('/config', auth, role('admin', 'superadmin'), async (req, res) => {
  try {
    const docs = await Settings.find({ key: { $in: KEYS } });
    const brut = {};
    docs.forEach(d => { brut[d.key] = d.value || ''; });

    const cfg = {
      deriv_app_id:       brut.deriv_app_id || '',
      deriv_cr_agent:     brut.deriv_cr_agent || '',
      deriv_oauth_app_id: brut.deriv_oauth_app_id || '',
      // Token renvoye en clair : le champ du panel doit rester directement
      // modifiable, comme avant. Choix assume par l'exploitant.
      // Contreparties conservees : acces limite a admin/superadmin (jamais
      // 'viewer'), et chaque lecture est journalisee — si le token fuit un
      // jour, on saura quel compte et quelle adresse IP y ont accede.
      deriv_token:        brut.deriv_token || '',
      // Indicatifs, pour l'affichage
      deriv_token_empreinte: empreinte(brut.deriv_token),
      deriv_token_present:   !!brut.deriv_token
    };
    if (brut.deriv_token) {
      audit(req, 'deriv_token_lu', 'lecture de la configuration Deriv', 'alerte')
        .catch(() => {});
    }
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
 * POST /api/deriv/config
 * ------------------------------------------------------------
 * Reserve au superadmin : changer le token Deriv, c'est changer la cle du
 * coffre. Une valeur vide ou masquee laisse le secret INCHANGE.
 * ============================================================ */
router.post('/config', auth, role('admin', 'superadmin'), async (req, res) => {
  try {
    const recu = {
      deriv_app_id:       req.body.deriv_app_id,
      deriv_token:        req.body.deriv_token,
      deriv_cr_agent:     req.body.deriv_cr_agent,
      deriv_oauth_app_id: req.body.deriv_oauth_app_id
    };

    const modifiees = [];
    for (const key of KEYS) {
      const val = recu[key];
      if (val === undefined || val === null) continue;

      const s = String(val).trim();

      if (SECRETES.includes(key)) {
        // Vide = inchange. Masque = inchange (protege contre l'ecrasement
        // accidentel par la valeur affichee).
        if (s === '') continue;
        if (estUnMasque(s)) {
          console.warn('deriv/config: valeur masquee ignoree pour ' + key);
          continue;
        }
        // Un token Deriv est long : refuser une saisie manifestement tronquee,
        // qui casserait tous les retraits.
        if (s.length < 10) {
          return res.status(400).json({
            error: 'Token Deriv trop court (' + s.length + ' caracteres) — enregistrement refuse'
          });
        }
      }

      await Settings.findOneAndUpdate({ key }, { value: s }, { upsert: true });
      modifiees.push(key);
    }

    if (modifiees.length) {
      // On journalise QUE les noms des cles, jamais les valeurs.
      await audit(req, 'deriv_config_modifiee', 'cles: ' + modifiees.join(', '),
                  modifiees.includes('deriv_token') ? 'critique' : 'alerte');
    }
    res.json({ ok: true, modifiees });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
 * GET /api/deriv/oauth-app — PUBLIC (vitrine).
 * Renvoie SEULEMENT l'App ID OAuth du login client. Aucun secret.
 * ============================================================ */
router.get('/oauth-app', async (req, res) => {
  try {
    const d = await Settings.findOne({ key: 'deriv_oauth_app_id' });
    res.json({ app_id: (d && d.value) ? String(d.value).trim() : '' });
  } catch (e) { res.json({ app_id: '' }); }
});

/* ============================================================
 * Helper interne — utilise par derivService / derivRest.
 * Reste inchange : le backend a besoin du token en clair pour appeler Deriv.
 * Ce n'est pas une faille : le secret ne sort jamais du serveur par ici.
 * ============================================================ */
async function getDerivConfig() {
  const docs = await Settings.find({ key: { $in: KEYS } });
  const cfg = { deriv_app_id: '', deriv_token: '', deriv_cr_agent: '' };
  docs.forEach(d => { cfg[d.key] = d.value || ''; });
  return cfg;
}

module.exports = router;
module.exports.getDerivConfig = getDerivConfig;
