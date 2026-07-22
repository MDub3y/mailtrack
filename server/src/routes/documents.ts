import { Router, Response, NextFunction, Request } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { protect, AuthRequest } from '../middleware/auth';
import { DocModel } from '../models/Document';
import { ShareToken } from '../models/ShareToken';

const router = Router();
router.use(protect);

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, _file, cb) => cb(null, `${uuidv4()}.pdf`),
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  },
});

// Wrap multer so errors come back as JSON (not Express HTML error page)
const uploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      res.status(400).json({ message: err.message || 'File upload failed' });
      return;
    }
    next();
  });
};

// POST /api/documents/upload
router.post('/upload', uploadMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ message: 'No file provided' }); return; }
    // Sanitize originalname: strip path separators, limit length
    const originalName = path.basename(req.file.originalname).slice(0, 255) || 'document.pdf';
    const doc = await DocModel.create({
      ownerId:      req.userId,
      originalName,
      storedName:   req.file.filename,
      mimeType:     req.file.mimetype,
      size:         req.file.size,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(500).json({ message: 'Upload error', error: String(err) });
  }
});

// GET /api/documents
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const docs = await DocModel.find({ ownerId: req.userId }).sort({ createdAt: -1 }).lean();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// POST /api/documents/:id/share
router.post('/:id/share', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await DocModel.findOne({ _id: req.params.id, ownerId: req.userId });
    if (!doc) { res.status(404).json({ message: 'Document not found' }); return; }

    const { password, expiresInHours } = req.body as { password?: string; expiresInHours?: number };

    const token        = uuidv4();
    const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;
    const expiresAt    = expiresInHours ? new Date(Date.now() + expiresInHours * 3600_000) : undefined;

    const shareToken = await ShareToken.create({ token, documentId: doc._id, passwordHash, expiresAt });

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.status(201).json({
      token:            shareToken.token,
      shareUrl:         `${clientUrl}/share/${shareToken.token}`,
      requiresPassword: !!passwordHash,
      expiresAt:        shareToken.expiresAt,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/documents/:id/shares
router.get('/:id/shares', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await DocModel.findOne({ _id: req.params.id, ownerId: req.userId });
    if (!doc) { res.status(404).json({ message: 'Document not found' }); return; }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const shares = await ShareToken.find({ documentId: doc._id }).sort({ createdAt: -1 }).lean();
    res.json(shares.map(s => ({
      ...s,
      shareUrl: `${clientUrl}/share/${s.token}`,
    })));
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// DELETE /api/documents/:id/shares/:tokenId
router.delete('/:id/shares/:tokenId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await DocModel.findOne({ _id: req.params.id, ownerId: req.userId });
    if (!doc) { res.status(404).json({ message: 'Document not found' }); return; }
    await ShareToken.deleteOne({ _id: req.params.tokenId, documentId: doc._id });
    res.json({ message: 'Share revoked' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// DELETE /api/documents/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await DocModel.findOne({ _id: req.params.id, ownerId: req.userId });
    if (!doc) { res.status(404).json({ message: 'Document not found' }); return; }

    const filePath = path.join(UPLOADS_DIR, doc.storedName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await ShareToken.deleteMany({ documentId: doc._id });
    await doc.deleteOne();
    res.json({ message: 'Document deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

export default router;
