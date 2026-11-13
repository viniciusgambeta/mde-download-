// Transcrição com o Whisper, rodando neste computador. O Whisper é opcional:
// sem ele o app funciona igual, só não transcreve vídeos sem legenda pronta.
//
// Há dois jeitos de rodar, e o app usa o primeiro que encontrar:
//   1. "python": o faster-whisper já instalado no Python da máquina (usa a
//      placa de vídeo quando dá). Nada é baixado pelo app.
//   2. "cpp": o whisper.cpp, um programa independente que o app baixa (com o
//      modelo) quando a pessoa aceita. Não precisa de Python.

const { app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bins = require('../bins');
const ytdlp = require('./ytdlp');
const cobalt = require('./cobalt');
const direct = require('./direct');
const subtitles = require('./subtitles');

// Versão fixa do whisper.cpp (binários oficiais do GitHub) e modelo "turbo"
// compactado: boa precisão em português e rápido o bastante no processador.
const CPP_ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const CPP_ZIP_BYTES = 9 * 1048576;
const CPP_MODEL = 'ggml-large-v3-turbo-q5_0.bin';
const CPP_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${CPP_MODEL}`;
const CPP_MODEL_BYTES = 574041195;
const INSTALL_BYTES = CPP_ZIP_BYTES + CPP_MODEL_BYTES;

const home = () => path.join(app.getPath('userData'), 'whisper');
const modelPath = () => path.join(home(), 'models', CPP_MODEL);

const canceled = () => Object.assign(new Error('Cancelado'), { canceled: true });

/* ---------- utilidades de processo ---------- */

// Roda um programa até o fim. onLine recebe cada linha que ele imprimir.
function runProcess(exe, args, { cwd, env, signal, onLine } = {}) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(canceled());
        let child;
        try {
            child = spawn(exe, args, { cwd, env, windowsHide: true });
        } catch (err) {
            return reject(err);
        }

        let tail = '';
        const buffers = { stdout: '', stderr: '' };
        const feed = (name) => (chunk) => {
            tail = (tail + chunk).slice(-4000);
            if (!onLine) return;
            buffers[name] += chunk;
            // O whisper.cpp reescreve a linha de progresso com "\r".
            const lines = buffers[name].split(/\r\n|\n|\r/);
            buffers[name] = lines.pop();
            lines.forEach(onLine);
        };

        const kill = () => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        if (signal) signal.addEventListener('abort', kill, { once: true });

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', feed('stdout'));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', feed('stderr'));
        child.on('error', (err) => {
            if (signal) signal.removeEventListener('abort', kill);
            reject(err);
        });
        child.on('close', (code) => {
            if (signal) signal.removeEventListener('abort', kill);
            if (signal && signal.aborted) return reject(canceled());
            resolve({ code, tail: tail.trim() });
        });
    });
}

/* ---------- 1. faster-whisper no Python da máquina ---------- */

const HAS_FASTER_WHISPER = 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("faster_whisper") else 1)';

let pythonChecked = false;
let python = null;

// Modelos do faster-whisper que o whisper_runner.py sabe usar, pelo nome da
// pasta no cache do Hugging Face.
const PYTHON_MODELS = [
    'Systran--faster-whisper-large-v3',
    'mobiuslabsgmbh--faster-whisper-large-v3-turbo',
    'Systran--faster-whisper-large-v2',
    'Systran--faster-whisper-medium',
    'Systran--faster-whisper-small',
];

// Só contamos com o Python se já houver um modelo baixado. Assim o app nunca
// baixa gigabytes de modelo sem perguntar: sem modelo em cache, ele cai na
// oferta de download do whisper.cpp, que mostra o tamanho e pede confirmação.
function pythonModelCached() {
    const cache = process.env.HF_HUB_CACHE
        || (process.env.HF_HOME && path.join(process.env.HF_HOME, 'hub'))
        || path.join(os.homedir(), '.cache', 'huggingface', 'hub');
    return PYTHON_MODELS.some((name) => {
        const snapshots = path.join(cache, `models--${name}`, 'snapshots');
        try {
            return fs.readdirSync(snapshots).some((rev) => fs.existsSync(path.join(snapshots, rev, 'model.bin')));
        } catch {
            return false;
        }
    });
}

// Procura um Python que tenha o faster-whisper. Só consulta se o pacote
// existe (não o carrega), então é rápido mesmo a cada abertura do app.
async function findPython() {
    if (pythonChecked) return python;
    pythonChecked = true;
    // Só em desenvolvimento: finge que não há Python, pra testar o outro caminho.
    if (!app.isPackaged && process.env.MDD_NO_PYTHON) return null;
    if (!pythonModelCached()) return null;

    for (const candidate of [['python'], ['py', '-3']]) {
        const [exe, ...args] = candidate;
        try {
            const timeout = AbortSignal.timeout(20000);
            const { code } = await runProcess(exe, [...args, '-c', HAS_FASTER_WHISPER], { signal: timeout });
            if (code === 0) {
                python = candidate;
                break;
            }
        } catch { /* esse Python não existe ou demorou demais */ }
    }
    return python;
}

function runPython(command, audioFile, ctx) {
    // O Python não lê arquivos de dentro do pacote do app, então copiamos o
    // script pra pasta de dados antes de usar.
    const script = path.join(app.getPath('userData'), 'whisper_runner.py');
    fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'whisper_runner.py')));

    let cues = [];
    let duration = 0;
    let finished = false;
    let failure = null;

    const onLine = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.event === 'loading') {
            // Recomeçou com outra configuração: descarta o que já tinha vindo.
            cues = [];
            ctx.progress(null, event.device === 'cuda' ? 'Carregando Whisper (placa de vídeo)' : 'Carregando Whisper (processador)');
        } else if (event.event === 'info') {
            duration = event.duration || 0;
            ctx.progress(0, 'Transcrevendo');
        } else if (event.event === 'segment') {
            cues.push({ start: Math.round(event.start * 1000), end: Math.round(event.end * 1000), text: event.text });
            ctx.progress(duration ? Math.min(event.end / duration, 1) : null, 'Transcrevendo');
        } else if (event.event === 'done') {
            finished = true;
        } else if (event.event === 'error') {
            failure = event.message;
        }
    };

    const [exe, ...args] = command;
    return runProcess(exe, [...args, '-X', 'utf8', script, audioFile], {
        signal: ctx.signal,
        onLine,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
    }).then(({ tail }) => {
        if (!finished) {
            throw Object.assign(new Error('O Whisper não conseguiu transcrever esse áudio.'),
                { detail: `faster-whisper: ${failure || ''}\n${tail.slice(-1500)}` });
        }
        return cues;
    });
}

/* ---------- 2. whisper.cpp baixado pelo app ---------- */

let cliCache = null;

// O pacote oficial traz o programa dentro de uma subpasta, então procuramos.
function findCli() {
    if (cliCache && fs.existsSync(cliCache)) return cliCache;
    cliCache = null;
    const walk = (dir, depth) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
        const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'whisper-cli.exe');
        if (hit) return path.join(dir, hit.name);
        if (depth >= 3) return null;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const found = walk(path.join(dir, entry.name), depth + 1);
            if (found) return found;
        }
        return null;
    };
    cliCache = walk(path.join(home(), 'bin'), 0);
    return cliCache;
}

function modelReady() {
    try {
        // Um download interrompido deixaria um arquivo menor que o esperado.
        return fs.statSync(modelPath()).size >= CPP_MODEL_BYTES * 0.98;
    } catch {
        return false;
    }
}

const cppInstalled = () => Boolean(findCli()) && modelReady();

async function extractZip(zip, dest, signal) {
    fs.mkdirSync(dest, { recursive: true });
    // O Windows 10 e 11 já vêm com o tar, que abre arquivos .zip.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try {
        const { code } = await runProcess(tar, ['-xf', zip, '-C', dest], { signal });
        if (code === 0) return;
    } catch (err) {
        if (err.canceled) throw err;
    }
    // Plano B: o PowerShell. Os caminhos vão entre aspas simples (com as
    // aspas internas dobradas) pra não serem interpretados como código.
    const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
    const { code, tail } = await runProcess('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dest)} -Force`],
        { signal });
    if (code !== 0) throw new Error(`Não consegui descompactar o Whisper. ${tail.slice(-200)}`);
}

