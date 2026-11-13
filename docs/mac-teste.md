# Roteiro de teste no Mac

Leva uns 15 minutos. A versão de Mac foi escrita num computador com Windows.
O GitHub confere sozinho que o app instala, abre e mostra a janela; o que
este roteiro testa é o uso de verdade, que só uma pessoa num Mac consegue
ver. Anote o número de cada passo que não sair como descrito e, se der, tire
um print (`Cmd + Shift + 4`).

## Antes de começar

0. Se você instalou a primeira versão, a que fechava sozinha ao abrir, arraste
   o **Me dá um Download** antigo da pasta Aplicativos para o Lixo e baixe o
   instalador de novo. O app novo não substitui o antigo sozinho.
1. Veja qual é o Mac: menu da maçã (canto superior esquerdo) › Sobre Este Mac.
   - "Chip Apple" (M1, M2...): use o arquivo que termina em `arm64.dmg`.
   - "Processador Intel": use o que termina em `x64.dmg`.
2. Abra o `.dmg` e arraste o **Me dá um Download** para a pasta
   **Aplicativos**.
3. Abra o app pela pasta Aplicativos. O macOS pergunta se você quer abrir um
   app baixado da internet: clique em **Abrir**.

   Se o instalador for o de teste (sem assinatura), o macOS bloqueia. Feche o
   aviso, vá em Ajustes do Sistema › Privacidade e Segurança, role até o fim
   e clique em **Abrir Mesmo Assim**.

## O teste

| # | O que fazer | O que deve acontecer |
|---|---|---|
| 1 | Olhe o topo da janela | Os três botões coloridos ficam à esquerda e **não cobrem** o nome "Me dá um Download". O ícone do app aparece no Dock e também, pequeno, na barra de menus (no alto, à direita) |
| 2 | Espere um minuto com o app aberto | Nada visível: nesse tempo ele baixa o yt-dlp. Nenhuma mensagem de erro deve aparecer |
| 3 | No navegador, copie o link de um vídeo curto do YouTube e volte para o app | O link aparece sozinho no campo, com o título do vídeo e os botões |
| 4 | Clique em **Baixar** | A barra de progresso anda, o vídeo entra na lista e o Finder abre mostrando o arquivo, em Downloads › Me dá um Download. O vídeo toca. A primeira vez pode demorar mais para começar |
| 5 | Cole o mesmo link de novo (`Cmd + V`) e clique em **Áudio** | Sai um arquivo `.mp3` que toca |
| 6 | Cole o mesmo link e clique em **Transcrição** | Saem dois arquivos, `.txt` e `.srt`, com o texto do vídeo |
| 7 | Cole o link de um Reel público do Instagram e baixe | O vídeo é baixado |
| 8 | Cole o link de um vídeo do TikTok e baixe | O vídeo é baixado (o TikTok às vezes falha na primeira; tente de novo) |
| 9 | Cole o link de um vídeo longo do YouTube (uma hora ou mais), clique em **Baixar** e, com o progresso andando, clique no **X** da linha | A linha some na hora e o download para. Não sobra arquivo pela metade na pasta |
| 10 | Clique no campo do link, digite qualquer coisa, selecione com `Cmd + A`, copie com `Cmd + C`, apague e cole com `Cmd + V` | Os atalhos funcionam |
| 11 | Feche a janela pelo botão vermelho | A janela some, mas o app continua no Dock e na barra de menus. Na primeira vez pode aparecer uma notificação (ou o pedido para permitir notificações) |
| 12 | Clique no ícone da barra de menus | Abre um menu com **Abrir**, **Abrir pasta de downloads** e **Sair** |
| 13 | Clique no ícone do Dock | A janela volta |
| 14 | Clique no ícone de ajustes, no alto à direita | Aparecem Pasta, Qualidade, Abrir pasta ao terminar, Whisper e Instagram. O Whisper mostra **Indisponível**: é o esperado nesta versão |
| 15 | Arraste um download concluído da lista para a Mesa | O arquivo é copiado para a Mesa |
| 16 | Em Ajustes do Sistema › Aparência, troque entre Claro e Escuro | O app acompanha a mudança |
| 17 | Com o app na frente, aperte `Cmd + Q` | O app fecha de verdade: some do Dock e da barra de menus |

## Opcional

- **Instagram com login:** nos ajustes, clique em **Conectar** e entre com
  uma conta (de preferência uma secundária). Depois cole o link de um perfil
  e teste baixar stories ou a foto de perfil.
- **Processos sobrando:** depois do passo 9, abra o Monitor de Atividade e
  busque por `yt-dlp` e `ffmpeg`. Não deve haver nenhum.

## Se algo der errado

Mande o número do passo, o print e, se possível, o arquivo de registro de
falhas. Para achá-lo: no Finder, menu Ir › Ir para a Pasta, cole o caminho
abaixo e aperte Enter.

```
~/Library/Application Support/MeDaUmDownload/falhas.log
```
