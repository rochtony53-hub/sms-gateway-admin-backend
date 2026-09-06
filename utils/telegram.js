/**
 * Notifications Telegram sur les transactions.
 *
 * Fil unique vers un canal prive : chaque ordre y laisse une trace, de sa
 * creation jusqu'a son issue. C'est le tableau de bord le plus rapide qui
 * soit — il arrive sur le telephone sans ouvrir l'admin.
 *
 * L'envoi n'est jamais bloquant et n'echoue jamais bruyamment : une
 * notification perdue ne doit pas faire echouer une transaction reussie.
 */
const TOKEN = () => (process.env.TG_NOTIF_TOKEN || process.env.TG_BOT_TOKEN || '').trim();

/**
 * Un canal par nature d'evenement plutot qu'un fil unique : melanger une
 * inscription et un depot echoue dans la meme conversation rend les deux
 * illisibles. Chaque canal a sa variable ; en son absence, tout retombe sur
 * TG_NOTIF_CHAT pour qu'aucune notification ne se perde en silence.
 */
const CANAUX = {
  transaction: 'TG_CHAT_TRANSACTION',
  wallet:      'TG_CHAT_WALLET',
  depot_ko:    'TG_CHAT_DEPOT_KO',
  retrait_err: 'TG_CHAT_RETRAIT_ERR',
  inscription: 'TG_CHAT_INSCRIPTION'
};
const CHAT = (canal) => (
  process.env[CANAUX[canal] || ''] ||
  process.env.TG_NOTIF_CHAT || process.env.TG_CHAT_ID || ''
).trim();

/** Echappe les caracteres reserves du HTML Telegram. */
function esc(v) {
  return String(v == null ? '\u2014' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function envoyer(texte, canal) {
  const token = TOKEN(), chat = CHAT(canal);
  if (!token || !chat) return;              // non configure : on se tait
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat, text: texte,
        parse_mode: 'HTML', disable_web_page_preview: true
      }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!r.ok) console.warn('telegram: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  } catch (e) {
    console.warn('telegram: envoi impossible -', e.message);
  }
}

const ICONES = {
  nouveau: '\u{1F195}', attente: '\u23F3', succes: '\u2705',
  echec:   '\u274C',    annule:  '\u{1F6AB}'
};
const TITRES = {
  nouveau: 'Nouvel ordre', attente: 'En attente',
  succes:  'Reussi',       echec:   'Echec', annule: 'Annule'
};

/**
 * @param etat  nouveau | attente | succes | echec | annule
 * @param o     objet transaction (Retrait ou ordre)
 * @param note  precision libre (motif d'echec, reference...)
 */
