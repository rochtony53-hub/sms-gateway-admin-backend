const mongoose = require('mongoose');

const retraitSchema = new mongoose.Schema({
  operator:  { type: String, required: true },
  numero:    { type: String, required: true },
  montant:   { type: Number, required: true },
  status:    { type: String, enum: ['pending','processing','success','failed'], default: 'pending' },
  type:      { type: String, enum: ['retrait','depot'], default: 'retrait' },
  channel:   { type: String, enum: ['gp','tpe','TPE','Grand Public'], default: 'gp' },
  ussdCode:  { type: String },
  // PIN a saisir SEPAREMENT par le gateway quand l'operateur affiche l'invite
  // "Entrez votre code secret" (Orange refuse un code USSD contenant deja le PIN).
  // Vide = PIN inclus dans ussdCode (ancien comportement).
  ussdPin:   { type: String, default: '' },
  sessionId: { type: String, index: true },
  clientId:   { type: String, default: '', index: true },
  montantUsd: { type: Number, default: 0 },
  rate:       { type: Number, default: 0 },
  devise:     { type: String, default: 'Ar' },
  provider:   { type: String, default: '' },
  // CR Deriv lasibatra (destination) -- TSY tokony hovaina mihitsy taorian'ny
  // famoronana, mba ho azo amin'ny relance/retry foana ny CR marina.
  providerId: { type: String, default: '' },
  derivRequestId: { type: String, default: '', index: true },
  // Token OAuth client — sert UNIQUEMENT a interroger le statut du retrait chez
  // Deriv. Efface des que le retrait est regle (complete/rejected/failed).
  derivClientToken: { type: String, default: '' },
  // Cle d'idempotence (retry cote client-api - evite les doublons)
  clientRef: { type: String, default: '', index: true },
  // FIX: ID transaction nampodin'i Deriv rehefa vita ny transfer -- saha MIAVAKA
  // amin'ny providerId (CR), tsy mifangaro intsony.
  derivTxnId: { type: String, default: '' },
  // FIX: lock atomika anti double-validation -- raha SMS na cron roa mihantona
  // hikasika ity retrait ity indray mihoatra, ny iray ihany no mahazo manova
  // solde / miantso Deriv. Averina ho false rehefa vita ny dingana.
  locked:     { type: Boolean, default: false },
  // ==================================================================
  // ORANGE MONEY WEB PAYMENT (depot via API)
  // ------------------------------------------------------------------
  // omOrderId : identifiant transmis a Orange. UNIQUE (index sparse) :
  //   c'est la cle d'idempotence de la notification. Orange peut rejouer
  //   le meme notif plusieurs fois ; sans unicite, un depot serait
  //   credite deux fois.
  // omNotifToken : jeton rendu par Orange a l'initialisation. La notif
  //   entrante doit le presenter — c'est l'authentification du webhook,
  //   qui est public par necessite.
  // omPayUrl : page de paiement Orange. JAMAIS renvoyee au client tel
  //   quel ; le client recoit /pay/go/:id qui redirige cote serveur.
  // ==================================================================
  // PAS de default:'' — une chaine vide n'est pas null, l'index sparse ne
  // l'ignorerait donc PAS et le 2e retrait sans paiement Orange serait rejete
  // pour doublon. Champ absent tant qu'aucun paiement Orange n'est initie.
  omOrderId:    { type: String },
  omPayToken:   { type: String, default: '' },
  omNotifToken: { type: String, default: '' },
  omPayUrl:     { type: String, default: '' },
  omStatus:     { type: String, enum: ['', 'init', 'awaiting_payment', 'paid', 'cancelled', 'expired', 'failed'], default: '' },
  omNotifiedAt: { type: Date },
  omMontant:    { type: Number, default: 0 },
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
  // Frais reellement annonces par l'operateur (ils varient : jamais calcules)
  frais:      { type: Number, default: null },
  // Solde annonce par l'operateur apres l'operation — fait autorite
  soldeApres: { type: Number, default: null },
  lastUssdResponse: { type: String, default: '' },
  // FIX: relance automatique isaky 15 min raha erreur
  relanceCount: { type: Number, default: 0 },
  lastRelanceAt: { type: Date, default: null },
  createdBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Unicite de omOrderId : garde-fou base de donnees contre le double credit.
// sparse => les retraits sans paiement Orange (la majorite) ne sont pas
// concernes par la contrainte.
retraitSchema.index({ omOrderId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Retrait', retraitSchema);
