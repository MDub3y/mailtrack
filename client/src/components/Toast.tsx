import { useEffect, useState } from 'react';

export interface ToastMessage {
  id: number;
  text: string;
  type: 'success' | 'info';
}

interface Props {
  toasts: ToastMessage[];
  onRemove: (id: number) => void;
}

export const Toast = ({ toasts, onRemove }: Props) => {
  return (
    <div style={styles.container}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
};

const ToastItem = ({ toast, onRemove }: { toast: ToastMessage; onRemove: (id: number) => void }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Animate in
    requestAnimationFrame(() => setVisible(true));
    // Auto-dismiss after 4s
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onRemove(toast.id), 300);
    }, 4000);
    return () => clearTimeout(t);
  }, [toast.id, onRemove]);

  return (
    <div style={{
      ...styles.toast,
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0)' : 'translateY(16px)',
      background: toast.type === 'success' ? '#1d4ed8' : '#374151',
    }}>
      {toast.text}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed', bottom: 24, right: 24,
    display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9999,
  },
  toast: {
    padding: '12px 20px', borderRadius: 10, color: '#fff',
    fontSize: '0.88rem', fontWeight: 600,
    boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
    transition: 'opacity 0.3s ease, transform 0.3s ease',
    maxWidth: 320, lineHeight: 1.4,
  },
};
