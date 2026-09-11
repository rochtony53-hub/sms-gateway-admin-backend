/**
 * Envoi des notifications Firebase aux clients.
 *
 * Deux usages : l'issue d'un ordre (reussi ou echoue) et les annonces de
 * l'admin. Rien d'autre — une notification de trop se paie en desinstallations.
 *
 * L'authentification passe par le compte de service (firebase-admin.json,
 * jamais versionne). Sans ce fichier, la fonction se tait : le site doit
 * continuer a marcher meme si les notifications sont indisponibles.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHEMIN = process.env.FIREBASE_SA || path.join(__dirname, '..', 'firebase-admin.json');

let compte = null, jeton = null, jetonExpire = 0;

function chargerCompte() {
  if (compte !== null) return compte;
  try { compte = JSON.parse(fs.readFileSync(CHEMIN, 'utf8')); }
  catch (e) { compte = false; console.warn('push: compte de service illisible —', e.message); }
  return compte;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Jeton OAuth2 obtenu par JWT signe, valable une heure, garde en memoire. */
async function accessToken() {
  const sa = chargerCompte();
  if (!sa) return null;
  const maintenant = Math.floor(Date.now() / 1000);
  if (jeton && jetonExpire > maintenant + 60) return jeton;

  const entete = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corps = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: maintenant, exp: maintenant + 3600
  }));
  const signature = b64url(
    crypto.createSign('RSA-SHA256').update(entete + '.' + corps).sign(sa.private_key)
  );

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: entete + '.' + corps + '.' + signature
    })
  });
  const d = await r.json();
  if (!d.access_token) { console.warn('push: jeton refuse —', JSON.stringify(d).slice(0, 160)); return null; }
  jeton = d.access_token;
  jetonExpire = maintenant + (d.expires_in || 3600);
  return jeton;
}

/**
 * @returns true si le jeton est encore valide, false s'il faut l'oublier.
 */
async function envoyerA(tokenAppareil, titre, corps, url) {
  const sa = chargerCompte();
  const acces = await accessToken();
  if (!sa || !acces) return true;          // indisponible : on ne jette rien
  try {
    const r = await fetch(
      'https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + acces, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: tokenAppareil,
            // Uniquement 'data' : c'est le service worker qui compose la
            // notification, donc l'affichage est identique partout.
            data: { title: String(titre), body: String(corps), url: String(url || '/') },
            webpush: { headers: { Urgency: 'high' } }
          }
        })
      }
    );
    if (r.ok) return true;
    const txt = await r.text();
    // 404 / UNREGISTERED : l'appareil a desinstalle ou vide ses donnees.
    if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(txt)) return false;
    console.warn('push: HTTP ' + r.status + ' ' + txt.slice(0, 140));
    return true;
  } catch (e) {
    console.warn('push: envoi impossible —', e.message);
    return true;
  }
}

/** Envoie a tous les appareils d'un client et nettoie les jetons morts. */
async function notifierClient(User, userId, titre, corps, url) {
  try {
    const u = await User.findById(userId).select('fcmTokens').lean();
    const liste = (u && u.fcmTokens) || [];
    if (!liste.length) return;
    const morts = [];
    for (const t of liste) {
      const vivant = await envoyerA(t, titre, corps, url);
      if (!vivant) morts.push(t);
    }
    if (morts.length) await User.updateOne({ _id: userId }, { $pull: { fcmTokens: { $in: morts } } });
  } catch (e) { console.warn('push: notifierClient —', e.message); }
}

module.exports = { notifierClient, envoyerA };
