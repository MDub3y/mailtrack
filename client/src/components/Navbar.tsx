import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from './Logo';
import { useAuth } from '../context/AuthContext';

export const Navbar = () => {
    const { user } = useAuth();
    const [isScrolled, setIsScrolled] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    useEffect(() => {
        const handleScroll = () => {
            setIsScrolled(window.scrollY > 40);
        };
        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const navLinks = [
        { label: 'Pricing', href: '#pricing' },
        { label: 'Features', href: '#features' },
        { label: 'Security', href: '#security' },
        { label: 'Docs', href: '#faqs' },
    ];

    return (
        <nav className="max-w-7xl mx-auto w-full">
            {/* Floating Header */}
            <div
                className="fixed inset-x-0 top-0 z-50 mx-auto hidden max-w-[calc(80rem-4rem)] items-center justify-between bg-neutral-900/80 px-4 py-2 backdrop-blur-md transition-all duration-300 md:flex xl:rounded-2xl border border-neutral-800 shadow-[0px_2px_12px_rgba(0,0,0,0.8)]"
                style={{
                    transform: isScrolled ? 'translateY(10px)' : 'translateY(-100px)',
                    opacity: isScrolled ? 1 : 0,
                    pointerEvents: isScrolled ? 'auto' : 'none',
                }}
            >
                <Logo />

                <div className="flex items-center gap-10">
                    {navLinks.map((link) => (
                        <a
                            key={link.label}
                            className="font-medium text-gray-300 transition duration-200 hover:text-white text-sm"
                            href={link.href}
                        >
                            {link.label}
                        </a>
                    ))}
                </div>

                <div className="flex items-center gap-2">
                    <Link
                        className="block rounded-xl px-6 py-2 text-center text-sm font-medium transition duration-150 active:scale-[0.98] sm:text-base bg-white text-black hover:bg-neutral-200"
                        to={user ? '/sent' : '/register'}
                    >
                        {user ? 'Open App' : 'Start tracking'}
                    </Link>
                </div>
            </div>

            {/* Standard Header */}
            <div
                className={`hidden items-center justify-between px-4 py-4 md:flex transition-opacity duration-300 ${isScrolled ? 'opacity-0 pointer-events-none' : 'opacity-100'
                    }`}
            >
                <Logo />

                <div className="flex items-center gap-10">
                    {navLinks.map((link) => (
                        <a
                            key={link.label}
                            className="font-medium text-gray-300 transition duration-200 hover:text-white text-sm"
                            href={link.href}
                        >
                            {link.label}
                        </a>
                    ))}
                </div>

                <div className="flex items-center gap-2">
                    <Link
                        className="block rounded-xl px-6 py-2 text-center text-sm font-medium transition duration-150 active:scale-[0.98] sm:text-base bg-white text-black hover:bg-neutral-200"
                        to={user ? '/sent' : '/register'}
                    >
                        {user ? 'Open App' : 'Start tracking'}
                    </Link>
                </div>
            </div>

            {/* Mobile Header */}
            <div className="relative flex items-center justify-between p-4 md:hidden">
                <Logo />
                <button
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    className="flex size-9 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-gray-300"
                    aria-label="Toggle menu"
                    type="button"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="size-5 shrink-0"
                    >
                        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                        <path d="M4 6l16 0" />
                        <path d="M4 12l16 0" />
                        <path d="M4 18l16 0" />
                    </svg>
                </button>

                {mobileMenuOpen && (
                    <div className="absolute top-full left-0 right-0 z-50 mt-2 flex flex-col gap-4 rounded-2xl bg-neutral-900 p-6 shadow-2xl border border-neutral-800">
                        {navLinks.map((link) => (
                            <a
                                key={link.label}
                                href={link.href}
                                onClick={() => setMobileMenuOpen(false)}
                                className="text-sm font-medium text-gray-300 hover:text-white"
                            >
                                {link.label}
                            </a>
                        ))}
                        <hr className="border-neutral-800 my-1" />
                        <Link
                            to={user ? '/sent' : '/register'}
                            onClick={() => setMobileMenuOpen(false)}
                            className="block rounded-xl px-6 py-2.5 text-center text-sm font-medium bg-white text-black hover:bg-neutral-200"
                        >
                            {user ? 'Open Dashboard' : 'Start tracking'}
                        </Link>
                    </div>
                )}
            </div>
        </nav>
    );
};