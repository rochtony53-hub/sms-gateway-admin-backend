// Service Betwinner — Cashdesk API (https://partners.servcul.com/CashdeskBotAPI/)
// Signature: sign = SHA256( SHA256(step1) + MD5(step2) )   [hex minuscule concaténé]
//   step1 (commun)   : "hash={hash}&lng={lng}&userid={userId}"
//   step2 Dépôt      : "summa={summa}&cashierpass={pass}&cashdeskid={id}"
//   step2 Payout     : "code={code}&cashierpass={pass}&cashdeskid={id}"
// confirm = MD5("{userId}:{hash}")
// Vecteurs du doc validés: step1 ✅ (userid minuscule), confirm ✅, formule finale ✅.
const crypto = require('crypto');
const { getBetwinnerConfig, getCashdeskConfig } = require('./betwinner');

const BW_BASE = 'https://partners.servcul.com/CashdeskBotAPI';
const BW_TIMEOUT_MS = 25000;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const md5    = s => crypto.createHash('md5').update(String(s)).digest('hex');

function requireCfg(cfg) {
  if (!cfg.betwinner_hash || !cfg.betwinner_cashierpass || !cfg.betwinner_cashdeskid) {
    const nom = (cfg && cfg._marque) || 'Betwinner';
    const e = new Error(nom + ' non configuré (hash / cashierpass / cashdeskid)');
    e.code = 'BetwinnerNotConfigured';
    throw e;
  }
}

/**
 * Betwinner et 1xBet sont deux marques du MEME reseau Cashdesk : meme URL, memes
 * formules de signature, seuls les identifiants changent. Les fonctions ci-dessous
 * prennent donc une marque en premier argument, et getCashdeskConfig renvoie la
 * config de cette marque sous des cles identiques -- le reste du code n'a pas a
 * savoir laquelle il manipule.
 *
 * Les anciens noms (betwinnerDeposit, ...) restent disponibles en fin de fichier
 * et pointent sur la marque 'betwinner' : AUCUN appelant existant n'est modifie.
 */
async function cfgDe(marque) {
  return marque ? await getCashdeskConfig(marque) : await getBetwinnerConfig();
}

/**
 * true si ce fournisseur passe par le reseau Cashdesk (Betwinner ou 1XBET).
 * Le nom enregistre dans Retrait.provider est libre : on teste sans tenir
 * compte de la casse.
 */
function estCashdesk(provider) {
  return /betwinner|1xbet/i.test(String(provider || ''));
}

/**
 * Marque a utiliser, donc CAISSE a debiter ou crediter.
 *
 * Trois caisses distinctes, avec des identifiants entierement separes :
 *   Betwinner   -> operateurs de Madagascar
 *   1XBET       -> operateurs de Madagascar
 *   1XBET KM    -> Comores (mvola_km), en franc comorien
 *
 * C'est l'OPERATEUR qui separe les deux caisses 1XBET : le fournisseur
 * enregistre vaut "1XBET" des deux cotes. Omettre l'operateur ferait donc
 * partir un mouvement comorien sur la caisse malgache.
 *
 * En l'absence d'operateur on retombe sur la caisse malgache : c'est le
 * comportement d'avant les Comores, et il ne peut pas creer de melange
 * puisqu'un ordre comorien porte toujours son operateur mvola_km.
 */
function marqueDe(provider, operator) {
  if (!/1xbet/i.test(String(provider || ''))) return 'betwinner';
  return /mvola_km|comor/i.test(String(operator || '')) ? 'onexbet_km' : 'onexbet';
}

