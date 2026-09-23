import mongoose from 'mongoose';
import { InboundMessage, IInboundMessage } from '../../models/InboundMessage';
import { Category } from '../../models/Category';
import { writeLabel } from '../corrections';
import { addExample } from './categories';
import { applyPolicy } from './index';

// A human changing a category is the cheap tier's training signal: it is
// stored as a Label against the classify run (for accuracy and calibration)
// and as an example on the target category (so the centroid moves and the
// LLM prompt carries it). The policy is then re-applied under the new key.

export async function correctCategory(
  ownerId: string | mongoose.Types.ObjectId,
  userId: string | mongoose.Types.ObjectId,
  inboundMessageId: string,
  categoryKey: string
): Promise<IInboundMessage | null> {
  const m = await InboundMessage.findOne({ _id: inboundMessageId, ownerId });
  if (!m) return null;
  const cat = await Category.findOne({ ownerId, key: categoryKey });
  if (!cat) throw new Error(`unknown category "${categoryKey}"`);

  const before = m.classification;
  const changed = before?.categoryKey !== cat.key;
  await writeLabel({
    ownerId: m.ownerId,
    runKind: 'classify',
    runId: before?.runId,
    verdict: before ? (changed ? 'edited' : 'accepted') : 'human',
    before: before ? { categoryKey: before.categoryKey, backend: before.backend, confidence: before.confidence } : undefined,
    after: changed ? { categoryKey: cat.key } : undefined,
    confidence: before?.confidence,
    labeledBy: new mongoose.Types.ObjectId(userId),
  });

  m.classification = {
    categoryKey: cat.key,
    categoryId: cat._id,
    confidence: 1,
    backend: 'human',
    at: new Date(),
    correctedFrom: changed ? before?.categoryKey : before?.correctedFrom,
    correctedBy: new mongoose.Types.ObjectId(userId),
  };
  if (changed) {
    await addExample(ownerId, cat.key, { text: `${m.subject}\n${m.textExcerpt}`.trim(), source: 'correction', inboundMessageId: m._id });
  }
  if (m.triage.status !== 'processed') await applyPolicy(m, cat);
  else await m.save();
  return m;
}
