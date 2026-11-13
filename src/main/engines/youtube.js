// Extras do YouTube que não precisam do yt-dlp: prévia (título) e thumbnail.

const { net } = require('electron');
const direct = require('./direct');

// Título e canal pelo oEmbed oficial: uma chamada leve, sem chave de API.
async function preview(url, id) {
    const out = { thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, title: null, author: null };
    try {
        const res = await net.fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
        if (res.ok) {
            const data = await res.json();
            out.title = data.title || null;
            out.author = data.author_name || null;
        }
    } catch { /* sem prévia, segue o jogo */ }
    return out;
}

// Tenta da maior pra menor: nem todo vídeo tem a versão em 1280x720.
async function thumbnail({ url, id, dir }, ctx) {
    const info = await preview(url, id);
    if (info.title) ctx.meta({ title: info.title });
    const name = info.title ? `${info.title} [${id}] thumbnail` : `youtube_${id}_thumbnail`;

    for (const size of ['maxresdefault', 'sddefault', 'hqdefault']) {
        try {
            const file = await direct.download(`https://i.ytimg.com/vi/${id}/${size}.jpg`, {
                dir,
                name: `${name}.jpg`,
                signal: ctx.signal,
                onProgress: (fraction) => ctx.progress(fraction, ''),
            });
            return { files: [file], title: info.title };
        } catch (err) {
            if (ctx.signal.aborted) throw err;
        }
    }
    throw new Error('Não encontrei a thumbnail desse vídeo.');
}

module.exports = { preview, thumbnail };
