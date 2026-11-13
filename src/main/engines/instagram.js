// Motor Instagram: stories, destaques, foto de perfil e posts, usando a
// sessão logada dentro do próprio app.
//
// O login acontece numa janela do Instagram de verdade; o app nunca vê a
// senha, só reaproveita a sessão (cookies) que fica guardada nesta máquina.
//
// Como os dados são obtidos (conferido em nov/2026 com uma sessão logada):
//   - Posts: consulta "media/<id>/info" em www.instagram.com, feita de dentro
//     de uma página do próprio Instagram (a "página-ponte").
//   - Stories, destaques e foto de perfil: os endereços diretos que existiam
//     pra isso foram desativados ou respondem vazio pra sessões do site
//     (web_profile_info dá 404; feed/reels_media dá erro 500 no www e volta
//     vazio no i.instagram.com). O site atual busca esses dados por consultas
//     internas cujos identificadores mudam a cada versão. Em vez de copiar
//     esses identificadores, abrimos a página de verdade numa janela invisível
//     e lemos a resposta que o próprio site busca.
//   - Ao abrir a página de stories, o site avisaria o dono de que você viu o
//     story. Esse aviso é bloqueado antes de sair (ver "isSeenReceipt").

const { BrowserWindow, session } = require('electron');
const direct = require('./direct');

const PARTITION = 'persist:instagram';
const APP_ID = '936619743392459';
const ORIGIN = 'https://www.instagram.com';
// Página leve do Instagram, usada só como ponto de partida das consultas de
// posts (não carrega o feed).
const BRIDGE_URL = `${ORIGIN}/robots.txt`;
const BRIDGE_IDLE = 60000;
const CAPTURE_TIMEOUT = 25000;

let configured = false;

