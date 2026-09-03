const router      = require('express').Router();
const settings    = require('./settings');
const apikey      = require('../middleware/apikey');
const auth        = require('../middleware/auth');
const Sms         = require('../models/Sms');
const Device      = require('../models/Device');
const Retrait     = require('../models/Retrait');
const SmsTemplate = require('../models/SmsTemplate');
const Solde       = require('../models/Solde');

function getOpKey(op) {
  const o = (op||'').toLowerCase();
  if (o.includes('comor') || o.includes('mvola_km') || o.includes('telma_km')) return 'mvola_km';
  if (o.includes('orange')) return 'orange';
  if (o.includes('yas')||o.includes('telma')||o.includes('mvola')) return 'mvola';
  if (o.includes('airtel')) return 'airtel';
  return null;
}

// Maka numero malgache ao anatin'ny SMS (0XX XXXXXXX)
function extractNumeroFromSms(message) {
  const m = (message||'').replace(/[\s.\-]/g,'').match(/(0(?:32|33|34|37|38)\d{7})/);
  return m ? m[1] : null;
}

// Mizaha raha mitovy ny SMS amin'ny template ho an'ity operator ity.
// Mamerina { type, template } raha mitovy, na null raha tsy misy template configured,
// na false raha misy template configured fa tsy mitovy.
async function checkTemplate(opKey, message) {
  const templates = await SmsTemplate.find({ operator: opKey });
  if (!templates.length) return null;
  const msg = message.toLowerCase();
  for (const t of templates) {
    const allMatch = (t.keywords||[]).every(kw => msg.includes(kw.toLowerCase()));
    if (allMatch) return { type: t.type, template: t };
  }
  return false;
}

// TOLERANCE: depot -> montant <= recu <= montant*1.10 ; retrait -> egalite stricte
function montantDepotOk(type, montantSms, montantOrdre) {
  const mOrd = Math.round(Number(montantOrdre)), mSms = Math.round(Number(montantSms));
  if (!mOrd || isNaN(mSms)) return false;
  return (type === 'depot')
    ? (mSms >= mOrd && mSms <= Math.round(mOrd * 1.10))
    : (mSms === mOrd);
}

// Maka ny MONTANT TRANSACTION (montant voalohany), TSY ny solde
function parseMontant(message) {
  const msg = (message || '');
  const cut = msg.replace(/(nouveau\s+)?solde[^.]*\.?/ig,' ').replace(/balance[^.]*\.?/ig,' ');
  let m = cut.match(/(?:ar|mga|fc|kmf)\s*([0-9][0-9\s.,]*)/i)
        || cut.match(/([0-9][0-9\s.,]*?)\s*(?:ar|mga|fc|kmf)/i);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/[\s,]/g,''));
  return (isNaN(val)) ? null : val;
}

// Mitady Retrait pending/processing mifanaraka amin'ny NUMERO hita ao amin'ny SMS.
// FIX: matching amin'ny numero client (araka ny exemple ao amin'ny template),
// tsy "pending tranainy indrindra" fotsiny.
/**
 * @param strict  true = n'accepter QUE une correspondance par numero.
 *                Utilise pour les SMS qui ne correspondent a aucun template :
 *                on ne sait pas de quel retrait ils parlent, donc on n'a pas
 *                le droit de designer une victime au hasard.
 */
async function findMatchingRetrait(opKey, type, message, strict) {
  const numero = extractNumeroFromSms(message);

  // En mode strict, sans numero il n'y a AUCUN moyen de savoir de quel retrait
  // parle ce SMS. Le filtre sans numero renverrait le plus ancien retrait en
  // cours — un innocent. On prefere ne rien faire.
  if (strict && !numero) return null;

  const filter = { operator: opKey, status: { $in: ['pending','processing'] }, type };
  if (numero) filter.numero = numero;

  let candidates = await Retrait.find(filter).sort({ createdAt: 1 });

  // ------------------------------------------------------------------
  // REPLI "le plus ancien" — dangereux, donc interdit en mode strict.
  // ------------------------------------------------------------------
  // Sans numero exploitable, ce repli renvoie simplement le retrait
  // pending/processing le plus ancien. Applique a un SMS d'ECHEC, cela
  // condamne un retrait qui n'a rien a voir : celui-ci passe en 'failed',
  // et comme autoValidate ne rattrape que 'pending' et 'processing', son
  // propre SMS de succes sera ensuite ignore. Argent parti, retrait
  // declare perdu, aucune correction possible.
  //
  // Cas reel : "Votre solde MVola est insuffisant. Votre solde est de
  // 151 Ar. ... Ref:4661996794" — aucun mot-cle de template, aucun numero
  // au format malgache. Le repli aurait vise un retrait innocent.
  // ------------------------------------------------------------------
  if (!candidates.length && numero && !strict) {
    candidates = await Retrait.find({
      operator: opKey, status: { $in: ['pending','processing'] }, type
    }).sort({ createdAt: 1 });
  }
  return candidates[0] || null;
}

