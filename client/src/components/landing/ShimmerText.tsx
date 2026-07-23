import React from 'react';

export const ShimmerText: React.FC<{ children: React.ReactNode; }> = ({ children }) => {
    return (
        <p
            className="relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))] text-sm font-normal [--base-color:var(--color-brand)] [--base-gradient-color:var(--color-brand-light)]"
            style={{
                backgroundImage: 'var(--bg), linear-gradient(var(--base-color), var(--base-color))',
                backgroundPosition: '0% center',
            }}
        >
            {children}
        </p>
    );
};