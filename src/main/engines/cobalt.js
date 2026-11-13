// Motor Cobalt: sobe a API do Cobalt como servidor local (só nesta máquina,
// em 127.0.0.1) e pede os arquivos pra ela. Cobre Instagram, TikTok, X e
// mais uma dúzia de sites, incluindo fotos e carrosséis.

const { net: electronNet } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const bins = require('../bins');
const direct = require('./direct');

let child = null;
let baseUrl = null;
let starting = null;

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
    if (child && baseUrl) return Promise.resolve(baseUrl);
    if (starting) return starting;

    starting = (async () => {
        const dir = bins.cobaltDir();
        const runner = path.join(dir, 'run.mjs');
        if (!fs.existsSync(runner)) throw new Error('Cobalt não encontrado. Rode "npm run setup".');

        const port = await freePort();
        const url = `http://127.0.0.1:${port}/`;

        const proc = spawn(process.execPath, [runner], {
            cwd: dir,
            windowsHide: true,
            // stdin fica aberto de propósito: o run.mjs encerra o Cobalt quando
            // esse canal fecha, ou seja, quando o app fecha (mesmo se travar).
            stdio: ['pipe', 'ignore', 'ignore'],
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                API_URL: url,
                API_PORT: String(port),
                API_LISTEN_ADDRESS: '127.0.0.1',
                DISABLED_SERVICES: 'youtube',
                RATELIMIT_MAX: '100000',
                TUNNEL_RATELIMIT_MAX: '100000',
                TUNNEL_LIFESPAN: '3600',
                DURATION_LIMIT: '86400',
            },
        });
        proc.on('exit', () => {
            if (child === proc) { child = null; baseUrl = null; }
        });
        proc.on('error', () => {});
        child = proc;

        for (let i = 0; i < 100; i++) {
            if (proc.exitCode !== null) throw new Error('O Cobalt não conseguiu iniciar.');
            try {
                const res = await electronNet.fetch(url, { headers: { accept: 'application/json' } });
                if (res.ok) { baseUrl = url; return url; }
            } catch { /* ainda subindo */ }
            await sleep(200);
        }
        stop();
        throw new Error('O Cobalt demorou demais pra iniciar.');
    })().finally(() => { starting = null; });

    return starting;
}

function stop() {
    if (child) {
        try { child.stdin.end(); } catch { /* já fechou */ }
        try { child.kill(); } catch { /* já morreu */ }
    }
    child = null;
    baseUrl = null;
}

function friendlyError(error) {
    const code = (error && error.code) || '';
    const tests = [
        [/private/, 'Conteúdo privado.'],
        [/\.age/, 'Conteúdo com restrição de idade.'],
        [/unavailable|region/, 'Conteúdo indisponível.'],
        [/link\.(unsupported|invalid)|service\.(unsupported|disabled)/, 'Link não suportado.'],
        [/rate/, 'Muitas requisições seguidas. Tenta de novo em instantes.'],
        [/too_long/, 'Vídeo longo demais.'],
        [/login/, 'Esse conteúdo precisa de login.'],
    ];
    for (const [re, msg] of tests) if (re.test(code)) return msg;
    return 'Não consegui extrair esse link.';
}

async function request(body, signal) {
    const url = await start();
    const res = await electronNet.fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    return res.json();
}

const isImageName = (name) => /\.(jpe?g|png|webp|heic|gif)$/i.test(name || '');

// opts: { url, mode: 'auto' | 'audio', quality, dir, baseName, expectVideo }
// ctx:  { signal, progress(fraction|null, detail), meta({ title }) }
async function run(opts, ctx) {
    const { url, mode, quality, dir, baseName, expectVideo } = opts;

    const data = await request({
        url,
        alwaysProxy: true,
        filenameStyle: 'basic',
        videoQuality: quality || '1080',
        downloadMode: mode === 'audio' ? 'audio' : 'auto',
        audioFormat: 'mp3',
        audioBitrate: '320',
    }, ctx.signal);

    if (data.status === 'error') {
        throw Object.assign(new Error(friendlyError(data.error)), { detail: `cobalt: ${JSON.stringify(data.error)}` });
    }

    if (data.status === 'tunnel' || data.status === 'redirect') {
        // Sem login, às vezes o Instagram só entrega a capa de um reel.
        // Tratamos como falha pra que o próximo motor tente o vídeo de verdade.
        if (expectVideo && isImageName(data.filename)) throw new Error('Só encontrei a capa do vídeo.');
        const file = await direct.download(data.url, {
            dir,
            name: data.filename || baseName,
            signal: ctx.signal,
            onProgress: (fraction) => ctx.progress(fraction, ''),
        });
        return { files: [file] };
    }

    if (data.status === 'picker') {
        if (mode === 'audio') {
            if (!data.audio) throw new Error('Esse post não tem áudio.');
            const file = await direct.download(data.audio, {
                dir,
                name: data.audioFilename || `${baseName}_audio`,
                signal: ctx.signal,
                onProgress: (fraction) => ctx.progress(fraction, ''),
            });
            return { files: [file] };
        }

        const items = data.picker || [];
        if (!items.length) throw new Error('Não encontrei mídia nesse link.');
        const files = [];
        for (let i = 0; i < items.length; i++) {
            const detail = items.length > 1 ? `${i + 1} de ${items.length}` : '';
            files.push(await direct.download(items[i].url, {
                dir,
                name: `${baseName}_${i + 1}`,
                preferServerName: true,
                signal: ctx.signal,
                onProgress: (fraction) => ctx.progress(((fraction || 0) + i) / items.length, detail),
            }));
        }
        return { files };
    }

    throw new Error('Resposta inesperada do Cobalt.');
}

module.exports = { start, stop, run };