function notifierTransaction(etat, o, note) {
  if (!o) return;
  const ic = ICONES[etat] || '\u2139';
  const dev = o.devise || 'Ar';
  const l = [];
  l.push(ic + ' <b>' + esc(TITRES[etat] || etat) + '</b> \u2014 ' + esc(String(o.type || 'ordre').toUpperCase()));
  l.push('');
  l.push('Operateur   : <b>' + esc(o.operator) + '</b>');
  l.push('Numero      : <code>' + esc(o.numero) + '</code>');
  l.push('Montant     : <b>' + esc(Number(o.montant || 0).toLocaleString('fr-FR')) + ' ' + esc(dev) + '</b>');
  if (o.montantUsd) l.push('Soit        : ' + esc(o.montantUsd) + ' USD (cours ' + esc(o.rate) + ')');
  if (o.provider)   l.push('Fournisseur : ' + esc(o.provider));
  if (o.providerId) l.push('ID joueur   : <code>' + esc(o.providerId) + '</code>');
  if (o.sessionId)  l.push('Session     : <code>' + esc(o.sessionId) + '</code>');
  if (note)         l.push('\n<i>' + esc(note) + '</i>');
  l.push('');
  l.push(new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Antananarivo' }));
  // Volontairement sans await : la transaction ne doit pas attendre Telegram.
  envoyer(l.join('\n'), 'transaction');
}

/* ===== Les quatre autres canaux ========================================
   Meme bot, destinations differentes. Tant qu'un canal n'a pas son chat_id,
   ses messages retombent sur le canal transaction : mieux vaut un message
   mal range qu'un message perdu. */

/** Changement de numero de portefeuille demande par un client. */
function notifierWallet(action, u, w, note) {
  const l = [];
  l.push('\u{1F514} <b>WALLET</b> \u2014 ' + esc(action));
  l.push('');
  if (u) l.push('Client    : <b>' + esc(u.name || u.email || u.phone) + '</b>');
  if (w) {
    l.push('Operateur : ' + esc(w.operator));
    l.push('Numero    : <code>' + esc(w.numero) + '</code>');
    if (w.ancien) l.push('Ancien    : <code>' + esc(w.ancien) + '</code>');
  }
  if (note) l.push('\n<i>' + esc(note) + '</i>');
  l.push('');
  l.push(new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Antananarivo' }));
  envoyer(l.join('\n'), 'wallet');
}

/** Depot encaisse mais non credite chez le fournisseur. */
function notifierDepotKo(o, motif) {
  const l = [];
  l.push('\u{1F6A8} <b>DEPOT KO</b> \u2014 argent recu, compte non credite');
  l.push('');
  l.push('Operateur   : <b>' + esc(o.operator) + '</b>');
  l.push('Numero      : <code>' + esc(o.numero) + '</code>');
  l.push('Montant     : <b>' + esc(Number(o.montant || 0).toLocaleString('fr-FR')) + ' ' + esc(o.devise || 'Ar') + '</b>');
  if (o.provider)   l.push('Fournisseur : ' + esc(o.provider));
  if (o.providerId) l.push('ID joueur   : <code>' + esc(o.providerId) + '</code>');
  if (o.sessionId)  l.push('Session     : <code>' + esc(o.sessionId) + '</code>');
  l.push('\n<i>' + esc(motif || 'motif inconnu') + '</i>');
  l.push('');
  l.push(new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Antananarivo' }));
  envoyer(l.join('\n'), 'depot_ko');
}

/** Retrait dont l'envoi Mobile Money a echoue. */
function notifierRetraitErreur(o, motif) {
  const l = [];
  l.push('\u26A0\uFE0F <b>ERREUR ENVOI</b> \u2014 retrait');
  l.push('');
  l.push('Operateur : <b>' + esc(o.operator) + '</b>');
  l.push('Numero    : <code>' + esc(o.numero) + '</code>');
  l.push('Montant   : <b>' + esc(Number(o.montant || 0).toLocaleString('fr-FR')) + ' ' + esc(o.devise || 'Ar') + '</b>');
  if (o.sessionId) l.push('Session   : <code>' + esc(o.sessionId) + '</code>');
  if (o.ussdCode)  l.push('Code USSD : <code>' + esc(o.ussdCode) + '</code>');
  l.push('\n<i>' + esc(motif || 'motif inconnu') + '</i>');
  l.push('');
  l.push(new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Antananarivo' }));
  envoyer(l.join('\n'), 'retrait_err');
}

/** Nouveau compte client. */
function notifierInscription(u) {
  const l = [];
  l.push('\u{1F464} <b>NOUVELLE INSCRIPTION</b>');
  l.push('');
  l.push('Nom       : <b>' + esc(u.name) + '</b>');
  if (u.email)   l.push('Email     : <code>' + esc(u.email) + '</code>');
  if (u.phone)   l.push('Telephone : <code>' + esc(u.phone) + '</code>');
  if (u.country) l.push('Pays      : ' + esc(u.country) + (u.kmAccount ? ' (Comores, Fc)' : ''));
  l.push('');
  l.push(new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Antananarivo' }));
  envoyer(l.join('\n'), 'inscription');
}

module.exports = {
  notifierTransaction, notifierWallet, notifierDepotKo,
  notifierRetraitErreur, notifierInscription, envoyerTelegram: envoyer
};