// A sessão se apresenta como um Chrome comum (sem "Electron" no user agent).
function ses() {
    const s = session.fromPartition(PARTITION);
    if (!configured) {
        const major = process.versions.chrome.split('.')[0];
        s.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`);
        configured = true;
    }
    return s;
}

async function cookie(name) {
    const found = await ses().cookies.get({ url: ORIGIN, name });
    return found[0] ? found[0].value : null;
}

// Logado = tem o cookie da sessão e o do usuário. Só o primeiro não basta:
// ele pode existir no meio de um login que ainda não terminou.
async function isConnected() {
    return Boolean(await cookie('sessionid')) && Boolean(await cookie('ds_user_id'));
}

class IgError extends Error {
    constructor(message, code, detail) {
        super(message);
        this.code = code;
        if (detail) this.detail = detail;
    }
}

const requireLogin = async () => {
    if (!(await isConnected())) throw new IgError('Conecte o Instagram pra baixar isso.', 'ig-login');
};
const expired = (detail) => new IgError('A sessão do Instagram expirou. Conecte de novo.', 'ig-login', detail);
const rateLimited = (detail) => new IgError('O Instagram limitou as requisições. Tenta de novo em alguns minutos.', 'rate', detail);

function hiddenWindow() {
    ses();
    const win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 900,
        webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return win;
}

/* ---------- posts: consulta feita de dentro de uma página do Instagram ---------- */

// Roda dentro da página (por isso é montada como texto mais abaixo).
async function requestFromPage(path, appId) {
    const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '';
    const res = await fetch(path, {
        credentials: 'include',
        referrer: `${location.origin}/`,
        headers: {
            'x-ig-app-id': appId,
            'x-asbd-id': '359341',
            'x-ig-www-claim': sessionStorage.getItem('www-claim-v2') || '0',
            'x-requested-with': 'XMLHttpRequest',
            'x-csrftoken': csrf,
        },
    });
    return { status: res.status, type: res.headers.get('content-type') || '', url: res.url, text: await res.text() };
}

let bridgeWindow = null;
let bridgeOpening = null;
let bridgeTimer = null;

function closeBridge() {
    clearTimeout(bridgeTimer);
    if (bridgeWindow && !bridgeWindow.isDestroyed()) bridgeWindow.destroy();
    bridgeWindow = null;
}

// Janela invisível numa página do Instagram. Fica aberta por um minuto depois
// do último uso, pra consultas seguidas não pagarem o custo de abrir de novo.
function bridge() {
    clearTimeout(bridgeTimer);
    bridgeTimer = setTimeout(closeBridge, BRIDGE_IDLE);
    if (bridgeWindow && !bridgeWindow.isDestroyed()) return Promise.resolve(bridgeWindow);
    if (bridgeOpening) return bridgeOpening;

    bridgeOpening = (async () => {
        const win = hiddenWindow();
        win.on('closed', () => { if (bridgeWindow === win) bridgeWindow = null; });
        try {
            await win.loadURL(BRIDGE_URL);
        } catch (err) {
            win.destroy();
            throw err;
        }
        bridgeWindow = win;
        return win;
    })().finally(() => { bridgeOpening = null; });

    return bridgeOpening;
}

// Resumo curto da resposta pro registro de falhas (sem cookies nem dados pessoais).
function describe(reply) {
    const head = reply.text.slice(0, 400).replace(/\s+/g, ' ');
    const html = head.match(/<html[^>]*>/i);
    return `HTTP ${reply.status} ${reply.type.split(';')[0]} ${html ? html[0] : head.slice(0, 160)}`;
}

// Consulta em www.instagram.com/api/v1. Atenção: a página de "404" do
// Instagram vem sempre marcada como "not-logged-in", mesmo com a conta logada,
// então ela NÃO serve de sinal de sessão expirada.
async function api(pathname) {
    await requireLogin();

    let reply;
    try {
        const win = await bridge();
        reply = await win.webContents.executeJavaScript(
            `(${requestFromPage.toString()})(${JSON.stringify(`/api/v1/${pathname}`)}, ${JSON.stringify(APP_ID)})`, true);
    } catch (err) {
        throw new IgError('Falha de conexão com o Instagram.', 'network', String(err && err.message).slice(0, 200));
    }

    const detail = `${pathname.split('?')[0]} -> ${describe(reply)}`;
    if (reply.status === 429) throw rateLimited(detail);

    let data = null;
    if (reply.type.includes('json')) {
        try { data = JSON.parse(reply.text); } catch { /* resposta truncada ou inválida */ }
    }

    const askedLogin = data && (data.require_login || data.message === 'login_required' || data.message === 'checkpoint_required');
    if (reply.status === 401 || askedLogin || /\/accounts\/login/.test(reply.url || '')) throw expired(detail);
    if (reply.status === 404) throw new IgError('Não encontrado no Instagram.', 'not-found', detail);
    if (reply.status < 200 || reply.status >= 300 || !data) {
        throw new IgError(`O Instagram respondeu com erro (${reply.status}).`, 'http', detail);
    }
    return data;
}

/* ---------- stories, destaques e perfil: lendo o que a página busca ---------- */

// O site avisa o dono do story de que alguém viu por um pedido cujo nome
// contém "Seen" (ex.: PolarisStoriesV3SeenMutation) ou pelos endereços antigos
// ".../seen". Qualquer pedido assim é barrado antes de sair.
function isSeenReceipt(request) {
    const friendly = request.headers['X-FB-Friendly-Name'] || request.headers['x-fb-friendly-name'] || '';
    return /seen/i.test(friendly)
        || /fb_api_req_friendly_name=[^&]*seen/i.test(request.postData || '')
        || /\/seen\b|[/_]seen[/?]/i.test(request.url);
}

function parseLoose(text) {
    const start = text.indexOf('{');
    if (start < 0) return null;
    try { return JSON.parse(text.slice(start)); } catch { return null; }
}

// Procura, em qualquer profundidade do JSON, objetos que passem no teste.
// Os dados embutidos na página ficam bem fundo (mais de 15 níveis), daí o limite alto.
function findAll(node, test, out = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 60) return out;
    if (!Array.isArray(node) && test(node)) out.push(node);
    for (const value of Array.isArray(node) ? node : Object.values(node)) findAll(value, test, out, depth + 1);
    return out;
}

// Uma captura por vez: abrir duas janelas dessas ao mesmo tempo, ou uma logo
// depois de fechar a outra, faz a segunda falhar ao carregar.
let captureQueue = Promise.resolve();
function capture(pagePath, hint, pick) {
    const run = captureQueue.then(() => captureNow(pagePath, hint, pick));
    captureQueue = run.catch(() => {}).then(() => new Promise((resolve) => setTimeout(resolve, 300)));
    return run;
}

// Abre uma página do Instagram numa janela invisível e acompanha o que chega:
// o documento da página (que já traz dados embutidos) e as respostas das
// consultas internas do site. Cada bloco de dados que combinar com `hint` é
// interpretado e passado a `pick(json)`, que devolve o dado quando achar (ou
// nada, pra continuar esperando). Resolve com o dado, ou null se a página
// terminou de carregar sem trazê-lo.
async function captureNow(pagePath, hint, pick) {
    await requireLogin();
    const win = hiddenWindow();
    const dbg = win.webContents.debugger;

    return new Promise((resolve, reject) => {
        let settled = false;
        const wanted = new Set();
        let idleTimer = null;

        const finish = (settle, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            clearTimeout(idleTimer);
            // Desliga a interceptação antes de fechar a janela, senão a próxima
            // janela pode falhar ao carregar.
            Promise.resolve()
                .then(() => (dbg.isAttached() ? dbg.sendCommand('Fetch.disable') : null))
                .catch(() => {})
                .then(() => {
                    try { if (dbg.isAttached()) dbg.detach(); } catch { /* já solto */ }
                    if (!win.isDestroyed()) win.destroy();
                    settle(value);
                });
        };
        const deadline = setTimeout(() => finish(resolve, null), CAPTURE_TIMEOUT);
        // Depois que a página carrega, se passar um tempo sem nada novo, desistimos.
        const armIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finish(resolve, null), 6000);
        };

        const documents = new Set();
        const inspect = async (requestId, isDocument) => {
            const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId });
            const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
            // No documento, os dados vêm em blocos <script type="application/json">.
            const chunks = isDocument
                ? [...text.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
                : [text];
            for (const chunk of chunks) {
                if (settled) return;
                if (!hint.test(chunk)) continue;
                const json = parseLoose(chunk);
                const value = json && pick(json);
                if (value) return finish(resolve, value);
            }
        };

        dbg.on('message', (_event, method, params) => {
            if (settled) return;
            if (method === 'Fetch.requestPaused') {
                const blocked = isSeenReceipt(params.request);
                // Só em desenvolvimento: mostra o nome de cada consulta interna e se foi barrada.
                if (process.env.MDD_IG_DEBUG) {
                    const name = params.request.headers['X-FB-Friendly-Name'] || params.request.headers['x-fb-friendly-name']
                        || ((params.request.postData || '').match(/fb_api_req_friendly_name=([^&]+)/) || [])[1] || new URL(params.request.url).pathname;
                    console.log(`[instagram] ${blocked ? 'BARRADO ' : 'liberado'} ${name}`);
                }
                const command = blocked
                    ? ['Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }]
                    : ['Fetch.continueRequest', { requestId: params.requestId }];
                dbg.sendCommand(...command).catch(() => {});
            } else if (method === 'Network.responseReceived') {
                const { url, status } = params.response;
                if (params.type === 'Document') {
                    // Outros documentos (ex.: sincronização com o Facebook) não interessam.
                    if (!url.startsWith(ORIGIN) || url === BRIDGE_URL) return;
                    if (/\/accounts\/login/.test(url)) finish(reject, expired(`${pagePath} -> redirecionou pro login`));
                    else if (status === 404) finish(reject, new IgError('Não encontrado no Instagram.', 'not-found', `${pagePath} -> HTTP 404`));
                    else if (status === 429) finish(reject, rateLimited(`${pagePath} -> HTTP 429`));
                    else { wanted.add(params.requestId); documents.add(params.requestId); }
                } else if (/graphql/.test(url)) {
                    wanted.add(params.requestId);
                }
            } else if (method === 'Network.loadingFinished' && wanted.delete(params.requestId)) {
                if (idleTimer) armIdle();
                inspect(params.requestId, documents.has(params.requestId)).catch(() => {});
            }
        });

        win.webContents.once('did-stop-loading', armIdle);

        (async () => {
            // Primeiro uma página leve do Instagram: o acompanhamento da rede só
            // se mantém se for ligado com a janela já dentro do site.
            await win.loadURL(BRIDGE_URL).catch(() => new Promise((r) => setTimeout(r, 600)).then(() => win.loadURL(BRIDGE_URL)));
            dbg.attach('1.3');
            await dbg.sendCommand('Network.enable');
            // Pausa só os pedidos que podem ser o aviso de "visto", pra decidir um a um.
            await dbg.sendCommand('Fetch.enable', {
                patterns: [{ urlPattern: '*graphql*', requestStage: 'Request' }, { urlPattern: '*seen*', requestStage: 'Request' }],
            });
            await win.loadURL(`${ORIGIN}${pagePath}`);
        })().catch((err) => {
            // loadURL "falha" quando a página redireciona; a navegação segue normal.
            if (!/ERR_ABORTED|-3\b/.test(String(err && err.message))) {
                finish(reject, new IgError('Falha de conexão com o Instagram.', 'network', String(err && err.message).slice(0, 200)));
            }
        });
    });
}

const hasMedia = (item) => Boolean(item && (item.image_versions2 || item.video_versions));
const isReel = (node) => Array.isArray(node.items) && node.items.some(hasMedia);

// Escolhe a melhor versão (maior resolução) de um item de mídia.
function bestMedia(item) {
    const area = (v) => (v.width || 0) * (v.height || 0);
    if (item.video_versions && item.video_versions.length) {
        const best = [...item.video_versions].sort((a, b) => area(b) - area(a))[0];
        return { url: best.url, type: 'video' };
    }
    const candidates = item.image_versions2 && item.image_versions2.candidates;
    if (candidates && candidates.length) {
        const best = [...candidates].sort((a, b) => area(b) - area(a))[0];
        return { url: best.url, type: 'photo' };
    }
    return null;
}

async function downloadAll(medias, dir, ctx) {
    const files = [];
    for (let i = 0; i < medias.length; i++) {
        const { url, name } = medias[i];
        const detail = medias.length > 1 ? `${i + 1} de ${medias.length}` : '';
        files.push(await direct.download(url, {
            dir,
            name,
            signal: ctx.signal,
            onProgress: (fraction) => ctx.progress(((fraction || 0) + i) / medias.length, detail),
        }));
    }
    return files;
}

/* ---------- login ---------- */

let loginWindow = null;

// Abre a tela de login do Instagram e resolve quando a pessoa estiver logada
// (true) ou quando a janela for fechada antes (false).
function connect(parent) {
    if (loginWindow) {
        loginWindow.focus();
        return new Promise((resolve) => loginWindow.once('closed', () => isConnected().then(resolve)));
    }

    return new Promise((resolve) => {
        const s = ses();
        const win = new BrowserWindow({
            width: 460,
            height: 740,
            parent,
            title: 'Conectar Instagram',
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        loginWindow = win;

        // De tempos em tempos confere se o login terminou: os dois cookies da
        // sessão existem e a janela já saiu das telas de login, de código de
        // verificação e de confirmação de segurança. A janela só fecha depois
        // de duas conferências seguidas positivas, pra não cortar o Instagram
        // no meio de um redirecionamento.
        let checking = false;
        let positives = 0;
        const check = async () => {
            if (checking || win.isDestroyed()) return;
            checking = true;
            try {
                const path = new URL(win.webContents.getURL()).pathname;
                const stillLoggingIn = /^\/(accounts\/login|accounts\/two_factor|two_factor|challenge|auth_platform)/.test(path);
                positives = (await isConnected()) && !stillLoggingIn ? positives + 1 : 0;
                if (positives >= 2 && !win.isDestroyed()) win.close();
            } catch { /* página trocando; tenta de novo na próxima volta */ } finally {
                checking = false;
            }
        };
        const timer = setInterval(check, 1200);

        win.on('closed', () => {
            clearInterval(timer);
            loginWindow = null;
            s.cookies.flushStore().catch(() => {}).then(() => isConnected()).then(resolve);
        });

        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.loadURL(`${ORIGIN}/accounts/login/`);
    });
}

async function disconnect() {
    closeBridge();
    await ses().clearStorageData();
}

/* ---------- o que dá pra baixar ---------- */

async function avatar({ username, dir }, ctx) {
    ctx.meta({ title: `@${username}` });
    const wanted = username.toLowerCase();
    const isOwner = (node) => typeof node.username === 'string' && node.username.toLowerCase() === wanted
        && Boolean(node.hd_profile_pic_url_info || node.profile_pic_url_hd || node.profile_pic_url);

    // A página do perfil traz os dados do dono em mais de uma resposta. A foto
    // em alta (hd_profile_pic_url_info) vem numa das últimas, então guardamos a
    // versão menor como reserva e seguimos esperando a melhor.
    let fallback = null;
    const best = await capture(`/${encodeURIComponent(username)}/`, /profile_pic/, (json) => {
        const nodes = findAll(json, isOwner);
        const hd = nodes.find((node) => node.hd_profile_pic_url_info && node.hd_profile_pic_url_info.url);
        if (hd) return hd;
        fallback = nodes.find((node) => node.profile_pic_url_hd) || fallback || nodes[0] || null;
        return null;
    });
    const user = best || fallback;
    if (!user) throw new IgError('Não consegui ler esse perfil no Instagram.', 'http', 'página do perfil não trouxe os dados do usuário');

    const url = (user.hd_profile_pic_url_info && user.hd_profile_pic_url_info.url) || user.profile_pic_url_hd || user.profile_pic_url;
    if (!url) throw new IgError('Esse perfil não tem foto.', 'empty');

    const files = await downloadAll([{ url, name: `${user.username}_perfil` }], dir, ctx);
    return { files, title: `@${user.username}` };
}

// Abre a página de stories (ou de um destaque) e devolve o conjunto de itens
// que veio nela. A página pode trazer conjuntos de outras pessoas (a fila de
// stories), então `matches` diz qual é o que queremos.
function reelFrom(pagePath, matches) {
    return capture(pagePath, /"(?:image_versions2|video_versions)"/, (json) => findAll(json, isReel).find(matches) || null);
}

// storyId opcional: baixa só aquele story em vez de todos.
async function stories({ username, storyId, dir }, ctx) {
    ctx.meta({ title: `@${username}` });

    const wanted = username.toLowerCase();
    const found = await reelFrom(`/stories/${encodeURIComponent(username)}/`,
        (r) => Boolean(r.user && typeof r.user.username === 'string' && r.user.username.toLowerCase() === wanted));
    let items = ((found && found.items) || []).filter(hasMedia);
    const owner = (found && found.user && found.user.username) || username;
    if (storyId) {
        items = items.filter((it) => String(it.pk) === String(storyId) || String(it.id).startsWith(`${storyId}_`));
        if (!items.length) throw new IgError('Esse story não está mais disponível.', 'empty');
    }
    if (!items.length) {
        // Pode ser falta de stories ou perfil privado que a conta não segue.
        throw new IgError(`@${username} não tem stories visíveis agora.`, 'empty');
    }

    const medias = items.map((it) => ({ url: bestMedia(it).url, name: `${owner}_story_${it.pk || it.id}` }));
    const files = await downloadAll(medias, dir, ctx);
    return { files, title: `@${owner}` };
}

async function highlight({ id, dir }, ctx) {
    const found = await reelFrom(`/stories/highlights/${encodeURIComponent(id)}/`,
        (r) => String(r.id || '').includes(String(id)) || String(r.reel_type || '').includes('highlight'));
    const items = ((found && found.items) || []).filter(hasMedia);
    if (!items.length) throw new IgError('Destaque vazio ou indisponível.', 'empty');

    const owner = (found.user && found.user.username) || 'instagram';
    ctx.meta({ title: found.title ? `${found.title} · @${owner}` : `@${owner}` });

    const medias = items.map((it) => ({ url: bestMedia(it).url, name: `${owner}_destaque_${it.pk || it.id}` }));
    const files = await downloadAll(medias, dir, ctx);
    return { files, title: `@${owner}` };
}

// O código curto do link (ex.: "CvYrSgnsKjv") é o ID numérico em base 64.
function shortcodeToId(shortcode) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (const ch of shortcode.slice(0, 11)) {
        const value = alphabet.indexOf(ch);
        if (value < 0) throw new IgError('Link de post inválido.', 'not-found');
        id = id * 64n + BigInt(value);
    }
    return id.toString();
}

async function post({ shortcode, dir }, ctx) {
    const data = await api(`media/${shortcodeToId(shortcode)}/info/`);
    const item = data.items && data.items[0];
    if (!item) throw new IgError('Post não encontrado ou privado.', 'not-found');

    const owner = (item.user && item.user.username) || 'instagram';
    ctx.meta({ title: `@${owner}` });

    const parts = item.carousel_media && item.carousel_media.length ? item.carousel_media : [item];
    const medias = parts
        .map((part) => bestMedia(part))
        .filter(Boolean)
        .map((media, i, all) => ({
            url: media.url,
            name: all.length > 1 ? `${owner}_${shortcode}_${i + 1}` : `${owner}_${shortcode}`,
        }));
    if (!medias.length) throw new IgError('Não encontrei mídia nesse post.', 'empty');

    const files = await downloadAll(medias, dir, ctx);
    return { files, title: `@${owner}` };
}

module.exports = { isConnected, connect, disconnect, avatar, stories, highlight, post, shortcodeToId };
