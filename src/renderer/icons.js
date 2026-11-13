// Ícones desenhados em SVG (traço simples, 24x24) e os selos de cada rede.

const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;

window.ICONS = {
    link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    download: svg('<path d="M12 4v11M7 11l5 5 5-5M6 20h12"/>'),
    folder: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    sliders: svg('<path d="M4 7h9M19 7h1M4 17h3M13 17h7"/><circle cx="16" cy="7" r="2.5"/><circle cx="10" cy="17" r="2.5"/>'),
    retry: svg('<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4.5V9h4.5"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.2v.3"/>'),
    enter: svg('<path d="M19 6v6a3 3 0 0 1-3 3H6M9.5 11.5L6 15l3.5 3.5"/>'),
};

// Selos das redes: glifo branco sobre a cor da marca.
window.BADGES = {
    youtube: svg('<path d="M10 8.6v6.8l5.8-3.4z" fill="currentColor" stroke="none"/>'),
    // Versão em contorno, usada na fileira discreta de redes suportadas.
    youtubeLine: svg('<rect x="3" y="6" width="18" height="12" rx="4"/><path d="M10.6 9.9v4.2l3.6-2.1z" fill="currentColor" stroke="none"/>'),
    instagram: svg('<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="16.6" cy="7.4" r=".6" fill="currentColor"/>'),
    tiktok: svg('<path d="M13.5 4v10.2a3.3 3.3 0 1 1-3.3-3.3"/><path d="M13.5 4c.3 2.5 2 4.2 4.5 4.5"/>'),
    x: svg('<path d="M5.5 5l13 14M18.5 5l-13 14"/>'),
    generic: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.8 3 2.8 14 0 17M12 3.5c-2.8 3-2.8 14 0 17"/>'),
};
