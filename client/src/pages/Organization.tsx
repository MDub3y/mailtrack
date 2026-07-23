import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { organizationsApi } from '../api';
import { useAuth } from '../context/AuthContext';

interface CreateFormData {
  name: string;
  domain: string;
  sendgridApiKey: string;
  fromEmail: string;
}

export const Organization = () => {
  const { user, refreshUser } = useAuth();
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<CreateFormData>();
  const [joinId, setJoinId] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  const org = user?.organizationId;

  const onCreate = async (data: CreateFormData) => {
    setError('');
    try {
      await organizationsApi.create(data);
      await refreshUser();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string; }; }; })?.response?.data?.message ??
        'Failed to create organization.';
      setError(msg);
    }
  };

  const onJoin = async () => {
    setError('');
    setJoining(true);
    try {
      await organizationsApi.join(joinId.trim());
      await refreshUser();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string; }; }; })?.response?.data?.message ??
        'Failed to join organization.';
      setError(msg);
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-[#ffffff]">
      <div className="px-8 py-5 border-b border-[#eaedf1]">
        <h1 className="text-lg font-semibold text-[#0f172a] tracking-tight">Enterprise</h1>
        <p className="text-xs text-[#64748b] mt-0.5">
          Onboard your company's own SendGrid account so every member sends tracked email as your domain — no personal Gmail connection needed.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-8 max-w-lg">
        {org ? (
          <div className="p-5 rounded-2xl border border-emerald-100 bg-emerald-50 space-y-2">
            <div className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-700">Connected</div>
            <div className="text-sm font-semibold text-[#0f172a]">{org.name}</div>
            <div className="text-xs text-[#64748b]">Domain: <span className="font-mono">{org.domain}</span></div>
            <div className="text-xs text-[#64748b]">Sending as: <span className="font-mono">{org.fromEmail}</span></div>
            <div className="text-xs text-[#64748b] pt-1">
              Org ID (share with teammates to join): <span className="font-mono">{org._id}</span>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            <form onSubmit={handleSubmit(onCreate)} className="space-y-3 p-5 rounded-2xl border border-[#eaedf1]">
              <div className="text-xs font-mono font-bold uppercase tracking-wider text-[#94a3b8]">
                Onboard your company
              </div>
              <div>
                <label className="text-[11px] font-semibold text-[#64748b] uppercase tracking-wider block mb-1">Company name</label>
                <input
                  {...register('name', { required: true })}
                  className="w-full px-3 py-2 rounded-lg border border-[#eaedf1] text-xs text-[#0f172a] outline-none focus:border-[#0f172a]"
                  placeholder="Acme Inc"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-[#64748b] uppercase tracking-wider block mb-1">Domain</label>
                <input
                  {...register('domain', { required: true })}
                  className="w-full px-3 py-2 rounded-lg border border-[#eaedf1] text-xs text-[#0f172a] outline-none focus:border-[#0f172a]"
                  placeholder="acme.com"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-[#64748b] uppercase tracking-wider block mb-1">SendGrid API key</label>
                <input
                  {...register('sendgridApiKey', { required: true })}
                  type="password"
                  className="w-full px-3 py-2 rounded-lg border border-[#eaedf1] text-xs text-[#0f172a] outline-none focus:border-[#0f172a] font-mono"
                  placeholder="SG.xxxxxxxx"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-[#64748b] uppercase tracking-wider block mb-1">
                  From address (must be domain-authenticated in SendGrid)
                </label>
                <input
                  {...register('fromEmail', { required: true })}
                  className="w-full px-3 py-2 rounded-lg border border-[#eaedf1] text-xs text-[#0f172a] outline-none focus:border-[#0f172a]"
                  placeholder="notifications@acme.com"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 rounded-xl bg-[#171717] hover:bg-[#000000] text-white text-xs font-semibold cursor-pointer"
              >
                {isSubmitting ? 'Creating…' : 'Create Organization'}
              </button>
            </form>

            <div className="space-y-3 p-5 rounded-2xl border border-[#eaedf1]">
              <div className="text-xs font-mono font-bold uppercase tracking-wider text-[#94a3b8]">
                Already onboarded? Join it
              </div>
              <input
                value={joinId}
                onChange={(e) => setJoinId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[#eaedf1] text-xs text-[#0f172a] outline-none focus:border-[#0f172a] font-mono"
                placeholder="Organization ID"
              />
              <button
                onClick={onJoin}
                disabled={joining || !joinId.trim()}
                className="px-4 py-2 rounded-xl border border-[#eaedf1] bg-[#ffffff] hover:bg-[#f8fafc] text-xs font-semibold text-[#0f172a] cursor-pointer"
              >
                {joining ? 'Joining…' : 'Join Organization'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-600">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
