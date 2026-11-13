// O que muda entre o Windows e o macOS fica reunido aqui, pra que o resto do
// código quase não precise perguntar em qual sistema está rodando.

const { spawn } = require('node:child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Opções pra iniciar um programa externo. Fora do Windows ele vira líder de
// um grupo de processos próprio, o que permite encerrar o grupo inteiro depois.
const spawnOptions = (extra = {}) => ({ windowsHide: true, detached: !isWin, ...extra });

// Encerra um programa e tudo o que ele abriu (o yt-dlp, por exemplo, chama o
// ffmpeg). Só alcança os "filhos" se ele foi iniciado com spawnOptions().
function killTree(child) {
    if (!child || !child.pid) return;
    if (isWin) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
        return;
    }
    // Um PID negativo manda o sinal pro grupo todo.
    const signalGroup = (signal) => {
        try { process.kill(-child.pid, signal); } catch { /* o grupo já terminou */ }
    };
    // Primeiro um pedido educado, que dá tempo de o programa apagar os
    // arquivos temporários dele; se não sair em 3 segundos, vai à força.
    signalGroup('SIGTERM');
    const force = setTimeout(() => signalGroup('SIGKILL'), 3000);
    child.once('close', () => clearTimeout(force));
}

// Executável que roda JavaScript "puro": o próprio Electron em modo Node
// (variável ELECTRON_RUN_AS_NODE). No macOS usamos o auxiliar do app, como o
// Electron faz por conta própria, pra nenhum ícone extra aparecer no Dock.
const nodeRuntime = () => (isMac && process.helperExecPath) || process.execPath;

// O app se apresenta aos sites como um Chrome comum do sistema em que está
// (sem "Electron" no meio). Dizer que é Windows estando num Mac chamaria atenção.
function browserUserAgent() {
    const major = process.versions.chrome.split('.')[0];
    const system = isMac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64';
    return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

module.exports = { isWin, isMac, spawnOptions, killTree, nodeRuntime, browserUserAgent };
