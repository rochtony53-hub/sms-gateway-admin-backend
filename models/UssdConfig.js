const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema({
  depot:  { type: String, default: '' },
  retrait:{ type: String, default: '' }
}, { _id: false });

const ussdConfigSchema = new mongoose.Schema({
  operator:  { type: String, required: true, unique: true },
  // GP = Grand Public
  gp:        { type: channelSchema, default: {} },
  // TPE = Terminal de Paiement
  tpe:       { type: channelSchema, default: {} },
  // subIdPrefix — famantarana SIM (ex: "032","034","#144")
  subIdPrefix: { type: [String], default: [] },
  updatedBy: { type: String },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UssdConfig', ussdConfigSchema);
