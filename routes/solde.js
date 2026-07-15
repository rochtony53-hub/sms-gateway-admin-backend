const router  = require('express').Router();
const auth    = require('../middleware/auth');
const apikey  = require('../middleware/apikey');
const Solde   = require('../models/Solde');

function getOpKey(operator) {
  const o = (operator || '').toLowerCase();
  if (o.includes('comor') || o.includes('mvola_km') || o.includes('telma_km')) return 'mvola_km';
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

  // Cherche le montant avant "Ar" ou "ariary" en priorité
  const arPattern = /(\d[\d\s.,]*)\s*(?:Ar|ariary|Fc|kmf)/gi;
  const arMatches = [...text.matchAll(arPattern)];
  if (arMatches.length > 0) {
    for (const m of arMatches) {
      let s = m[1].trim();
      const commaIdx = s.indexOf(',');
      let decimalPart = '';
      if (commaIdx >= 0) {
        decimalPart = s.substring(commaIdx + 1);
        s = s.substring(0, commaIdx);
      }
      const intPart = s.replace(/[\s]/g, '').replace(/\./g, '');
      const num = parseFloat(intPart + (decimalPart ? '.' + decimalPart : ''));
      if (!isNaN(num) && num >= 0 && num < 1000000000) return Math.round(num);
    }
  }

  // Fallback: premier nombre trouvé dans le texte
  const pattern = /\d{1,3}(?:[\s.]\d{3})*(?:,\d{1,2})?/g;
  const matches = text.match(pattern);
  if (!matches || !matches.length) return null;

  const amounts = matches.map(raw => {
    let s = raw.trim();
    let decimalPart = '';
    const commaIdx = s.indexOf(',');
    if (commaIdx >= 0) {
      decimalPart = s.substring(commaIdx + 1);
      s = s.substring(0, commaIdx);
    }
    const intPart = s.replace(/[\s.]/g, '');
    const num = parseFloat(intPart + (decimalPart ? '.' + decimalPart : ''));
    return isNaN(num) ? null : num;
  }).filter(n => n !== null);

  if (!amounts.length) return null;
  return Math.round(amounts[0]); // Premier montant trouvé
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

    // ===== ALERTE "vola tonga nefa tsy nisy SMS" =====
    // Raha niakatra ny solde marina (delta > 0) ary misy ordre DEPOT
    // pending/processing tsy mbola nahazo SMS izay mifanandrify amin'ny
    // delta (tolerance +10%) -> mamorona alerte admin (Verifier/Valider/Refuser).
    try {
      const prev = await Solde.findOne({ operator: opKey }).lean();
      const soldeAvant = prev ? (Number(prev.montant) || 0) : 0;
      const delta = amount - soldeAvant;
      if (delta > 0) {
        const Retrait = require('../models/Retrait');
        const Alert = require('../models/Alert');
        const oneHourAgo = new Date(Date.now() - 60*60*1000);
        const candidats = await Retrait.find({
          type: 'depot', operator: opKey,
          status: { $in: ['pending','processing'] },
          receptionStatus: { $ne: 'confirme' },
          createdAt: { $gte: oneHourAgo },
          $or: [ { lastUssdResponse: { $in: [null, ''] } }, { lastUssdResponse: { $exists: false } } ]
        }).sort({ createdAt: 1 }).lean();
        for (const c of candidats) {
          const mOrd = Math.round(c.montant);
          if (delta >= mOrd && delta <= Math.round(mOrd * 1.10)) {
            const deja = await Alert.findOne({ retraitId: c._id, status: 'pending' });
            if (!deja) {
              await Alert.create({
                type: 'depot_sans_sms', retraitId: c._id, operator: opKey,
                montantAttendu: mOrd, montantRecu: delta,
                soldeAvant, soldeApres: amount,
                detail: 'Solde gateway +' + delta + ' (check USSD) nefa tsy nisy SMS ho an\'ity ordre ity'
              });
              console.log('[ALERTE] depot sans SMS:', String(c._id), 'delta', delta);
            }
            break; // ordre iray ihany isaky ny delta
          }
        }
      }
    } catch(eA) { console.error('alerte depot_sans_sms:', eA.message); }

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
