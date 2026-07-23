import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { ShareToken } from '../models/ShareToken';
import { DocModel } from '../models/Document';

const router = Router();
const JWT_SECRET  = process.env.JWT_SECRET!;
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

// GET /api/share/:token — public metadata
router.get('/:token', async (req: Request, res: Response): Promise<void> => {
  try {
    const st = await ShareToken.findOne({ token: req.params.token }).populate<{ documentId: { originalName: string; size: number } }>('documentId', 'originalName size');
    if (!st) { res.status(404).json({ message: 'Share link not found' }); return; }

    if (st.expiresAt && st.expiresAt < new Date()) {
      res.status(410).json({ message: 'This share link has expired' });
      return;
    }

    res.json({
      requiresPassword: !!st.passwordHash,
      documentName:     st.documentId.originalName,
      documentSize:     st.documentId.size,
      expiresAt:        st.expiresAt,
      accessCount:      st.accessCount,
    });
  } catch (err) {
    console.error('Share route error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/share/:token/access — validate password, record view, return view token
router.post('/:token/access', async (req: Request, res: Response): Promise<void> => {
  try {
    const st = await ShareToken.findOne({ token: req.params.token });
    if (!st) { res.status(404).json({ message: 'Share link not found' }); return; }

    if (st.expiresAt && st.expiresAt < new Date()) {
      res.status(410).json({ message: 'This share link has expired' });
      return;
    }

    if (st.passwordHash) {
      const { password } = req.body as { password?: string };
      if (!password) { res.status(401).json({ message: 'Password required' }); return; }
      const ok = await bcrypt.compare(password, st.passwordHash);
      if (!ok) { res.status(401).json({ message: 'Incorrect password' }); return; }
    }

    const doc = await DocModel.findById(st.documentId);
    if (!doc) { res.status(404).json({ message: 'Document not found' }); return; }

    const ip = ((req.headers['x-forwarded-for'] as string) || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    doc.views.push({ viewedAt: new Date(), ip });
    doc.viewCount += 1;
    await doc.save();

    st.accessCount += 1;
    await st.save();

    const viewToken = jwt.sign(
      { documentId: doc._id.toString(), shareToken: req.params.token },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({ viewToken, documentName: doc.originalName });
  } catch (err) {
    console.error('Share route error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/share/:token/file?vt=<viewToken> — stream PDF
router.get('/:token/file', async (req: Request, res: Response): Promise<void> => {
  try {
    const vt = req.query['vt'] as string | undefined;
    if (!vt) { res.status(401).json({ message: 'View token required' }); return; }

    let payload: { documentId: string; shareToken: string };
    try {
      payload = jwt.verify(vt, JWT_SECRET) as { documentId: string; shareToken: string };
    } catch {
      res.status(401).json({ message: 'Invalid or expired view token' });
      return;
    }

    if (payload.shareToken !== req.params.token) {
      res.status(403).json({ message: 'Token mismatch' });
      return;
    }

    const doc = await DocModel.findById(payload.documentId);
    if (!doc) { res.status(404).json({ message: 'Document not found' }); return; }

    const filePath = path.resolve(UPLOADS_DIR, doc.storedName);
    // Guard against path traversal — resolved path must stay inside UPLOADS_DIR
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
      res.status(400).json({ message: 'Invalid file reference' });
      return;
    }
    if (!fs.existsSync(filePath)) { res.status(404).json({ message: 'File missing on server' }); return; }

    // Sanitize filename for Content-Disposition header
    const safeFilename = doc.originalName.replace(/[^\w.\- ]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Share route error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
