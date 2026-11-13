// Recebe um texto colado e descobre: de qual rede é, que tipo de conteúdo é
// e quais ações fazem sentido. Tudo por padrão de URL, sem acessar a rede,
// pra resposta aparecer instantaneamente.

const A = {
    video: { id: 'video', label: 'Vídeo' },
    audio: { id: 'audio', label: 'Áudio' },
    thumb: { id: 'thumb', label: 'Thumbnail' },
    transcript: { id: 'transcript', label: 'Transcrição' },
    media: { id: 'media', label: 'Baixar' },
    story: { id: 'story', label: 'Este story', needs: 'instagram' },
    stories: { id: 'stories', label: 'Stories', needs: 'instagram' },
    allStories: { id: 'stories', label: 'Todos os stories', needs: 'instagram' },
    highlight: { id: 'highlight', label: 'Baixar destaque', needs: 'instagram' },
    avatar: { id: 'avatar', label: 'Foto de perfil', needs: 'instagram' },
    playlist: { id: 'playlist', label: 'Playlist inteira' },
    playlistAudio: { id: 'playlist-audio', label: 'Só áudio' },
};

// Páginas do Instagram que não são nomes de usuário.
const IG_RESERVED = new Set([
    'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'share',
    'about', 'developer', 'legal', 'web', 'api', 'challenge', 'emails', 'graphql',
    'oauth', 'privacy', 'press', 'session', 'your_activity', 'ads', 'help',
]);

// Sites que o Cobalt entende (além de Instagram, TikTok e X, tratados à parte).
const COBALT_SITES = [
    ['facebook', 'Facebook', /(^|\.)(facebook\.com|fb\.watch)$/],
    ['reddit', 'Reddit', /(^|\.)(reddit\.com|redd\.it)$/],
    ['pinterest', 'Pinterest', /(^|\.)(pinterest\.[a-z.]+|pin\.it)$/],
    ['vimeo', 'Vimeo', /(^|\.)vimeo\.com$/],
    ['twitch', 'Twitch', /(^|\.)twitch\.tv$/],
    ['soundcloud', 'SoundCloud', /(^|\.)soundcloud\.com$/],
    ['bluesky', 'Bluesky', /(^|\.)bsky\.app$/],
    ['snapchat', 'Snapchat', /(^|\.)snapchat\.com$/],
    ['dailymotion', 'Dailymotion', /(^|\.)(dailymotion\.com|dai\.ly)$/],
    ['loom', 'Loom', /(^|\.)loom\.com$/],
    ['streamable', 'Streamable', /(^|\.)streamable\.com$/],
    ['tumblr', 'Tumblr', /(^|\.)tumblr\.com$/],
    ['bilibili', 'Bilibili', /(^|\.)(bilibili\.com|b23\.tv)$/],
];

function extractUrl(text) {
    if (!text) return null;
    const trimmed = String(text).trim();
    const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
    let raw = match ? match[0] : null;
    // Link colado sem "https://" (ex.: instagram.com/p/abc)
    if (!raw && /^[\w-]+(\.[\w-]+)+\/\S*$/.test(trimmed)) raw = 'https://' + trimmed;
    if (!raw) return null;
    try {
        return new URL(raw.replace(/[),.;!?]+$/, ''));
    } catch {
        return null;
    }
}

const result = (url, platform, site, kind, kindLabel, actions, extra = {}) => ({
    ok: true,
    url: url.toString(),
    platform,
    site,
    kind,
    kindLabel,
    // A primeira ação é a principal (a que o Enter dispara).
    actions: actions.map((a, i) => ({ ...a, primary: i === 0 })),
    ...extra,
});

function youtube(url, host) {
    const parts = url.pathname.split('/').filter(Boolean);
    const music = host.startsWith('music.');
    let id = null;
    let kind = 'video';

    if (host === 'youtu.be') id = parts[0];
    else if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (parts[0] === 'shorts') { id = parts[1]; kind = 'short'; }
    else if (['live', 'embed', 'v'].includes(parts[0])) id = parts[1];

    if (id && /^[\w-]{11}$/.test(id)) {
        const actions = music ? [A.audio, A.video, A.thumb] : [A.video, A.audio, A.thumb, A.transcript];
        return result(url, 'youtube', music ? 'YouTube Music' : 'YouTube',
            kind, kind === 'short' ? 'Short' : (music ? 'Música' : 'Vídeo'), actions,
            { id, quality: true });
    }

    if (parts[0] === 'playlist' && url.searchParams.get('list')) {
        return result(url, 'youtube', 'YouTube', 'playlist', 'Playlist',
            [A.playlist, A.playlistAudio], { id: url.searchParams.get('list'), quality: true });
    }

    return { ok: false, reason: 'Cole o link de um vídeo, short ou playlist.' };
}

