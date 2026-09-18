import { onSignal } from '../../services/signalService';
import { Contact } from '../../models/Contact';
import { enqueueBrief, enqueueEngagement } from '../../queues/aiQueue';
import './policy'; // registers the memory_item applier

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
