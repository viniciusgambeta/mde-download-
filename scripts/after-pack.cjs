// Roda depois que o electron-builder monta a pasta do app e antes de ele
// assinar: copia o Cobalt (com as dependências dele) pra dentro dos recursos.
//
// Isso é feito aqui, e não via "extraResources", porque o electron-builder
// descarta qualquer pasta node_modules que venha por extraResources.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Arch } = require('electron-builder');

exports.default = async function afterPack(context) {
    const mac = context.electronPlatformName === 'darwin';
    const from = path.join(context.packager.projectDir, 'vendor', 'cobalt');
    // No macOS o app é uma pasta ".app" e os recursos ficam dentro dela.
    const resources = mac
        ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
        : path.join(context.appOutDir, 'resources');
    const to = path.join(resources, 'cobalt');

    const ffmpegDir = path.join(from, 'node_modules', 'ffmpeg-static');
    const ready = fs.existsSync(path.join(from, 'run.mjs'))
        && fs.existsSync(path.join(ffmpegDir, mac ? 'install.js' : 'ffmpeg.exe'));
    if (!ready) {
        throw new Error('vendor/cobalt não está preparado. Rode "npm run setup" antes de empacotar.');
    }

    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, {
        recursive: true,
        // As pastas ".bin" só têm atalhos de linha de comando, que o app não
        // usa. No macOS eles são links simbólicos, e um link apontando pra
        // fora do app invalida a assinatura.
        filter: (source) => path.basename(source) !== '.bin',
        verbatimSymlinks: true,
    });

    if (mac) {
        prepareMacFfmpeg(path.join(to, 'node_modules', 'ffmpeg-static'), Arch[context.arch]);
        const fileName = context.packager.appInfo.sanitizedProductName;
        assertPlainMacName(fileName);
        localizeMacName(resources, context.packager.info.metadata.productName, fileName);
    }
};

// No macOS os arquivos do app não podem ter acento no nome. O Electron, ao
// abrir, compara letra por letra o caminho dos programas auxiliares dele
// ("... Helper") com o que está no disco, e uma letra acentuada pode estar
// gravada de dois jeitos ("á" inteiro ou "a" + acento). O disco do .dmg grava
// do segundo jeito, a comparação falha e o app fecha no instante em que abre.
// Por isso o "npm run dist:mac" gera o app como "Me da um Download".
function assertPlainMacName(fileName) {
    if (/[^\x20-\x7e]/.test(fileName)) {
        throw new Error(`O nome "${fileName}" tem acento, e no macOS isso faz o app fechar ao abrir. `
            + 'Gere pelo "npm run dist:mac", que usa um nome sem acento.');
    }
}

// O nome com acento continua aparecendo no Finder, no Dock e na barra de
// menus: o macOS mostra o nome "traduzido" que encontra nestes arquivos, um
// por idioma, desde que o nome do arquivo do app seja o do Info.plist.
function localizeMacName(resources, shownName, fileName) {
    if (!shownName || shownName === fileName) return;
    const quoted = shownName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const strings = Buffer.from(`﻿"CFBundleDisplayName" = "${quoted}";\n"CFBundleName" = "${quoted}";\n`, 'utf16le');
    const languages = new Set(fs.readdirSync(resources).filter((name) => name.endsWith('.lproj')));
    for (const name of ['en.lproj', 'pt_BR.lproj', 'pt_PT.lproj']) languages.add(name);
    for (const name of languages) {
        fs.mkdirSync(path.join(resources, name), { recursive: true });
        fs.writeFileSync(path.join(resources, name, 'InfoPlist.strings'), strings);
    }
}

// O "npm run setup" baixa o ffmpeg do processador da máquina que está gerando
// o app. Como a mesma máquina gera a versão Apple Silicon (arm64) e a Intel
// (x64), aqui conferimos o ffmpeg que foi copiado e, se for do processador
// errado, pedimos ao próprio ffmpeg-static que baixe o certo.
function prepareMacFfmpeg(dir, arch) {
    if (arch !== 'arm64' && arch !== 'x64') {
        throw new Error(`Não sei preparar o ffmpeg para "${arch}". Gere o app para arm64 e x64 separadamente.`);
    }
    const binary = path.join(dir, 'ffmpeg');
    const matches = () => fs.existsSync(binary) && machoArchs(binary).includes(arch);

    if (!matches()) {
        for (const name of fs.readdirSync(dir)) {
            if (/^ffmpeg(\.exe)?(\.|$)/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
        }
        const env = { ...process.env, npm_config_platform: 'darwin', npm_config_arch: arch };
        delete env.FFMPEG_BIN;
        execFileSync(process.execPath, ['install.js'], { cwd: dir, env, stdio: 'inherit' });
    }
    if (!matches()) throw new Error(`O ffmpeg embutido não é um executável do macOS para ${arch}.`);
    fs.chmodSync(binary, 0o755);
}

// Lê, no cabeçalho de um executável do macOS, pra quais processadores ele serve.
function machoArchs(file) {
    const CPUS = new Map([[0x01000007, 'x64'], [0x0100000c, 'arm64']]);
    const head = Buffer.alloc(256);
    const fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    if (read < 8) return [];

    const magic = head.readUInt32BE(0);
    // Executável de 64 bits pra um processador só.
    if (magic === 0xcffaedfe) return [CPUS.get(head.readUInt32LE(4))].filter(Boolean);
    // Executável "universal": uma lista de processadores, 20 bytes por item.
    if (magic === 0xcafebabe) {
        const count = Math.min(head.readUInt32BE(4), Math.floor((read - 8) / 20));
        return Array.from({ length: count }, (_, i) => CPUS.get(head.readUInt32BE(8 + i * 20))).filter(Boolean);
    }
    return [];
}

exports.machoArchs = machoArchs;
exports.prepareMacFfmpeg = prepareMacFfmpeg;
exports.assertPlainMacName = assertPlainMacName;
exports.localizeMacName = localizeMacName;
