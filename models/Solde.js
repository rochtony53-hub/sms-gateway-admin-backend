const mongoose = require('mongoose');

const soldeSchema = new mongoose.Schema({
  operator:  { type: String, required: true, unique: true },
  montant:   { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Solde', soldeSchema);
