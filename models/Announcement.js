const mongoose = require('mongoose');

/**
 * Annonce affichee a tous les clients dans la cloche du site.
 *
 * Une annonce reste visible tant qu'elle est active et non expiree : c'est
 * l'admin qui decide, il n'y a pas de suppression automatique.
 */
const announcementSchema = new mongoose.Schema({
  title:     { type: String, default: '' },
  body:      { type: String, required: true },
  // info | success | warning — sert a la couleur cote client.
  level:     { type: String, enum: ['info','success','warning'], default: 'info' },
  active:    { type: Boolean, default: true },
  // Vide = pas d'expiration.
  expiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Announcement', announcementSchema);
