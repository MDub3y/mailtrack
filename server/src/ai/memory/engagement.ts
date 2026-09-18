import mongoose from 'mongoose';
import { Signal } from '../../models/Signal';
import { Memory, IMemory } from '../../models/Memory';
import { Contact } from '../../models/Contact';

// Deterministic engagement memory: one system-sourced item per contact,
// recomputed from Signals and updated in place. No model involved
// (doc/02-ai-architecture.md §1.3). Rendered as facts, never a score.

export interface EngagementStats {
  sent: number;
  delivered: number;
  humanOpens: number;
  automatedOpens: number;
  replied: number;
  docViews: number;
  lastSentAt?: Date;
  lastOpenAt?: Date;
  lastReplyAt?: Date;
  lastDocViewAt?: Date;
  medianOpenDelayMs?: number;
  // Opens since the last email we sent them, with no reply since.
  opensSinceLastSend: number;
  quietDaysBeforeLastOpen?: number;
  // Page dwell summary from the most recent attributed document view.
  topDwell?: { documentName: string; page: number; seconds: number; totalSeconds: number; at: Date };
}

const DAY = 86_400_000;

export async function computeEngagement(ownerId: mongoose.Types.ObjectId | string, contactId: mongoose.Types.ObjectId | string): Promise<EngagementStats> {
  const signals = await Signal.find({ ownerId, contactId }).sort({ at: 1 }).lean();
  const s: EngagementStats = { sent: 0, delivered: 0, humanOpens: 0, automatedOpens: 0, replied: 0, docViews: 0, opensSinceLastSend: 0 };

  const sentAtByEmail = new Map<string, number>();
  const openDelays: number[] = [];
  const humanOpens: Date[] = [];
  let lastSend: Date | undefined;
  let lastReply: Date | undefined;

  for (const sig of signals) {
    const emailKey = sig.emailId?.toString();
    switch (sig.type) {
      case 'sent':
        s.sent += 1; lastSend = sig.at; s.lastSentAt = sig.at;
        if (emailKey) sentAtByEmail.set(emailKey, sig.at.getTime());
        break;
      case 'delivered':
        s.delivered += 1; break;
      case 'open':
        if (sig.integrity.verdict === 'automated') { s.automatedOpens += 1; break; }
        s.humanOpens += 1; s.lastOpenAt = sig.at; humanOpens.push(sig.at);
        if (emailKey && sentAtByEmail.has(emailKey)) {
          const delay = sig.at.getTime() - sentAtByEmail.get(emailKey)!;
          if (delay >= 0 && openDelays.length < 1000) openDelays.push(delay);
        }
        break;
      case 'reply':
        s.replied += 1; s.lastReplyAt = sig.at; lastReply = sig.at; break;
      case 'doc_view':
        s.docViews += 1; s.lastDocViewAt = sig.at; break;
      case 'page_dwell': {
        const p = (sig.payload ?? {}) as { documentName?: string; topPage?: number; topSeconds?: number; totalSeconds?: number };
        if (p.topPage && p.topSeconds && (!s.topDwell || sig.at >= s.topDwell.at)) {
          s.topDwell = { documentName: p.documentName ?? 'document', page: p.topPage, seconds: p.topSeconds, totalSeconds: p.totalSeconds ?? p.topSeconds, at: sig.at };
        }
        break;
      }
      default: break;
    }
  }

  if (openDelays.length) {
    const sorted = [...openDelays].sort((a, b) => a - b);
    s.medianOpenDelayMs = sorted[Math.floor(sorted.length / 2)];
  }
  if (lastSend) {
    s.opensSinceLastSend = humanOpens.filter((d) => d > lastSend! && (!lastReply || d > lastReply)).length;
  }
  if (humanOpens.length >= 2) {
    const last = humanOpens[humanOpens.length - 1];
    const prev = humanOpens[humanOpens.length - 2];
    const gapDays = Math.floor((last.getTime() - prev.getTime()) / DAY);
    if (gapDays >= 1) s.quietDaysBeforeLastOpen = gapDays;
  }
  return s;
}

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// One or two sentences of facts. Kept plain on purpose.
export function renderEngagement(s: EngagementStats): string {
  if (s.sent === 0) return 'No email sent to this contact yet.';
  const parts: string[] = [];
  parts.push(`${s.sent} email${s.sent === 1 ? '' : 's'} sent`);
  if (s.humanOpens) parts.push(`${s.humanOpens} open${s.humanOpens === 1 ? '' : 's'}${s.lastOpenAt ? ` (last ${fmtDay(s.lastOpenAt)})` : ''}`);
  else parts.push('no opens');
  if (s.replied) parts.push(`${s.replied} repl${s.replied === 1 ? 'y' : 'ies'}`);
  if (s.docViews) parts.push(`${s.docViews} document view${s.docViews === 1 ? '' : 's'}`);
  let text = parts.join(', ') + '.';
  if (s.opensSinceLastSend >= 2) text += ` Opened the latest email ${s.opensSinceLastSend} times with no reply.`;
  if (s.quietDaysBeforeLastOpen && s.quietDaysBeforeLastOpen >= 7) text += ` Opened again after ${s.quietDaysBeforeLastOpen} quiet days.`;
  if (s.topDwell && s.topDwell.seconds >= 30) {
    const mins = Math.round(s.topDwell.totalSeconds / 60);
    text += ` Spent ${mins >= 1 ? `about ${mins} minute${mins === 1 ? '' : 's'}` : `${s.topDwell.totalSeconds} seconds`} in "${s.topDwell.documentName}", longest on page ${s.topDwell.page}.`;
  }
  if (s.automatedOpens) text += ` (${s.automatedOpens} automated scan${s.automatedOpens === 1 ? '' : 's'} filtered.)`;
  return text;
}

export async function recomputeEngagement(ownerId: mongoose.Types.ObjectId | string, contactId: mongoose.Types.ObjectId | string): Promise<IMemory> {
  const stats = await computeEngagement(ownerId, contactId);
  const content = renderEngagement(stats);
  const memory = await Memory.findOneAndUpdate(
    { ownerId, subjectId: contactId, kind: 'engagement', source: 'system' },
    {
      $set: { content, structured: stats as unknown as Record<string, unknown>, status: 'active', confidence: 1, lastConfirmedAt: new Date() },
      $setOnInsert: { ownerId, scope: 'contact', subjectId: contactId, kind: 'engagement', source: 'system', evidence: [], createdAt: new Date() },
    },
    { upsert: true, new: true }
  );
  await Contact.updateOne({ _id: contactId }, { $set: { 'stats.opened': stats.humanOpens, 'stats.replied': stats.replied, 'stats.docViews': stats.docViews, 'stats.sent': stats.sent } });
  return memory!;
}
