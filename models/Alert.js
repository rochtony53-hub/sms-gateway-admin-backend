const mongoose = require('mongoose');

// Alerte admin: vola tonga tao amin'ny gateway (solde niakatra) nefa tsy nisy
// SMS voaray — mila fanamarinana manuel (Vérifier / Valider / Refuser).
const alertSchema = new mongoose.Schema({
  type:           { type: String, default: 'depot_sans_sms' },
  retraitId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Retrait', index: true },
  operator:       { type: String, default: '' },
  montantAttendu: { type: Number, default: 0 },   // montant ny ordre
  montantRecu:    { type: Number, default: 0 },   // delta solde hita
  soldeAvant:     { type: Number, default: 0 },
  soldeApres:     { type: Number, default: 0 },
  detail:         { type: String, default: '' },
  status:         { type: String, enum: ['pending','valide','refuse'], default: 'pending', index: true },
  createdAt:      { type: Date, default: Date.now },
  resolvedAt:     { type: Date }
});

module.exports = mongoose.model('Alert', alertSchema);
