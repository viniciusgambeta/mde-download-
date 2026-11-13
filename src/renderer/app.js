/* global api, ICONS, BADGES */
// "api" é a ponte exposta pelo preload.js.

const $ = (selector) => document.querySelector(selector);

document.documentElement.classList.toggle('is-mac', api.platform === 'darwin');

const els = {
    app: $('#app'),
    palette: $('#palette'),
    url: $('#url'),
    clear: $('#clear'),
    result: $('#result'),
    sites: $('#sites'),
    list: $('#list'),
    sheet: $('#settings'),
    openSettings: $('#open-settings'),
    pickFolder: $('#pick-folder'),
    quality: $('#quality'),
    igToggle: $('#ig-toggle'),
    openFolderToggle: $('#open-folder-toggle'),
    whisperCard: $('#whisper-card'),
    whisperToggle: $('#whisper-toggle'),
};

const QUALITY_LABELS = { max: 'Máx', 2160: '4K', 1440: '1440p', 1080: '1080p', 720: '720p', 480: '480p' };

let settings = { quality: '1080', qualities: [], outDir: '', instagram: false, openFolder: true };
let detection = null;
let detectSeq = 0;
let lastClip = '';
const rows = new Map();

// Cria um elemento. O texto sempre entra como texto puro (nunca como HTML),
// já que títulos vêm da internet.
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function iconButton(icon, title, onClick) {
    const button = el('button', 'icon-btn');
    button.innerHTML = icon;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return button;
}

const badgeFor = (platform) => BADGES[platform] || BADGES.generic;
const badgeClass = (platform) => (BADGES[platform] ? platform : 'generic');
// Na lista os ícones são em uma cor só; o do YouTube precisa do contorno.
const listIconFor = badgeFor;

/* ---------- campo de link e sugestão de ações ---------- */

function reset() {
    els.url.value = '';
    detection = null;
    detectSeq++;
    els.clear.hidden = true;
    renderResult();
    els.url.focus();
}

function setLink(text) {
    els.url.value = String(text || '').trim();
    onInput();
    els.url.focus();
}

async function onInput() {
    const text = els.url.value.trim();
    els.clear.hidden = !text;
    const seq = ++detectSeq;

    if (!text) {
        detection = null;
        renderResult();
        return;
    }

    const det = await api.detect(text);
    if (seq !== detectSeq) return;
    detection = det;
    renderResult();

    if (det.ok && det.platform === 'youtube' && det.kind !== 'playlist') {
        const info = await api.preview(text);
        if (seq !== detectSeq || !info) return;
        const title = els.result.querySelector('.result-title');
        const sub = els.result.querySelector('.result-sub');
        if (title && info.title) title.textContent = info.title;
        if (sub && info.author) sub.textContent = `${det.site} · ${info.author}`;
    }
}

function renderResult() {
    const box = els.result;
    box.replaceChildren();
    els.sites.classList.toggle('is-hidden', Boolean(detection) || !els.whisperCard.hidden);

    if (!detection) {
        box.hidden = true;
        return;
    }
    box.hidden = false;

    if (!detection.ok) {
        box.append(el('div', 'result-note', detection.reason || 'Isso não parece um link.'));
        return;
    }

    const det = detection;

    const info = el('div', 'result-info');
    if (det.platform === 'youtube' && det.kind !== 'playlist') {
        const thumb = el('img', 'preview-thumb');
        thumb.src = `https://i.ytimg.com/vi/${encodeURIComponent(det.id)}/mqdefault.jpg`;
        thumb.alt = '';
        info.append(thumb);
    } else {
        const badge = el('div', `badge ${badgeClass(det.platform)}`);
        badge.innerHTML = badgeFor(det.platform);
        info.append(badge);
    }
    const text = el('div', 'result-text');
    if (det.username) {
        text.append(el('div', 'result-title', `@${det.username}`), el('div', 'result-sub', `${det.kindLabel} · ${det.site}`));
    } else if (det.platform === 'generic') {
        text.append(el('div', 'result-title', det.site), el('div', 'result-sub', 'Vídeo ou áudio'));
    } else {
        text.append(el('div', 'result-title', det.kindLabel), el('div', 'result-sub', det.site));
    }
    info.append(text);
    box.append(info);

    if (det.locked) {
        box.append(el('div', 'result-note', 'Stories e foto de perfil precisam da sua conta do Instagram.'));
        const actions = el('div', 'actions');
        const connect = el('button', 'btn primary');
        connect.append(el('span', '', 'Conectar Instagram'));
        connect.addEventListener('click', connectInstagram);
        actions.append(connect);
        box.append(actions);
        return;
    }

    const actions = el('div', 'actions');
    for (const action of det.actions) {
        const button = el('button', action.primary ? 'btn primary' : 'btn');
        if (action.primary) button.insertAdjacentHTML('beforeend', ICONS.download);
        button.append(el('span', '', action.label));
        if (action.primary) button.insertAdjacentHTML('beforeend', ICONS.enter.replace('<svg', '<svg class="hint-key"'));
        button.addEventListener('click', () => run(action.id));
        actions.append(button);
    }

    if (det.quality) {
        const select = el('select', 'quality-select');
        select.title = 'Qualidade do vídeo';
        for (const quality of settings.qualities) {
            const option = el('option', '', QUALITY_LABELS[quality] || quality);
            option.value = quality;
            option.selected = quality === settings.quality;
            select.append(option);
        }
        select.addEventListener('change', () => saveSettings({ quality: select.value }));
        actions.append(select);
    }
    box.append(actions);
}

