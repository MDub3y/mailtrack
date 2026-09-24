import mongoose from 'mongoose';
import { User } from '../models/User';
import { Contact } from '../models/Contact';
import { Memory } from '../models/Memory';
import { Signal } from '../models/Signal';

// Organisation-shared memory (doc/01 F9, doc/03 Phase 4 deliverable 5).
// Every member keeps their own contacts, memory and signals; nothing is
// re-owned. A member who opts in can see what colleagues who also opted in
// know about the same address, with each item attributed to the member
// whose email produced it. Reciprocal: you see shared memory only while
// you share yours. Proposed items, rejected items, voice and fingerprint
// memory, and email bodies never cross the line.

export interface ColleagueRef { _id: string; name: string; email: string }

export interface SharedContactView {
  sharing: boolean;                 // the requesting member shares
  organizationId?: string;
  colleagues: Array<{
    member: ColleagueRef;
    contact: { _id: string; address: string; displayName?: string; stats: { sent: number; opened: number; replied: number; docViews: number }; lastSignalAt?: Date };
    brief?: { text: string; generatedAt: Date };
    memory: Array<{ _id: string; kind: string; content: string; confidence: number; source: string; createdAt: Date; expiresAt?: Date; evidence: Array<{ emailId?: string; quote?: string }> }>;
    recentSignals: Array<{ type: string; at: Date; verdict: string }>;
  }>;
}

export async function setSharing(userId: string | mongoose.Types.ObjectId, enabled: boolean): Promise<{ enabled: boolean; organizationId?: string } | null> {
  const user = await User.findById(userId).select('organizationId');
  if (!user?.organizationId) return null;
  await User.updateOne({ _id: userId }, { $set: { shareContactMemory: enabled } });
  return { enabled, organizationId: user.organizationId.toString() };
}

export async function sharingStatus(userId: string | mongoose.Types.ObjectId): Promise<{ inOrganization: boolean; sharing: boolean; members: number; membersSharing: number }> {
  const user = await User.findById(userId).select('organizationId shareContactMemory').lean();
  if (!user?.organizationId) return { inOrganization: false, sharing: false, members: 0, membersSharing: 0 };
  const [members, membersSharing] = await Promise.all([
    User.countDocuments({ organizationId: user.organizationId }),
    User.countDocuments({ organizationId: user.organizationId, shareContactMemory: true }),
  ]);
  return { inOrganization: true, sharing: !!user.shareContactMemory, members, membersSharing };
}

// Colleagues in the same organisation who share, excluding the member.
export async function colleaguesFor(userId: string | mongoose.Types.ObjectId): Promise<{ me: { organizationId?: mongoose.Types.ObjectId; sharing: boolean }; colleagues: ColleagueRef[] }> {
  const me = await User.findById(userId).select('organizationId shareContactMemory').lean();
  if (!me?.organizationId || !me.shareContactMemory) return { me: { organizationId: me?.organizationId, sharing: !!me?.shareContactMemory }, colleagues: [] };
  const rows = await User.find({ organizationId: me.organizationId, shareContactMemory: true, _id: { $ne: me._id } }).select('name email').lean();
  return { me: { organizationId: me.organizationId, sharing: true }, colleagues: rows.map((u) => ({ _id: u._id.toString(), name: u.name, email: u.email })) };
}

export async function sharedContactView(userId: string | mongoose.Types.ObjectId, address: string): Promise<SharedContactView> {
  const { me, colleagues } = await colleaguesFor(userId);
  const view: SharedContactView = { sharing: me.sharing, organizationId: me.organizationId?.toString(), colleagues: [] };
  if (!colleagues.length) return view;
  const addr = address.toLowerCase().trim();
  const contacts = await Contact.find({ ownerId: { $in: colleagues.map((c) => new mongoose.Types.ObjectId(c._id)) }, address: addr }).lean();
  for (const c of contacts) {
    const member = colleagues.find((m) => m._id === c.ownerId.toString())!;
    const [memory, signals] = await Promise.all([
      Memory.find({ ownerId: c.ownerId, subjectId: c._id, status: 'active', kind: { $in: ['commitment', 'preference', 'fact'] } }).sort({ kind: 1, confidence: -1, createdAt: -1 }).limit(40).lean(),
      Signal.find({ ownerId: c.ownerId, contactId: c._id, 'integrity.verdict': { $ne: 'automated' }, type: { $ne: 'page_dwell' } }).sort({ at: -1 }).limit(10).select('type at integrity').lean(),
    ]);
    view.colleagues.push({
      member,
      contact: { _id: c._id.toString(), address: c.address, displayName: c.displayName, stats: c.stats, lastSignalAt: c.lastSignalAt },
      brief: c.brief ? { text: c.brief.text, generatedAt: c.brief.generatedAt } : undefined,
      memory: memory.map((m) => ({ _id: m._id.toString(), kind: m.kind, content: m.content, confidence: m.confidence, source: m.source, createdAt: m.createdAt, expiresAt: m.expiresAt, evidence: m.evidence.map((e) => ({ emailId: e.emailId?.toString(), quote: e.quote ? e.quote.slice(0, 160) : undefined })) })),
      recentSignals: signals.map((s) => ({ type: s.type, at: s.at, verdict: s.integrity.verdict })),
    });
  }
  view.colleagues.sort((a, b) => (b.contact.lastSignalAt?.getTime() ?? 0) - (a.contact.lastSignalAt?.getTime() ?? 0));
  return view;
}

// For the contact list: how many sharing colleagues also know each address.
export async function sharedCounts(userId: string | mongoose.Types.ObjectId, addresses: string[]): Promise<Record<string, number>> {
  const { colleagues } = await colleaguesFor(userId);
  if (!colleagues.length || !addresses.length) return {};
  const rows = await Contact.aggregate<{ _id: string; n: number }>([
    { $match: { ownerId: { $in: colleagues.map((c) => new mongoose.Types.ObjectId(c._id)) }, address: { $in: addresses.map((a) => a.toLowerCase()) } } },
    { $group: { _id: '$address', n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}
