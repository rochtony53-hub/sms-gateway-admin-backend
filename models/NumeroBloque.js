const mongoose = require('mongoose');

/**
 * Numero interdit d'ordre.
 *
 * Le blocage porte sur le NUMERO, pas sur le compte : un client ecarte
 * reviendrait sinon sous un autre compte avec la meme ligne. Le motif est
 * conserve pour qu'un autre administrateur comprenne la decision.
 */
const numeroBloqueSchema = new mongoose.Schema({
  numero:    { type: String, required: true, unique: true, trim: true },
  motif:     { type: String, default: '' },
  parQui:    { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'numeros_bloques' });

module.exports = mongoose.model('NumeroBloque', numeroBloqueSchema);
