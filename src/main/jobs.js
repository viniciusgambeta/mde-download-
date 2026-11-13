// Fila de downloads: decide qual motor usar pra cada link, tenta o próximo
// quando um falha e avisa a interface a cada mudança.

const { app, nativeImage, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const settings = require('./settings');
const { detect } = require('./detect');
const ytdlp = require('./engines/ytdlp');
const cobalt = require('./engines/cobalt');
const instagram = require('./engines/instagram');
const youtube = require('./engines/youtube');
const transcript = require('./engines/transcript');
const whisper = require('./engines/whisper');

const MAX_PARALLEL = 3;
const HISTORY_LIMIT = 100;

const jobs = new Map();
const controllers = new Map();
const lastEmit = new Map();
let emit = () => {};

const historyFile = () => path.join(app.getPath('userData'), 'history.json');
const logFile = () => path.join(app.getPath('userData'), 'falhas.log');

// Registro simples das falhas, pra dar pra investigar depois o que houve.
function log(message) {
    fs.promises.appendFile(logFile(), `[${new Date().toISOString()}] ${message}\n`).catch(() => {});
}

const IMAGE = /\.(jpe?g|png|webp|heic|gif)$/i;

// Alguns sites mandam o título com entidades HTML ("&amp;" no lugar de "&").
function decodeEntities(text) {
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
    return String(text).replace(/&(amp|lt|gt|quot|apos|#39);/g, (_m, name) => map[name]);
}

// Espera que pode ser interrompida pelo cancelamento do download.
function pause(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Cancelado'));
        }, { once: true });
    });
}

function send(job, force = true) {
    // Um download cancelado ainda pode soltar um último aviso de progresso;
    // sem este filtro a linha removida reapareceria na lista.
    if (!jobs.has(job.id)) return;
    // O progresso chega em rajadas; limitamos a ~10 avisos por segundo.
    const now = Date.now();
    if (!force && now - (lastEmit.get(job.id) || 0) < 100) return;
    lastEmit.set(job.id, now);
    emit('job', job);
}

function saveHistory() {
    const done = [...jobs.values()]
        .filter((j) => j.status === 'done')
        .slice(-HISTORY_LIMIT)
        .map(({ thumb, ...rest }) => rest);
    fs.promises.writeFile(historyFile(), JSON.stringify(done)).catch(() => {});
}

async function makeThumb(file) {
    try {
        const image = await nativeImage.createThumbnailFromPath(file, { width: 112, height: 112 });
        return image.toDataURL();
    } catch {
        return null;
    }
}

function init(emitter) {
    emit = emitter;
    // O registro recomeça quando passa de 1 MB.
    try {
        if (fs.statSync(logFile()).size > 1048576) fs.rmSync(logFile());
    } catch { /* ainda não existe */ }
    try {
        const saved = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
        for (const job of saved) {
            job.files = (job.files || []).filter((f) => fs.existsSync(f));
            if (!job.files.length) continue;
            job.thumb = null;
            jobs.set(job.id, job);
            makeThumb(job.files[0]).then((thumb) => {
                if (thumb && jobs.has(job.id)) { job.thumb = thumb; send(job); }
            });
        }
    } catch { /* sem histórico ainda */ }
}

// Um link "share" do Instagram não diz se é reel ou post; seguimos o
// redirecionamento pra descobrir o link de verdade.
async function resolveShare(det, signal) {
    try {
        const res = await net.fetch(det.url, { redirect: 'follow', signal });
        const real = detect(res.url);
        if (real.ok && real.platform === 'instagram' && real.kind !== 'share') return real;
    } catch { /* cai no plano genérico */ }
    return det;
}

