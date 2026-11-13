// Baixa o Cobalt (https://github.com/imputnet/cobalt) e prepara uma cópia
// enxuta da API em vendor/cobalt, pronta pra rodar como servidor local.
//
// Uso: npm run setup            (pega a versão mais recente)
//      npm run setup -- <ref>   (pega um commit/tag específico)

import { execFileSync, execSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'vendor', 'cobalt');
const ref = process.argv[2];

const tmp = mkdtempSync(join(tmpdir(), 'cobalt-'));
console.log('> clonando cobalt...');
execFileSync('git', ['clone', ...(ref ? [] : ['--depth', '1']), 'https://github.com/imputnet/cobalt', tmp], { stdio: 'inherit' });
if (ref) execFileSync('git', ['-C', tmp, 'checkout', ref], { stdio: 'inherit' });
const commit = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD']).toString().trim();

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(tmp, 'api', 'src'), join(dest, 'src'), { recursive: true });
cpSync(join(tmp, 'api', 'LICENSE'), join(dest, 'LICENSE'));

const pkg = JSON.parse(readFileSync(join(tmp, 'api', 'package.json'), 'utf8'));

// O Cobalt pede a cifra pelo apelido "aes256", que só o OpenSSL conhece.
// O Electron usa BoringSSL, então trocamos pelo nome canônico do mesmo
// algoritmo. Sem isso, todo link que passa pelo túnel do Cobalt falha.
const cryptoFile = join(dest, 'src', 'misc', 'crypto.js');
const cryptoSource = readFileSync(cryptoFile, 'utf8');
if (!cryptoSource.includes('"aes256"')) {
    throw new Error('O trecho de criptografia do Cobalt mudou; revise o ajuste em setup-cobalt.mjs.');
}
writeFileSync(cryptoFile, cryptoSource.replace('"aes256"', '"aes-256-cbc"'));

// O Cobalt lê versão/commit de um repositório git que não existe na cópia
// enxuta, então trocamos esse pacote por um com valores fixos.
const stub = (name, files) => {
    const dir = join(dest, 'stubs', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: files.pkgName, version: '0.0.0', type: 'module', main: 'index.js',
    }, null, 2));
    writeFileSync(join(dir, 'index.js'), files.index);
};

stub('version-info', {
    pkgName: '@imput/version-info',
    index: [
        `export const getCommit = async () => ${JSON.stringify(commit)};`,
        `export const getBranch = async () => "main";`,
        `export const getRemote = async () => "imputnet/cobalt";`,
        `export const getVersion = async () => ${JSON.stringify(pkg.version)};`,
        '',
    ].join('\n'),
});

// isolated-vm é um módulo nativo usado só pelo extrator de YouTube do Cobalt.
// No Baixador o YouTube vai pelo yt-dlp, então um substituto vazio basta e
// evita precisar compilar código nativo.
stub('isolated-vm', {
    pkgName: 'isolated-vm',
    index: [
        'class Isolate { constructor() { throw new Error("isolated-vm desativado no Baixador"); } }',
        'export default { Isolate };',
        '',
    ].join('\n'),
});

pkg.dependencies['@imput/version-info'] = 'file:./stubs/version-info';
pkg.dependencies['isolated-vm'] = 'file:./stubs/isolated-vm';
delete pkg.optionalDependencies;
delete pkg.scripts;
writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg, null, 4));
writeFileSync(join(dest, 'COMMIT'), commit + '\n');

// Ponto de entrada usado pelo app: inicia a API e a encerra quando o
// Baixador fecha (o stdin é o "cordão" entre os dois processos).
writeFileSync(join(dest, 'run.mjs'), [
    '// Ponto de entrada usado pelo Baixador. Inicia a API do Cobalt e a encerra',
    '// assim que o app que a abriu fecha (o stdin é o "cordão" entre os dois).',
    "process.stdin.on('end', () => process.exit(0));",
    "process.stdin.on('close', () => process.exit(0));",
    "process.stdin.on('error', () => process.exit(0));",
    'process.stdin.resume();',
    '',
    "await import('./src/cobalt.js');",
    '',
].join('\n'));

console.log('> instalando dependências do cobalt...');
execSync('npm install --omit=dev --install-links --no-audit --no-fund', { cwd: dest, stdio: 'inherit' });

// Quem baixa o ffmpeg é o script de instalação do ffmpeg-static. O npm 12 não
// roda mais esses scripts sem autorização, então rodamos à mão se faltar.
const ffmpegDir = join(dest, 'node_modules', 'ffmpeg-static');
if (!existsSync(join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))) {
    console.log('> baixando o ffmpeg...');
    execFileSync(process.execPath, ['install.js'], { cwd: ffmpegDir, stdio: 'inherit' });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`> pronto: cobalt ${pkg.version} (${commit.slice(0, 7)}) em vendor/cobalt`);
