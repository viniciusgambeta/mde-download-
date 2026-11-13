const { app, BrowserWindow, Tray, ipcMain, clipboard, shell, dialog, nativeTheme, nativeImage, Menu, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_NAME = 'Me dá um Download';
const APP_ID = 'local.medaumdownload.app';

app.setName(APP_NAME);
// O Electron põe o nome do app na identificação enviada aos sites (cabeçalho
// User-Agent). O acento de "dá" faz alguns servidores recusarem o pedido (o de
// mídia do Instagram responde HTTP 400), então tiramos esse trecho.
app.userAgentFallback = app.userAgentFallback.replace(/ \S+\/\S+(?= Chrome\/)/, '');
// A pasta de dados usa um nome sem acentos de propósito: alguns programas
// externos (como o Whisper) tropeçam em caminhos acentuados no Windows.
// No macOS ela fica em ~/Library/Application Support/MeDaUmDownload.
// Em desenvolvimento, MDD_USERDATA permite testar com dados isolados.
app.setPath('userData', (!app.isPackaged && process.env.MDD_USERDATA)
    || path.join(app.getPath('appData'), 'MeDaUmDownload'));

if (!app.isPackaged && process.argv.some((a) => a.startsWith('--theme='))) {
    nativeTheme.themeSource = process.argv.find((a) => a.startsWith('--theme=')).slice('--theme='.length);
}
// Nas capturas de teste a janela pode estar coberta por outras; sem isto o
// Chromium para de redesenhar e a captura sai desatualizada.
const SHOTS_MODE = !app.isPackaged && process.argv.some((a) => a.startsWith('--shots='));
if (SHOTS_MODE) {
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

const settings = require('./settings');
const jobs = require('./jobs');
const bins = require('./bins');
const { detect } = require('./detect');
const cobalt = require('./engines/cobalt');
const instagram = require('./engines/instagram');
const youtube = require('./engines/youtube');
const whisper = require('./engines/whisper');
const { isWin, isMac } = require('./platform');

const ICON_PNG = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');
const ICON_ICO = path.join(__dirname, '..', 'renderer', 'assets', 'icon.ico');
// Ícone pequeno da barra de menus do macOS (18 pontos; a versão "@2x", pras
// telas Retina, é carregada sozinha pelo Electron).
const ICON_TRAY_MAC = path.join(__dirname, '..', 'renderer', 'assets', 'tray-mac.png');

let win = null;
let tray = null;
let quitting = false;

const palette = () => (nativeTheme.shouldUseDarkColors
    ? { bg: '#0e0e10', symbol: '#f4f4f5' }
    : { bg: '#f7f7f8', symbol: '#18181b' });

function createWindow() {
    const colors = palette();
    win = new BrowserWindow({
        width: 720,
        height: 720,
        minWidth: 460,
        minHeight: 480,
        show: false,
        title: APP_NAME,
        icon: isWin ? ICON_ICO : ICON_PNG,
        backgroundColor: colors.bg,
        titleBarStyle: 'hidden',
        // Windows: os botões da janela ficam à direita, desenhados por cima da
        // interface. macOS: os três botões ficam à esquerda, numa posição fixa,
        // e a interface reserva o espaço deles (ver ".is-mac .bar" no styles.css).
        ...(isMac
            ? { trafficLightPosition: { x: 16, y: 14 } }
            : { titleBarOverlay: { color: 'rgba(0,0,0,0)', symbolColor: colors.symbol, height: 44 } }),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            // Nos testes de tela a janela pode estar coberta ou a tela bloqueada;
            // sem isto a interface "congela" e a captura sai atrasada.
            backgroundThrottling: !SHOTS_MODE,
        },
    });

    // A interface é só o arquivo local: nada de navegar pra outro lugar.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.on('focus', () => win.webContents.send('focus'));

    // Fechar a janela não encerra o app: ele vai pra bandeja (no macOS, a
    // barra de menus) e os downloads continuam. Pra sair de verdade, use
    // "Sair" no menu do ícone da bandeja (ou Cmd+Q no macOS).
    win.on('close', (event) => {
        if (quitting) return;
        event.preventDefault();
        win.hide();
        showBackgroundHint();
    });
    win.on('closed', () => { win = null; });

    if (!app.isPackaged) {
        win.webContents.on('console-message', (event) => {
            if (event.level === 'error' || event.level === 'warning') {
                console.error(`[interface] ${event.message} (${path.basename(event.sourceId || '')}:${event.lineNumber})`);
            }
        });
        win.webContents.on('preload-error', (_event, file, error) => console.error('[preload]', file, error));
        win.webContents.on('before-input-event', (_event, input) => {
            if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
        });
        runDevShots();
    }
}

// Avisa, uma única vez, que fechar a janela não encerra o app.
function showBackgroundHint() {
    if (!tray || settings.load().trayHintShown) return;
    settings.save({ trayHintShown: true });
    if (isWin) {
        tray.displayBalloon({
            iconType: 'custom',
            icon: nativeImage.createFromPath(ICON_PNG),
            title: APP_NAME,
            content: 'Continuo aqui na bandeja. Os downloads seguem em segundo plano.',
        });
    } else if (Notification.isSupported()) {
        // Os balões da bandeja só existem no Windows; aqui vai uma notificação.
        new Notification({
            title: APP_NAME,
            body: 'Continuo aberto na barra de menus. Os downloads seguem em segundo plano.',
        }).show();
    }
}

function showWindow() {
    if (!win) {
        createWindow();
        return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function quit() {
    quitting = true;
    app.quit();
}

/* ---------- menu do app (macOS) ---------- */

// No macOS é o menu do app que faz Cmd+C, Cmd+V, Cmd+W e Cmd+Q funcionarem;
// sem ele os atalhos somem. No Windows o app segue sem barra de menus.
function applicationMenu() {
    if (!isMac) return null;
    return Menu.buildFromTemplate([
        {
            label: APP_NAME,
            submenu: [
                { role: 'about', label: `Sobre o ${APP_NAME}` },
                { type: 'separator' },
                { role: 'hide', label: `Ocultar ${APP_NAME}` },
                { role: 'hideOthers', label: 'Ocultar Outros' },
                { role: 'unhide', label: 'Mostrar Todos' },
                { type: 'separator' },
                { role: 'quit', label: `Encerrar ${APP_NAME}` },
            ],
        },
        {
            label: 'Editar',
            submenu: [
                { role: 'undo', label: 'Desfazer' },
                { role: 'redo', label: 'Refazer' },
                { type: 'separator' },
                { role: 'cut', label: 'Recortar' },
                { role: 'copy', label: 'Copiar' },
                { role: 'paste', label: 'Colar' },
                { role: 'selectAll', label: 'Selecionar Tudo' },
            ],
        },
        {
            label: 'Janela',
            submenu: [
                { role: 'minimize', label: 'Minimizar' },
                { role: 'close', label: 'Fechar' },
            ],
        },
    ]);
}

/* ---------- bandeja ---------- */

const isActive = (job) => job.status === 'running' || job.status === 'queued';
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function jobLine(job, max) {
    const percent = job.status === 'queued' ? 'Na fila' : job.progress == null ? '…' : `${Math.round(job.progress * 100)}%`;
    const name = job.title || job.url.replace(/^https?:\/\/(www\.)?/, '');
    return `${percent} · ${shorten(name, max)}`;
}

function createTray() {
    tray = new Tray(isMac ? ICON_TRAY_MAC : ICON_ICO);
    tray.on('click', showWindow);
    refreshTray();
}

// Atualiza o texto ao passar o mouse, o menu do botão direito e a barra de
// progresso no ícone da barra de tarefas.
function refreshTray() {
    if (!tray) return;
    const active = jobs.list().filter(isActive);
    const known = active.filter((j) => j.status === 'running' && j.progress != null);
    const average = known.length ? known.reduce((sum, j) => sum + j.progress, 0) / known.length : null;

    const lines = [APP_NAME];
    if (active.length) {
        const count = active.length === 1 ? '1 download em andamento' : `${active.length} downloads em andamento`;
        lines.push(average == null ? count : `${count} · ${Math.round(average * 100)}%`);
        for (const job of active.slice(0, 2)) lines.push(jobLine(job, 24));
    } else {
        lines.push('Nenhum download em andamento');
    }
    // O Windows corta o texto da bandeja em 127 caracteres.
    lastTooltip = lines.join('\n').slice(0, 127);
    tray.setToolTip(lastTooltip);

    tray.setContextMenu(Menu.buildFromTemplate([
        ...(active.length
            ? [...active.slice(0, 8).map((job) => ({ label: jobLine(job, 48), enabled: false })), { type: 'separator' }]
            : []),
        { label: 'Abrir', click: showWindow },
        { label: 'Abrir pasta de downloads', click: () => shell.openPath(settings.outDir()) },
        { type: 'separator' },
        { label: 'Sair', click: quit },
    ]));

    if (win) win.setProgressBar(active.length ? (average == null ? 2 : average) : -1);
}

let trayTimer = null;
function scheduleTrayRefresh() {
    if (trayTimer) return;
    trayTimer = setTimeout(() => {
        trayTimer = null;
        refreshTray();
    }, 500);
}

/* ---------- testes de tela (só em desenvolvimento) ---------- */

// `electron . --shots=roteiro.json` executa passos na interface e salva
// capturas de tela, pra conferir o layout sem clicar.
function runDevShots() {
    const arg = process.argv.find((a) => a.startsWith('--shots='));
    if (!arg) return;
    const steps = JSON.parse(fs.readFileSync(arg.slice('--shots='.length), 'utf8'));
    win.webContents.once('did-finish-load', async () => {
        for (const step of steps) {
            if (step.js) await win.webContents.executeJavaScript(step.js, true).catch((e) => console.error('[shots]', e));
            if (step.main === 'tray') console.error(`TRAY ${JSON.stringify(trayState())}`);
            if (step.main === 'close') win.close();
            if (step.main === 'show') showWindow();
            if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
            if (step.shot && win) {
                // Força um redesenho antes de capturar, pra imagem refletir o estado atual.
                win.webContents.invalidate();
                await new Promise((r) => setTimeout(r, 450));
                fs.writeFileSync(step.shot, (await win.webContents.capturePage()).toPNG());
            }
        }
        quit();
    });
}

let lastTooltip = '';
function trayState() {
    return { tooltip: lastTooltip, visible: win ? win.isVisible() : false };
}

nativeTheme.on('updated', () => {
    if (!win) return;
    const colors = palette();
    win.setBackgroundColor(colors.bg);
    // No macOS os botões da janela são do sistema e trocam de cor sozinhos.
    if (!isMac) win.setTitleBarOverlay({ color: 'rgba(0,0,0,0)', symbolColor: colors.symbol });
});

function registerIpc() {
    ipcMain.handle('detect', async (_e, text) => {
        const det = detect(text);
        if (!det.ok) return det;
        const needsLogin = det.actions.some((a) => a.needs === 'instagram');
        return { ...det, locked: needsLogin && !(await instagram.isConnected()) };
    });

    ipcMain.handle('preview', (_e, text) => {
        const det = detect(text);
        if (det.ok && det.platform === 'youtube' && det.kind !== 'playlist') return youtube.preview(det.url, det.id);
        return null;
    });

    ipcMain.handle('jobs:list', () => jobs.list());
    ipcMain.handle('jobs:start', (_e, payload) => jobs.start(payload));
    ipcMain.handle('jobs:retry', (_e, id, action) => jobs.retry(id, action));
    ipcMain.handle('jobs:remove', (_e, id) => jobs.remove(id));
    ipcMain.handle('jobs:clear', () => jobs.clearFinished());

    // Só abrimos/arrastamos arquivos que o próprio app baixou.
    ipcMain.handle('file:open', (_e, file) => (jobs.ownsFile(file) ? shell.openPath(file) : null));
    ipcMain.handle('file:show', (_e, file) => (jobs.ownsFile(file) ? shell.showItemInFolder(file) : null));
    ipcMain.on('file:drag', (event, id) => {
        const job = jobs.list().find((j) => j.id === id);
        const files = job ? job.files.filter((f) => fs.existsSync(f)) : [];
        if (!files.length) return;
        const icon = job.thumb ? nativeImage.createFromDataURL(job.thumb) : nativeImage.createFromPath(ICON_PNG).resize({ width: 48 });
        event.sender.startDrag({ files, file: files[0], icon });
    });
    ipcMain.handle('folder:open', () => shell.openPath(settings.outDir()));

    const fullSettings = async () => ({
        ...settings.load(),
        qualities: settings.QUALITIES,
        instagram: await instagram.isConnected(),
        version: app.getVersion(),
    });
    ipcMain.handle('settings:get', fullSettings);
    ipcMain.handle('settings:set', (_e, patch) => {
        const { outDir, quality, openFolder } = patch || {};
        settings.save({ outDir, quality, openFolder });
        return fullSettings();
    });
    ipcMain.handle('settings:pick-folder', async () => {
        const picked = await dialog.showOpenDialog(win, {
            title: 'Onde salvar os downloads',
            defaultPath: settings.load().outDir,
            properties: ['openDirectory', 'createDirectory'],
        });
        if (!picked.canceled && picked.filePaths[0]) settings.save({ outDir: picked.filePaths[0] });
        return fullSettings();
    });

    // Whisper (opcional). "asked" diz se já oferecemos o download uma vez.
    const whisperStatus = async () => ({ ...(await whisper.status()), asked: settings.load().whisperAsked });
    const sendWhisper = (payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('whisper', payload);
    };
    ipcMain.handle('whisper:status', whisperStatus);
    ipcMain.handle('whisper:dismiss', () => { settings.save({ whisperAsked: true }); });
    ipcMain.handle('whisper:cancel', () => whisper.cancelInstall());
    ipcMain.handle('whisper:install', async () => {
        settings.save({ whisperAsked: true });
        try {
            await whisper.install((state) => sendWhisper({ state: 'installing', ...state }));
            sendWhisper(await whisperStatus());
            return { ok: true };
        } catch (err) {
            const error = err.canceled || err.name === 'AbortError' ? null : (err.message || 'Falha ao baixar o Whisper.');
            sendWhisper({ ...(await whisperStatus()), error });
            return { ok: false, error };
        }
    });

    ipcMain.handle('ig:connect', () => instagram.connect(win));
    ipcMain.handle('ig:disconnect', async () => { await instagram.disconnect(); return false; });

    ipcMain.handle('clipboard:read', () => clipboard.readText());
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    // Abrir o app de novo (pelo atalho) traz de volta a janela que está na bandeja.
    app.on('second-instance', showWindow);

    app.whenReady().then(() => {
        app.setAppUserModelId(APP_ID);
        Menu.setApplicationMenu(applicationMenu());
        registerIpc();
        jobs.init((channel, payload) => {
            if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
            scheduleTrayRefresh();
        });
        createWindow();
        createTray();
        // macOS: clicar no ícone do Dock traz de volta a janela escondida.
        app.on('activate', () => showWindow());

        // Deixa os motores prontos em segundo plano.
        cobalt.start().catch(() => {});
        bins.ensureYtDlp().then(() => bins.updateYtDlpInBackground()).catch(() => {});
    });

    // Com a janela escondida na bandeja o app continua vivo.
    app.on('window-all-closed', () => {});
    app.on('before-quit', () => { quitting = true; });
    app.on('will-quit', () => {
        jobs.cancelAll();
        cobalt.stop();
    });
}
