const mongoose = require('mongoose');

/**
 * Code a usage unique pour l'entree dans l'administration.
 *
 * L'administration commande l'argent : un mot de passe seul, meme change,
 * reste une chaine qu'on peut deviner ou se faire voler. Le code part vers
 * une boite aux lettres que nous seuls relevons, et meurt apres usage.
 */
const schema = new mongoose.Schema({
  // Empreinte du code, jamais le code lui-meme : une lecture de la base ne
  // doit pas suffire a entrer.
  hash:      { type: String, required: true },
  expireLe:  { type: Date,   required: true },
  utiliseLe: { type: Date,   default: null },
  // Nombre de codes proposes puis refuses : au-dela, on repart de zero.
  essais:    { type: Number, default: 0 },
  username:  { type: String, default: '' },
  ip:        { type: String, default: '' },
  createdAt: { type: Date,   default: Date.now }
});

// Les codes perimes disparaissent d'eux-memes : rien a nettoyer a la main.
schema.index({ expireLe: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('AdminOtp', schema);
