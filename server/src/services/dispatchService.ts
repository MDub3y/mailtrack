import { User } from '../models/User';
import { Organization } from '../models/Organization';
import { sendViaGmail } from './gmailService';
import { sendViaSendGrid } from './sendgridService';

export interface SenderIdentity {
  mode: 'sendgrid' | 'gmail';
  fromAddress: string;
}

// Enterprise members (an org configured with its own domain-authenticated
// SendGrid account) send through that org — no personal OAuth needed.
// Everyone else falls back to their own connected Gmail account.
export async function resolveSenderIdentity(userId: string): Promise<SenderIdentity | null> {
  const user = await User.findById(userId);
  if (!user) return null;

  if (user.organizationId) {
    const org = await Organization.findById(user.organizationId);
    if (org) return { mode: 'sendgrid', fromAddress: org.fromEmail };
  }

  if (user.gmailAddress) {
    return { mode: 'gmail', fromAddress: user.gmailAddress };
  }

  return null;
}

export interface DispatchParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface DispatchResult {
  providerMessageId?: string;
}

export async function dispatchEmail(senderId: string, params: DispatchParams): Promise<DispatchResult> {
  const user = await User.findById(senderId);
  if (!user) throw new Error('Sender not found');

  if (user.organizationId) {
    const org = await Organization.findById(user.organizationId).select('+sendgridApiKey');
    if (!org) throw new Error('Organization not found');
    return sendViaSendGrid({
      apiKey: org.sendgridApiKey,
      fromEmail: org.fromEmail,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
  }

  return sendViaGmail(senderId, params);
}
