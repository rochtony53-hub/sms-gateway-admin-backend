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
function extractAmount(text) {
  if (!text) return null;
  const cleaned = text.replace(/\s/g, '');
  const matches = cleaned.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/g);
  if (!matches || !matches.length) return null;
  // Prendre le plus grand nombre trouvé (généralement le solde)
  const amounts = matches.map(m => {
    let n = m.replace(/[.,](?=\d{3}(\D|$))/g, ''); // retire séparateurs milliers
    n = n.replace(',', '.'); // virgule décimale -> point
    return parseFloat(n);
  }).filter(n => !isNaN(n));
  if (!amounts.length) return null;
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
      return res.status(400).json({ error: 'Impossible d\'extraire le montant', raw: ussdResponse });

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

// GET /api/solde — liste des soldes avec infos base
router.get('/', auth, async (req, res) => {
  try {
    const soldes = await Solde.find();
    res.json(soldes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