let installing = null;
let installAbort = null;
let installState = { progress: 0, detail: '' };

// Baixa o whisper.cpp e o modelo. onProgress recebe { progress: 0..1, detail }.
function install(onProgress) {
    if (installing) return installing;
    installAbort = new AbortController();
    const { signal } = installAbort;

    const report = (bytes, detail) => {
        installState = { progress: Math.min(bytes / INSTALL_BYTES, 1), detail };
        onProgress(installState);
    };

    installing = (async () => {
        fs.mkdirSync(path.join(home(), 'models'), { recursive: true });

        if (!findCli()) {
            report(0, 'Baixando o programa');
            fs.rmSync(path.join(home(), 'bin'), { recursive: true, force: true });
            const zip = await direct.download(CPP_ZIP_URL, {
                dir: home(),
                name: 'whisper-bin-x64.zip',
                signal,
                onProgress: (_fraction, received) => report(Math.min(received, CPP_ZIP_BYTES), 'Baixando o programa'),
            });
            try {
                await extractZip(zip, path.join(home(), 'bin'), signal);
            } finally {
                fs.rm(zip, { force: true }, () => {});
            }
            if (!findCli()) throw new Error('O pacote do Whisper veio diferente do esperado.');
        }

        if (!modelReady()) {
            report(CPP_ZIP_BYTES, 'Baixando o modelo');
            fs.rmSync(modelPath(), { force: true });
            await direct.download(CPP_MODEL_URL, {
                dir: path.dirname(modelPath()),
                name: CPP_MODEL,
                signal,
                onProgress: (_fraction, received) => report(CPP_ZIP_BYTES + received, 'Baixando o modelo'),
            });
            if (!modelReady()) throw new Error('O modelo do Whisper não baixou por inteiro. Tenta de novo.');
        }

        report(INSTALL_BYTES, 'Pronto');
    })().finally(() => {
        installing = null;
        installAbort = null;
    });

    return installing;
}

