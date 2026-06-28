const mongoose = require('mongoose');

const retraitSchema = new mongoose.Schema({
  operator:  { type: String, required: true },
  numero:    { type: String, required: true },
  montant:   { type: Number, required: true },
  status:    { type: String, enum: ['pending','processing','success','failed'], default: 'pending' },
  type:      { type: String, enum: ['retrait','depot'], default: 'retrait' },
  channel:   { type: String, enum: ['gp','tpe','TPE','Grand Public'], default: 'gp' },
  ussdCode:  { type: String },
  sessionId: { type: String, index: true },
  clientId:   { type: String, default: '', index: true },
  montantUsd: { type: Number, default: 0 },
  rate:       { type: Number, default: 0 },
  devise:     { type: String, default: 'Ar' },
  provider:   { type: String, default: '' },
  // CR Deriv lasibatra (destination) -- TSY tokony hovaina mihitsy taorian'ny
  // famoronana, mba ho azo amin'ny relance/retry foana ny CR marina.
  providerId: { type: String, default: '' },
  // FIX: ID transaction nampodin'i Deriv rehefa vita ny transfer -- saha MIAVAKA
  // amin'ny providerId (CR), tsy mifangaro intsony.
  derivTxnId: { type: String, default: '' },
  // FIX: lock atomika anti double-validation -- raha SMS na cron roa mihantona
  // hikasika ity retrait ity indray mihoatra, ny iray ihany no mahazo manova
  // solde / miantso Deriv. Averina ho false rehefa vita ny dingana.
  locked:     { type: Boolean, default: false },
  response:  { type: String },
  // FIX: heure limite (createdAt + 1h) — raha tafahoatra io ary "processing"
  // mbola, dia automatic "failed". Calculée a la creation.
  expiresAt: { type: Date },
  // FIX: "Reception" -- ahafantarana inona no nataon'ny CLIENT (signal/dériv
  // tonga any amin'ny serveur). Hafa amin'ny "status" izay milaza ny retour
  // mankany amin'ny client.
  receptionStatus: {
    type: String,
    enum: ['en_attente','verification','confirme','rejete'],
    default: 'en_attente'
  },
  // FIX: dernier message USSD brut (rehefa vita ny USSD)
  lastUssdResponse: { type: String, default: '' },
  // FIX: relance automatique isaky 15 min raha erreur
  relanceCount: { type: Number, default: 0 },
  lastRelanceAt: { type: Date, default: null },
  createdBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Retrait', retraitSchema);
