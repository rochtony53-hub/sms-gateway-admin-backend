const mongoose = require('mongoose');

// Alerte admin: vola tonga tao amin'ny gateway (solde niakatra) nefa tsy nisy
// SMS voaray — mila fanamarinana manuel (Vérifier / Valider / Refuser).
const alertSchema = new mongoose.Schema({
  // depot_sans_sms      : argent arrive sans SMS, a valider a la main
  // retrait_sans_reponse : la passerelle n'a jamais rendu de verdict alors que
  //                        le fournisseur a DEJA debite le client — le montant
  //                        doit lui etre rendu ou l'envoi refait.
  type:           { type: String, default: 'depot_sans_sms' },
  retraitId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Retrait', index: true },
  operator:       { type: String, default: '' },
  montantAttendu: { type: Number, default: 0 },   // montant ny ordre
  montantRecu:    { type: Number, default: 0 },   // delta solde hita
  soldeAvant:     { type: Number, default: 0 },
  soldeApres:     { type: Number, default: 0 },
  detail:         { type: String, default: '' },
  status:         { type: String, enum: ['pending','valide','refuse'], default: 'pending', index: true },
  // Retrait uniquement : reference du debit deja effectue chez le fournisseur.
  // Sa presence signifie que le client a ete debite ; tant que l'alerte reste
  // "pending", il attend soit son argent, soit un remboursement.
  refFournisseur: { type: String, default: '' },
  createdAt:      { type: Date, default: Date.now },
  resolvedAt:     { type: Date }
});

module.exports = mongoose.model('Alert', alertSchema);
