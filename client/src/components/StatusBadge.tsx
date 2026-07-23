import type { EmailStatus } from '../types';

const config: Record<EmailStatus, { label: string; bg: string; color: string; dot: string; }> = {
  sent: { label: 'Sent', bg: '#f1f5f9', color: '#64748b', dot: '#94a3b8' },
  delivered: { label: 'Delivered', bg: '#f0fdf4', color: '#16a34a', dot: '#22c55e' },
  opened: { label: 'Opened', bg: '#eff6ff', color: '#2563eb', dot: '#3b82f6' },
  failed: { label: 'Failed', bg: '#fef2f2', color: '#dc2626', dot: '#ef4444' },
};

interface Props {
  status: EmailStatus;
  size?: 'sm' | 'md';
}

export const StatusBadge = ({ status, size = 'md' }: Props) => {
  const { label, bg, color, dot } = config[status] ?? config.sent;
  const sm = size === 'sm';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full font-semibold font-mono tracking-tight"
      style={{
        padding: sm ? '2px 8px' : '4px 10px',
        backgroundColor: bg,
        color: color,
        fontSize: sm ? '10px' : '12px',
      }}
    >
      <span
        className="rounded-full shrink-0"
        style={{
          width: sm ? 5 : 6,
          height: sm ? 5 : 6,
          backgroundColor: dot,
        }}
      />
      {label}
    </span>
  );
};