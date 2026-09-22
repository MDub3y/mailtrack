import mongoose from 'mongoose';
import { z } from 'zod';
import { Email } from '../../models/Email';
import { Memory, IMemory } from '../../models/Memory';
import { ContextBuilder } from '../context/builder';
import { runAgent } from '../runAgent';

// The sender's voice, derived from their own sent mail, stored as one
// sender-scoped `voice` memory item whose prose the user can edit
// (doc/03 Phase 2). It is the stable prefix under every draft, so it must
// render identically across requests: no dates, no ids, no counts.

export const VoiceOutput = z.object({
  greeting: z.string().max(60),
  signoff: z.string().max(80),
  avgSentenceLength: z.enum(['short', 'medium', 'long']),
  formality: z.enum(['casual', 'plain', 'formal']),
  phrases: z.array(z.string().max(60)).max(8),
  avoids: z.array(z.string().max(60)).max(6),
  prose: z.string().min(40).max(700),
});
export type VoiceProfile = z.infer<typeof VoiceOutput>;

const SYSTEM = [
  'You describe how one person writes email, from samples of their own sent mail, so that drafts written for them sound like them.',
  'Observe, do not judge. Note the usual greeting and sign-off, sentence length, formality, characteristic phrases, and things they clearly avoid (exclamation marks, hedging, bullet lists, emoji).',
  'Write `prose` as three to five sentences of plain instruction a ghostwriter could follow, in the second person ("You open with…").',
  'If the samples are too few or too varied to say something with confidence, say so in prose rather than inventing a style.',
].join('\n');

export const MIN_SAMPLES = 3;
const MAX_SAMPLES = 30;
const MAX_CHARS_PER_SAMPLE = 1200;

export async function getVoiceProfile(ownerId: mongoose.Types.ObjectId | string): Promise<IMemory | null> {
  return Memory.findOne({ ownerId, scope: 'sender', kind: 'voice', status: 'active' }).sort({ createdAt: -1 });
}

// The text that goes into the prompt. User edits win: if the user edited the
// prose, that is the profile.
export async function voiceTextFor(ownerId: mongoose.Types.ObjectId | string): Promise<string | null> {
  const v = await getVoiceProfile(ownerId);
  return v?.content ?? null;
}

export async function generateVoiceProfile(ownerId: mongoose.Types.ObjectId | string): Promise<{ runId: string; profile: VoiceProfile; memory: IMemory } | null> {
  const samples = await Email.find({ senderId: ownerId, direction: { $ne: 'inbound' }, textBody: { $exists: true, $ne: '' } })
    .sort({ createdAt: -1 }).limit(MAX_SAMPLES).select('subject textBody').lean();
  if (samples.length < MIN_SAMPLES) return null;

  const sampleText = samples
    .map((e, i) => `--- sample ${i + 1} (subject: ${e.subject})\n${e.textBody.slice(0, MAX_CHARS_PER_SAMPLE)}`)
    .join('\n\n');

  const ctx = new ContextBuilder()
    .add({ name: 'system', budgetTokens: 400, stable: true, text: SYSTEM })
    .add({ name: 'task', budgetTokens: 12_000, stable: false, text: `Samples of the sender's own email, newest first:\n\n${sampleText}` })
    .build();

  const result = await runAgent({
    kind: 'voice_profile',
    ownerId,
    model: 'primary',
    effort: 'medium',
    context: ctx,
    outputSchema: VoiceOutput,
    maxTokens: 4000,
    inputRefs: { note: `voice profile from ${samples.length} samples` },
  });

  // Supersede the previous agent-written profile; never a user-edited one.
  const previous = await getVoiceProfile(ownerId);
  const memory = await Memory.create({
    ownerId,
    scope: 'sender',
    kind: 'voice',
    content: result.output.prose,
    structured: { ...result.output, sampleCount: samples.length },
    evidence: [],
    confidence: Math.min(1, samples.length / 10),
    source: 'agent',
    status: previous?.source === 'user' ? 'proposed' : 'active',
    createdByRunId: new mongoose.Types.ObjectId(result.runId),
    lastConfirmedAt: new Date(),
  });
  if (previous && previous.source !== 'user') {
    previous.status = 'superseded';
    previous.supersededBy = memory._id;
    await previous.save();
  }
  return { runId: result.runId, profile: result.output, memory };
}

// The user rewrote the prose: that becomes the active profile, marked as theirs.
export async function setVoiceProse(ownerId: mongoose.Types.ObjectId | string, prose: string): Promise<IMemory> {
  const previous = await getVoiceProfile(ownerId);
  const memory = await Memory.create({
    ownerId, scope: 'sender', kind: 'voice', content: prose.trim(),
    structured: previous?.structured, evidence: [], confidence: 1, source: 'user', status: 'active', lastConfirmedAt: new Date(),
  });
  if (previous) { previous.status = 'superseded'; previous.supersededBy = memory._id; await previous.save(); }
  return memory;
}
