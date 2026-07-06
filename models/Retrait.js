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
  providerId: { type: String, default: '' },
  // REST Payment Agent API : request_id du retrait Deriv (suivi GET /withdraw/{id})
  derivRequestId: { type: String, default: '', index: true },
  // Clé d'idempotence (retry côté client-api — évite les doublons)
  clientRef: { type: String, default: '', index: true },
  derivTransactionId: { type: String, default: '' },
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
