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

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.1.0' }));

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connecté');
    app.listen(process.env.PORT || 3000, () =>
      console.log('Backend démarré port', process.env.PORT || 3000));
  })
  .catch(err => { console.error('MongoDB error:', err); process.exit(1); });