// FIX: 1h timeout - raha tafahoatra 1h ny pending/processing -> failed
async function expireOldRetraits(opKey) {
  const oneHourAgo = new Date(Date.now() - 60*60*1000);
  await Retrait.updateMany(
    { operator: opKey, status: { $in: ['pending','processing'] }, createdAt: { $lt: oneHourAgo } },
    { status: 'failed', updatedAt: new Date() }
  );
}

// FLOW FENO:
// 1. SMS tsy mitovy template configured -> ignore (pas de retrait touche)
// 2. SMS mitovy template fa tsy misy retrait mifanaraka -> "matched"
// 3. SMS mitovy template + misy retrait mifanaraka (numero):
//    a. tafahoatra 1h -> deja "failed" (expireOldRetraits)
//    b. montant != ordre -> "failed", admin garde valide/refuse manuel
//    c. montant exact + solde ampy (retrait) -> "success" auto, solde miova
//    d. montant exact fa solde tsy azo hamarinina -> "processing" (EN ATTENTE admin)
// 4. SMS misy template fa TSY mitovy keywords -> "failed" avy hatrany,
//    admin mahazo mbola valide/refuse manuel.
/* ============================================================
 * LECTURE DU SOLDE REEL ANNONCE PAR L'OPERATEUR
 * ------------------------------------------------------------
 * Les frais Mobile Money ne sont PAS fixes : ils varient selon le montant et
 * l'operateur. Les deduire par calcul serait forcement faux tot ou tard, et
 * l'erreur s'accumulerait a chaque retrait.
 *
 * L'operateur annonce lui-meme le solde exact apres l'operation
 * ("Nouveau solde: 1154626 Ar"). Cette valeur fait autorite : elle inclut deja
 * les frais, quels qu'ils soient. Quand on parvient a la lire, on ALIGNE le
 * solde enregistre dessus au lieu de le calculer.
 *
 * Si la lecture echoue, on retombe sur l'ancien comportement (decrementer du
 * montant) : jamais de blocage, seulement une precision moindre.
 * ============================================================ */

