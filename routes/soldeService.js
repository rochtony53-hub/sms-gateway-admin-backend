/* ============================================================
 * SERVICE SOLDE — point d'entree UNIQUE.
 * ------------------------------------------------------------
 * Avant : dix endroits differents ecrivaient dans la collection Solde, les
 * uns avec $set, les autres avec $inc, certains avec la cle normalisee et
 * d'autres avec l'operateur brut. Resultat : des documents en double
 * ("mvola" et "yas"), un total qui derivait, et un solde affiche a -1 Ar.
 *
 * Regle metier retenue, conforme au fonctionnement voulu :
 *
 *   La PASSERELLE interroge le solde reel. Le serveur l'enregistre.
 *   L'ADMIN ne fait que LIRE. Il ne calcule rien.
 *
 * Modele :
 *   baseAmount    solde REEL constate (code USSD de consultation, ou SMS de
 *                 l'operateur qui annonce "Nouveau solde: ...")
 *   baseTimestamp date de ce constat
 *   delta         somme des mouvements survenus DEPUIS ce constat
 *   montant       = baseAmount + delta  (toujours recalcule, jamais incremente
 *                                        de facon independante)
 *
 * Consequence : a chaque nouveau constat reel, delta repart de zero. Aucune
 * derive ne peut s'accumuler. Un ecart eventuel est absorbe et journalise.
 * ============================================================ */

const Solde = require('../models/Solde');

/** Cle canonique. Telma = YAS = MVola : un seul et meme operateur. */
function cleOperateur(operator) {
  const o = String(operator || '').toLowerCase().trim();
  if (!o) return null;
  // Comores d'abord : "mvola_km" contient "mvola"
  if (o.includes('comor') || o.includes('_km') || o.includes('km_')) return 'mvola_km';
  if (o.includes('orange')) return 'orange';
  if (o.includes('mvola') || o.includes('yas') || o.includes('telma')) return 'mvola';
  if (o.includes('airtel')) return 'airtel';
  return null;
}

const CLES = ['orange', 'mvola', 'airtel', 'mvola_km'];

/**
 * Enregistre un solde REEL constate. C'est la seule verite.
 * Remet le compteur de mouvements a zero : toute derive accumulee disparait.
 *
 * @param source 'ussd' (consultation par la passerelle) ou 'sms' (annonce
 *               de l'operateur dans un SMS de confirmation)
 */
