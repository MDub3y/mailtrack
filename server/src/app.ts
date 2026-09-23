import express from 'express';
import cors from 'cors';

import authRoutes     from './routes/auth';
import emailRoutes    from './routes/emails';
import documentRoutes from './routes/documents';
import shareRoutes    from './routes/share';
import trackRoutes    from './routes/track';
import organizationRoutes from './routes/organizations';
import aiRoutes        from './routes/ai';
import contactRoutes, { memoryRouter } from './routes/contacts';
import queueRoutes     from './routes/queue';
import integrityRoutes from './routes/integrity';
import inboxRoutes     from './routes/inbox';
import digestRoutes    from './routes/digest';
import integrationsRoutes, { signalsRouter } from './routes/integrations';

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
app.use('/api/organizations', organizationRoutes);
app.use('/api/ai',        aiRoutes);
app.use('/api/contacts',  contactRoutes);
app.use('/api/memory',    memoryRouter);
app.use('/api/queue',     queueRoutes);
app.use('/api/integrity', integrityRoutes);
app.use('/api/inbox',     inboxRoutes);
app.use('/api/digest',    digestRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/signals',   signalsRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export default app;