function run(actionId) {
    if (!detection || !detection.ok || detection.locked) return;
    lastClip = els.url.value.trim();
    api.jobs.start({ url: detection.url, action: actionId, quality: settings.quality });
    reset();
}

function runPrimary() {
    if (!detection || !detection.ok) return;
    if (detection.locked) connectInstagram();
    else run(detection.actions[0].id);
}

async function connectInstagram() {
    const connected = await api.instagram.connect();
    settings.instagram = connected;
    renderSettings();
    if (els.url.value.trim()) onInput();
    return connected;
}

// Ao voltar pro app com um link novo copiado, ele já aparece no campo.
async function suggestFromClipboard() {
    if (els.url.value.trim()) return;
    const text = String((await api.readClipboard()) || '').trim();
    if (!text || text === lastClip || text.length > 2000) return;
    lastClip = text;
    const det = await api.detect(text);
    if (det.ok && !els.url.value.trim()) setLink(det.url);
}

/* ---------- lista de downloads ---------- */

const fileName = (file) => file.split(/[\\/]/).pop();

function titleFor(job) {
    if (job.title) return job.title;
    if (job.files.length) return fileName(job.files[0]);
    return job.url.replace(/^https?:\/\/(www\.)?/, '');
}

function subFor(job) {
    const what = job.action === 'media' ? job.kindLabel : job.actionLabel;
    const base = `${what} · ${job.site}`;
    if (job.status === 'error') return job.error || 'Não deu pra baixar.';
    if (job.status === 'queued') return `${base} · Na fila`;
    if (job.status === 'done') return job.files.length > 1 ? `${base} · ${job.files.length} arquivos` : base;
    const parts = [base];
    if (job.progress != null) parts.push(`${Math.round(job.progress * 100)}%`);
    if (job.detail) parts.push(job.detail);
    if (job.progress == null && !job.detail) parts.push('Preparando');
    return parts.join(' · ');
}

function createRow(job) {
    const item = el('li', 'item');
    const thumb = el('div', 'item-thumb');
    const text = el('div', 'item-text');
    const title = el('div', 'item-title');
    const sub = el('div', 'item-sub');
    const subIcon = el('span', 'item-sub-icon');
    const subText = el('span');
    sub.append(subIcon, subText);
    text.append(title, sub);
    const actions = el('div', 'item-actions');
    const progress = el('div', 'item-progress');
    const bar = el('i');
    progress.append(bar);
    item.append(thumb, text, actions, progress);

    item.addEventListener('click', () => {
        const current = rows.get(job.id).job;
        if (current.status !== 'done') return;
        if (current.files.length === 1) api.openFile(current.files[0]);
        else api.showFile(current.files[0]);
    });
    // Arrastar a linha leva o arquivo de verdade pra outro programa.
    item.addEventListener('dragstart', (event) => {
        event.preventDefault();
        if (rows.get(job.id).job.status === 'done') api.dragJob(job.id);
    });

    const row = { job, item, thumb, title, subIcon, subText, actions, progress, bar, thumbKey: null, actionsKey: null };
    rows.set(job.id, row);
    els.list.prepend(item);
    return row;
}

