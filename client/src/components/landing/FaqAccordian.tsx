import { useState } from 'react';

interface FAQItem {
    question: string;
    answer: string;
}

const faqs: FAQItem[] = [
    {
        question: 'What exactly does MailTrack do?',
        answer:
            'MailTrack is a full-stack internal email and document tracking platform. It closes the loop by providing instant read receipts within 4 seconds, queue-based mass emailing with BullMQ + Redis, and password-protected PDF sharing with viewer analytics.',
    },
    {
        question: 'How do 4-second open receipts work without external tracking pixels?',
        answer:
            'Because MailTrack manages sender, receiver, and storage endpoints natively, opening an email immediately triggers req.userId verification and PATCH /open. The sender UI silently polls every 4 seconds and updates the status badge automatically.',
    },
    {
        question: 'How does Mass Emailing handle large lists?',
        answer:
            'Mass emailing utilizes Redis and BullMQ worker queues in the background. Large multi-recipient sends process asynchronously without blocking the HTTP server thread or delaying UI responses.',
    },
    {
        question: 'Is document sharing secure for external non-account holders?',
        answer:
            'Yes. Share URLs are publicly accessible. If password protection is enabled, the server validates bcrypt-hashed passwords before issuing a short-lived (2-hour expiry) JWT view token.',
    },
];

export const FaqAccordion = () => {
    const [openIndex, setOpenIndex] = useState<number | null>(null);

    return (
        <div className="divide-divide w-full divide-y">
            {faqs.map((faq, idx) => {
                const isOpen = openIndex === idx;
                return (
                    <div key={idx} className="group">
                        <button
                            type="button"
                            onClick={() => setOpenIndex(isOpen ? null : idx)}
                            className="flex w-full items-center justify-between gap-4 px-8 py-6 text-left cursor-pointer"
                        >
                            <span className="text-charcoal-700 text-base font-medium dark:text-neutral-100">
                                {faq.question}
                            </span>
                            <span className="text-charcoal-700 shadow-aceternity inline-flex size-6 items-center justify-center rounded-md bg-white dark:bg-neutral-950">
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                    className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                                >
                                    <path
                                        d="M3.75 6.5L8 10.75L12.25 6.5"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            </span>
                        </button>
                        {isOpen && (
                            <div className="px-8 pb-6 text-sm text-gray-600 dark:text-neutral-300 leading-relaxed">
                                {faq.answer}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};