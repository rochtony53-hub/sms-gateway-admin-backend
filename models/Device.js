const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId:    { type: String, required: true, unique: true },
  battery:     { type: Number, default: 0 },
  sims:        { type: String },
  smsReceived: { type: Number, default: 0 },
  pendingCmds:  { type: [String], default: [] },
  smsSent:     { type: Number, default: 0 },
  online:      { type: Boolean, default: false },
  lastSeen:    { type: Date, default: Date.now }
});

module.exports = mongoose.model('Device', deviceSchema);