async function soldeVerifie(operator, montantReel, source, texteBrut) {
  const cle = cleOperateur(operator);
  if (!cle) { console.warn('soldeVerifie: operateur inconnu "' + operator + '"'); return null; }

  const montant = Number(montantReel);
  if (!Number.isFinite(montant) || montant < 0 || montant > 1e12) {
    console.warn('soldeVerifie ' + cle + ': valeur refusee (' + montantReel + ')');
    return null;
  }

  const avant = await Solde.findOne({ operator: cle }).lean();
  const estime = avant ? Number(avant.montant || 0) : null;

  const doc = await Solde.findOneAndUpdate(
    { operator: cle },
    {
      $set: {
        baseAmount: montant,
        baseTimestamp: new Date(),
        baseRawResponse: String(texteBrut || '').slice(0, 500),
        delta: 0,                 // le constat reel annule les estimations
        montant: montant,
        montantOff: montant,
        updatedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );

  if (estime !== null && estime !== montant) {
    console.log('solde ' + cle + ' recale par ' + source + ' : estime ' + estime
              + ' -> reel ' + montant + ' (ecart ' + (montant - estime) + ')');
  }
  return doc;
}

/**
 * Enregistre un MOUVEMENT (retrait = negatif, depot = positif) survenu depuis
 * le dernier constat. N'ecrit jamais directement dans baseAmount : ce n'est
 * qu'une estimation, corrigee au prochain constat reel.
 */
async function soldeMouvement(operator, delta, motif) {
  const cle = cleOperateur(operator);
  if (!cle) { console.warn('soldeMouvement: operateur inconnu "' + operator + '"'); return null; }

  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) return null;

  const doc = await Solde.findOneAndUpdate(
    { operator: cle },
    { $inc: { delta: d }, $set: { updatedAt: new Date() } },
    { upsert: true, new: true }
  );

  // montant est TOUJOURS derive : jamais incremente pour son propre compte.
  const base    = Number(doc.baseAmount || 0);
  const cumul   = Number(doc.delta || 0);
  const montant = base + cumul;

  await Solde.updateOne({ operator: cle },
    { $set: { montant, montantOff: montant } });

  if (montant < 0) {
    // Signal, pas un plantage : soit le dernier constat est trop ancien, soit
    // un mouvement a ete compte deux fois. Visible dans les journaux.
    console.warn('solde ' + cle + ' NEGATIF (' + montant + ') apres "' + (motif || '?')
               + '". Base ' + base + ' + mouvements ' + cumul
               + '. Lancez une consultation de solde pour recaler.');
  }
  return doc;
}

/** Lecture pour affichage : une entree par operateur, cles fusionnees. */
async function lireSoldes() {
  const docs = await Solde.find().lean();
  const out = {};
  for (const c of CLES) {
    out[c] = { montant: 0, montantOff: 0, baseAmount: 0, baseTimestamp: null, delta: 0 };
  }
  for (const d of docs) {
    const cle = cleOperateur(d.operator);
    if (!cle) continue;
    // Documents en double (ex: "mvola" + "yas") : on garde le constat le plus
    // recent et on ADDITIONNE les mouvements, au lieu d'ecraser l'un par l'autre.
    const cur = out[cle];
    const tsNouveau = d.baseTimestamp ? new Date(d.baseTimestamp).getTime() : 0;
    const tsCourant = cur.baseTimestamp ? new Date(cur.baseTimestamp).getTime() : 0;
    if (tsNouveau >= tsCourant) {
      cur.baseAmount    = Number(d.baseAmount || 0);
      cur.baseTimestamp = d.baseTimestamp || cur.baseTimestamp;
    }
    cur.delta += Number(d.delta || 0);
  }
  for (const c of CLES) {
    out[c].montant = out[c].baseAmount + out[c].delta;
    out[c].montantOff = out[c].montant;
  }
  return out;
}

/**
 * Fusionne les documents en double crees par l'ancien code (operateur brut).
 * A lancer une fois; sans effet ensuite.
 */
async function fusionnerDoublons() {
  const docs = await Solde.find().lean();
  const parCle = {};
  for (const d of docs) {
    const cle = cleOperateur(d.operator);
    if (!cle) continue;
    (parCle[cle] = parCle[cle] || []).push(d);
  }

  const rapport = [];
  for (const [cle, liste] of Object.entries(parCle)) {
    if (liste.length < 2 && liste[0].operator === cle) continue;

    // Constat le plus recent
    let meilleur = liste[0];
    for (const d of liste) {
      const a = d.baseTimestamp ? new Date(d.baseTimestamp).getTime() : 0;
      const b = meilleur.baseTimestamp ? new Date(meilleur.baseTimestamp).getTime() : 0;
      if (a > b) meilleur = d;
    }
    const delta = liste.reduce((s, d) => s + Number(d.delta || 0), 0);
    const base  = Number(meilleur.baseAmount || 0);

    await Solde.deleteMany({ _id: { $in: liste.map(d => d._id) } });
    await Solde.create({
      operator: cle,
      baseAmount: base,
      baseTimestamp: meilleur.baseTimestamp || null,
      baseRawResponse: meilleur.baseRawResponse || '',
      delta,
      montant: base + delta,
      montantOff: base + delta,
      updatedAt: new Date()
    });
    rapport.push({
      operateur: cle,
      fusionnes: liste.map(d => d.operator),
      baseAmount: base, delta, montant: base + delta
    });
  }
  return rapport;
}

module.exports = { cleOperateur, soldeVerifie, soldeMouvement, lireSoldes, fusionnerDoublons, CLES };
