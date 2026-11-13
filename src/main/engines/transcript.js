// Transcrição a partir da legenda que a própria plataforma já tem pronta
// (YouTube e TikTok). É instantâneo e não precisa baixar o vídeo.
// Quando não existe legenda, o erro sai com o código "no-subs" e a interface
// oferece o Whisper.

const { net, session, BrowserWindow } = require('electron');
const ytdlp = require('./ytdlp');
const subtitles = require('./subtitles');

const UA = () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

const noSubs = () => Object.assign(new Error('Esse vídeo não tem legenda pronta.'), { code: 'no-subs' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, signal, headers = {}) {
    const res = await net.fetch(url, { signal, headers: { 'user-agent': UA(), ...headers } });
    if (!res.ok) {
        throw Object.assign(new Error(res.status === 429
            ? 'Muitas requisições seguidas. Tenta de novo em instantes.'
            : `Não consegui baixar a legenda (erro ${res.status}).`), { transient: true });
    }
    return res.text();
}

/* ---------- YouTube ---------- */

const FORMATS = ['json3', 'vtt', 'srt'];

// Escolhe a legenda mais fiel ao que foi falado: primeiro a escrita à mão no
// idioma do vídeo, depois a automática do idioma original; traduções por último.
function pickTrack(info) {
    const base = String(info.language || '').split('-')[0].toLowerCase();
    const manual = Object.entries(info.subtitles || {}).filter(([lang]) => lang !== 'live_chat');
    const auto = Object.entries(info.automatic_captions || {});
    const originals = auto.filter(([lang]) => lang.endsWith('-orig'));

    const starting = (list, prefix) => (prefix ? list.find(([lang]) => lang.toLowerCase().startsWith(prefix)) : undefined);
    const candidates = [
        [starting(manual, base), false],
        [starting(originals, base), true],
        [originals.length === 1 ? originals[0] : undefined, true],
        [starting(auto, base), true],
        [starting(manual, 'pt'), false],
        [starting(manual, 'en'), false],
        [starting(originals, 'pt') || starting(originals, 'en'), true],
        [starting(auto, 'pt') || starting(auto, 'en'), true],
        [manual[0], false],
        [auto[0], true],
    ];

    for (const [entry, isAuto] of candidates) {
        if (!entry) continue;
        const [lang, formats] = entry;
        for (const ext of FORMATS) {
            const format = (formats || []).find((f) => f.ext === ext && f.url);
            if (format) return { lang: lang.replace(/-orig$/, ''), url: format.url, ext, auto: isAuto };
        }
    }
    return null;
}

async function youtube({ url, dir }, ctx) {
    ctx.progress(null, 'Procurando legenda');
    const info = await ytdlp.info(url, ctx.signal);
    if (info.title) ctx.meta({ title: info.title });

    const track = pickTrack(info);
    if (!track) throw noSubs();

    const cues = subtitles.parse(await fetchText(track.url, ctx.signal), track.ext);
    const files = subtitles.write({
        cues,
        dir,
        name: `${info.title || 'youtube'} [${info.id}]`,
        title: info.title,
        url: info.webpage_url || url,
        source: `${track.auto ? 'legenda automática' : 'legenda'} do YouTube (${track.lang})`,
    });
    return { files, title: info.title };
}

/* ---------- TikTok ---------- */

const TIKTOK_PARTITION = 'persist:tiktok';
const READ_PAGE_DATA = `(() => {
    const node = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    return node ? node.textContent : null;
})()`;

let tiktokReady = false;
function tiktokSession() {
    const ses = session.fromPartition(TIKTOK_PARTITION);
    if (!tiktokReady) {
        ses.setUserAgent(UA());
        // A janela só existe pra ler os dados da página: nada de permissões
        // (câmera, notificações...) nem de downloads.
        ses.setPermissionRequestHandler((_contents, _permission, allow) => allow(false));
        ses.on('will-download', (event) => event.preventDefault());
        tiktokReady = true;
    }
    return ses;
}

// Os dados do vídeo (incluindo as legendas) vêm embutidos na página. Pedir a
// página "por fora" costuma cair na verificação anti-robô do TikTok, então
// abrimos a página numa janela invisível de navegador de verdade, que resolve
// a verificação sozinha, e lemos os dados de lá.
async function tiktokItem(videoId, signal) {
    tiktokSession();
    const win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 800,
        webPreferences: { partition: TIKTOK_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const abort = () => { if (!win.isDestroyed()) win.destroy(); };
    signal.addEventListener('abort', abort, { once: true });

    try {
        // A página redireciona algumas vezes; o loadURL "falha" nesses casos,
        // mas a navegação segue normalmente.
        win.loadURL(`https://www.tiktok.com/@i/video/${videoId}`).catch(() => {});

        for (let attempt = 0; attempt < 50; attempt++) {
            await sleep(500);
            if (signal.aborted || win.isDestroyed()) throw Object.assign(new Error('Cancelado'), { canceled: true });
            let raw = null;
            try {
                raw = await win.webContents.executeJavaScript(READ_PAGE_DATA, true);
            } catch { /* no meio de uma navegação; tenta de novo */ }
            if (!raw) continue;
            let detail = null;
            try {
                const data = JSON.parse(raw);
                detail = data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.video-detail'];
            } catch { continue; }
            const item = detail && detail.itemInfo && detail.itemInfo.itemStruct;
            if (item) return item;
            if (detail && detail.statusMsg) throw new Error('Vídeo indisponível no TikTok.');
        }
        throw Object.assign(new Error('O TikTok não respondeu a tempo. Tenta de novo em instantes.'), { transient: true });
    } finally {
        signal.removeEventListener('abort', abort);
        if (!win.isDestroyed()) win.destroy();
    }
}

async function tiktok({ url, id, dir }, ctx) {
    ctx.progress(null, 'Procurando legenda');

    let videoId = id;
    if (!/^\d{15,}$/.test(videoId || '')) {
        // Link curto: seguimos o redirecionamento pra achar o número do vídeo.
        const res = await net.fetch(url, { redirect: 'follow', signal: ctx.signal, headers: { 'user-agent': UA() } });
        videoId = (res.url.match(/\/(?:video|photo)\/(\d+)/) || [])[1];
        if (!videoId) throw new Error('Não consegui abrir esse link do TikTok.');
    }

    const item = await tiktokItem(videoId, ctx.signal);
    const author = (item.author && item.author.uniqueId) || 'tiktok';
    const title = (item.desc || '').trim() || `@${author}`;
    ctx.meta({ title });

    const video = item.video || {};
    const captions = (video.claInfo && video.claInfo.captionInfos) || [];
    const legacy = video.subtitleInfos || [];
    // "Original" = gerada a partir do áudio; as outras são traduções automáticas.
    const pick = captions.find((c) => c.isOriginalCaption && c.url)
        || legacy.find((s) => s.Source === 'ASR' && s.Url)
        || captions.find((c) => c.url)
        || legacy.find((s) => s.Url);
    if (!pick) throw noSubs();

    const lang = pick.language || pick.LanguageCodeName || '';
    const body = await fetchText(pick.url || pick.Url, ctx.signal, { referer: 'https://www.tiktok.com/' });
    const cues = subtitles.parse(body, 'vtt');
    const files = subtitles.write({
        cues,
        dir,
        name: `${title.slice(0, 80)} [${videoId}]`,
        title,
        url,
        source: `legenda automática do TikTok${lang ? ` (${lang})` : ''}`,
    });
    return { files, title };
}

module.exports = { youtube, tiktok };
