import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { contactsApi } from '../api';
import type { ContactSummary } from '../types';

// Everyone the owner has written to, with what the system remembers about
// them. Memory counts are items other than the engagement line.

function ago(iso?: string): string {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export const Contacts = () => {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    contactsApi.list().then((res) => setContacts(res.data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const visible = contacts.filter((c) => {
    const q = filter.toLowerCase();
    return !q || c.address.includes(q) || (c.displayName ?? '').toLowerCase().includes(q) || c.domain.includes(q);
  });

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-6 border-b border-[#eaedf1] flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-[#0f172a]">Contacts</h1>
          <p className="text-xs text-[#64748b] mt-1">Everyone you have written to, and what MailTrack remembers about them.</p>
        </div>
        <input
          className="w-64 rounded-lg border border-[#eaedf1] bg-[#ffffff] px-3 py-2 text-xs text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:border-[#F17463]"
          placeholder="Filter by name, address, domain"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="p-8 text-xs text-[#64748b]">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="p-8 text-xs text-[#64748b]">No contacts yet. Send a tracked email and the recipient appears here.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-[#64748b] border-b border-[#eaedf1]">
            <tr>
              <th className="px-8 py-2 font-medium">Contact</th>
              <th className="px-3 py-2 font-medium">Brief</th>
              <th className="px-3 py-2 font-medium text-right">Sent</th>
              <th className="px-3 py-2 font-medium text-right">Opens</th>
              <th className="px-3 py-2 font-medium text-right">Docs</th>
              <th className="px-3 py-2 font-medium text-right">Memory</th>
              <th className="px-8 py-2 font-medium text-right">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c._id} className="border-b border-[#eaedf1] hover:bg-[#f8fafc]">
                <td className="px-8 py-3">
                  <Link to={`/contacts/${c._id}`} className="block">
                    <div className="font-medium text-[#0f172a]">{c.displayName ?? c.address}</div>
                    {c.displayName && <div className="text-[#64748b]">{c.address}</div>}
                  </Link>
                </td>
                <td className="px-3 py-3 text-[#475569] max-w-md">
                  <div className="line-clamp-2">{c.briefText ?? <span className="text-[#94a3b8]">No brief yet</span>}</div>
                </td>
                <td className="px-3 py-3 text-right font-mono">{c.stats.sent}</td>
                <td className="px-3 py-3 text-right font-mono">{c.stats.opened}</td>
                <td className="px-3 py-3 text-right font-mono">{c.stats.docViews}</td>
                <td className="px-3 py-3 text-right font-mono">
                  {c.memoryCounts.active}
                  {c.memoryCounts.proposed > 0 && <span className="ml-1 text-[#92400e]">+{c.memoryCounts.proposed} to review</span>}
                </td>
                <td className="px-8 py-3 text-right text-[#64748b]">{ago(c.lastSignalAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
