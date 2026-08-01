// Service Betwinner — Cashdesk API (https://partners.servcul.com/CashdeskBotAPI/)
// Signature: sign = SHA256( SHA256(step1) + MD5(step2) )   [hex minuscule concaténé]
//   step1 (commun)   : "hash={hash}&lng={lng}&userid={userId}"
//   step2 Dépôt      : "summa={summa}&cashierpass={pass}&cashdeskid={id}"
//   step2 Payout     : "code={code}&cashierpass={pass}&cashdeskid={id}"
// confirm = MD5("{userId}:{hash}")
// Vecteurs du doc validés: step1 ✅ (userid minuscule), confirm ✅, formule finale ✅.
const crypto = require('crypto');
const { getBetwinnerConfig } = require('./betwinner');

const BW_BASE = 'https://partners.servcul.com/CashdeskBotAPI';
const BW_TIMEOUT_MS = 25000;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const md5    = s => crypto.createHash('md5').update(String(s)).digest('hex');

function requireCfg(cfg) {
  if (!cfg.betwinner_hash || !cfg.betwinner_cashierpass || !cfg.betwinner_cashdeskid) {
    const e = new Error('Betwinner non configuré (hash / cashierpass / cashdeskid)');
    e.code = 'BetwinnerNotConfigured';
    throw e;
  }
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
    if (r.status === 401) { const e = new Error('Signature Betwinner refusée (401)'); e.code='SignInvalid'; e.httpStatus=401; throw e; }
    if (r.status === 403) {
      // Ne PAS attribuer un 403 au champ "confirm" : ce message a envoye
      // l'exploitation chercher du cote de la signature alors que toutes les
      // variantes de signature renvoyaient le meme 403. Un rejet identique
      // quelle que soit la signature signifie que la requete est refusee AVANT
      // toute verification cryptographique — donc au niveau de l'autorisation
      // d'acces : adresse IP du serveur non declaree chez Betwinner, caisse non
      // activee pour l'API, ou identifiants appartenant a un autre environnement.
      const e = new Error(
        'Betwinner refuse l\'acces (403). Verifiez, dans cet ordre : '
        + '(1) l\'adresse IP sortante de ce serveur est-elle declaree chez Betwinner ; '
        + '(2) la caisse ' + (String(path).match(/Cashdesk\/(\d+)/) || [,'?'])[1]
        + ' est-elle activee pour l\'API ; '
        + '(3) le hash et le cashierpass proviennent-ils bien de cette caisse. '
        + 'Un 403 identique sur toutes les variantes de signature exclut une erreur de calcul.'
      );
      e.code = 'AccesRefuse'; e.httpStatus = 403; e.raw = json; throw e;
    }
    if (!r.ok) { const e = new Error('Betwinner HTTP ' + r.status + (json.message ? (': ' + json.message) : '')); e.httpStatus=r.status; e.raw=json; throw e; }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('Betwinner timeout'); t.code='Timeout'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

// DÉPÔT — POST Deposit/{userId}/Add  (summa = Ariary, entier)
async function betwinnerDeposit(userId, summaAr) {
  const cfg = await getBetwinnerConfig();
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
async function betwinnerPayout(userId, code) {
  const cfg = await getBetwinnerConfig();
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
    const e = new Error((data && data.message) || 'Code Betwinner invalide ou payout refusé');
    e.code = 'PayoutRefused'; e.messageId = data && data.messageId; e.raw = data;
    throw e;
  }
  const summa = Math.abs(Number(data.summa) || 0);
  if (!summa) { const e = new Error('Payout Betwinner sans montant (summa vide)'); e.code='PayoutNoAmount'; e.raw=data; throw e; }
  return { ok: true, summa, raw: data };
}

// RECHERCHE JOUEUR — GET /Users/{userId}?confirm=&cashdeskid=
// ATTENTION : le doc ecrit "userId" (majuscule) mais l'API ne l'accepte PAS.
// Diagnostic en production : seule la variante "userid" MINUSCULE renvoie 200.
// C'est coherent avec la signature generale du doc, dont le vecteur officiel
// n'est reproductible qu'avec "userid" minuscule.
// step1: "hash={h}&userid={u}&cashdeskid={c}"   step2: "userid={u}&cashierpass={p}&hash={h}"
async function betwinnerFindUser(userId) {
  const cfg = await getBetwinnerConfig();
  requireCfg(cfg);
  const s1 = sha256(`hash=${cfg.betwinner_hash}&userid=${userId}&cashdeskid=${cfg.betwinner_cashdeskid}`);
  const s2 = md5(`userid=${userId}&cashierpass=${cfg.betwinner_cashierpass}&hash=${cfg.betwinner_hash}`);
  const sign = sha256(s1 + s2);
  const confirm = md5(`${userId}:${cfg.betwinner_hash}`);
  const data = await bwFetch('GET',
    `/Users/${encodeURIComponent(userId)}?confirm=${confirm}&cashdeskid=${encodeURIComponent(cfg.betwinner_cashdeskid)}`,
    { sign });
  if (!data || data.userId == null) { const e = new Error('Joueur Betwinner introuvable'); e.code='UserNotFound'; e.raw=data; throw e; }
  return { ok: true, userId: data.userId, name: data.name || '', currencyId: data.currencyId };
}

// SOLDE CAISSE — GET Cashdesk/{id}/Balance?confirm=&dt=   (dt = yyyy.MM.dd HH:mm:ss UTC)
async function betwinnerBalance() {
  const cfg = await getBetwinnerConfig();
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

module.exports = { betwinnerDeposit, betwinnerPayout, betwinnerFindUser, betwinnerBalance };
