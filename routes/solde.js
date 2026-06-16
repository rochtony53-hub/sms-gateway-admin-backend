const router  = require('express').Router();
const auth    = require('../middleware/auth');
const apikey  = require('../middleware/apikey');
const Solde   = require('../models/Solde');

function getOpKey(operator) {
  const o = (operator || '').toLowerCase();
  if (o.includes('orange')) return 'orange';
  if (o.includes('yas') || o.includes('telma') || o.includes('mvola')) return 'mvola';
  if (o.includes('airtel')) return 'airtel';
  return null;
}

// Extrait le montant depuis le texte brut de la réponse USSD
// Ex: "Votre solde est de 49 500,00 Ar" -> 49500
// Ex: "Solde: 1.250.000 Ar" -> 1250000
function extractAmount(text) {
  if (!text) return null;

  // Cherche un nombre avec espaces ou points comme séparateurs de milliers,
  // suivi optionnellement d'une partie décimale après virgule ou point
  // Pattern: groupes de 1-3 chiffres séparés par espace/point, puis decimal optionnel
  const pattern = /\d{1,3}(?:[\s.]\d{3})*(?:,\d{1,2})?/g;
  const matches = text.match(pattern);
  if (!matches || !matches.length) return null;

  const amounts = matches.map(raw => {
    let s = raw.trim();
    // Sépare partie décimale (après virgule) de la partie entière
    let decimalPart = '';
    const commaIdx = s.indexOf(',');
    if (commaIdx >= 0) {
      decimalPart = s.substring(commaIdx + 1);
      s = s.substring(0, commaIdx);
    }
    // Retire tous les séparateurs de milliers (espace ou point)
    const intPart = s.replace(/[\s.]/g, '');
    const num = parseFloat(intPart + (decimalPart ? '.' + decimalPart : ''));
    return isNaN(num) ? null : num;
  }).filter(n => n !== null);

  if (!amounts.length) return null;
  // Le solde est généralement le plus grand nombre trouvé dans le message
  return Math.round(Math.max(...amounts));
}

// POST /api/solde/check-result — reçoit le résultat USSD réel depuis l'APK
router.post('/check-result', apikey, async (req, res) => {
  try {
    const { operator, ussdResponse, timestamp } = req.body;
    if (!operator || !ussdResponse)
      return res.status(400).json({ error: 'operator et ussdResponse requis' });

    const opKey = getOpKey(operator);
    if (!opKey) return res.status(400).json({ error: 'Opérateur non reconnu' });

    const amount = extractAmount(ussdResponse);
    if (amount === null)
      return res.status(400).json({ error: "Impossible d'extraire le montant", raw: ussdResponse });

    const baseTimestamp = timestamp ? new Date(timestamp) : new Date();

    await Solde.findOneAndUpdate(
      { operator: opKey },
      {
        baseAmount: amount,
        baseTimestamp,
        baseRawResponse: ussdResponse,
        montant: amount, // le solde affiché repart de cette base
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true, operator: opKey, baseAmount: amount, baseTimestamp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/solde — liste des soldes avec infos base (pour badge Vérifié/Estimé)
router.get('/', auth, async (req, res) => {
  try {
    const soldes = await Solde.find();
    res.json(soldes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