async function bwFetch(method, path, { sign, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BW_TIMEOUT_MS);
  try {
    const headers = { 'sign': sign };
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(BW_BASE + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const txt = await r.text();
    let json = {};
    try { json = txt ? JSON.parse(txt) : {}; } catch(_) { json = { raw: txt }; }
    // Trace de diagnostic : sans elle, une reponse inattendue de l'API est
    // indiscernable d'un joueur inexistant. Aucun secret n'est journalise
    // (ni hash, ni cashierpass : ils voyagent dans l'en-tete 'sign').
    console.log('Betwinner ' + method + ' ' + path.split('?')[0]
              + ' -> HTTP ' + r.status + ' ' + String(txt || '').slice(0, 200));
    if (r.status === 401) { const e = new Error('Signature Betwinner refusée (401)'); e.code='SignInvalid'; e.httpStatus=401; throw e; }
    if (r.status === 403) { const e = new Error('Confirm Betwinner refusé (403)'); e.code='ConfirmInvalid'; e.httpStatus=403; throw e; }
    if (!r.ok) { const e = new Error('Betwinner HTTP ' + r.status + (json.message ? (': ' + json.message) : '')); e.httpStatus=r.status; e.raw=json; throw e; }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('Betwinner timeout'); t.code='Timeout'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

// DÉPÔT — POST Deposit/{userId}/Add  (summa = Ariary, entier)
async function cashdeskDeposit(marque, userId, summaAr) {
  const cfg = await cfgDe(marque);
  requireCfg(cfg);
  const lng = cfg.betwinner_lng || 'fr';
  const summa = Math.round(Number(summaAr)); // Ariary direct, entier
  const s1 = sha256(`hash=${cfg.betwinner_hash}&lng=${lng}&userid=${userId}`);
  const s2 = md5(`summa=${summa}&cashierpass=${cfg.betwinner_cashierpass}&cashdeskid=${cfg.betwinner_cashdeskid}`);
  const sign = sha256(s1 + s2);
  const confirm = md5(`${userId}:${cfg.betwinner_hash}`);
  const data = await bwFetch('POST', `/Deposit/${encodeURIComponent(userId)}/Add`, {
    sign,
    body: { cashdeskid: Number(cfg.betwinner_cashdeskid), lng, summa, confirm }
  });
  // Réponse attendue: { summa, success, messageId, message }
  if (data && data.success === false) {
    const e = new Error(data.message || ('Betwinner depot refusé (code ' + (data.messageId ?? '?') + ')'));
    e.code = 'DepositRefused'; e.messageId = data.messageId; e.raw = data;
    throw e;
  }
  return { ok: true, summa: data?.summa ?? summa, raw: data };
}

// RETRAIT (payout) — POST Deposit/{userId}/Payout  (code = code client Betwinner)
// Ny montant dia FANTATRA amin'ny réponse (summa) rehefa mahomby.
async function cashdeskPayout(marque, userId, code) {
  const cfg = await cfgDe(marque);
  requireCfg(cfg);
  const lng = cfg.betwinner_lng || 'fr';
  const s1 = sha256(`hash=${cfg.betwinner_hash}&lng=${lng}&userid=${userId}`);
  const s2 = md5(`code=${code}&cashierpass=${cfg.betwinner_cashierpass}&cashdeskid=${cfg.betwinner_cashdeskid}`);
  const sign = sha256(s1 + s2);
  const confirm = md5(`${userId}:${cfg.betwinner_hash}`);
  const data = await bwFetch('POST', `/Deposit/${encodeURIComponent(userId)}/Payout`, {
    sign,
    body: { cashdeskId: Number(cfg.betwinner_cashdeskid), lng, code: String(code), confirm }
  });
  if (!data || data.success !== true) {
    // Le message nommait toujours Betwinner : un client 1XBET croyait s'etre
    // trompe de fournisseur. On reprend la marque reellement utilisee.
    const nom = marque === 'onexbet' ? '1XBET' : (marque === 'onexbet_km' ? '1XBET' : 'Betwinner');
    const e = new Error((data && data.message) || ('Code ' + nom + ' invalide ou payout refusé'));
    e.code = 'PayoutRefused'; e.messageId = data && data.messageId; e.raw = data;
    throw e;
  }
  const summa = Math.abs(Number(data.summa) || 0);
  if (!summa) { const e = new Error('Payout sans montant (summa vide)'); e.code='PayoutNoAmount'; e.raw=data; throw e; }
  return { ok: true, summa, raw: data };
}

// RECHERCHE JOUEUR — GET /Users/{userId}?confirm=&cashdeskid=
// ATTENTION : le doc ecrit "userId" (majuscule) mais l'API ne l'accepte PAS.
// Diagnostic en production : seule la variante "userid" MINUSCULE renvoie 200.
// C'est coherent avec la signature generale du doc, dont le vecteur officiel
// n'est reproductible qu'avec "userid" minuscule.
// step1: "hash={h}&userid={u}&cashdeskid={c}"   step2: "userid={u}&cashierpass={p}&hash={h}"
async function cashdeskFindUser(marque, userId) {
  const cfg = await cfgDe(marque);
  requireCfg(cfg);
  const s1 = sha256(`hash=${cfg.betwinner_hash}&userid=${userId}&cashdeskid=${cfg.betwinner_cashdeskid}`);
  const s2 = md5(`userid=${userId}&cashierpass=${cfg.betwinner_cashierpass}&hash=${cfg.betwinner_hash}`);
  const sign = sha256(s1 + s2);
  const confirm = md5(`${userId}:${cfg.betwinner_hash}`);
  const data = await bwFetch('GET',
    `/Users/${encodeURIComponent(userId)}?confirm=${confirm}&cashdeskid=${encodeURIComponent(cfg.betwinner_cashdeskid)}`,
    { sign });

  // ------------------------------------------------------------------
  // L'API Betwinner n'est PAS constante sur la casse des champs : ailleurs
  // dans ce meme service, betwinnerBalance() lit deja "Balance ?? balance".
  // Ici on ne testait que "userId" en minuscules : si la reponse contient
  // "UserId", un joueur parfaitement valide etait declare introuvable.
  // On accepte donc les deux ecritures.
  // ------------------------------------------------------------------
  const id  = data?.UserId ?? data?.userId ?? data?.Id ?? data?.id;
  const nom = data?.Name   ?? data?.name   ?? '';
  const dev = data?.CurrencyId ?? data?.currencyId;

  if (!data || id == null) {
    // Message d'erreur utile : sans le contenu reel de la reponse, on ne
    // peut pas distinguer "ce joueur n'existe pas" de "l'API a repondu
    // autre chose que ce qu'on attendait".
    let detail = '';
    if (data && typeof data === 'object') {
      if (data.Message || data.message) detail = String(data.Message || data.message);
      else detail = JSON.stringify(data).slice(0, 200);
    }
    const e = new Error('Joueur Betwinner introuvable'
      + (detail ? (' — reponse API : ' + detail) : ' (reponse vide)'));
    e.code = 'UserNotFound'; e.raw = data;
    throw e;
  }
  return { ok: true, userId: id, name: nom, currencyId: dev };
}

// SOLDE CAISSE — GET Cashdesk/{id}/Balance?confirm=&dt=   (dt = yyyy.MM.dd HH:mm:ss UTC)
async function cashdeskBalance(marque) {
  const cfg = await cfgDe(marque);
  requireCfg(cfg);
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const dt = `${d.getUTCFullYear()}.${p(d.getUTCMonth()+1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const s1 = sha256(`hash=${cfg.betwinner_hash}&cashdeskid=${cfg.betwinner_cashdeskid}&dt=${dt}`);
  const s2 = md5(`dt=${dt}&cashierpass=${cfg.betwinner_cashierpass}&cashdeskid=${cfg.betwinner_cashdeskid}`);
  const sign = sha256(s1 + s2);
  const confirm = md5(`${cfg.betwinner_cashdeskid}:${cfg.betwinner_hash}`);
  const data = await bwFetch('GET',
    `/Cashdesk/${encodeURIComponent(cfg.betwinner_cashdeskid)}/Balance?confirm=${confirm}&dt=${encodeURIComponent(dt)}`,
    { sign });
  return { ok: true, balance: data?.Balance ?? data?.balance ?? null, limit: data?.Limit ?? data?.limit ?? null };
}

// --- Anciens noms : marque 'betwinner' implicite ---------------------------
// Conserves a l'identique pour que les 7 fichiers qui les appellent restent
// inchanges. Toute evolution passe desormais par les fonctions cashdesk*.
const betwinnerDeposit  = (userId, summaAr) => cashdeskDeposit('betwinner', userId, summaAr);
const betwinnerPayout   = (userId, code)    => cashdeskPayout('betwinner', userId, code);
const betwinnerFindUser = (userId)          => cashdeskFindUser('betwinner', userId);
const betwinnerBalance  = ()                => cashdeskBalance('betwinner');

module.exports = {
  betwinnerDeposit, betwinnerPayout, betwinnerFindUser, betwinnerBalance,
  cashdeskDeposit,  cashdeskPayout,  cashdeskFindUser,  cashdeskBalance,
  estCashdesk,      marqueDe
};
