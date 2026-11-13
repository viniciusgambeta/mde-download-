// Download direto de um arquivo por HTTP, com progresso e cancelamento.

const { net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

const EXT_BY_TYPE = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav',
    'audio/x-wav': 'wav', 'audio/webm': 'weba',
};

// Remove o que o Windows não aceita em nome de arquivo.
function safeName(name) {
    return String(name)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/, '')
        .trim()
        .slice(0, 150) || 'arquivo';
}

// Se já existir um arquivo com esse nome, vira "nome (2).ext", "nome (3).ext"...
function uniquePath(dir, filename) {
    const ext = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let candidate = path.join(dir, filename);
    for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
    return candidate;
}

function nameFromDisposition(header) {
    if (!header) return null;
    const star = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
    if (star) {
        try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* ignora */ }
    }
    const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
    return plain ? plain[1].trim() : null;
}

function extFromUrl(url) {
    try {
        const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
        return /^[a-z0-9]{2,5}$/.test(ext) ? ext : null;
    } catch {
        return null;
    }
}

// opts.name: nome desejado (com ou sem extensão). Sem extensão, ela é
// deduzida da resposta. opts.preferServerName usa o nome que o servidor mandar.
async function download(url, opts) {
    const { dir, name, headers, onProgress, signal, preferServerName, fetchImpl } = opts;
    const doFetch = fetchImpl || net.fetch;

    const res = await doFetch(url, { headers, signal });
    if (!res.ok || !res.body) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }

    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const serverName = nameFromDisposition(res.headers.get('content-disposition'));

    let filename = (preferServerName && serverName) || name || serverName || 'arquivo';
    if (!path.extname(filename) || path.extname(filename).length > 6) {
        const ext = (serverName && path.extname(serverName).slice(1)) || EXT_BY_TYPE[type] || extFromUrl(url) || 'bin';
        filename = `${filename}.${ext}`;
    }
    filename = safeName(filename);

    fs.mkdirSync(dir, { recursive: true });
    const dest = uniquePath(dir, filename);
    const tmp = dest + '.part';

    const total = Number(res.headers.get('content-length')) || Number(res.headers.get('estimated-content-length')) || 0;
    let received = 0;
    let lastTick = 0;
    const meter = new Transform({
        transform(chunk, _enc, cb) {
            received += chunk.length;
            const now = Date.now();
            if (onProgress && now - lastTick > 120) {
                lastTick = now;
                onProgress(total ? Math.min(received / total, 1) : null, received);
            }
            cb(null, chunk);
        },
    });

    try {
        await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp), { signal });
        if (received === 0) throw new Error('O servidor devolveu um arquivo vazio.');
        fs.renameSync(tmp, dest);
    } catch (err) {
        fs.rm(tmp, { force: true }, () => {});
        throw err;
    }

    if (onProgress) onProgress(1, received);
    return dest;
}

module.exports = { download, safeName, uniquePath };