/** Convertit "1 154 626", "1,154,626", "1154626.00" en nombre. */
function versNombre(brut) {
  if (brut == null) return null;
  let t = String(brut).trim();
  // Separateur decimal a 2 chiffres en fin : on le retire (montants en Ariary)
  t = t.replace(/[.,](\d{2})\s*$/, '');
  t = t.replace(/[^0-9]/g, '');
  if (!t) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

const MOTIFS_SOLDE = [
  /nouveau\s*solde\s*[:=]?\s*([0-9][0-9\s.,]{0,15})/i,
  /solde\s*(?:actuel|restant|disponible)\s*[:=]?\s*([0-9][0-9\s.,]{0,15})/i,
  /votre\s*solde(?:\s+\S+){0,2}\s*est\s*(?:de)?\s*[:=]?\s*([0-9][0-9\s.,]{0,15})/i,
  /solde\s*[:=]\s*([0-9][0-9\s.,]{0,15})/i,
  /volanao\s*(?:sisa)?\s*[:=]?\s*([0-9][0-9\s.,]{0,15})/i
];

/** Solde annonce par l'operateur, ou null si absent/illisible. */
function lireSoldeAnnonce(message) {
  const t = String(message == null ? '' : message);
  // Un message d'echec peut citer un solde : ne pas s'y fier.
  if (/insuffisant|echou|echec|annul[ée]e/i.test(t)) return null;
  for (const re of MOTIFS_SOLDE) {
    const m = t.match(re);
    if (m) {
      const n = versNombre(m[1]);
      // Bornes de securite : une valeur absurde ne doit jamais ecraser le solde.
      if (n != null && n >= 0 && n < 1e12) return n;
    }
  }
  return null;
}

const MOTIFS_FRAIS = [
  /frais\s*[:=]?\s*([0-9][0-9\s.,]{0,10})/i,
  /sarany\s*[:=]?\s*([0-9][0-9\s.,]{0,10})/i
];

/** Frais annonces par l'operateur, ou null. */
function lireFrais(message) {
  const t = String(message == null ? '' : message);
  for (const re of MOTIFS_FRAIS) {
    const m = t.match(re);
    if (m) {
      const n = versNombre(m[1]);
      if (n != null && n >= 0 && n < 1e7) return n;
    }
  }
  return null;
}

/* Formulations annoncant un ECHEC. Servent de condition avant de faire
 * basculer un retrait en 'failed' sur la foi d'un SMS non reconnu.
 * Les tournures d'echec contenant un mot positif ("n'a pas reussi") sont
 * testees en premier, sinon "reussi" les ferait passer pour un succes. */
const SMS_ECHEC_PATTERNS = [
  /n'?\s*a\s+pas\s+(r[eé]ussi|about)/i,
  /pas\s+r[eé]ussi/i,
  /non\s+r[eé]ussi/i,
  /solde[^.\n]{0,30}insuffisant/i,
  /insuffisant/i,
  /[eé]chou[eé]?/i, /[eé]chec/i,
  /annul[eé]e?/i,
  /rejet[eé]e?/i,
  /impossible/i,
  /incorrect|invalide/i,
  /tsy\s*ampy/i, /tsy\s*nahomby/i,
  /insufficient/i, /failed/i, /declined/i, /cancell?ed/i
];

/** true si le SMS annonce explicitement un echec. */
function ressembleAUnEchec(message) {
  const t = String(message == null ? '' : message);
  return SMS_ECHEC_PATTERNS.some(re => re.test(t));
}

async function autoValidate(operator, message, smsId) {
  const opts = settings.getOptions();
  if (!opts.ret_aut) return;
  const opKey = getOpKey(operator);
  if (!opKey) return;

  await expireOldRetraits(opKey);

  // Tout SMS annoncant un solde fait foi, meme sans ordre associe
  // (ex: consultation de solde). C'est un constat reel de l'operateur.
  try {
    const sAnn = lireSoldeAnnonce(message);
    if (sAnn != null) await require('./soldeService').soldeVerifie(opKey, sAnn, 'sms solde', message);
  } catch (e) { console.error('solde depuis SMS:', e.message); }

  const result = await checkTemplate(opKey, message);

  if (result === null) {
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'pending' });
    return;
  }

  if (result === false) {
    // ------------------------------------------------------------------
    // SMS ne correspondant a AUCUN template configure.
    // ------------------------------------------------------------------
    // Deux precautions avant de condamner quoi que ce soit :
    //
    // 1) MODE STRICT : sans numero identifiable dans le SMS, on ne sait pas
    //    de quel retrait il parle. Le repli "le plus ancien en cours" ferait
    //    tomber un innocent. Cas reel : le SMS MVola "Votre solde est
    //    insuffisant... Ref:4661996794" ne contient aucun numero malgache.
    //
    // 2) MOTIF D'ECHEC EXIGE : un SMS non reconnu n'est pas forcement un
    //    echec. Si l'operateur change une tournure — "transfert de 3000 Ar
    //    A 0324..." au lieu de "VERS 0324..." — le SMS de SUCCES ne colle
    //    plus au template, mais il contient bien un numero. Sans ce
    //    controle, un retrait REUSSI serait marque 'failed', donc plus
    //    jamais rattrapable : argent parti, retrait declare perdu.
    //    On n'agit donc que si le texte annonce reellement un echec.
    // ------------------------------------------------------------------
    if (!ressembleAUnEchec(message)) {
      console.warn('SMS ' + opKey + ' non reconnu et sans motif d\'echec : ignore '
                 + '(verifiez les mots-cles dans Admin > Templates SMS) — "'
                 + String(message).slice(0, 120) + '"');
      if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'matched' });
      return;
    }

    const retrait = await findMatchingRetrait(opKey, 'retrait', message, true)
                 || await findMatchingRetrait(opKey, 'depot', message, true);
    if (retrait) {
      // FIX: receptionStatus = rejete (SMS niditra fa tsy mitovy template)
      await Retrait.findByIdAndUpdate(retrait._id, {
        status: 'failed', receptionStatus: 'rejete', lastUssdResponse: message, updatedAt: new Date()
      });
      if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'failed', retraitId: retrait._id });
    } else {
      if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'failed' });
    }
    return;
  }

  const { type } = result;
  const retrait = await findMatchingRetrait(opKey, type, message);

  if (!retrait) {
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'matched' });
    return;
  }

  const montantSms = parseMontant(message);

  if (montantSms === null) {
    // FIX: receptionStatus = verification (SMS niditra fa mbola tsy voamarina)
    await Retrait.findByIdAndUpdate(retrait._id, {
      status: 'processing', receptionStatus: 'verification', lastUssdResponse: message, updatedAt: new Date()
    });
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'processing', retraitId: retrait._id });
    return;
  }

  // TOLERANCE DEPOT +10% : ny client indraindray mandefa mihoatra kely.
  //   depot  : montant <= recu <= montant*1.10 -> OK ; recu < montant -> REFUSE ;
  //            recu > +10% -> refuse (tsy an'io ordre io angamba)
  //   retrait: egalite stricte (toy ny teo aloha)
  const mSms = Math.round(montantSms);
  if (!montantDepotOk(type, montantSms, retrait.montant)) {
    // FIX: receptionStatus = rejete (montant diso / tsy ampy / mihoatra be)
    await Retrait.findByIdAndUpdate(retrait._id, {
      status: 'failed', receptionStatus: 'rejete', lastUssdResponse: message, updatedAt: new Date()
    });
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'failed', retraitId: retrait._id });
    return;
  }

  // FIX: CLAIM ATOMIQUE -- raha SMS hafa (dupliqué tafita ny dedup, na cron
  // relance) dia mitady ity retrait ity indray mihoatra mandritra izao, ny
  // iray ihany no "mahazo" azy. Ny hafa dia tsy hikasika Solde na hiantso
  // Deriv intsony, fa hijanona eto fotsiny.
  // FIX: "stale lock" (2 min) -- raha tojo crash ny serveur teo am-pandraisana
  // ka locked:true tsy voavela mihitsy, dia azo raisina indray io retrait io
  // taorian'ny 2 minitra (ela be noho ny timeout Deriv 15s).
  const staleLockCutoff = new Date(Date.now() - 2 * 60 * 1000);
  const claimed = await Retrait.findOneAndUpdate(
    {
      _id: retrait._id,
      status: { $in: ['pending', 'processing'] },
      $or: [ { locked: { $ne: true } }, { locked: true, updatedAt: { $lt: staleLockCutoff } } ]
    },
    { $set: { locked: true, updatedAt: new Date() } },
    { new: true }
  );
  if (!claimed) {
    console.warn('autoValidate: retrait', retrait._id, 'efa an-dalam-pandraisana (dupliqué) -- ignoré');
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'duplicate', retraitId: retrait._id });
    return;
  }

  if (type === 'retrait') {
    // RETRAIT : vola alefa amin'ny client. SMS niditra = voaray ny client -> success.
    const solde = await Solde.findOne({ operator: opKey });
    const balance = solde?.montant || 0;
    if (balance < claimed.montant) {
      await Retrait.findByIdAndUpdate(claimed._id, {
        status: 'processing', receptionStatus: 'verification', lastUssdResponse: message,
        locked: false, updatedAt: new Date()
      });
      if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'processing', retraitId: claimed._id });
      return;
    }
    const soldeAnnonce = lireSoldeAnnonce(message);
    const frais        = lireFrais(message);

    const svcSolde = require('./soldeService');
    if (soldeAnnonce != null) {
      // Le SMS annonce le solde EXACT apres operation : frais inclus, quel
      // que soit leur montant. C'est un constat reel, il fait autorite.
      await svcSolde.soldeVerifie(opKey, soldeAnnonce, 'sms retrait', message);
    } else {
      // Aucun solde lisible : simple mouvement estime. Les frais ne sont pas
      // connus, l'ecart sera absorbe a la prochaine consultation de solde.
      await svcSolde.soldeMouvement(opKey, -claimed.montant, 'retrait valide par SMS');
      console.warn('solde ' + opKey + ' : aucun solde annonce dans le SMS, '
                 + 'frais non deduits — sera recale au prochain controle');
    }

    await Retrait.findByIdAndUpdate(claimed._id, {
      status: 'success', receptionStatus: 'confirme', lastUssdResponse: message,
      frais: frais == null ? undefined : frais,
      soldeApres: soldeAnnonce == null ? undefined : soldeAnnonce,
      locked: false, updatedAt: new Date()
    });
    if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'matched', retraitId: claimed._id });
    return;
  }

  // DEPOT : vola voaray (solde miakatra amin'ny VOLA TENA VOARAY — tolerance +10%).
  const montantRecu = (typeof mSms === 'number' && mSms) ? mSms : Math.round(claimed.montant);
  const soldeDepot = lireSoldeAnnonce(message);
  const svc = require('./soldeService');
  if (soldeDepot != null) {
    await svc.soldeVerifie(opKey, soldeDepot, 'sms depot', message);
  } else {
    await svc.soldeMouvement(opKey, montantRecu, 'depot valide par SMS');
  }

  let depotStatus = 'processing';
  let derivErr = '';
  let derivTxnId = '';
  // Betwinner et 1XBET : meme API Cashdesk, mais CAISSES DIFFERENTES.
  // marqueDe() choisit les identifiants du bon operateur — sans lui, un depot
  // 1XBET partirait sur la caisse Betwinner.
  const { estCashdesk, marqueDe } = require('./betwinnerService');
  const isBetwinnerDepot = estCashdesk(claimed.provider);
  if (claimed.providerId && isBetwinnerDepot) {
    // CASHDESK: credit joueur — montant ARIARY/Fc DIRECT (tsy misy cours)
    try {
      const { cashdeskDeposit } = require('./betwinnerService');
      const b = await cashdeskDeposit(marqueDe(claimed.provider, claimed.operator), claimed.providerId, claimed.montant);
      if (b && b.ok) depotStatus = 'success';
      else { depotStatus = 'processing'; derivErr = 'Betwinner: reponse non confirmee'; }
    } catch(e) {
      console.error('betwinnerDeposit error pour depot', claimed._id, ':', e.message);
      depotStatus = 'processing';
      derivErr = e.message;
    }
  } else if (claimed.providerId && /1win/i.test(claimed.provider || '')) {
    // DEPOT 1WIN : caisse en USD, comme Deriv. Le montant Ariary (ou Fc) paye
    // par le client a deja ete converti a la creation de l'ordre : on envoie
    // montantUsd, jamais le montant en monnaie locale.
    try {
      const { onewinDeposit } = require('./onewinService');
      const usd = Number(claimed.montantUsd);
      if (!isFinite(usd) || usd <= 0) throw new Error('montantUsd absent — conversion manquante');
      const w = await onewinDeposit(claimed.providerId, usd);
      depotStatus = 'success';
      derivTxnId = String(w.id || '');
    } catch (e) {
      console.error('onewinDeposit error pour depot', claimed._id, ':', e.message);
      depotStatus = 'processing';
      derivErr = e.message;
    }
  } else if (claimed.providerId) {
    try {
      // DEPOT DERIV via NICKNAME (REST Payment Agent /transfer).
      // request_id STABLE dérivé de l'_id -> idempotence : toute relance
      // (autoValidate re-entrée, cron, alerte) réutilise le MÊME request_id,
      // Deriv déduplique -> aucun double-crédit possible.
      const { restTransferToClient } = require('./derivRest');
      const reqId = 'dep' + String(claimed._id);
      const r = await restTransferToClient(claimed.providerId, claimed.montantUsd || claimed.montant, 'USD', reqId);
      if (r && r.ok) {
        depotStatus = 'success';
        derivTxnId = r.transaction_id || '';
      } else {
        depotStatus = 'processing';
        derivErr = 'Deriv: transfert ' + ((r && r.status) ? r.status : 'non confirme');
      }
    } catch(e) {
      console.error('restTransferToClient error pour depot', claimed._id, ':', e.message);
      depotStatus = 'processing';
      derivErr = e.message;
    }
  } else {
    depotStatus = 'processing';
    derivErr = 'providerId (CR Deriv) manquant';
  }

  // FIX: providerId (CR Deriv lasibatra) TSY soratana indray intsony -- mijanona
  // ho azy marina foana izy mba ho azo amin'ny relance raha tsy nahomby ny
  // andrana voalohany. Ny vokatra transaction dia ao amin'ny derivTxnId.
  // FIX: locked:false -- alefa indray hovana (relance cron) raha mbola 'processing'.
  await Retrait.findByIdAndUpdate(claimed._id, {
    status: depotStatus, receptionStatus: 'confirme',
    derivTxnId: derivTxnId || claimed.derivTxnId || '', response: derivErr,
    lastUssdResponse: message,
    locked: false, updatedAt: new Date()
  });
  if (smsId) await Sms.findByIdAndUpdate(smsId, { status: 'matched', retraitId: claimed._id });
}

