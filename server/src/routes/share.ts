import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { ShareToken } from '../models/ShareToken';
import { DocModel } from '../models/Document';
import { Email } from '../models/Email';
import { contactForEmail, recordSignal } from '../services/signalService';

const router = Router();
const JWT_SECRET  = process.env.JWT_SECRET!;
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

// Dwell is a fact, not a score, and it must be told how it can lie
// (doc/02-ai-architecture.md §1.8): the viewer only counts visible time and
// skips the first second; the server caps each page and each report.
const MAX_DWELL_SECONDS_PER_PAGE = 300;
const MAX_PAGES_PER_REPORT = 200;

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

    // Attribution: links in outgoing mail carry ?via=<trackingToken>, so a
    // view can be tied to the email (and contact) it came from. Anonymous
    // share-link opens have no `via` and stay unattributed.
    const via = typeof req.body?.via === 'string' ? req.body.via : undefined;
    const viaEmail = via ? await Email.findOne({ trackingToken: via }).select('_id senderId to contactId') : null;
    const contact = viaEmail ? await contactForEmail(viaEmail) : null;

    const ip = ((req.headers['x-forwarded-for'] as string) || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    const viewId = uuidv4();
    const viewedAt = new Date();
    doc.views.push({ viewedAt, ip, viewId, viaEmailId: viaEmail?._id, contactId: contact?._id });
    doc.viewCount += 1;
    await doc.save();

    st.accessCount += 1;
    await st.save();

    if (viaEmail && contact) {
      recordSignal({
        ownerId: viaEmail.senderId,
        contactId: contact._id,
        emailId: viaEmail._id,
        documentId: doc._id,
        type: 'doc_view',
        at: viewedAt,
        payload: { documentName: doc.originalName, viewId, ip },
        verdict: 'human',
        source: 'viewer',
        dedupeKey: `doc_view:${viewId}`,
      }).catch((err) => console.error('Share signal error:', err));
    }

    const viewToken = jwt.sign(
      { documentId: doc._id.toString(), shareToken: req.params.token, viewId },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({ viewToken, documentName: doc.originalName });
  } catch (err) {
    console.error('Share route error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/share/:token/dwell { vt, pages: [{ page, seconds }] }
// The viewer reports per-page visible seconds on page change and unmount.
// Reports are merged (max per page) onto the view entry and recorded as a
// page_dwell signal when the view is attributed to a contact.
router.post('/:token/dwell', async (req: Request, res: Response): Promise<void> => {
  try {
    const { vt, pages } = req.body as { vt?: string; pages?: Array<{ page: number; seconds: number }> };
    if (!vt || !Array.isArray(pages)) { res.status(400).json({ message: 'vt and pages are required' }); return; }

    let payload: { documentId: string; shareToken: string; viewId?: string };
    try {
      payload = jwt.verify(vt, JWT_SECRET) as typeof payload;
    } catch {
      res.status(401).json({ message: 'Invalid or expired view token' });
      return;
    }
    if (payload.shareToken !== req.params.token || !payload.viewId) { res.status(403).json({ message: 'Token mismatch' }); return; }

    const clean = pages
      .filter((p) => Number.isInteger(p.page) && p.page > 0 && Number.isFinite(p.seconds) && p.seconds > 0)
      .slice(0, MAX_PAGES_PER_REPORT)
      .map((p) => ({ page: p.page, seconds: Math.min(Math.round(p.seconds), MAX_DWELL_SECONDS_PER_PAGE) }));
    if (!clean.length) { res.status(204).end(); return; }

    const doc = await DocModel.findById(payload.documentId);
    const view = doc?.views.find((v) => v.viewId === payload.viewId);
    if (!doc || !view) { res.status(404).json({ message: 'View not found' }); return; }

    const merged = new Map<number, number>((view.pageDwell ?? []).map((d) => [d.page, d.seconds]));
    for (const p of clean) merged.set(p.page, Math.max(merged.get(p.page) ?? 0, p.seconds));
    view.pageDwell = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([page, seconds]) => ({ page, seconds }));
    doc.markModified('views');
    await doc.save();

    if (view.viaEmailId && view.contactId) {
      const totalSeconds = view.pageDwell.reduce((n, d) => n + d.seconds, 0);
      const top = view.pageDwell.reduce((a, b) => (b.seconds > a.seconds ? b : a));
      // One signal per view, updated in place as reports arrive: the dedupe
      // key is the view id, so the payload is refreshed rather than duplicated.
      const { Signal } = await import('../models/Signal');
      await Signal.updateOne(
        { dedupeKey: `page_dwell:${payload.viewId}` },
        {
          $setOnInsert: {
            ownerId: doc.ownerId, contactId: view.contactId, emailId: view.viaEmailId, documentId: doc._id,
            type: 'page_dwell', at: view.viewedAt, integrity: { verdict: 'human' }, source: 'viewer', dedupeKey: `page_dwell:${payload.viewId}`, createdAt: new Date(),
          },
          $set: { payload: { documentName: doc.originalName, viewId: payload.viewId, pages: view.pageDwell, totalSeconds, topPage: top.page, topSeconds: top.seconds } },
        },
        { upsert: true }
      );
      const { notifySignalUpdated } = await import('../services/signalService');
      notifySignalUpdated(`page_dwell:${payload.viewId}`).catch(() => {});
    }

    res.status(204).end();
  } catch (err) {
    console.error('Dwell route error:', err);
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
