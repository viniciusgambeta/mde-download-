// Roda depois que o electron-builder monta a pasta do app: copia o Cobalt
// (com as dependências dele) pra dentro de resources/cobalt.
//
// Isso é feito aqui, e não via "extraResources", porque o electron-builder
// descarta qualquer pasta node_modules que venha por extraResources.

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
    const from = path.join(context.packager.projectDir, 'vendor', 'cobalt');
    const to = path.join(context.appOutDir, 'resources', 'cobalt');

    if (!fs.existsSync(path.join(from, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))) {
        throw new Error('vendor/cobalt não está preparado. Rode "npm run setup" antes de empacotar.');
    }

    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
};
