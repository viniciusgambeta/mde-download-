// Localiza (e mantém atualizados) os programas externos que o app usa:
// yt-dlp, ffmpeg e a cópia local do Cobalt.

const { app, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

// No Linux usamos a versão "standalone" do yt-dlp, que já traz o Python dentro.
const YTDLP_ASSET = IS_WIN ? 'yt-dlp.exe' : (process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux');
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;
const UPDATE_EVERY = 24 * 60 * 60 * 1000;

const binDir = () => path.join(app.getPath('userData'), 'bin');
const ytDlpPath = () => path.join(binDir(), `yt-dlp${EXE}`);

// No app instalado o Cobalt fica em resources/cobalt; em desenvolvimento, em vendor/cobalt.
const cobaltDir = () => (app.isPackaged
    ? path.join(process.resourcesPath, 'cobalt')
    : path.join(app.getAppPath(), 'vendor', 'cobalt'));

// O ffmpeg vem junto com o Cobalt (pacote ffmpeg-static).
const ffmpegPath = () => path.join(cobaltDir(), 'node_modules', 'ffmpeg-static', `ffmpeg${EXE}`);

let ensuring = null;

// Garante que o yt-dlp existe; baixa do GitHub oficial na primeira vez.
function ensureYtDlp() {
    if (fs.existsSync(ytDlpPath())) return Promise.resolve(ytDlpPath());
    if (!ensuring) {
        ensuring = (async () => {
            fs.mkdirSync(binDir(), { recursive: true });
            const tmp = ytDlpPath() + '.part';
            const res = await net.fetch(YTDLP_URL);
            if (!res.ok) throw new Error(`Não consegui baixar o yt-dlp (HTTP ${res.status}).`);
            await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
            // Fora do Windows o arquivo precisa da permissão de execução.
            if (!IS_WIN) fs.chmodSync(tmp, 0o755);
            fs.renameSync(tmp, ytDlpPath());
            return ytDlpPath();
        })().finally(() => { ensuring = null; });
    }
    return ensuring;
}

// Os sites mudam o tempo todo e o yt-dlp lança correções com frequência,
// então ele se atualiza sozinho em segundo plano, no máximo uma vez por dia.
async function updateYtDlpInBackground() {
    const stamp = path.join(binDir(), 'last-update');
    try {
        const last = Number(fs.readFileSync(stamp, 'utf8'));
        if (Date.now() - last < UPDATE_EVERY) return;
    } catch { /* nunca atualizou */ }

    try {
        const exe = await ensureYtDlp();
        await new Promise((resolve) => {
            const p = spawn(exe, ['-U'], { windowsHide: true, stdio: 'ignore' });
            p.on('error', resolve);
            p.on('close', resolve);
        });
        fs.writeFileSync(stamp, String(Date.now()));
    } catch { /* sem internet agora; tenta na próxima abertura */ }
}

module.exports = { ytDlpPath, ffmpegPath, cobaltDir, ensureYtDlp, updateYtDlpInBackground };