// Monta a lista de tentativas, na ordem, pra um link + ação.
function plan(job, det, connected) {
    const dir = settings.outDir();
    const quality = job.quality;
    const baseName = `${det.platform}_${det.id || 'arquivo'}`;

    const yt = (mode, extra = {}) => (ctx) => ytdlp.run({ url: det.url, mode, quality, dir, ...extra }, ctx);
    const cb = (mode, extra = {}) => (ctx) => cobalt.run({ url: det.url, mode, quality, dir, baseName, ...extra }, ctx);
    const audio = job.action === 'audio';

    // Transcrição: primeiro a legenda que a plataforma já tem pronta. O
    // Whisper entra quando o usuário pede (action "whisper") ou quando a
    // plataforma não oferece legenda nenhuma, caso dos Reels.
    const viaWhisper = (ctx) => whisper.transcribe({ url: det.url, id: det.id || 'video', platform: det.platform, dir }, ctx);
    if (job.action === 'whisper') return [viaWhisper];
    if (job.action === 'transcript') {
        if (det.platform === 'youtube') return [(ctx) => transcript.youtube({ url: det.url, dir }, ctx)];
        if (det.platform === 'tiktok') return [(ctx) => transcript.tiktok({ url: det.url, id: det.id, dir }, ctx)];
        return [viaWhisper];
    }

    if (det.platform === 'youtube') {
        if (job.action === 'thumb') return [(ctx) => youtube.thumbnail({ url: det.url, id: det.id, dir }, ctx)];
        if (job.action === 'playlist') return [yt('video', { playlist: true })];
        if (job.action === 'playlist-audio') return [yt('audio', { playlist: true })];
        return [yt(audio ? 'audio' : 'video')];
    }

    if (det.platform === 'instagram') {
        const igPost = (ctx) => instagram.post({ shortcode: det.id, dir }, ctx);

        if (job.action === 'avatar') return [(ctx) => instagram.avatar({ username: det.username, dir }, ctx)];
        if (job.action === 'stories') return [(ctx) => instagram.stories({ username: det.username, dir }, ctx)];
        if (job.action === 'story') return [(ctx) => instagram.stories({ username: det.username, storyId: det.id, dir }, ctx)];
        if (job.action === 'highlight') return [(ctx) => instagram.highlight({ id: det.id, dir }, ctx)];

        if (det.kind === 'reel') {
            if (audio) return [yt('audio'), cb('audio')];
            return [yt('video'), ...(connected ? [igPost] : []), cb('auto', { expectVideo: true })];
        }
        if (det.kind === 'post') {
            // Logado, a API do Instagram é a fonte mais fiel (traz tudo do carrossel).
            if (connected) return [igPost, cb('auto'), yt('video')];
            return [anonymousPost(det, cb('auto'), yt('video')), yt('video')];
        }
        return [cb('auto'), yt('video')];
    }

    if (det.platform === 'generic') return [yt(audio ? 'audio' : 'video')];

    // TikTok, X e demais sites do Cobalt; o yt-dlp fica de reserva.
    return audio ? [cb('audio'), yt('audio')] : [cb('auto'), yt('video')];
}

// Post do Instagram sem login: o Cobalt às vezes só consegue a capa de um
// vídeo. Quando vier uma única imagem, conferimos com o yt-dlp se existe
// vídeo; se existir, ele substitui a imagem.
function anonymousPost(det, viaCobalt, viaYtDlp) {
    return async (ctx) => {
        const result = await viaCobalt(ctx);
        const single = result.files.length === 1 && /\.(jpe?g|png|webp|heic)$/i.test(result.files[0]);
        if (!single) return result;
        try {
            const video = await viaYtDlp({ ...ctx, progress: () => {}, meta: () => {} });
            fs.rm(result.files[0], { force: true }, () => {});
            return video;
        } catch (err) {
            if (ctx.signal.aborted) throw err;
            return result;
        }
    };
}

