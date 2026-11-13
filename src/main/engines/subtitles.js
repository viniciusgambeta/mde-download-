// Lê legendas em vários formatos e grava a transcrição em dois arquivos:
// um .txt de texto corrido (pra ler, colar numa IA etc.) e um .srt com os
// tempos (pra usar como legenda num editor de vídeo).

const fs = require('node:fs');
const path = require('node:path');
const { safeName, uniquePath } = require('./direct');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

const clean = (text) => String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();

// Uma legenda não deve continuar na tela depois que a próxima começou
// (as automáticas do YouTube se sobrepõem de propósito).
function fixOverlaps(cues) {
    for (let i = 0; i < cues.length - 1; i++) {
        if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    }
    return cues.filter((cue) => cue.text && cue.end > cue.start);
}

// Formato "json3" do YouTube.
function parseJson3(source) {
    const data = JSON.parse(source);
    const cues = [];
    for (const event of data.events || []) {
        // Eventos "aAppend" só marcam quebra de linha na tela.
        if (!event.segs || event.aAppend) continue;
        const text = clean(event.segs.map((seg) => seg.utf8 || '').join(''));
        if (!text) continue;
        const start = event.tStartMs || 0;
        cues.push({ start, end: start + (event.dDurationMs || 2000), text });
    }
    return fixOverlaps(cues);
}

const toMs = (h, m, s, ms) => ((Number(h || 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, '0'));
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

// WebVTT e SRT (os dois têm a mesma estrutura de blocos com "-->").
function parseTimed(source) {
    const cues = [];
    for (const block of String(source).replace(/\r/g, '').split(/\n{2,}/)) {
        const lines = block.split('\n');
        const at = lines.findIndex((line) => TIME.test(line));
        if (at < 0) continue;
        const m = lines[at].match(TIME);
        const text = clean(lines.slice(at + 1).join(' '));
        if (!text) continue;
        // Legendas "rolantes" repetem a linha anterior; guardamos só o que é novo.
        const previous = cues[cues.length - 1];
        if (previous && previous.text === text) {
            previous.end = toMs(m[5], m[6], m[7], m[8]);
            continue;
        }
        cues.push({ start: toMs(m[1], m[2], m[3], m[4]), end: toMs(m[5], m[6], m[7], m[8]), text });
    }
    return fixOverlaps(cues);
}

function parse(source, format) {
    return format === 'json3' ? parseJson3(source) : parseTimed(source);
}

function stamp(ms) {
    const pad = (n, size = 2) => String(Math.floor(n)).padStart(size, '0');
    return `${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function toSrt(cues) {
    return cues.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n');
}

// Junta as falas em parágrafos: quebra numa pausa longa, ou quando o
// parágrafo já está grande e a frase terminou.
function toText(cues) {
    const paragraphs = [];
    let current = '';
    let lastEnd = 0;
    for (const cue of cues) {
        const pause = cue.start - lastEnd;
        const longEnough = current.length > 450 && /[.!?…]["')]?$/.test(current);
        if (current && (pause > 2500 || longEnough || current.length > 900)) {
            paragraphs.push(current);
            current = '';
        }
        current = current ? `${current} ${cue.text}` : cue.text;
        lastEnd = cue.end;
    }
    if (current) paragraphs.push(current);
    return paragraphs.join('\n\n');
}

// Grava "<nome> transcrição.txt" e ".srt" na pasta e devolve os caminhos.
function write({ cues, dir, name, title, url, source }) {
    if (!cues.length) throw Object.assign(new Error('A legenda veio vazia.'), { code: 'no-subs' });
    fs.mkdirSync(dir, { recursive: true });

    const base = safeName(`${name} transcrição`);
    const txt = uniquePath(dir, `${base}.txt`);
    const srt = path.join(dir, `${path.basename(txt, '.txt')}.srt`);

    const header = [title, url, source ? `Fonte: ${source}` : null].filter(Boolean).join('\n');
    fs.writeFileSync(txt, `${header}\n\n${toText(cues)}\n`, 'utf8');
    fs.writeFileSync(srt, toSrt(cues), 'utf8');
    return [txt, srt];
}

module.exports = { parse, write };
