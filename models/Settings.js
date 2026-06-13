const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed }
});

module.exports = mongoose.model('Settings', settingsSchema);
