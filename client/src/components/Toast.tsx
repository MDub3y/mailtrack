import React, { useEffect, useState } from 'react';

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
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
};

const ToastItem = ({ toast, onRemove }: { toast: ToastMessage; onRemove: (id: number) => void; }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onRemove(toast.id), 300);
    }, 4000);
    return () => clearTimeout(t);
  }, [toast.id, onRemove]);

  return (
    <div
      className={`pointer-events-auto max-w-sm px-4 py-3 rounded-xl border text-xs font-medium shadow-xl transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        } ${toast.type === 'success'
          ? 'bg-[#171717] border-neutral-800 text-white'
          : 'bg-[#ffffff] border-[#eaedf1] text-[#0f172a]'
        }`}
    >
      {toast.text}
    </div>
  );
};