/* ============================================================================
 * VALIDATION D'UN DEPOT PAYE VIA L'API ORANGE MONEY
 * ----------------------------------------------------------------------------
 * Appelee par le webhook Orange (routes/orangePay.js) une fois le paiement
 * CONFIRME par Orange. Il n'y a pas de SMS ici : la preuve de reception est la
 * notification Orange, deja authentifiee (notif_token) et deja verifiee sur le
 * montant par l'appelant.
 *
 * On reprend VOLONTAIREMENT la meme mecanique que la validation par SMS :
 *   - claim atomique (locked) : le webhook peut etre rejoue par Orange, et une
 *     relance admin peut arriver en meme temps. Un seul passage credite.
 *   - mouvement de solde par soldeService, comme un depot encaisse.
 *   - credit du fournisseur (Deriv nickname / Betwinner) avec un request_id
 *     STABLE derive de l'_id : toute relance reutilise le meme identifiant,
 *     Deriv deduplique, donc aucun double credit possible.
 * ==========================================================================*/
async function validerDepotOrangePay(retraitDoc) {
  if (!retraitDoc || !retraitDoc._id) return;
  const opKey = getOpKey(retraitDoc.operator) || 'orange';

  // CLAIM ATOMIQUE — identique au chemin SMS, avec la meme tolerance de
  // "stale lock" (2 min) au cas ou un crash aurait laisse le verrou pose.
  const staleLockCutoff = new Date(Date.now() - 2 * 60 * 1000);
  const claimed = await Retrait.findOneAndUpdate(
    {
      _id: retraitDoc._id,
      type: 'depot',
      status: { $in: ['pending', 'processing'] },
      $or: [ { locked: { $ne: true } }, { locked: true, updatedAt: { $lt: staleLockCutoff } } ]
    },
    { $set: { locked: true, updatedAt: new Date() } },
    { new: true }
  );
  if (!claimed) {
    console.warn('[orange-pay] depot', String(retraitDoc._id),
      'deja en cours de traitement ou deja regle — ignore');
    return;
  }

  const montantRecu = Math.round(Number(claimed.omMontant || claimed.montant) || 0);
  const svc = require('./soldeService');
  // Pas de solde annonce par Orange : on enregistre le mouvement encaisse.
  await svc.soldeMouvement(opKey, montantRecu, 'depot paye via API Orange Money');

  let depotStatus = 'processing';
  let derivErr = '';
  let derivTxnId = '';
  const { estCashdesk: estCd2, marqueDe: marqueDe2 } = require('./betwinnerService');
  const isBetwinnerDepot = estCd2(claimed.provider);
  if (claimed.providerId && isBetwinnerDepot) {
    try {
      const { cashdeskDeposit } = require('./betwinnerService');
      const b = await cashdeskDeposit(marqueDe2(claimed.provider, claimed.operator), claimed.providerId, claimed.montant);
      if (b && b.ok) depotStatus = 'success';
      else { depotStatus = 'processing'; derivErr = 'Betwinner: reponse non confirmee'; }
    } catch (e) {
      console.error('[orange-pay] betwinnerDeposit', String(claimed._id), ':', e.message);
      depotStatus = 'processing'; derivErr = e.message;
    }
  } else if (claimed.providerId) {
    try {
      const { restTransferToClient } = require('./derivRest');
      const reqId = 'dep' + String(claimed._id);   // MEME request_id que le chemin SMS
      const r = await restTransferToClient(
        claimed.providerId, claimed.montantUsd || claimed.montant, 'USD', reqId);
      if (r && r.ok) { depotStatus = 'success'; derivTxnId = r.transaction_id || ''; }
      else { depotStatus = 'processing'; derivErr = 'Deriv: transfert ' + ((r && r.status) ? r.status : 'non confirme'); }
    } catch (e) {
      console.error('[orange-pay] restTransferToClient', String(claimed._id), ':', e.message);
      depotStatus = 'processing'; derivErr = e.message;
    }
  } else {
    depotStatus = 'processing';
    derivErr = 'providerId (CR Deriv) manquant';
  }

  await Retrait.findByIdAndUpdate(claimed._id, {
    status: depotStatus, receptionStatus: 'confirme',
    derivTxnId: derivTxnId || claimed.derivTxnId || '', response: derivErr,
    lastUssdResponse: 'Paiement Orange Money confirme (' + montantRecu + ')',
    locked: false, updatedAt: new Date()
  });
  console.log('[orange-pay] depot', String(claimed._id), '->', depotStatus);
}

