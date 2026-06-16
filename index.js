const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/sms',     require('./routes/sms'));
app.use('/api/device',  require('./routes/device'));
app.use('/api/retrait', require('./routes/retrait'));
app.use('/api/template', require('./routes/template'));
app.use('/api/ussd',    require('./routes/ussd'));
app.use('/api/stats',   require('./routes/stats'));
app.use('/api/service', require('./routes/service'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/solde',   require('./routes/solde'));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.1.0' }));

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connecté');
    app.listen(process.env.PORT || 3000, () =>
      console.log('Backend démarré port', process.env.PORT || 3000));

    // Auto-refuse les transactions pending depuis plus de 24h
    const Retrait = require('./models/Retrait');
    const DELAY_MS = 24 * 60 * 60 * 1000;
    setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - DELAY_MS);
        const expired = await Retrait.find({ status: 'pending', createdAt: { $lte: cutoff } });
        for (const r of expired) {
          await Retrait.findByIdAndUpdate(r._id, {
            status: 'failed',
            updatedAt: new Date(),
            response: 'Refusé automatiquement — délai de 24h dépassé sans validation solde'
          });
          console.log('Auto-refuse retrait', r._id, r.operator, r.numero, r.montant);
        }
      } catch (e) {
        console.error('Auto-refuse cron error:', e.message);
      }
    }, 10 * 60 * 1000); // vérifie toutes les 10 minutes
  })
  .catch(err => { console.error('MongoDB error:', err); process.exit(1); });
