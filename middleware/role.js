/**
 * Controle de role. A utiliser APRES le middleware auth.
 *
 * Motif : plusieurs routes sensibles ne verifiaient que "l'utilisateur est
 * connecte", sans regarder son role. Un compte 'viewer' pouvait ainsi lire des
 * secrets (notamment le token Deriv) qui donnent acces a l'argent.
 *
 *   router.get('/config', auth, role('superadmin'), handler)
 */
module.exports = function role(...autorises) {
  const liste = autorises.flat().map(r => String(r).toLowerCase());
  return (req, res, next) => {
    const r = req.user && req.user.role ? String(req.user.role).toLowerCase() : '';
    if (!r) return res.status(401).json({ error: 'Non authentifie' });
    if (!liste.includes(r)) {
      return res.status(403).json({
        error: 'Acces refuse : role ' + liste.join(' ou ') + ' requis'
      });
    }
    next();
  };
};
