const mongoose = require('mongoose');

const smsTemplateSchema = new mongoose.Schema({
  operator:  { type: String, required: true },
  type:      { type: String, enum: ['retrait','depot'], required: true },
  keywords:  [{ type: String }],
  exemple:   { type: String },
  createdBy: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SmsTemplate', smsTemplateSchema);
