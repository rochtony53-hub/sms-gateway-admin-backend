const mongoose = require('mongoose');

/**
 * Journal de securite. Sert a repondre a la question "qui a touche a quoi, et
 * quand" — question a laquelle il etait impossible de repondre lors de
 * l'incident sur le solde Deriv, faute de toute trace.
 *
 * Ne contient JAMAIS de secret : on enregistre le fait qu'un secret a ete lu,
 * pas sa valeur.
 */
const auditLogSchema = new mongoose.Schema({
  // 'login_ok', 'login_echec', 'login_bloque', 'deriv_token_lu',
  // 'deriv_config_modifiee', 'pin_modifie', 'retrait_relance', ...
  action:    { type: String, required: true, index: true },
  username:  { type: String, default: '' },
  role:      { type: String, default: '' },
  ip:        { type: String, default: '' },
  userAgent: { type: String, default: '' },
  // Details non sensibles (jamais de token, jamais de PIN, jamais de mot de passe)
  detail:    { type: String, default: '' },
  gravite:   { type: String, enum: ['info', 'alerte', 'critique'], default: 'info' },
  createdAt: { type: Date, default: Date.now, index: true }
});

// Purge automatique apres 180 jours (assez long pour une enquete)
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
