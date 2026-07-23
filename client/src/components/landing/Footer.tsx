import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../Logo';

export const Footer = () => {
    const [email, setEmail] = useState('');
    const [subscribed, setSubscribed] = useState(false);

    const handleNewsletterSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (email.trim()) {
            setSubscribed(true);
            setEmail('');
            setTimeout(() => setSubscribed(false), 4000);
        }
    };

    return (
        <footer className="w-full bg-black text-white">
            {/* Horizontal Divider Line */}
            <div className="bg-neutral-800 h-[1px] w-full" />

            {/* Main Outer Container */}
            <div className="max-w-7xl mx-auto border-x border-neutral-800 relative">
                {/* Intersection Corner Squares */}
                <div className="absolute z-20 h-2 w-2 top-[-4px] left-[-4px] bg-neutral-700" />
                <div className="absolute z-20 h-2 w-2 top-[-4px] right-[-4px] bg-neutral-700" />

                {/* ---------------- TOP GRID SECTION ---------------- */}
                <div className="grid grid-cols-1 px-6 py-16 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-8">

                    {/* Brand Column */}
                    <div className="mb-6 sm:col-span-2 md:col-span-4 lg:col-span-3">
                        <Logo />
                        <p className="text-sm font-medium tracking-tight text-gray-400 mt-4 max-w-sm text-left leading-relaxed">
                            Real-time email read receipts, mass dispatch queues, and password-protected PDF document analytics.
                        </p>
                        <Link
                            to="/register"
                            className="inline-block rounded-xl px-6 py-2.5 text-center text-sm font-medium transition duration-150 active:scale-[0.98] sm:text-base bg-white text-black hover:bg-neutral-200 mt-6 shadow-md"
                        >
                            Start tracking
                        </Link>
                    </div>

                    {/* Product Links */}
                    <div className="col-span-1 flex flex-col gap-3">
                        <p className="text-sm font-medium text-white tracking-wide">Product</p>
                        <a className="text-sm text-gray-400 hover:text-white transition-colors duration-200" href="#features">
                            Email Tracking
                        </a>
                        <a className="text-sm text-gray-400 hover:text-white transition-colors duration-200" href="#how-it-works">
                            Mass Dispatch
                        </a>
                        <a className="text-sm text-gray-400 hover:text-white transition-colors duration-200" href="#features">
                            PDF Security
                        </a>
                        <a className="text-sm text-gray-400 hover:text-white transition-colors duration-200" href="#features">
                            Document Viewer
                        </a>
                    </div>

                    {/* Company / Brand Links */}
                    <div className="col-span-1 flex flex-col gap-3">
                        <p className="text-sm font-medium text-white tracking-wide">MXDUB</p>
                        <a
                            className="text-sm text-gray-400 hover:text-white transition-colors duration-200 font-mono text-xs flex items-center gap-1"
                            href="https://mxdub.vercel.app/"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Portfolio ↗
                        </a>
                        <Link className="text-sm text-gray-400 hover:text-white transition-colors duration-200" to="/login">
                            Sign In
                        </Link>
                        <a className="text-sm text-gray-400 hover:text-white transition-colors duration-200" href="#pricing">
                            Pricing
                        </a>
                        <a className="text-sm text-gray-400 hover:text-white transition-colors duration-200" href="#security">
                            Security
                        </a>
                    </div>

                    {/* Legal Links */}
                    <div className="col-span-1 flex flex-col gap-3">
                        <p className="text-sm font-medium text-white tracking-wide">Legal</p>
                        <a className="text-sm text-gray-400 hover:text-white transition-colors duration-200" href="#">
                            Privacy Policy
                        </a>
                        <a className="text-sm text-gray-400 hover:text-white transition-colors duration-200" href="#">
                            Terms of Service
                        </a>
                    </div>

                    {/* Newsletter Column */}
                    <div className="col-span-1 sm:col-span-2 md:col-span-2 lg:col-span-2 flex flex-col items-start">
                        <p className="text-sm font-medium text-white">Newsletter</p>
                        <form onSubmit={handleNewsletterSubmit} className="mt-3 flex w-full items-center rounded-xl border border-neutral-800 bg-neutral-900 p-1.5 focus-within:border-neutral-700">
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Your email address"
                                className="flex-1 bg-transparent px-3 text-sm text-white placeholder-gray-500 outline-none"
                            />
                            <button
                                type="submit"
                                className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-black hover:bg-neutral-200 transition duration-150 cursor-pointer"
                                aria-label="Subscribe"
                            >
                                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path
                                        d="M8.73467 13.15C8.75683 13.2052 8.79536 13.2524 8.84508 13.2851C8.8948 13.3178 8.95334 13.3345 9.01283 13.333C9.07232 13.3314 9.12992 13.3117 9.17791 13.2765C9.22589 13.2413 9.26195 13.1923 9.28126 13.136L13.0729 2.05266C13.0916 2.00098 13.0952 1.94504 13.0832 1.8914C13.0712 1.83776 13.0442 1.78864 13.0054 1.74978C12.9665 1.71092 12.9174 1.68393 12.8638 1.67197C12.8101 1.66001 12.7542 1.66358 12.7025 1.68225L1.61917 5.47391C1.56288 5.49322 1.51384 5.52928 1.47863 5.57726C1.44342 5.62524 1.42374 5.68285 1.42221 5.74234C1.42069 5.80183 1.4374 5.86037 1.47011 5.91009C1.50281 5.95981 1.54994 5.99833 1.60517 6.0205L6.23101 7.8755C6.37724 7.93404 6.5101 8.0216 6.62159 8.13288C6.73307 8.24416 6.82086 8.37687 6.87967 8.523L8.73467 13.15Z"
                                        stroke="currentColor"
                                        strokeWidth="1.16667"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                    <path d="M13.003 1.75122L6.62134 8.1323" stroke="currentColor" strokeWidth="1.16667" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </button>
                        </form>
                        {subscribed ? (
                            <p className="text-xs text-brand mt-3 font-mono">✓ Subscribed to updates!</p>
                        ) : (
                            <p className="text-xs text-gray-400 mt-3 text-left leading-normal">
                                Get product releases and updates across the MXDUB ecosystem.
                            </p>
                        )}
                    </div>

                </div>

                {/* Divider inside container */}
                <div className="bg-neutral-800 h-[1px] w-full" />

                {/* ---------------- BOTTOM CLEAN COPYRIGHT ROW ---------------- */}
                <div className="flex flex-col items-center justify-between px-6 py-6 md:flex-row gap-4">
                    <p className="text-xs text-gray-400 font-mono">
                        © 2026 MailTrack by{' '}
                        <a
                            href="https://mxdub.vercel.app/"
                            target="_blank"
                            rel="noreferrer"
                            className="text-white hover:text-brand transition-colors font-semibold underline underline-offset-4 decoration-neutral-700"
                        >
                            MXDUB
                        </a>
                        . All rights reserved.
                    </p>

                    <a
                        className="text-gray-400 hover:text-white transition-colors duration-200 text-xs font-mono"
                        href="https://mxdub.vercel.app/"
                        target="_blank"
                        rel="noreferrer"
                    >
                        mxdub.vercel.app
                    </a>
                </div>

            </div>
        </footer>
    );
};