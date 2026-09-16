const mongoose = require('mongoose');

/**
 * Acces en LECTURE aux jetons de notification des clients.
 *
 * Les comptes clients appartiennent a client-api, qui partage la meme base.
 * On ne redefinit donc pas le compte entier : juste ce qu'il faut pour lui
 * envoyer une notification, en pointant explicitement la collection 'users'.
 * strict:false pour ne rien casser des champs geres par client-api.
 */
const schema = new mongoose.Schema(
  { fcmTokens: { type: [String], default: [] } },
  // Les comptes clients vivent dans 'client_users' : pointer 'users' visait
  // la collection des administrateurs, et aucune notification ne partait.
  { collection: 'client_users', strict: false }
);

module.exports = mongoose.models.ClientPush || mongoose.model('ClientPush', schema);
