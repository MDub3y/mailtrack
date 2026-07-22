import type { EmailStatus } from '../types';

const config: Record<EmailStatus, { label: string; bg: string; color: string; dot: string }> = {
  sent:      { label: 'Sent',      bg: '#f1f5f9', color: '#64748b', dot: '#94a3b8' },
  delivered: { label: 'Delivered', bg: '#f0fdf4', color: '#16a34a', dot: '#22c55e' },
  opened:    { label: 'Opened',    bg: '#eff6ff', color: '#2563eb', dot: '#3b82f6' },
};

interface Props {
  status: EmailStatus;
  size?: 'sm' | 'md';
}

export const StatusBadge = ({ status, size = 'md' }: Props) => {
  const { label, bg, color, dot } = config[status] ?? config.sent;
  const sm = size === 'sm';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: sm ? 4 : 5,
      padding: sm ? '2px 8px' : '4px 10px',
      borderRadius: 9999,
      background: bg, color,
      fontSize: sm ? '0.7rem' : '0.75rem',
      fontWeight: 600, whiteSpace: 'nowrap',
      letterSpacing: '0.01em',
    }}>
      <span style={{
        width: sm ? 5 : 6, height: sm ? 5 : 6,
        borderRadius: '50%', background: dot, flexShrink: 0,
      }} />
      {label}
    </span>
  );
};
