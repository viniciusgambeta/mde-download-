// Motor Instagram: stories, destaques, foto de perfil e posts, usando a
// sessão logada dentro do próprio app.
//
// O login acontece numa janela do Instagram de verdade; o app nunca vê a
// senha, só reaproveita a sessão (cookies) que fica guardada nesta máquina.

const { BrowserWindow, session } = require('electron');
const direct = require('./direct');

const PARTITION = 'persist:instagram';
const APP_ID = '936619743392459';
const ORIGIN = 'https://www.instagram.com';

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

async function isConnected() {
    return Boolean(await cookie('sessionid'));
}

let loginWindow = null;

// Abre a tela de login do Instagram e resolve quando a sessão existir
// (true) ou quando a janela for fechada sem login (false).
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

        const onCookie = (_event, changed, _cause, removed) => {
            if (changed.name === 'sessionid' && !removed && changed.value) {
                // Dá um instante pro Instagram terminar de gravar os outros cookies.
                setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 1500);
            }
        };
        s.cookies.on('changed', onCookie);

        win.on('closed', () => {
            s.cookies.removeListener('changed', onCookie);
            loginWindow = null;
            s.cookies.flushStore().catch(() => {}).then(() => isConnected()).then(resolve);
        });

        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.loadURL(`${ORIGIN}/accounts/login/`);
    });
}

async function disconnect() {
    await ses().clearStorageData();
}

class IgError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

async function api(pathname) {
    if (!(await isConnected())) throw new IgError('Conecte o Instagram pra baixar isso.', 'ig-login');

    let res;
    try {
        res = await ses().fetch(`${ORIGIN}/api/v1/${pathname}`, {
            credentials: 'include',
            redirect: 'manual',
            headers: {
                accept: '*/*',
                'x-ig-app-id': APP_ID,
                'x-asbd-id': '359341',
                'x-ig-www-claim': '0',
                'x-requested-with': 'XMLHttpRequest',
                'x-csrftoken': (await cookie('csrftoken')) || '',
                referer: `${ORIGIN}/`,
            },
        });
    } catch {
        throw new IgError('Falha de conexão com o Instagram.', 'network');
    }

    if (res.status === 429) throw new IgError('O Instagram limitou as requisições. Tenta de novo em alguns minutos.', 'rate');
    if (res.status === 404) throw new IgError('Não encontrado no Instagram.', 'not-found');

    let data = null;
    try { data = await res.json(); } catch { /* resposta não era JSON */ }

    const loginNeeded = res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)
        || (data && (data.require_login || data.message === 'login_required' || data.message === 'checkpoint_required'));
    if (loginNeeded) throw new IgError('A sessão do Instagram expirou. Conecte de novo.', 'ig-login');
    if (!res.ok || !data) throw new IgError(`O Instagram respondeu com erro (${res.status}).`, 'http');

    return data;
}

async function profile(username) {
    const data = await api(`users/web_profile_info/?username=${encodeURIComponent(username)}`);
    const user = data && data.data && data.data.user;
    if (!user) throw new IgError(`Perfil @${username} não encontrado.`, 'not-found');
    return user;
}

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

async function avatar({ username, dir }, ctx) {
    const user = await profile(username);
    ctx.meta({ title: `@${user.username}` });

    let url = user.profile_pic_url_hd || user.profile_pic_url;
    // Esse segundo endpoint devolve a foto em resolução cheia; se falhar,
    // ficamos com a versão menor que já temos.
    try {
        const info = await api(`users/${user.id}/info/`);
        const hd = info.user && info.user.hd_profile_pic_url_info && info.user.hd_profile_pic_url_info.url;
        if (hd) url = hd;
    } catch (err) {
        if (err.code === 'ig-login') throw err;
    }
    if (!url) throw new IgError('Esse perfil não tem foto.', 'empty');

    const files = await downloadAll([{ url, name: `${user.username}_perfil` }], dir, ctx);
    return { files, title: `@${user.username}` };
}

async function reel(reelId) {
    const data = await api(`feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`);
    const fromMap = data.reels && (data.reels[reelId] || Object.values(data.reels)[0]);
    const fromList = data.reels_media && data.reels_media[0];
    return fromMap || fromList || null;
}

// storyId opcional: baixa só aquele story em vez de todos.
async function stories({ username, storyId, dir }, ctx) {
    const user = await profile(username);
    ctx.meta({ title: `@${user.username}` });

    const found = await reel(String(user.id));
    let items = (found && found.items) || [];
    if (storyId) {
        items = items.filter((it) => String(it.pk) === String(storyId) || String(it.id).startsWith(`${storyId}_`));
        if (!items.length) throw new IgError('Esse story não está mais disponível.', 'empty');
    }
    if (!items.length) {
        const why = user.is_private && !user.followed_by_viewer
            ? 'Perfil privado: só dá pra ver os stories seguindo a conta.'
            : `@${user.username} não tem stories agora.`;
        throw new IgError(why, 'empty');
    }

    const medias = items
        .map((it) => ({ media: bestMedia(it), pk: it.pk }))
        .filter((m) => m.media)
        .map((m) => ({ url: m.media.url, name: `${user.username}_story_${m.pk}` }));
    const files = await downloadAll(medias, dir, ctx);
    return { files, title: `@${user.username}` };
}

async function highlight({ id, dir }, ctx) {
    const found = await reel(`highlight:${id}`);
    const items = (found && found.items) || [];
    if (!items.length) throw new IgError('Destaque vazio ou indisponível.', 'empty');

    const owner = (found.user && found.user.username) || 'instagram';
    ctx.meta({ title: found.title ? `${found.title} · @${owner}` : `@${owner}` });

    const medias = items
        .map((it) => ({ media: bestMedia(it), pk: it.pk }))
        .filter((m) => m.media)
        .map((m) => ({ url: m.media.url, name: `${owner}_destaque_${m.pk}` }));
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