function upsertRow(job) {
    const row = rows.get(job.id) || createRow(job);
    row.job = job;
    const { item } = row;

    item.className = `item is-${job.status}`;
    item.draggable = job.status === 'done';
    item.title = job.status === 'done' ? 'Clique pra abrir · arraste pra usar em outro programa' : '';

    const thumbKey = job.thumb || `badge:${job.platform}`;
    if (row.thumbKey !== thumbKey) {
        row.thumbKey = thumbKey;
        row.thumb.replaceChildren();
        if (job.thumb) {
            const image = el('img');
            image.src = job.thumb;
            image.alt = '';
            row.thumb.append(image);
        } else {
            row.thumb.innerHTML = listIconFor(job.platform);
        }
    }

    row.title.textContent = titleFor(job);
    row.subText.textContent = subFor(job);
    row.subIcon.innerHTML = job.status === 'done' ? ICONS.check : job.status === 'error' ? ICONS.alert : '';
    row.subIcon.hidden = !row.subIcon.innerHTML;

    const actionsKey = `${job.status}:${job.errorCode || ''}:${job.action}:${whisper.state === 'unavailable'}`;
    if (row.actionsKey !== actionsKey) {
        row.actionsKey = actionsKey;
        row.actions.replaceChildren();
        if (job.status === 'done') {
            row.actions.append(iconButton(ICONS.folder, 'Mostrar na pasta', () => api.showFile(row.job.files[0])));
        }
        if (job.status === 'error') {
            if (job.errorCode === 'ig-login') {
                const connect = el('button', 'text-btn', 'Conectar');
                connect.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    if (await connectInstagram()) api.jobs.retry(job.id);
                });
                row.actions.append(connect);
            } else if (job.errorCode === 'no-whisper') {
                // Precisa do Whisper e ele não está neste computador: leva pra
                // oferta de download (que mostra o tamanho e pede confirmação).
                // Onde o download não existe (macOS, por enquanto) fica só o aviso.
                if (whisper.state !== 'unavailable') {
                    const install = el('button', 'text-btn is-strong', 'Baixar Whisper');
                    install.addEventListener('click', (event) => {
                        event.stopPropagation();
                        offerWhisper(job.id);
                    });
                    row.actions.append(install);
                }
            } else {
                // Não achou legenda pronta: oferece transcrever o áudio com o Whisper.
                if (job.action === 'transcript' && whisper.state !== 'unavailable') {
                    const useWhisper = el('button', 'text-btn is-strong', 'Usar Whisper');
                    useWhisper.title = 'Transcrever o áudio com o Whisper';
                    useWhisper.addEventListener('click', (event) => {
                        event.stopPropagation();
                        if (whisper.state === 'ready') api.jobs.retry(job.id, 'whisper');
                        else offerWhisper(job.id, 'whisper');
                    });
                    row.actions.append(useWhisper);
                }
                if (job.errorCode !== 'no-subs') {
                    row.actions.append(iconButton(ICONS.retry, 'Tentar de novo', () => api.jobs.retry(job.id)));
                }
            }
        }
        const running = job.status === 'running' || job.status === 'queued';
        row.actions.append(iconButton(ICONS.close, running ? 'Cancelar' : 'Tirar da lista', () => api.jobs.remove(job.id)));
    }

    const active = job.status === 'running';
    row.progress.hidden = !active;
    row.progress.classList.toggle('is-indeterminate', active && job.progress == null);
    row.bar.style.width = job.progress == null ? '' : `${Math.round(job.progress * 100)}%`;

    els.app.classList.toggle('is-empty', rows.size === 0);
}

function removeRow(id) {
    const row = rows.get(id);
    if (!row) return;
    row.item.remove();
    rows.delete(id);
    els.app.classList.toggle('is-empty', rows.size === 0);
}

/* ---------- Whisper (opcional) ---------- */

// O Whisper transcreve vídeos sem legenda pronta. Ele é opcional: se não
// estiver no computador, o app oferece o download e segue funcionando
// normalmente caso a pessoa recuse.
let whisper = { state: 'ready', asked: true };
let whisperOffer = false;
let whisperError = null;
// Transcrições esperando o Whisper ficar pronto: id do download → ação.
const whisperWaiting = new Map();

