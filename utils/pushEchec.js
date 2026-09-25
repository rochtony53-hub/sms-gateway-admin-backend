/**
 * Notification au client quand un de ses ordres echoue.
 *
 * Les succes sont deja annonces la ou ils se produisent. Les echecs, eux,
 * surviennent a une vingtaine d'endroits (expiration d'une heure, erreur
 * USSD, refus de l'administration...) et n'etaient jamais annonces : le
 * client ne savait pas que son ordre n'avait pas abouti.
 *
 * Cette tache a part lit les ordres passes en 'failed' et previent le client
 * UNE fois. Elle ne modifie aucun statut et ne touche pas aux notifications
 * de succes. Seuls les echecs survenus apres sa mise en service sont vises.
 */
const Retrait  = require('../models/Retrait');
const Settings = require('../models/Settings');

const TOUR_MS = 30 * 1000;
const CLE     = 'push_echec_depuis';
let enCours   = false;

async function depuis() {
  await Settings.updateOne({ key: CLE },
    { $setOnInsert: { key: CLE, value: new Date().toISOString() } }, { upsert: true });
  const d = await Settings.findOne({ key: CLE }).lean();
  const t = new Date(d && d.value);
  return isNaN(t.getTime()) ? new Date() : t;
}

function montantTexte(o) {
  const n = Number(o.montant || 0).toLocaleString('fr-FR');
  return (o.provider && String(o.provider).trim()) ? ('$' + n) : (n + ' ' + (o.devise || 'Ar'));
}

function masque(n) {
  return String(n || '').replace(/^(\d{3})\d+(\d{2})$/, '$1*****$2');
}

async function tour() {
  if (enCours) return;
  enCours = true;
  try {
    const debut = await depuis();
    for (let i = 0; i < 20; i++) {
      // Reservation atomique par le pilote natif : deux tours simultanes ne
      // prennent jamais le meme ordre, donc jamais deux notifications.
      const r = await Retrait.collection.findOneAndUpdate(
        { status: 'failed', clientId: { $nin: [null, ''] },
          pushEchecLe: null, updatedAt: { $gte: debut } },
        { $set: { pushEchecLe: new Date() } },
        { sort: { updatedAt: 1 }, returnDocument: 'after' });
      const o = (r && r.value !== undefined && r.ok !== undefined) ? r.value : r;
      if (!o) break;

      const dep   = o.type === 'depot';
      const titre = dep ? 'Dépôt non abouti' : 'Retrait non abouti';
      const corps = dep
        ? 'Aucun paiement reçu pour votre dépôt de ' + montantTexte(o)
          + '. Si vous avez payé, contactez le support.'
        : 'Votre retrait de ' + montantTexte(o) + ' vers ' + masque(o.numero)
          + " n'a pas abouti. Contactez le support si besoin.";
      try {
        const ClientPush = require('../models/ClientPush');
        await require('./push').notifierClient(ClientPush, o.clientId, titre, corps, '/');
        console.log('[push-echec] ' + (o.type || '') + ' ' + (o.operator || '') + ' '
          + o.montant + ' client ' + String(o.clientId));
      } catch (e) { console.warn('[push-echec] envoi:', e.message); }
    }
  } catch (e) {
    console.error('[push-echec] tour:', e.message);
  } finally { enCours = false; }
}

function demarrer() {
  setInterval(tour, TOUR_MS);
  console.log('[push-echec] actif (toutes les 30 s)');
}

module.exports = { demarrer, tour };
