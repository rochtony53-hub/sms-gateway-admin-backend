const AuditLog = require('../models/AuditLog');

/** IP reelle du client derriere le proxy Render. */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.ip || (req.connection && req.connection.remoteAddress) || '').replace('::ffff:', '');
}

/**
 * Enregistre un evenement de securite. Ne leve JAMAIS d'exception : une panne
 * de journalisation ne doit pas empecher une operation legitime, ni reveler
 * au passage que la journalisation existe.
 */
async function audit(req, action, detail, gravite) {
  try {
    await AuditLog.create({
      action,
      username:  (req && req.user && req.user.username) || (req && req.body && req.body.username) || '',
      role:      (req && req.user && req.user.role) || '',
      ip:        req ? clientIp(req) : '',
      userAgent: req ? String(req.headers['user-agent'] || '').slice(0, 200) : '',
      detail:    String(detail == null ? '' : detail).slice(0, 500),
      gravite:   gravite || 'info'
    });
  } catch (e) {
    console.error('audit:', e.message);
  }
}

module.exports = { audit, clientIp };
