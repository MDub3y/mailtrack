import React from 'react';

interface Props {
    children: React.ReactNode;
    className?: string;
}

export const SectionContainer: React.FC<Props> = ({ children, className = '' }) => {
    return (
        <div className={`max-w-7xl mx-auto border-divide relative border-x ${className}`}>
            {/* Small square intersection markers */}
            <div
                className="absolute z-10 h-2 w-2 top-0 xl:-top-1 left-0 xl:-left-2 bg-black dark:bg-white"
                style={{ borderRadius: '0%' }}
            />
            <div
                className="absolute z-10 h-2 w-2 top-0 xl:-top-1 right-0 xl:-right-2 bg-black dark:bg-white"
                style={{ borderRadius: '0%' }}
            />
            <div
                className="absolute z-10 h-2 w-2 left-0 xl:-left-2 bottom-0 xl:-bottom-1 bg-black dark:bg-white"
                style={{ borderRadius: '0%' }}
            />
            <div
                className="absolute z-10 h-2 w-2 right-0 xl:-right-2 bottom-0 xl:-bottom-1 bg-black dark:bg-white"
                style={{ borderRadius: '0%' }}
            />
            {children}
        </div>
    );
};