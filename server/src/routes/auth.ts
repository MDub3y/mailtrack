import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { protect, AuthRequest } from '../middleware/auth';
import { buildGoogleAuthUrl, connectGmailAccount } from '../services/gmailService';

const router = Router();

const signToken = (userId: string): string =>
  jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '7d' });

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, emailAddress } = req.body as {
      name: string;
      email: string;
      password: string;
      emailAddress: string;
    };

    if (!name || !email || !password || !emailAddress) {
      res.status(400).json({ message: 'All fields are required' });
      return;
    }

    const existing = await User.findOne({ $or: [{ email }, { emailAddress }] });
    if (existing) {
      res.status(409).json({ message: 'Email or emailAddress already in use' });
      return;
    }

    const user = await User.create({ name, email, password, emailAddress });
    const token = signToken(user._id.toString());

    res.status(201).json({
      token,
      user: { _id: user._id, name: user.name, email: user.email, emailAddress: user.emailAddress },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      res.status(400).json({ message: 'Email and password are required' });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !(await user.comparePassword(password))) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    const token = signToken(user._id.toString());
    res.json({
      token,
      user: { _id: user._id, name: user.name, email: user.email, emailAddress: user.emailAddress },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: String(err) });
  }
});

// GET /api/auth/google?token=<platformJWT>
// Kicks off the Gmail OAuth consent flow. Uses a query-param token (rather
// than protect middleware) because this is a plain browser navigation, not
// an XHR call — the platform JWT is round-tripped through Google's `state`
// param so the callback knows which platform user to attach tokens to.
router.get('/google', (req: Request, res: Response): void => {
  const token = req.query.token as string | undefined;
  if (!token) { res.status(400).json({ message: 'Missing token' }); return; }

  try {
    jwt.verify(token, process.env.JWT_SECRET!);
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
    return;
  }

  res.redirect(buildGoogleAuthUrl(token));
});

// GET /api/auth/google/callback?code=...&state=<platformJWT>
router.get('/google/callback', async (req: Request, res: Response): Promise<void> => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

  if (error) {
    res.redirect(`${clientUrl}/sent?gmail=denied`);
    return;
  }
  if (!code || !state) {
    res.redirect(`${clientUrl}/sent?gmail=error`);
    return;
  }

  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET!) as { userId: string };
    await connectGmailAccount(decoded.userId, code);
    res.redirect(`${clientUrl}/sent?gmail=connected`);
  } catch (err) {
    console.error('Gmail connect error:', err);
    res.redirect(`${clientUrl}/sent?gmail=error`);
  }
});

export default router;
