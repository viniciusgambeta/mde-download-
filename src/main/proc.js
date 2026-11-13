// Cancelar uma tarefa precisa encerrar o programa externo e os que ele abriu
// (o yt-dlp chama o ffmpeg, por exemplo), não só o primeiro processo.

const { spawn } = require('node:child_process');

const IS_WIN = process.platform === 'win32';

// Fora do Windows, quem é aberto com { detached: OWN_GROUP } ganha um grupo de
// processos próprio, e killTree encerra o grupo inteiro de uma vez. No Windows
// "detached" abriria uma janela de console, então lá fica desligado.
const OWN_GROUP = !IS_WIN;

function killTree(child) {
    if (IS_WIN) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch { /* já terminou */ }
}

module.exports = { OWN_GROUP, killTree };