function noticeButton(label, primary, onClick) {
    const button = el('button', primary ? 'btn sm primary' : 'btn sm', label);
    button.addEventListener('click', onClick);
    return button;
}

function renderWhisper() {
    const card = els.whisperCard;
    const installing = whisper.state === 'installing';
    const visible = installing || Boolean(whisperError) || (whisperOffer && whisper.state === 'missing');
    card.hidden = !visible;
    els.sites.classList.toggle('is-hidden', visible || Boolean(detection));

    if (visible) {
        const title = card.querySelector('.notice-title');
        const text = card.querySelector('.notice-text');
        const progress = card.querySelector('.notice-progress');
        const actions = card.querySelector('.notice-actions');
        actions.replaceChildren();
        progress.hidden = !installing;

        if (installing) {
            const percent = Math.round((whisper.progress || 0) * 100);
            title.textContent = 'Baixando o Whisper';
            text.textContent = `${percent}% · ${whisper.detail || 'Preparando'}`;
            progress.firstElementChild.style.width = `${percent}%`;
            actions.append(noticeButton('Cancelar', false, () => api.whisper.cancel()));
        } else if (whisperError) {
            title.textContent = 'Não deu pra baixar o Whisper';
            text.textContent = whisperError;
            actions.append(noticeButton('Tentar de novo', true, installWhisper), noticeButton('Fechar', false, dismissWhisper));
        } else {
            title.textContent = 'Transcrever vídeos sem legenda?';
            text.textContent = `O Whisper roda neste computador. Download único de ${whisper.sizeMB || 560} MB.`;
            actions.append(noticeButton('Baixar', true, installWhisper), noticeButton('Agora não', false, dismissWhisper));
        }
    }

    const toggle = els.whisperToggle;
    toggle.replaceChildren();
    toggle.disabled = whisper.state !== 'missing';
    toggle.classList.toggle('is-off', whisper.state === 'unavailable');
    if (whisper.state === 'unavailable') {
        toggle.append(el('span', '', 'Indisponível'));
        toggle.title = 'Nesta versão o Whisper só funciona se o faster-whisper já estiver instalado no Python deste computador';
    } else if (whisper.state === 'ready') {
        toggle.append(el('span', 'dot'), el('span', '', 'Pronto'));
        toggle.title = whisper.backend === 'python'
            ? 'Usando o faster-whisper do Python deste computador'
            : 'Instalado pelo app (whisper.cpp)';
    } else if (installing) {
        toggle.append(el('span', '', `Baixando ${Math.round((whisper.progress || 0) * 100)}%`));
        toggle.title = '';
    } else {
        toggle.append(el('span', '', `Baixar · ${whisper.sizeMB || 580} MB`));
        toggle.title = 'Opcional: transcreve vídeos que não têm legenda pronta';
    }
}

// Mostra a oferta de download. jobId/action: transcrição a refazer quando terminar.
function offerWhisper(jobId, action) {
    if (jobId) whisperWaiting.set(jobId, action);
    whisperOffer = true;
    whisperError = null;
    toggleSheet(false);
    renderWhisper();
}

function dismissWhisper() {
    whisperOffer = false;
    whisperError = null;
    whisperWaiting.clear();
    api.whisper.dismiss();
    renderWhisper();
}

async function installWhisper() {
    whisperOffer = false;
    whisperError = null;
    whisper = { ...whisper, state: 'installing', progress: 0, detail: 'Preparando' };
    renderWhisper();

    const result = await api.whisper.install();
    whisper = await api.whisper.status();
    if (result.ok) {
        for (const [id, action] of whisperWaiting) api.jobs.retry(id, action);
        whisperWaiting.clear();
    } else {
        // error vem vazio quando a própria pessoa cancelou.
        whisperError = result.error;
    }
    renderWhisper();
}

/* ---------- ajustes ---------- */

async function saveSettings(patch) {
    settings = await api.settings.set(patch);
    renderSettings();
}