function cancelInstall() {
    if (installAbort) installAbort.abort();
}

async function runCpp(audioFile, work, ctx) {
    // O whisper.cpp só lê WAV de 16 kHz mono; o ffmpeg que vem no app converte.
    ctx.progress(null, 'Preparando áudio');
    const wav = path.join(work, 'audio16k.wav');
    const converted = await runProcess(bins.ffmpegPath(),
        ['-y', '-loglevel', 'error', '-i', audioFile, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
        { signal: ctx.signal });
    if (converted.code !== 0 || !fs.existsSync(wav)) {
        throw Object.assign(new Error('Esse vídeo não tem áudio pra transcrever.'), { detail: converted.tail });
    }

    // Tudo com caminhos relativos à pasta do Whisper: assim o programa nunca
    // recebe um caminho com acento (ex.: nome de usuário), que ele não abre.
    const relative = (file) => path.relative(home(), file);
    const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
    const out = path.join(work, 'out');

    ctx.progress(null, 'Carregando Whisper (processador)');
    const { code, tail } = await runProcess(findCli(), [
        '-m', relative(modelPath()),
        '-f', relative(wav),
        '-l', 'auto',
        '-osrt', '-of', relative(out),
        '-pp', '-t', String(threads),
    ], {
        cwd: home(),
        signal: ctx.signal,
        onLine: (line) => {
            const match = line.match(/progress\s*=\s*(\d+)\s*%/);
            if (match) ctx.progress(Math.min(Number(match[1]) / 100, 1), 'Transcrevendo');
        },
    });

    const srt = `${out}.srt`;
    if (code !== 0 || !fs.existsSync(srt)) {
        // 0xC0000135: o Windows não achou uma DLL de que o programa precisa.
        const missingDll = code === 3221225781;
        throw Object.assign(new Error(missingDll
            ? 'O Whisper não iniciou neste computador. Instale o "Microsoft Visual C++ Redistributable" e tente de novo.'
            : 'O Whisper não conseguiu transcrever esse áudio.'),
        { detail: `whisper.cpp (código ${code}): ${tail.slice(-1500)}` });
    }
    return subtitles.parse(fs.readFileSync(srt, 'utf8'), 'srt');
}

/* ---------- uso pelo app ---------- */

// Situação do Whisper nesta máquina, pra interface decidir o que mostrar.
async function status() {
    if (installing) return { state: 'installing', ...installState };
    if (await findPython()) return { state: 'ready', backend: 'python' };
    if (cppInstalled()) return { state: 'ready', backend: 'cpp' };
    return { state: 'missing', sizeMB: Math.round(INSTALL_BYTES / 1048576) };
}

// Uma transcrição por vez: duas ao mesmo tempo disputariam placa de vídeo e processador.
let queue = Promise.resolve();
function exclusive(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

// Baixa só o áudio (ou o menor arquivo que tenha áudio) pra uma pasta temporária.
async function fetchAudio({ url, work }, ctx) {
    const quiet = { signal: ctx.signal, meta: ctx.meta, progress: (fraction) => ctx.progress(fraction, 'Baixando áudio') };
    try {
        const result = await ytdlp.run({ url, mode: 'rawaudio', dir: work, outputTemplate: 'audio.%(ext)s' }, quiet);
        return { file: result.files[0], title: result.title };
    } catch (err) {
        if (ctx.signal.aborted) throw err;
        const result = await cobalt.run({ url, mode: 'audio', dir: work, baseName: 'audio' }, quiet);
        return { file: result.files[0], title: null };
    }
}

// opts: { url, id, platform, dir }
async function transcribe({ url, id, platform, dir }, ctx) {
    ctx.progress(null, 'Preparando Whisper');
    const command = await findPython();
    if (!command && !cppInstalled()) {
        throw Object.assign(new Error('O Whisper não está instalado neste computador.'), { code: 'no-whisper' });
    }

    const workRoot = path.join(home(), 'work');
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, 'w-'));
    try {
        const audio = await fetchAudio({ url, work }, ctx);
        ctx.progress(null, 'Na fila do Whisper');
        const cues = await exclusive(() => (command ? runPython(command, audio.file, ctx) : runCpp(audio.file, work, ctx)));
        if (!cues.length) {
            throw Object.assign(new Error('O Whisper não encontrou fala nesse vídeo.'), { code: 'no-speech' });
        }

        const title = audio.title || `${platform}_${id}`;
        const files = subtitles.write({
            cues,
            dir,
            name: audio.title ? `${audio.title} [${id}]` : `${platform}_${id}`,
            title,
            url,
            source: 'transcrição automática (Whisper)',
        });
        return { files, title };
    } finally {
        fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }, () => {});
    }
}

module.exports = { status, install, cancelInstall, transcribe };