function instagram(url) {
    let parts = url.pathname.split('/').filter(Boolean);
    const clean = (u) => u.replace(/^@/, '').toLowerCase();

    if (parts[0] === 'share') {
        return result(url, 'instagram', 'Instagram', 'share', 'Link', [A.media], { id: parts[parts.length - 1] });
    }

    if (parts[0] === 'stories') {
        if (parts[1] === 'highlights' && parts[2]) {
            return result(url, 'instagram', 'Instagram', 'highlight', 'Destaque', [A.highlight], { id: parts[2] });
        }
        if (parts[1] && parts[2]) {
            return result(url, 'instagram', 'Instagram', 'story', 'Story', [A.story, A.allStories],
                { username: clean(parts[1]), id: parts[2] });
        }
        if (parts[1]) {
            return result(url, 'instagram', 'Instagram', 'stories', 'Stories', [A.stories],
                { username: clean(parts[1]) });
        }
    }

    // Formato instagram.com/usuario/reel/ID
    if (parts.length >= 3 && ['p', 'reel', 'reels', 'tv'].includes(parts[1])) parts = parts.slice(1);

    if (['reel', 'reels', 'tv'].includes(parts[0]) && parts[1]) {
        return result(url, 'instagram', 'Instagram', 'reel', 'Reel', [A.video, A.audio, A.transcript], { id: parts[1] });
    }
    if (parts[0] === 'p' && parts[1]) {
        return result(url, 'instagram', 'Instagram', 'post', 'Post', [A.media], { id: parts[1] });
    }
    if (parts.length === 1 && !IG_RESERVED.has(parts[0].toLowerCase()) && /^@?[\w.]{1,30}$/.test(parts[0])) {
        return result(url, 'instagram', 'Instagram', 'profile', 'Perfil', [A.avatar, A.stories],
            { username: clean(parts[0]) });
    }

    return { ok: false, reason: 'Cole o link de um post, reel, story ou perfil.' };
}

function tiktok(url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'video' || p === 'photo');
    if (idx >= 0 && parts[idx + 1]) {
        const photo = parts[idx] === 'photo';
        return result(url, 'tiktok', 'TikTok', photo ? 'photo' : 'video', photo ? 'Fotos' : 'Vídeo',
            photo ? [A.media, A.audio] : [A.video, A.audio, A.transcript], { id: parts[idx + 1].replace(/\D.*$/, '') });
    }
    // Link curto (vm.tiktok.com/xxx, tiktok.com/t/xxx): só dá pra saber o tipo ao baixar.
    if (parts.length >= 1 && !parts[0].startsWith('@')) {
        return result(url, 'tiktok', 'TikTok', 'video', 'Vídeo', [A.media, A.audio, A.transcript],
            { id: parts[parts.length - 1], shortLink: true });
    }
    return { ok: false, reason: 'Cole o link de um vídeo do TikTok.' };
}

function twitter(url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('status');
    if (idx >= 0 && /^\d+$/.test(parts[idx + 1] || '')) {
        return result(url, 'x', 'X', 'post', 'Post', [A.media, A.audio], { id: parts[idx + 1] });
    }
    return { ok: false, reason: 'Cole o link de um post do X.' };
}

function detect(text) {
    const url = extractUrl(text);
    if (!url) return { ok: false, reason: null };

    const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');

    if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host) || host === 'youtu.be') return youtube(url, host);
    if (/(^|\.)(instagram\.com|instagr\.am)$/.test(host)) return instagram(url);
    if (/(^|\.)tiktok\.com$/.test(host)) return tiktok(url);
    if (/^(twitter\.com|x\.com|vxtwitter\.com|fixvx\.com|fxtwitter\.com)$/.test(host)) return twitter(url);

    for (const [platform, site, re] of COBALT_SITES) {
        if (re.test(host)) {
            const actions = platform === 'soundcloud' ? [A.audio] : [A.media, A.audio];
            return result(url, platform, site, 'media', 'Link', actions, { cobalt: true });
        }
    }

    // Qualquer outro site: o yt-dlp conhece mais de mil.
    return result(url, 'generic', host, 'media', 'Link', [A.video, A.audio], { quality: true });
}

module.exports = { detect, extractUrl };