function renderSettings() {
    const parts = settings.outDir.split(/[\\/]/).filter(Boolean);
    els.pickFolder.textContent = parts.slice(-2).join(' › ') || 'Escolher';
    els.pickFolder.title = `${settings.outDir}\nClique pra trocar`;

    els.quality.replaceChildren();
    for (const quality of settings.qualities) {
        const button = el('button', '', QUALITY_LABELS[quality] || quality);
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(quality === settings.quality));
        button.addEventListener('click', () => saveSettings({ quality }));
        els.quality.append(button);
    }

    els.openFolderToggle.setAttribute('aria-checked', String(Boolean(settings.openFolder)));

    els.igToggle.replaceChildren();
    els.igToggle.classList.toggle('is-on', settings.instagram);
    if (settings.instagram) {
        els.igToggle.append(el('span', 'dot'), el('span', 'when-idle', 'Conectado'), el('span', 'when-hover', 'Desconectar'));
    } else {
        els.igToggle.append(el('span', '', 'Conectar'));
    }

    const select = els.result.querySelector('.quality-select');
    if (select) select.value = settings.quality;
}

function toggleSheet(open) {
    const show = open === undefined ? els.sheet.hidden : open;
    els.sheet.hidden = !show;
    els.openSettings.classList.toggle('is-active', show);
}

/* ---------- eventos ---------- */

$('#open-folder').innerHTML = ICONS.folder;
els.openSettings.innerHTML = ICONS.sliders;
els.clear.innerHTML = ICONS.close;
$('#field-icon').innerHTML = ICONS.link;
els.sites.innerHTML = ['youtube', 'instagram', 'tiktok', 'x', 'generic'].map((key) => BADGES[key]).join('');

els.url.addEventListener('input', onInput);
els.clear.addEventListener('click', reset);
$('#open-folder').addEventListener('click', () => api.openFolder());
$('#clear-list').addEventListener('click', () => api.jobs.clear());

els.openSettings.addEventListener('click', (event) => { event.stopPropagation(); toggleSheet(); });
els.sheet.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', () => toggleSheet(false));

els.pickFolder.addEventListener('click', async () => {
    settings = await api.settings.pickFolder();
    renderSettings();
});
els.openFolderToggle.addEventListener('click', () => saveSettings({ openFolder: !settings.openFolder }));
els.whisperToggle.addEventListener('click', () => { if (whisper.state === 'missing') offerWhisper(); });
els.igToggle.addEventListener('click', async () => {
    if (settings.instagram) {
        settings.instagram = await api.instagram.disconnect();
        renderSettings();
        if (els.url.value.trim()) onInput();
    } else {
        connectInstagram();
    }
});

// Colar em qualquer lugar da janela substitui o link atual.
document.addEventListener('paste', (event) => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    lastClip = text.trim();
    setLink(text);
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
        if (event.target.closest('button, select')) return;
        event.preventDefault();
        runPrimary();
    } else if (event.key === 'Escape') {
        if (!els.sheet.hidden) toggleSheet(false);
        else reset();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
        && !event.target.closest('input, select, button')) {
        els.url.focus();
    }
});

// Também dá pra soltar um link arrastado do navegador.
window.addEventListener('dragover', (event) => {
    event.preventDefault();
    els.palette.classList.add('is-dragover');
});
window.addEventListener('dragleave', () => els.palette.classList.remove('is-dragover'));
window.addEventListener('drop', (event) => {
    event.preventDefault();
    els.palette.classList.remove('is-dragover');
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (text) setLink(text.split(/\r?\n/)[0]);
});

api.on('job', upsertRow);
api.on('job-removed', removeRow);
api.on('whisper', (status) => {
    // Durante o download chegam vários avisos de andamento.
    if (status.state === 'installing') {
        whisper = { ...whisper, ...status };
        renderWhisper();
    }
});
api.on('focus', () => {
    els.url.focus();
    suggestFromClipboard();
});

(async () => {
    settings = await api.settings.get();
    renderSettings();
    (await api.jobs.list()).forEach(upsertRow);
    suggestFromClipboard();

    // Confere se o Whisper existe neste computador. Se não existir e ainda
    // não tivermos perguntado, oferece o download (uma vez só).
    whisper = await api.whisper.status();
    whisperOffer = whisper.state === 'missing' && !whisper.asked;
    renderWhisper();
    // Os botões de cada linha dependem de o Whisper poder ser oferecido.
    for (const row of rows.values()) upsertRow(row.job);
})();
