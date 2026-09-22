import { onSignal } from '../../services/signalService';
import { Contact } from '../../models/Contact';
import { Email } from '../../models/Email';
import { Memory } from '../../models/Memory';
import { enqueueBrief, enqueueEngagement, enqueueVoiceProfile } from '../../queues/aiQueue';
import './policy'; // registers the memory_item applier

// The voice profile refreshes itself once enough new sent mail has
// accumulated since the last one (doc/03 Phase 2: "nightly if ≥ 10 new").
// Event-triggered rather than nightly, like the brief (ADR-7).
const VOICE_REFRESH_AFTER_SENDS = Number(process.env.AI_VOICE_REFRESH_AFTER_SENDS || 10);

async function maybeRefreshVoice(ownerId: string): Promise<void> {
  const current = await Memory.findOne({ ownerId, scope: 'sender', kind: 'voice', status: 'active' }).select('createdAt source').lean();
  if (current?.source === 'user') return; // the user wrote it; leave it alone
  const since = current?.createdAt ?? new Date(0);
  const newSends = await Email.countDocuments({ senderId: ownerId, direction: { $ne: 'inbound' }, createdAt: { $gt: since } });
  if (newSends >= VOICE_REFRESH_AFTER_SENDS) await enqueueVoiceProfile(ownerId);
}

// Reactions to signals (doc/02-ai-architecture.md §1.7): engagement is
// recomputed deterministically on every signal; the brief is marked dirty
// and regenerated after a debounce when the change is meaningful.

const MEANINGFUL: ReadonlySet<string> = new Set(['reply', 'doc_view', 'page_dwell', 'sent']);
const QUIET_DAYS_FOR_RENEWED_INTEREST = 3;
const DAY = 86_400_000;

export function installMemoryHooks(): void {
  onSignal(async (signal, isNew) => {
    const contactId = signal.contactId.toString();
    await enqueueEngagement(contactId);
    if (signal.type === 'sent' && isNew) await maybeRefreshVoice(signal.ownerId.toString()).catch(() => {});

    if (signal.integrity.verdict === 'automated') return;

    let meaningful = MEANINGFUL.has(signal.type);
    if (!meaningful && signal.type === 'open' && isNew) {
      // An open after days of silence is worth a refreshed brief; a fourth
      // open in the same hour is not.
      const contact = await Contact.findById(contactId).select('brief lastSignalAt');
      const since = contact?.brief?.generatedAt;
      meaningful = !since || (signal.at.getTime() - since.getTime()) > QUIET_DAYS_FOR_RENEWED_INTEREST * DAY;
    }
    if (!meaningful) return;

    await Contact.updateOne({ _id: contactId, briefDirtyAt: { $exists: false } }, { $set: { briefDirtyAt: new Date() } });
    await enqueueBrief(contactId);
  });
}