async function runJob(job) {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    const { signal } = controller;

    Object.assign(job, { status: 'running', progress: null, detail: '', error: null, errorCode: null });
    send(job);

    const ctx = {
        signal,
        progress: (fraction, detail) => {
            job.progress = fraction;
            if (detail !== undefined) job.detail = detail;
            send(job, false);
        },
        meta: ({ title }) => {
            if (title) { job.title = decodeEntities(title); send(job); }
        },
    };

    try {
        let det = detect(job.url);
        if (!det.ok) throw new Error(det.reason || 'Link inválido.');
        if (det.kind === 'share') {
            det = await resolveShare(det, signal);
            if (det.kind === 'reel' && job.action === 'media') job.action = 'video';
        }

        const attempts = plan(job, det, await instagram.isConnected());
        const errors = [];
        let result = null;

        // Insistimos quando a falha parece passageira: o TikTok às vezes
        // responde com uma página de verificação em vez do vídeo, e o YouTube
        // de vez em quando corta um download no meio (erro 403).
        const MAX_ROUNDS = 3;
        let retry = true;
        let definitive = false;

        for (let round = 0; round < MAX_ROUNDS && !result && retry && !definitive; round++) {
            if (round > 0) await pause(1500, signal);
            retry = det.platform === 'tiktok';
            for (const attempt of attempts) {
                try {
                    result = await attempt(ctx);
                    break;
                } catch (err) {
                    if (signal.aborted) throw err;
                    errors.push(err);
                    if (err.transient) retry = true;
                    // Respostas definitivas: insistir não muda nada.
                    if (['no-subs', 'no-whisper', 'no-speech', 'ig-login'].includes(err.code)) definitive = true;
                    log(`${job.url} [${job.action}] tentativa falhou: ${err.message}${err.detail ? `\n${err.detail}` : ''}`);
                    job.progress = null;
                    job.detail = '';
                    send(job);
                }
            }
        }

        if (!result) {
            // Erro com código (login, sem legenda) é o mais útil de mostrar;
            // senão, o da última tentativa (o motor de reserva costuma
            // explicar melhor o motivo).
            throw errors.find((e) => e.code) || errors[errors.length - 1] || new Error('Não consegui baixar esse link.');
        }

        job.files = result.files.filter((f) => fs.existsSync(f));
        if (!job.files.length) throw new Error('O download terminou sem gerar arquivo.');
        if (result.title && !job.title) job.title = decodeEntities(result.title);
        // Um link de "vídeo" que na verdade era um carrossel de fotos (comum
        // no TikTok) passa a ser descrito como fotos.
        if (['media', 'video'].includes(job.action) && job.files.every((f) => IMAGE.test(f))) {
            job.kindLabel = job.actionLabel = job.files.length > 1 ? 'Fotos' : 'Foto';
        }
        job.thumb = await makeThumb(job.files.find((f) => /\.(jpe?g|png|webp|mp4|mov|mkv|webm)$/i.test(f)) || job.files[0]);
        Object.assign(job, { status: 'done', progress: 1, detail: '' });
        saveHistory();
        // Abre o Explorer (ou o Finder) já com o arquivo selecionado (dá pra desligar nos ajustes).
        if (settings.load().openFolder) shell.showItemInFolder(job.files[0]);
    } catch (err) {
        if (signal.aborted) {
            job.status = 'canceled';
        } else {
            let message = err.message || 'Não consegui baixar esse link.';
            // Códigos que a interface entende: "ig-login" (oferece conectar),
            // "no-subs" (oferece o Whisper) e "no-whisper" (falta instalar).
            let errorCode = ['ig-login', 'no-subs', 'no-whisper'].includes(err.code) ? err.code : null;
            // Sem login o Instagram barra muita coisa (fotos avulsas, perfis
            // restritos). Se falhou deslogado, o caminho é conectar a conta.
            if (!errorCode && job.platform === 'instagram' && !(await instagram.isConnected().catch(() => true))) {
                errorCode = 'ig-login';
                message = 'O Instagram não liberou sem login.';
            }
            Object.assign(job, { status: 'error', error: message, errorCode, progress: null, detail: '' });
        }
    } finally {
        controllers.delete(job.id);
    }

    if (jobs.has(job.id)) send(job);
    pump();
}

function pump() {
    let running = [...jobs.values()].filter((j) => j.status === 'running').length;
    for (const job of jobs.values()) {
        if (running >= MAX_PARALLEL) break;
        if (job.status === 'queued') {
            running++;
            runJob(job);
        }
    }
}

function start({ url, action, quality }) {
    const det = detect(url);
    if (!det.ok) throw new Error(det.reason || 'Link inválido.');
    const chosen = det.actions.find((a) => a.id === action) || det.actions[0];

    const job = {
        id: crypto.randomUUID(),
        url: det.url,
        platform: det.platform,
        site: det.site,
        kindLabel: det.kindLabel,
        action: chosen.id,
        actionLabel: chosen.label,
        quality: settings.QUALITIES.includes(quality) ? quality : settings.load().quality,
        status: 'queued',
        title: det.username ? `@${det.username}` : null,
        progress: null,
        detail: '',
        files: [],
        thumb: null,
        error: null,
        errorCode: null,
        createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    send(job);
    pump();
    return job;
}

// action "whisper": refaz uma transcrição que não achou legenda pronta,
// desta vez transcrevendo o áudio com o Whisper.
function retry(id, action) {
    const job = jobs.get(id);
    if (!job || job.status === 'running' || job.status === 'queued') return;
    if (action === 'whisper' && job.action === 'transcript') job.action = 'whisper';
    Object.assign(job, { status: 'queued', error: null, errorCode: null, progress: null, detail: '' });
    send(job);
    pump();
}

// Tira da lista (e cancela, se estiver rodando). Não apaga arquivos baixados.
function remove(id) {
    const controller = controllers.get(id);
    if (controller) controller.abort();
    if (jobs.delete(id)) {
        lastEmit.delete(id);
        emit('job-removed', id);
        saveHistory();
    }
}

function clearFinished() {
    for (const job of [...jobs.values()]) {
        if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') remove(job.id);
    }
}

function cancelAll() {
    for (const controller of controllers.values()) controller.abort();
}

const list = () => [...jobs.values()];
const ownsFile = (file) => list().some((j) => j.files.includes(file));

module.exports = { init, start, retry, remove, clearFinished, cancelAll, list, ownsFile };
