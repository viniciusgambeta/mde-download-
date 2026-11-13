// Motor yt-dlp: YouTube e qualquer outro site que ele conheça.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const bins = require('../bins');
const { spawnOptions, killTree, nodeRuntime } = require('../platform');

// Preferimos H.264 + AAC em MP4 porque abre em qualquer editor e player.
// Acima de 1080p o YouTube só oferece VP9/AV1, então em "max" vale a resolução.
const sortFor = (quality) => (quality === 'max'
    ? 'res,acodec:m4a'
    : `res:${quality},vcodec:h264,acodec:m4a`);

// Opções comuns a toda chamada do yt-dlp.
const baseArgs = () => [
    '--no-warnings', '--no-colors', '--encoding', 'utf-8',
    '--ffmpeg-location', bins.ffmpegPath(),
    // O YouTube exige rodar JavaScript pra liberar os links; usamos o
    // próprio executável do app como runtime (modo Node do Electron).
    '--no-js-runtimes', '--js-runtimes', `node:${nodeRuntime()}`,
];

const childEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });

function buildArgs({ url, mode, quality, dir, playlist, outputTemplate }) {
    const args = [
        ...baseArgs(),
        '--newline', '--progress', '--no-simulate',
        '--progress-template', 'download:BXP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s',
        '--progress-template', 'postprocess:BXS|%(progress.postprocessor)s|%(progress.status)s',
        '--print', 'before_dl:BXT|%(format_id)s|%(playlist_index)s|%(n_entries)s|%(id)s|%(title)s',
        '--print', 'after_move:BXF|%(filepath)s',
        '--no-mtime', '-N', '4',
        '-P', dir,
    ];

    if (playlist) {
        args.push('--yes-playlist', '--ignore-errors',
            '-o', '%(playlist_title).80B/%(playlist_index)03d - %(title).100B.%(ext)s');
    } else {
        args.push('--no-playlist', '-o', outputTemplate || '%(title).100B [%(id)s].%(ext)s');
    }

    if (mode === 'audio') {
        args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (mode === 'rawaudio') {
        // Áudio do jeito que vier, sem converter (o Whisper lê qualquer formato).
        args.push('-f', 'bestaudio/best');
    } else {
        args.push('-S', sortFor(quality || '1080'), '--merge-output-format', 'mp4');
    }

    args.push('--', url);
    return args;
}

function friendlyError(stderr) {
    const lines = stderr.split(/\r?\n/).filter((l) => l.startsWith('ERROR:'));
    const last = lines[lines.length - 1] || '';
    const tests = [
        [/private video|video is private|This content is private/i, 'Conteúdo privado.'],
        [/confirm your age|age.restricted|inappropriate for some users/i, 'Conteúdo com restrição de idade.'],
        [/login required|log in|sign in|cookies|rate-limit reached/i, 'Esse conteúdo precisa de login.'],
        [/video unavailable|not available|has been removed|does not exist|404/i, 'Conteúdo indisponível ou removido.'],
        [/Unsupported URL/i, 'Esse site ainda não é suportado.'],
        [/No video formats found|no media|no video in this post/i, 'Não encontrei vídeo nesse link.'],
        [/unable to obtain file audio codec/i, 'Esse vídeo não tem áudio.'],
        [/Unable to extract/i, 'O site bloqueou a extração agora. Tenta de novo em instantes.'],
        [/HTTP Error 403/i, 'O site recusou o download agora (erro 403). Tenta de novo.'],
        [/HTTP Error 429/i, 'Muitas requisições seguidas. Tenta de novo em instantes.'],
        [/getaddrinfo|timed out|Unable to download webpage|connection/i, 'Falha de conexão com o site.'],
    ];
    for (const [re, msg] of tests) if (re.test(last)) return msg;
    const cleaned = last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '').replace(/;? please report.*$/i, '').trim();
    return cleaned ? cleaned.slice(0, 140) : 'O yt-dlp não conseguiu baixar esse link.';
}

// Ao cancelar, o yt-dlp deixa pedaços (.part, .ytdl) pra trás; apagamos os
// que pertencem a esse vídeo (o nome do arquivo carrega o ID entre colchetes).
function removePartials(dir, mediaId) {
    if (!mediaId) return;
    try {
        for (const name of fs.readdirSync(dir)) {
            if (name.includes(`[${mediaId}]`) && /\.(part|ytdl)$|\.part-Frag\d+$/i.test(name)) {
                // O arquivo pode ficar travado por um instante depois do cancelamento.
                fs.rm(path.join(dir, name), { force: true, maxRetries: 5, retryDelay: 300 }, () => {});
            }
        }
    } catch { /* pasta sumiu; nada a limpar */ }
}

