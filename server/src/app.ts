import express from 'express';
import cors from 'cors';

import authRoutes     from './routes/auth';
import emailRoutes    from './routes/emails';
import documentRoutes from './routes/documents';
import shareRoutes    from './routes/share';
import trackRoutes    from './routes/track';

const app = express();

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json());

app.use('/api/auth',      authRoutes);
app.use('/api/emails',    emailRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/share',     shareRoutes);
app.use('/api/track',     trackRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export default app;
