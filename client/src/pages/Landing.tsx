import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Navbar } from '../components/Navbar';
import { Footer } from '../components/landing/Footer';

/* Container Wrapper with Subtle Borders & Corner Squares */
const Container: React.FC<{ children: React.ReactNode; className?: string; id?: string; }> = ({
    children,
    className = '',
    id,
}) => {
    return (
        <div id={id} className={`max-w-7xl mx-auto border-x border-neutral-800 relative ${className}`}>
            {/* Corner Intersection Squares matching vertical border line tone */}
            <div className="absolute z-20 h-2 w-2 top-[-4px] left-[-4px] bg-white" />
            <div className="absolute z-20 h-2 w-2 top-[-4px] right-[-4px] bg-white" />
            {children}
        </div>
    );
};

const DivideX = () => <div className="bg-neutral-800 h-[1px] w-full" />;

const ShimmerText: React.FC<{ children: React.ReactNode; }> = ({ children }) => {
    return (
        <p className="relative inline-block text-xs md:text-sm font-normal text-brand tracking-wider font-mono uppercase">
            {children}
        </p>
    );
};

export const Landing = () => {
    const TAB_DURATION = 5000; // 5 Seconds auto-switch
    const [activeTab, setActiveTab] = useState(0);
    const [progress, setProgress] = useState(0);
    const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
    const [openFaq, setOpenFaq] = useState<number | null>(null);

    // Auto-cycling timer with smooth progress bar
    useEffect(() => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const currentProgress = Math.min((elapsed / TAB_DURATION) * 100, 100);
            setProgress(currentProgress);

            if (elapsed >= TAB_DURATION) {
                setActiveTab((prev) => (prev + 1) % 3);
                setProgress(0);
            }
        }, 50);

        return () => clearInterval(interval);
    }, [activeTab]);

    const handleTabClick = (idx: number) => {
        setActiveTab(idx);
        setProgress(0);
    };

    const faqs = [
        {
            q: 'What exactly does MailTrack do?',
            a: 'MailTrack provides full-stack email delivery tracking, 4-second instant read receipts, BullMQ mass email queues, and password-protected PDF document sharing with view analytics.',
        },
        {
            q: 'How do read receipts work without pixel blocking?',
            a: 'MailTrack natively handles client-side email detail views. Opening an email fires an authenticated PATCH request that updates the email status to "opened" and notifies the sender in real-time.',
        },
        {
            q: 'Is my document sharing secure?',
            a: 'Yes. Documents are secured with bcrypt password hashes, automated expiration timers, UUID file locks, and short-lived 2-hour scoped view JWTs rendered on html5 canvas.',
        },
        {
            q: 'How does Mass Emailing handle high volumes?',
            a: 'Mass dispatch requests enqueue jobs into Redis & BullMQ background workers, allowing bulk sends to process asynchronously without blocking server HTTP threads.',
        },
        {
            q: 'Can a sender trigger their own read receipt?',
            a: 'No. The open tracking route validates server-side that req.userId === email.recipientId to ensure open receipt integrity.',
        },
    ];

    return (
        <main className="min-h-screen bg-black text-white">
            <Navbar />

            <DivideX />

            {/* ---------------- 1. HERO SECTION ---------------- */}
            <Container className="flex flex-col items-center justify-center px-4 pt-10 pb-10 md:pt-28 md:pb-16 text-center bg-black">
                <ShimmerText>For fast moving engineering teams.</ShimmerText>

                <h1 className="text-center text-3xl font-medium tracking-tight text-white md:text-5xl lg:text-6xl mt-4 leading-tight">
                    Manage and track <br />
                    email &amp; document <span className="text-brand">workflows</span>
                </h1>

                <h2 className="text-center text-sm font-medium tracking-tight text-gray-300 md:text-base mx-auto mt-6 max-w-lg">
                    We empower developers and technical teams to send, track, and manage real-time email read receipts and secure PDF documents visually.
                </h2>

                <div className="mt-6 flex items-center gap-4">
                    <Link
                        to="/register"
                        className="block rounded-xl px-6 py-2.5 text-center text-sm font-medium transition duration-150 active:scale-[0.98] sm:text-base bg-white text-black hover:bg-neutral-200 shadow-md"
                    >
                        Start Tracking
                    </Link>
                    <a
                        href="#pricing"
                        className="block rounded-xl px-6 py-2.5 text-center text-sm font-medium active:scale-[0.98] sm:text-base border border-neutral-800 bg-neutral-950 text-white hover:bg-neutral-800 transition duration-200"
                    >
                        View pricing
                    </a>
                </div>

                {/* Hero Rating / Endorsement Badge */}
                <div className="mt-8 flex items-center gap-2">
                    <div className="flex items-center text-amber-500 gap-0.5">
                        {[...Array(5)].map((_, i) => (
                            <svg key={i} className="w-3.5 h-3.5 fill-current" viewBox="0 0 15 14">
                                <path d="M7.114 2.01454C7.248 1.74216 7.315 1.60596 7.407 1.56245C7.486 1.52459 7.578 1.52459 7.658 1.56245C7.749 1.60596 7.816 1.74215 7.951 2.01454L9.226 4.59868L12.43 5.27093L10.625 8.07718L10.977 11.3297L7.749 10.4802L4.574 8.49037L2.376 6.06699L5.487 4.85389L7.114 2.01454Z" />
                            </svg>
                        ))}
                    </div>
                    <span className="border-l border-neutral-800 pl-3 text-xs text-gray-400">
                        Innovative Email &amp; Document Engine 2026
                    </span>
                </div>
            </Container>

            <DivideX />

            {/* ---------------- 2. HERO MOCKUP ---------------- */}
            <Container className="bg-neutral-950 p-3 md:p-6 lg:p-8">
                <div className="relative w-full rounded-xl border border-neutral-800 bg-black p-4 md:p-6 shadow-2xl overflow-hidden">
                    <div className="flex items-center justify-between border-b border-neutral-800 pb-4 mb-6">
                        <div className="flex items-center gap-2">
                            <span className="size-3 rounded-full bg-red-500 inline-block" />
                            <span className="size-3 rounded-full bg-yellow-500 inline-block" />
                            <span className="size-3 rounded-full bg-green-500 inline-block" />
                            <span className="ml-2 text-xs font-mono text-gray-400">
                                MailTrack Control Center — Live Polling (4s)
                            </span>
                        </div>
                        <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-emerald-950/60 text-emerald-400 border border-neutral-800">
                            ● Connected to Redis Queue
                        </span>
                    </div>

                    <div className="space-y-3 font-sans">
                        <div className="flex items-center justify-between p-4 rounded-lg border border-neutral-800 bg-neutral-900/80">
                            <div>
                                <div className="font-semibold text-sm text-white">Q3_Investor_Deck.pdf</div>
                                <div className="text-xs text-gray-400 mt-0.5">Recipient: partner@vc-firm.com</div>
                            </div>
                            <span className="text-xs font-semibold px-3 py-1 rounded-full bg-blue-950/60 text-blue-300 border border-neutral-800">
                                👁 Opened (2s ago)
                            </span>
                        </div>

                        <div className="flex items-center justify-between p-4 rounded-lg border border-neutral-800 bg-neutral-900/80">
                            <div>
                                <div className="font-semibold text-sm text-white">Mass Announcement Job #9021</div>
                                <div className="text-xs text-gray-400 mt-0.5">BullMQ Redis Worker · 500 recipients</div>
                            </div>
                            <span className="text-xs font-semibold px-3 py-1 rounded-full bg-emerald-950/60 text-emerald-400 border border-neutral-800">
                                ✓ 100% Completed
                            </span>
                        </div>
                    </div>
                </div>
            </Container>

            <DivideX />

            {/* ---------------- 3. LOGO CLOUD ---------------- */}
            <Container className="py-8 text-center bg-black">
                <h2 className="py-4 text-center font-mono text-xs tracking-tight text-gray-400 uppercase">
                    Trusted by Fast Growing Technical Teams
                </h2>
                <div className="border-t border-neutral-800 grid grid-cols-2 md:grid-cols-4">
                    {['MongoDB 7', 'Redis 7', 'BullMQ Queue', 'Express API', 'React 19', 'PDF.js Canvas', 'TypeScript', 'Docker Stack'].map((item, idx) => (
                        <div
                            key={idx}
                            className="border-r border-b border-neutral-800 py-8 px-4 flex items-center justify-center font-mono text-sm font-semibold text-gray-400 hover:text-white transition-colors"
                        >
                            {item}
                        </div>
                    ))}
                </div>
            </Container>

            <DivideX />

            {/* ---------------- 4. HOW IT WORKS ---------------- */}
            <Container id="how-it-works" className="py-16 text-center bg-black">
                <ShimmerText>How it works</ShimmerText>
                <h2 className="text-center text-2xl font-medium tracking-tight md:text-3xl lg:text-4xl text-neutral-100 mt-3">
                    Integrates into your workflow easily
                </h2>
                <p className="text-center text-sm font-medium tracking-tight text-gray-300 md:text-base mx-auto mt-4 max-w-lg">
                    Zero external email pixels or complex WebSockets required. Full stack control from write to read confirmation.
                </p>

                {/* Tab Switcher Grid */}
                <div className="border-t border-neutral-800 mt-12 grid grid-cols-1 lg:grid-cols-2">
                    {/* Left: Auto-cycling Buttons */}
                    <div className="border-r border-neutral-800 border-b lg:border-b-0">
                        {[
                            {
                                title: '1. Instant Email Read Tracking',
                                desc: 'When recipient views the email detail, PATCH /open fires immediately and updates the sender UI within 4 seconds.',
                            },
                            {
                                title: '2. Asynchronous Mass Queueing',
                                desc: 'Bulk emails process asynchronously via Redis & BullMQ workers without blocking HTTP responses or slowing UI.',
                            },
                            {
                                title: '3. Password Protected PDFs',
                                desc: 'Upload PDFs up to 20MB, set bcrypt passwords and link expiration timers, and track viewer analytics.',
                            },
                        ].map((tab, idx) => (
                            <button
                                key={idx}
                                type="button"
                                onClick={() => handleTabClick(idx)}
                                className={`group relative flex w-full flex-col items-start px-8 py-6 text-left transition-colors cursor-pointer overflow-hidden border-b border-neutral-800 last:border-b-0 ${activeTab === idx ? 'bg-neutral-900/80' : 'hover:bg-neutral-950'
                                    }`}
                            >
                                {/* Progress Bar indicating time left */}
                                <div className="absolute inset-x-0 bottom-0 z-30 h-0.5 w-full bg-neutral-800">
                                    <div
                                        className="bg-brand h-full transition-all duration-75 ease-linear"
                                        style={{ width: activeTab === idx ? `${progress}%` : '0%' }}
                                    />
                                </div>

                                <div
                                    className={`flex items-center gap-2 font-medium text-base ${activeTab === idx ? 'text-brand' : 'text-neutral-200'
                                        }`}
                                >
                                    <span className="size-2 rounded-full bg-brand inline-block" />
                                    {tab.title}
                                </div>
                                <p className="mt-2 text-sm text-neutral-300 leading-relaxed">
                                    {tab.desc}
                                </p>
                            </button>
                        ))}
                    </div>

                    {/* Right: Dynamic Output Box */}
                    <div className="p-8 bg-neutral-950 flex items-center justify-center">
                        {activeTab === 0 && (
                            <div className="w-full max-w-md p-6 rounded-xl bg-black border border-neutral-800 shadow-xl text-left font-mono text-xs space-y-3">
                                <div className="text-brand font-semibold">// EmailDetail.tsx mounts</div>
                                <div className="text-gray-300">PATCH /api/emails/:id/open</div>
                                <div className="p-3 bg-neutral-900 rounded border border-neutral-800 text-gray-400">
                                    status: "opened" <br />
                                    event: &#123; type: "opened", timestamp: "Now" &#125;
                                </div>
                                <div className="text-emerald-400">✓ Sender status badge flips to "opened"</div>
                            </div>
                        )}
                        {activeTab === 1 && (
                            <div className="w-full max-w-md p-6 rounded-xl bg-black border border-neutral-800 shadow-xl text-left font-mono text-xs space-y-3">
                                <div className="text-brand font-semibold">// POST /api/emails/send-bulk</div>
                                <div className="text-gray-300">BullMQ Queue Job Enqueued</div>
                                <div className="w-full bg-neutral-800 h-2 rounded-full overflow-hidden">
                                    <div className="bg-brand h-full w-3/4 rounded-full transition-all duration-500" />
                                </div>
                                <div className="text-gray-500">Progress: 75% (375 / 500 queued)</div>
                            </div>
                        )}
                        {activeTab === 2 && (
                            <div className="w-full max-w-md p-6 rounded-xl bg-black border border-neutral-800 shadow-xl text-left font-mono text-xs space-y-3">
                                <div className="text-brand font-semibold">// Share Token JWT (2-Hour Expiry)</div>
                                <div className="text-gray-300">POST /api/share/:token/access</div>
                                <div className="p-3 bg-neutral-900 rounded border border-neutral-800 text-gray-400">
                                    Password: bcrypt.compare() ✓ <br />
                                    ViewToken issued -&gt; Canvas PDF Rendered
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </Container>

            <DivideX />

            {/* ---------------- 5. FEATURES ---------------- */}
            <Container id="features" className="py-16 text-center bg-black">
                <ShimmerText>Features</ShimmerText>
                <h2 className="text-center text-2xl font-medium tracking-tight md:text-3xl lg:text-4xl text-neutral-100 mt-3">
                    Built for Mail &amp; Document Intelligence
                </h2>
                <p className="text-center text-sm font-medium tracking-tight text-gray-300 md:text-base mx-auto mt-4 max-w-lg">
                    Complete end-to-end capabilities designed for modern technical teams.
                </p>

                <div className="border-t border-b border-neutral-800 grid grid-cols-1 md:grid-cols-2 mt-12 text-left">
                    <div className="p-8 bg-black border-b md:border-b-0 md:border-r border-neutral-800">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-brand font-bold text-lg">⚡</span>
                            <h3 className="text-lg font-medium text-white">Real-Time Open Detection</h3>
                        </div>
                        <p className="text-sm text-gray-300 leading-relaxed">
                            Automatic status upgrades without manual polling workarounds or tracking pixel stripping. Sent feeds sync immediately on tab visibility changes.
                        </p>
                    </div>

                    <div className="p-8 bg-black">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-brand font-bold text-lg">🚀</span>
                            <h3 className="text-lg font-medium text-white">Mass Email Queueing</h3>
                        </div>
                        <p className="text-sm text-gray-300 leading-relaxed">
                            Send to hundreds of addresses at once. Redis and BullMQ process sends in background workers with live progress bars and per-address error reports.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12 text-left px-4">
                    <div className="p-6 rounded-xl border border-neutral-800 bg-neutral-900/60">
                        <h3 className="text-base font-medium mb-2">🔒 Password Protection</h3>
                        <p className="text-xs text-gray-400 leading-relaxed">
                            Secure PDF share links with bcrypt cost-factor 12 passwords. Plaintext passwords are never saved.
                        </p>
                    </div>

                    <div className="p-6 rounded-xl border border-neutral-800 bg-neutral-900/60">
                        <h3 className="text-base font-medium mb-2">⏳ Link Expiry &amp; Revocation</h3>
                        <p className="text-xs text-gray-400 leading-relaxed">
                            Set automated expiration timers on document links. Instantly delete access tokens without affecting underlying files.
                        </p>
                    </div>

                    <div className="p-6 rounded-xl border border-neutral-800 bg-neutral-900/60">
                        <h3 className="text-base font-medium mb-2">📄 Canvas PDF Viewer</h3>
                        <p className="text-xs text-gray-400 leading-relaxed">
                            Built-in pdf.js canvas viewer with page navigation, zoom controls, and no direct file exposures.
                        </p>
                    </div>
                </div>
            </Container>

            <DivideX />

            {/* ---------------- 6. PRICING ---------------- */}
            <Container id="pricing" className="py-16 text-center bg-black">
                <ShimmerText>Pricing</ShimmerText>
                <h2 className="text-center text-2xl font-medium tracking-tight md:text-3xl lg:text-4xl text-neutral-100 mt-3">
                    Simple and Feasible Pricing
                </h2>

                <div className="relative mt-8 inline-flex items-center gap-2 rounded-xl bg-neutral-900 p-1.5 border border-neutral-800">
                    <button
                        type="button"
                        onClick={() => setBillingCycle('monthly')}
                        className={`px-5 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${billingCycle === 'monthly' ? 'bg-neutral-950 text-white shadow-sm' : 'text-gray-400'
                            }`}
                    >
                        Monthly
                    </button>
                    <button
                        type="button"
                        onClick={() => setBillingCycle('yearly')}
                        className={`px-5 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${billingCycle === 'yearly' ? 'bg-neutral-950 text-white shadow-sm' : 'text-gray-400'
                            }`}
                    >
                        Yearly <span className="ml-1.5 bg-brand/10 text-brand rounded-full px-2 py-0.5 text-xs font-semibold">Save 20%</span>
                    </button>
                </div>

                <div className="border-t border-b border-neutral-800 mt-12 grid grid-cols-1 md:grid-cols-3">
                    <div className="p-8 text-left flex flex-col justify-between bg-black border-b md:border-b-0 md:border-r border-neutral-800">
                        <div>
                            <h3 className="text-xl font-medium text-neutral-100">Growth</h3>
                            <p className="text-sm text-neutral-400 mt-1">Early stage developers</p>
                            <div className="mt-6 text-3xl font-medium text-white">
                                ${billingCycle === 'monthly' ? '19' : '15'}
                                <span className="text-sm font-normal text-gray-500 ml-1">/seat</span>
                            </div>
                            <ul className="mt-6 space-y-3 text-sm text-neutral-300">
                                <li>✓ Up to 1,000 tracked emails</li>
                                <li>✓ Real-time 4s open receipts</li>
                                <li>✓ PDF document sharing</li>
                                <li>✓ Single workspace</li>
                            </ul>
                        </div>
                        <Link
                            to="/register"
                            className="block rounded-xl px-6 py-2.5 text-center text-sm font-medium border border-neutral-800 bg-neutral-950 text-white hover:bg-neutral-800 transition duration-200 mt-8 w-full"
                        >
                            Start Tracking
                        </Link>
                    </div>

                    <div className="p-8 text-left flex flex-col justify-between bg-neutral-900/60 border-b md:border-b-0 md:border-r border-neutral-800">
                        <div>
                            <span className="bg-brand/10 text-brand rounded-full px-2.5 py-1 text-xs font-medium uppercase">
                                Most Popular
                            </span>
                            <h3 className="text-xl font-medium text-neutral-100 mt-2">Scale</h3>
                            <p className="text-sm text-neutral-400 mt-1">Fast moving teams</p>
                            <div className="mt-6 text-3xl font-medium text-white">
                                ${billingCycle === 'monthly' ? '49' : '39'}
                                <span className="text-sm font-normal text-gray-500 ml-1">/seat</span>
                            </div>
                            <ul className="mt-6 space-y-3 text-sm text-neutral-300">
                                <li>✓ Unlimited tracked emails</li>
                                <li>✓ Redis + BullMQ Mass Emailing</li>
                                <li>✓ Password &amp; expiry PDF shares</li>
                                <li>✓ Priority worker queue</li>
                            </ul>
                        </div>
                        <Link
                            to="/register"
                            className="block rounded-xl px-6 py-2.5 text-center text-sm font-medium bg-brand text-white hover:bg-brand-hover transition duration-150 mt-8 w-full shadow-md"
                        >
                            Start for free
                        </Link>
                    </div>

                    <div className="p-8 text-left flex flex-col justify-between bg-black">
                        <div>
                            <h3 className="text-xl font-medium text-neutral-100">Enterprise</h3>
                            <p className="text-sm text-neutral-400 mt-1">Large operations</p>
                            <div className="mt-6 text-3xl font-medium text-white">Custom</div>
                            <ul className="mt-6 space-y-3 text-sm text-neutral-300">
                                <li>✓ Dedicated Redis queue clusters</li>
                                <li>✓ Custom MX Record integration</li>
                                <li>✓ Dedicated SLA &amp; support</li>
                                <li>✓ On-prem docker deployment</li>
                            </ul>
                        </div>
                        <a
                            href="mailto:sales@mailtrack.corp"
                            className="block rounded-xl px-6 py-2.5 text-center text-sm font-medium border border-neutral-800 bg-neutral-950 text-white hover:bg-neutral-800 transition duration-200 mt-8 w-full"
                        >
                            Contact sales
                        </a>
                    </div>
                </div>
            </Container>

            <DivideX />

            {/* ---------------- 7. SECURITY ---------------- */}
            <Container id="security" className="bg-neutral-900 py-12 px-8">
                <h2 className="text-center font-mono text-xs tracking-tight text-neutral-400 uppercase mb-8">
                    FOR SECURITY FIRST TEAMS
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                    <div className="text-left">
                        <h2 className="text-2xl font-medium tracking-tight md:text-3xl text-neutral-100">
                            Scale securely with confidence
                        </h2>
                        <p className="text-sm font-medium text-gray-300 mt-4 leading-relaxed">
                            MailTrack protects all document and email paths. Passwords use bcrypt hashing (cost 12), PDF view tokens use short-lived 2-hour JWTs, and search inputs are ReDoS-escaped server-side.
                        </p>
                        <Link
                            to="/register"
                            className="rounded-xl px-6 py-2.5 text-sm font-medium bg-white text-black hover:bg-neutral-200 mt-6 inline-block"
                        >
                            Start for free
                        </Link>
                    </div>
                    <div className="flex items-center justify-center gap-6 font-mono text-xs text-gray-400">
                        <div className="p-4 bg-black rounded-xl border border-neutral-800 text-center shadow-sm">
                            🔒 <br /> bcrypt (Cost 12)
                        </div>
                        <div className="p-4 bg-black rounded-xl border border-neutral-800 text-center shadow-sm">
                            🔑 <br /> JWT (2h Scope)
                        </div>
                        <div className="p-4 bg-black rounded-xl border border-neutral-800 text-center shadow-sm">
                            🛡 <br /> ReDoS Escaped
                        </div>
                    </div>
                </div>
            </Container>

            <DivideX />

            {/* ---------------- 8. FAQS ---------------- */}
            <Container id="faqs" className="py-16 text-center bg-black">
                <ShimmerText>FAQs</ShimmerText>
                <h2 className="text-2xl font-medium tracking-tight md:text-3xl lg:text-4xl text-neutral-100 mt-3">
                    Frequently Asked Questions
                </h2>
                <p className="text-sm text-gray-300 mt-2 max-w-lg mx-auto">
                    Find answers to common questions about email tracking and document security.
                </p>

                <div className="mt-8 max-w-3xl mx-auto text-left border-t border-neutral-800">
                    {faqs.map((faq, idx) => (
                        <div key={idx} className="group border-b border-neutral-800">
                            <button
                                type="button"
                                onClick={() => setOpenFaq(openFaq === idx ? null : idx)}
                                className="flex w-full items-center justify-between gap-4 py-5 text-left cursor-pointer"
                            >
                                <span className="text-neutral-100 text-base font-medium">
                                    {faq.q}
                                </span>
                                <span className="shadow-aceternity inline-flex size-6 items-center justify-center rounded-md bg-neutral-950 border border-neutral-800">
                                    <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 16 16"
                                        fill="none"
                                        className={`transition-transform duration-200 text-neutral-100 ${openFaq === idx ? 'rotate-180' : ''}`}
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
                            {openFaq === idx && (
                                <div className="pb-5 text-sm text-gray-300 leading-relaxed">
                                    {faq.a}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </Container>

            <DivideX />

            {/* ---------------- 9. CTA ORBIT SECTION ---------------- */}
            <Container className="py-20 text-center relative overflow-hidden flex flex-col items-center justify-center min-h-[22rem] bg-black">
                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 mx-auto pointer-events-none opacity-40">
                    <div className="w-[500px] h-[500px] rounded-full border border-neutral-800 animate-orbit mx-auto" />
                </div>

                <h2 className="text-2xl font-medium tracking-tight md:text-4xl lg:text-5xl text-neutral-100 relative z-10 max-w-2xl leading-tight">
                    Connect your Stack &amp; Start Tracking Today
                </h2>

                <Link
                    to="/register"
                    className="relative z-20 mt-6 rounded-xl px-8 py-3 text-base font-medium bg-white text-black hover:bg-neutral-200 shadow-lg"
                >
                    Start Tracking for Free
                </Link>
            </Container>

            <DivideX />

            {/* Footer */}
            <Footer />
        </main>
    );
};