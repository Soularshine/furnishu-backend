const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/api/listings', (_req, res) => res.json([]));

app.listen(PORT, () => console.log('Listening on', PORT));
