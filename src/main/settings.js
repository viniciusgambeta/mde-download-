// Preferências salvas em settings.json, na pasta de dados do app:
// %APPDATA%/MeDaUmDownload no Windows e
// ~/Library/Application Support/MeDaUmDownload no macOS.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const QUALITIES = ['max', '2160', '1440', '1080', '720', '480'];

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function defaults() {
    return {
        outDir: path.join(app.getPath('downloads'), 'Me dá um Download'),
        quality: '1080',
        // Abre o Explorer (ou o Finder) com o arquivo selecionado quando um download termina.
        openFolder: true,
        // Já avisamos uma vez que fechar a janela manda o app pra bandeja?
        trayHintShown: false,
        // Já perguntamos se a pessoa quer baixar o Whisper? (só perguntamos uma vez)
        whisperAsked: false,
    };
}

function load() {
    if (cache) return cache;
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch { /* primeira execução */ }
    cache = { ...defaults(), ...saved };
    if (!QUALITIES.includes(cache.quality)) cache.quality = '1080';
    return cache;
}

function save(patch) {
    const next = { ...load() };
    if (typeof patch.outDir === 'string' && patch.outDir) next.outDir = patch.outDir;
    if (QUALITIES.includes(patch.quality)) next.quality = patch.quality;
    if (typeof patch.openFolder === 'boolean') next.openFolder = patch.openFolder;
    if (typeof patch.trayHintShown === 'boolean') next.trayHintShown = patch.trayHintShown;
    if (typeof patch.whisperAsked === 'boolean') next.whisperAsked = patch.whisperAsked;
    cache = next;
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
    return next;
}

function outDir() {
    const dir = load().outDir;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = { load, save, outDir, QUALITIES };
