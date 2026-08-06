const router  = require('express').Router();
const auth    = require('../middleware/auth');
const apikey  = require('../middleware/apikey');
const Solde   = require('../models/Solde');

function getOpKey(operator) {
  const o = (operator || '').toLowerCase();
  // Comores AVANT mvola : "mvola_km"/"telma_km"/"comor" contiennent deja mvola.
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
  const arPattern = /(\d[\d\s.,]*)\s*(?:Ar|ariary)/gi;
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

// POST /api/solde/fusionner — repare les doublons et supprime le garbage.
// Appele par le bouton "Reparer les soldes" de l'admin. Cet endpoint avait ete
// supprime : le bouton renvoyait alors une erreur 404 silencieuse.
//
// Ce qu'il fait :
//   1) Supprime les entrees inexploitables : operateur contenant "debug",
//      montant negatif (heritage de l'ancien controle "one-shot").
//   2) Ramene chaque entree a sa cle canonique (orange / mvola / airtel /
//      mvola_km) et fusionne les doublons ("Orange Money" + "orange" -> un
//      seul "orange"), en gardant l'entree la plus recente.
router.post('/fusionner', auth, async (req, res) => {
  try {
    const VALID = ['orange', 'mvola', 'airtel', 'mvola_km'];
    const all = await Solde.find();

    const parCanon    = {};   // cle canonique -> document a conserver
    const aSupprimer  = [];   // _id a supprimer
    let garbage = 0, fusionnes = 0;

    for (const s of all) {
      const opRaw = String(s.operator || '');
      // 1) Garbage explicite : debug_* ou montant negatif.
      if (opRaw.toLowerCase().includes('debug')
          || (typeof s.montant === 'number' && s.montant < 0)) {
        aSupprimer.push(s._id); garbage++; continue;
      }
      // 2) Cle canonique.
      const canon = VALID.includes(opRaw) ? opRaw : getOpKey(opRaw);
      if (!canon) { aSupprimer.push(s._id); garbage++; continue; }

      const prev = parCanon[canon];
      if (!prev) { parCanon[canon] = s; continue; }
      // Doublon : garder le plus recent (baseTimestamp sinon updatedAt).
      const tNew = new Date(s.baseTimestamp || s.updatedAt || 0).getTime();
      const tOld = new Date(prev.baseTimestamp || prev.updatedAt || 0).getTime();
      const keep = tNew >= tOld ? s : prev;
      const drop = tNew >= tOld ? prev : s;
      parCanon[canon] = keep;
      aSupprimer.push(drop._id);
      fusionnes++;
    }

    // Supprimer d'ABORD (libere les cles), puis renommer les conserves.
    if (aSupprimer.length) await Solde.deleteMany({ _id: { $in: aSupprimer } });
    for (const [canon, doc] of Object.entries(parCanon)) {
      if (doc.operator !== canon) {
        await Solde.findByIdAndUpdate(doc._id, { operator: canon, updatedAt: new Date() });
      }
    }

    res.json({
      ok: true,
      supprimes: aSupprimer.length,
      garbage,
      doublonsFusionnes: fusionnes,
      restants: Object.keys(parCanon).length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