// Recoit SMS depuis APK Android
router.post('/receive', apikey, async (req, res) => {
  try {
    const { from, message, sim, simSlot, deviceId, operator: opBody } = req.body;
    let operator = opBody || 'Inconnu';
    // Appareil COMORES (deviceId misy KM/COMOR) -> operator Comores foana
    if (!opBody && deviceId && /(km|comor)/i.test(deviceId)) operator = 'MVola Comores';
    else if (!opBody && sim) {
      const s = sim.toUpperCase();
      if (s.includes('COMOR')) operator = 'MVola Comores';
      else if (s.includes('ORANGE')) operator = 'Orange Money';
      else if (s.includes('YAS') || s.includes('TELMA') || s.includes('MVOLA')) operator = 'YAS (Telma)';
      else if (s.includes('AIRTEL')) operator = 'Airtel Money';
    }

    // FIX: DEDUP SMS -- raha SMS mitovy marina tokoa (operator + message) efa
    // niditra tao anatin'ny 3 minitra lasa (ohatra: SIM roa mamaky SMS iray,
    // na ny APK mandefa indroa noho ny retry réseau), dia heverina ho
    // dupliqué: tahirizina ihany fa TSY mandalo autoValidate (tsy hisy
    // double appel Deriv / double Solde).
    const dedupWindow = new Date(Date.now() - 3 * 60 * 1000);
    const dup = await Sms.findOne({
      operator, message, receivedAt: { $gte: dedupWindow }
    }).sort({ receivedAt: -1 });

    const sms = new Sms({
      from, message, sim, simSlot, operator, deviceId,
      status: dup ? 'duplicate' : 'sent'
    });
    await sms.save();

    await Device.findOneAndUpdate(
      { deviceId },
      { $inc: { smsReceived: 1 }, lastSeen: new Date(), online: true },
      { upsert: true }
    );

    if (dup) {
      console.warn('SMS dupliqué ignoré (déjà reçu <3min):', String(message).slice(0, 60));
    } else {
      autoValidate(operator, message, sms._id).catch(e => console.error('autoValidate:', e));
    }
    res.json({ id: sms._id, status: dup ? 'duplicate' : 'received' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Liste SMS (admin)
router.get('/', auth, async (req, res) => {
  try {
    const { page=1, limit=50, operator, status } = req.query;
    const filter = {};
    if (operator) filter.operator = operator;
    if (status)   filter.status   = status;
    const total = await Sms.countDocuments(filter);
    const sms   = await Sms.find(filter)
      .sort({ receivedAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit))
      .populate('retraitId');
    res.json({ total, page: Number(page), data: sms });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// FIX: GET /api/sms/depot -- SMS dia mifandray amin'ny Retrait type=depot ihany
router.get('/depot', auth, async (req, res) => {
  try {
    const { page=1, limit=50, operator, status } = req.query;
    const depotRetraits = await Retrait.find({ type: 'depot' }).distinct('_id');
    const filter = { retraitId: { $in: depotRetraits } };
    if (operator) filter.operator = operator;
    if (status)   filter.status   = status;
    const total = await Sms.countDocuments(filter);
    const sms = await Sms.find(filter)
      .sort({ receivedAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit))
      .populate('retraitId');
    res.json({ total, page: Number(page), data: sms });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FIX: GET /api/sms/retrait -- SMS dia mifandray amin'ny Retrait type=retrait ihany
router.get('/retrait', auth, async (req, res) => {
  try {
    const { page=1, limit=50, operator, status } = req.query;
    const retraitRetraits = await Retrait.find({ type: 'retrait' }).distinct('_id');
    const filter = { retraitId: { $in: retraitRetraits } };
    if (operator) filter.operator = operator;
    if (status)   filter.status   = status;
    const total = await Sms.countDocuments(filter);
    const sms = await Sms.find(filter)
      .sort({ receivedAt: -1 })
      .skip((page-1)*limit)
      .limit(Number(limit))
      .populate('retraitId');
    res.json({ total, page: Number(page), data: sms });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/clear', auth, async (req, res) => {
  try {
    await Sms.deleteMany({});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await Sms.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// RELANCE AUTO DEPOT (Deriv) isaky 15 min (manuel ihany ny RETRAIT). Timeout 30 min -> failed.
const DEPOT_DERIV_TIMEOUT_MS = 30 * 60 * 1000;
async function autoRelanceDepotsDeriv() {
  try {
    const cutoff = new Date(Date.now() - DEPOT_DERIV_TIMEOUT_MS);
    const staleLockCutoff0 = new Date(Date.now() - 2 * 60 * 1000);
    const depots = await Retrait.find({
      type: 'depot', status: 'processing', receptionStatus: 'confirme',
      providerId: { $nin: [null, ''] },
      // FIX: alaina ireo tsy locked NA ireo locked efa "stale" (>2 min) --
      // tsy ireo tena an-dalam-pandraisana ankehitriny.
      $or: [ { locked: { $ne: true } }, { locked: true, updatedAt: { $lt: staleLockCutoff0 } } ]
    }).lean();
    for (const d of depots) {
      if (d.createdAt && new Date(d.createdAt) < cutoff) {
        await Retrait.findByIdAndUpdate(d._id, { status: 'failed', updatedAt: new Date() });
        continue;
      }

      // FIX: CLAIM ATOMIQUE mialoha ny appel Deriv -- raha autoValidate (SMS)
      // efa mandray io retrait io amin'izao fotoana izao, dia ny cron tsy
      // hiantso Deriv intsony. "Stale lock" 2 min koa raha crash teo aloha.
      const staleLockCutoff = new Date(Date.now() - 2 * 60 * 1000);
      const claimed = await Retrait.findOneAndUpdate(
        {
          _id: d._id, status: 'processing',
          $or: [ { locked: { $ne: true } }, { locked: true, updatedAt: { $lt: staleLockCutoff } } ]
        },
        { $set: { locked: true, updatedAt: new Date() } },
        { new: true }
      );
      if (!claimed) continue;

      try {
        // BETWINNER: relance voafetra 3 (tsy misy verification statement any
        // aminy — fadiana ny double-credit raha timeout nefa lany ihany)
        const { estCashdesk: estCd3, marqueDe: marqueDe3 } = require('./betwinnerService');
        if (estCd3(claimed.provider)) {
          if ((d.relanceCount || 0) >= 3) {
            await Retrait.findByIdAndUpdate(claimed._id, {
              response: 'Relance Betwinner voafetra (3) — validation manuelle ilaina',
              locked: false, updatedAt: new Date()
            });
            continue;
          }
          const { cashdeskDeposit } = require('./betwinnerService');
          const b = await cashdeskDeposit(marqueDe3(claimed.provider, claimed.operator), claimed.providerId, claimed.montant);
          await Retrait.findByIdAndUpdate(claimed._id, {
            status: (b && b.ok) ? 'success' : 'processing',
            response: (b && b.ok) ? '' : 'Betwinner: reponse non confirmee',
            relanceCount: (d.relanceCount||0)+1, lastRelanceAt: new Date(),
            locked: false, updatedAt: new Date()
          });
          continue;
        }
        // DEPOT DERIV via NICKNAME (REST) — idempotence par request_id STABLE.
        const { restTransferToClient, restTransferStatus } = require('./derivRest');
        const reqId = 'dep' + String(claimed._id);

        // 1) VERIFIER D'ABORD le statut du transfert (même request_id) :
        // si déjà 'complete', ne PAS renvoyer -> zéro double-crédit.
        let already = { status: '' };
        try {
          already = await restTransferStatus(reqId);
        } catch (eChk) {
          // 404 = transfert jamais créé -> il faut le tenter (normal au 1er relance)
          console.warn('restTransferStatus (relance depot):', eChk.message);
        }
        if ((already.status || '').toLowerCase() === 'complete') {
          await Retrait.findByIdAndUpdate(claimed._id, {
            status: 'success', derivTxnId: already.transaction_id || '',
            response: 'Confirme via statut transfert Deriv (relance, sans renvoyer)',
            relanceCount: (d.relanceCount||0)+1, lastRelanceAt: new Date(),
            locked: false, updatedAt: new Date()
          });
          continue;
        }

        // 2) (Re)tenter le transfert — MÊME request_id -> idempotent côté Deriv.
        const r = await restTransferToClient(claimed.providerId, claimed.montantUsd || claimed.montant, 'USD', reqId);
        if (r && r.ok) {
          await Retrait.findByIdAndUpdate(claimed._id, {
            status: 'success', derivTxnId: r.transaction_id || '', response: '',
            relanceCount: (d.relanceCount||0)+1, lastRelanceAt: new Date(),
            locked: false, updatedAt: new Date()
          });
        } else {
          await Retrait.findByIdAndUpdate(claimed._id, {
            response: 'Deriv: transfert ' + ((r && r.status) ? r.status : 'non confirme'),
            relanceCount: (d.relanceCount||0)+1, lastRelanceAt: new Date(),
            locked: false, updatedAt: new Date()
          });
        }
      } catch(e) {
        await Retrait.findByIdAndUpdate(claimed._id, {
          response: e.message, relanceCount: (d.relanceCount||0)+1,
          lastRelanceAt: new Date(), locked: false, updatedAt: new Date()
        });
      }
    }
  } catch(e) { console.error('autoRelanceDepotsDeriv:', e.message); }
}
// FIX: isaky 15 minitra ny relance depot (araka ny voafaritra), tsy 5mn intsony.
setInterval(autoRelanceDepotsDeriv, 15 * 60 * 1000);
module.exports = router;
// Exports ho an'ny fenetre 1h (ordre aorian'ny vola): retrait.js mampiasa
module.exports.autoValidate = autoValidate;
module.exports.validerDepotOrangePay = validerDepotOrangePay;
module.exports.extractNumeroFromSms = extractNumeroFromSms;
module.exports.parseMontant = parseMontant;
module.exports.getOpKeySms = getOpKey;
module.exports.montantDepotOk = montantDepotOk;

// Fonctions internes exposees pour les tests automatises.
module.exports.__test = { lireSoldeAnnonce, lireFrais, versNombre };