const num = (v) => (v && v !== 'NA' ? Number(v) : 0);

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec) return '';
    const mb = bytesPerSec / 1048576;
    return mb >= 1 ? `${mb.toFixed(1).replace('.', ',')} MB/s` : `${Math.round(bytesPerSec / 1024)} KB/s`;
}

// ctx: { signal, progress(fraction|null, detail), meta({ title }) }
async function run(opts, ctx) {
    const exe = await bins.ensureYtDlp();

    return new Promise((resolve, reject) => {
        const child = spawn(exe, buildArgs(opts), spawnOptions({ env: childEnv() }));

        const files = [];
        let title = null;
        let mediaId = null;
        let stderr = '';
        let buffer = '';
        // Vídeo e áudio costumam vir em dois arquivos separados que depois são
        // unidos; o vídeo é quase todo o tamanho, então ele ocupa 90% da barra.
        let streams = 1;
        let streamIndex = 0;
        let lastFraction = 0;
        let item = 1;
        let itemCount = 1;

        const kill = () => killTree(child);
        if (ctx.signal.aborted) kill();
        ctx.signal.addEventListener('abort', kill, { once: true });

        const overall = (fraction) => {
            const within = streams > 1
                ? (streamIndex === 0 ? fraction * 0.9 : 0.9 + fraction * 0.1)
                : fraction;
            return (item - 1 + within) / itemCount;
        };

        const onLine = (line) => {
            const [tag, ...rest] = line.split('|');
            if (tag === 'BXT') {
                const [formatId, index, count, id] = rest;
                mediaId = id;
                title = rest.slice(4).join('|');
                streams = formatId.includes('+') ? 2 : 1;
                streamIndex = 0;
                lastFraction = 0;
                item = num(index) || 1;
                itemCount = num(count) || 1;
                ctx.meta({ title: itemCount > 1 ? `${title}` : title });
            } else if (tag === 'BXP') {
                const downloaded = num(rest[0]);
                const total = num(rest[1]) || num(rest[2]);
                const fraction = total ? Math.min(downloaded / total, 1) : 0;
                if (streams > 1 && streamIndex === 0 && lastFraction > 0.9 && fraction < 0.5) streamIndex = 1;
                lastFraction = fraction;
                const parts = [];
                if (itemCount > 1) parts.push(`${item} de ${itemCount}`);
                const speed = formatSpeed(num(rest[3]));
                if (speed) parts.push(speed);
                ctx.progress(total ? overall(fraction) : null, parts.join(' · '));
            } else if (tag === 'BXS') {
                if (rest[1] === 'started') ctx.progress(overall(1), 'Finalizando');
            } else if (tag === 'BXF') {
                files.push(rest.join('|'));
            }
        };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            lines.forEach(onLine);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });

        child.on('error', reject);
        child.on('close', (code) => {
            ctx.signal.removeEventListener('abort', kill);
            if (buffer) onLine(buffer);
            if (ctx.signal.aborted) {
                removePartials(opts.dir, mediaId);
                return reject(Object.assign(new Error('Cancelado'), { canceled: true }));
            }
            // Um item indisponível (numa playlist ou num post com várias mídias)
            // não invalida os que deram certo.
            if (files.length) return resolve({ files, title });
            reject(Object.assign(new Error(friendlyError(stderr)), {
                detail: stderr.trim().slice(-1500),
                // Bloqueio momentâneo ou queda de rede: vale tentar de novo
                // (o yt-dlp retoma do ponto em que parou).
                transient: /HTTP Error (403|429|5\d\d)|timed out|connection (reset|aborted)|Unable to extract/i.test(stderr),
            }));
        });
    });
}

// Só consulta os dados do vídeo (título, idioma, legendas disponíveis),
// sem baixar nada.
async function info(url, signal) {
    const exe = await bins.ensureYtDlp();

    return new Promise((resolve, reject) => {
        const child = spawn(exe, [...baseArgs(), '--skip-download', '--no-playlist', '-J', '--', url],
            spawnOptions({ env: childEnv() }));

        let stdout = '';
        let stderr = '';
        const kill = () => killTree(child);
        if (signal.aborted) kill();
        signal.addEventListener('abort', kill, { once: true });

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
        child.on('error', reject);
        child.on('close', () => {
            signal.removeEventListener('abort', kill);
            if (signal.aborted) return reject(Object.assign(new Error('Cancelado'), { canceled: true }));
            try {
                resolve(JSON.parse(stdout));
            } catch {
                reject(Object.assign(new Error(friendlyError(stderr)), {
                    detail: stderr.trim().slice(-1500),
                    transient: /HTTP Error (403|429|5\d\d)|timed out|Unable to extract/i.test(stderr),
                }));
            }
        });
    });
}

module.exports = { run, info };
