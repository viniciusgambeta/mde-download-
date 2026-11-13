# Versão para macOS: como gerar o instalador

O instalador de Mac (`.dmg`) não sai do computador com Windows: quem gera é o
GitHub, numa máquina com macOS, pelo workflow **Build macOS**
([.github/workflows/build-mac.yml](../.github/workflows/build-mac.yml)). Ele
produz dois arquivos, um para Macs com chip Apple (M1 em diante) e outro para
Macs com processador Intel, assina os dois com o certificado **Developer ID**
e manda para a Apple conferir (a "notarização"). Com isso o app abre no Mac de
qualquer pessoa sem aviso de segurança.

## 1. Secrets do repositório

Para assinar e notarizar, o GitHub precisa de seis valores guardados como
**secrets** do repositório. Eles já foram criados e estão no seu arquivo
local de credenciais: é só colar cada um, uma única vez. Nenhum deles deve
ser colado em conversa, e-mail ou dentro do repositório.

Abra <https://github.com/viniciusgambeta/mde-download-/settings/secrets/actions>
e crie um secret (botão **New repository secret**) para cada linha:

| Nome do secret | O que colar |
|---|---|
| `CSC_LINK` | O certificado "Developer ID Application" com a chave privada: o arquivo `.p12` convertido em base64, numa linha só |
| `CSC_KEY_PASSWORD` | A senha do `.p12` |
| `APPLE_API_KEY_P8` | O conteúdo do arquivo `.p8` da chave de API do App Store Connect, inteiro, com as linhas `BEGIN` e `END` |
| `APPLE_API_KEY_ID` | O identificador da chave de API (Key ID) |
| `APPLE_API_ISSUER` | O identificador do emissor da chave de API (Issuer ID) |
| `APPLE_TEAM_ID` | O ID da equipe da conta de desenvolvedor |

Os nomes precisam ser exatamente esses. O workflow usa o `APPLE_TEAM_ID` para
conferir se o app saiu assinado pela equipe certa.

Antes de gerar o app, o workflow confere o certificado e a chave e tolera
colagens imperfeitas: espaços sobrando, a chave sem as linhas `BEGIN` e `END`
ou com texto a mais em volta. O que ele encontrou aparece na página da
execução, em **Annotations**, sem mostrar nenhum valor.

## 2. Gerar o instalador

O workflow roda sozinho em três situações:

- a cada push na branch `mac` (enquanto a versão de Mac está em teste);
- quando uma tag que começa com `v` é enviada (por exemplo `v1.1.0`);
- pelo botão **Run workflow**, na aba Actions (o botão só aparece depois que
  o arquivo do workflow estiver na branch `main`).

Um push que só altera arquivos `.md` não dispara o workflow.

Quando a execução vem de uma tag, os dois instaladores também são anexados à
release dessa tag no GitHub (criada na hora, se ainda não existir). É dessa
release que o site baixa os instaladores de Mac: ele usa, para cada sistema,
a release mais nova que tiver o arquivo. A primeira foi a `v1.0.1-mac`. Uma
tag terminada em `-mac` cria uma release só de Mac, que não toma o lugar da
marcada como a mais recente.

Antes de entregar os instaladores, o workflow instala cada `.dmg`, abre o app
de verdade e confere que ele cria a janela e continua aberto. Se o app fechar
sozinho, a execução falha e nada é publicado.

Acompanhe em <https://github.com/viniciusgambeta/mde-download-/actions>. Leva
de 15 a 20 minutos. No fim da página da execução, em **Artifacts**, fica o
arquivo `MeDaUmDownload-mac`, um zip com os dois instaladores (para baixar é
preciso estar logado no GitHub):

| Arquivo | Para qual Mac |
|---|---|
| `MeDaUmDownload-<versão>-mac-arm64.dmg` | Chip Apple (M1, M2, M3, M4...) |
| `MeDaUmDownload-<versão>-mac-x64.dmg` | Processador Intel |

Para saber qual é o Mac: menu da maçã (canto superior esquerdo) › Sobre Este
Mac. Se aparecer "Chip Apple", é o `arm64`; se aparecer "Processador Intel",
é o `x64`.

### Sem os secrets

Se nenhum dos seis secrets existir, o workflow ainda gera os instaladores,
mas **sem assinatura** (o artefato sai com o nome
`MeDaUmDownload-mac-SEM-ASSINATURA`). Serve para um primeiro teste, não para
distribuir. Para abrir um app assim no Mac: tente abrir, feche o aviso, vá em
Ajustes do Sistema › Privacidade e Segurança e clique em **Abrir Mesmo Assim**.

Se só alguns secrets existirem, ou se a execução for de uma tag, o workflow
para logo no começo e diz quais estão faltando.

## 3. Ícone

O ícone do app no Mac é o [build/icon-mac.png](../build/icon-mac.png), um PNG
de 1024×1024. Para trocar, salve a versão nova por cima dele, no mesmo
tamanho. O desenho deve ocupar um quadrado de cerca de 824×824 no centro, com
o resto transparente, que é a proporção dos ícones do macOS.

O ícone da barra de menus
([tray-mac.png](../src/renderer/assets/tray-mac.png) e a versão `@2x`) é o
mesmo ícone reduzido para 18 e 36 pixels, sem a margem transparente. Se o
ícone do app mudar, ele precisa ser gerado de novo.

## 4. Nome do app no Mac

Por dentro, o app de Mac se chama **Me da um Download**, sem acento: é o nome
da pasta `.app` e dos programas que vão dentro dela. No Finder, no Dock e na
barra de menus aparece **Me dá um Download**, com acento. No Monitor de
Atividade aparece o nome sem acento.

Isso é de propósito. Ao abrir, o Electron compara letra por letra o caminho
dos programas auxiliares dele com o que está no disco, e um "á" pode estar
gravado de dois jeitos (a letra inteira, ou "a" seguido do acento). O disco do
`.dmg` grava do segundo jeito, a comparação falha e o app fecha no instante em
que abre. Foi o que aconteceu com a primeira versão publicada.

Na prática:

- gere sempre pelo `npm run dist:mac`, que já passa o nome sem acento. O
  [after-pack](../scripts/after-pack.cjs) recusa gerar um app de Mac com
  acento no nome dos arquivos;
- o nome com acento vem dos arquivos `InfoPlist.strings` que o after-pack
  cria, um por idioma. Se alguém renomear o app no Finder, o macOS passa a
  mostrar o nome que a pessoa deu.

## 5. Testar um instalador já publicado

O workflow **Teste de abertura no macOS**
([.github/workflows/teste-mac.yml](../.github/workflows/teste-mac.yml)) baixa
os instaladores de uma release, instala e abre o app no macOS 15 e no 26, com
chip Apple e com Intel. Ele roda quando o arquivo do workflow muda na branch
`mac` e pelo botão **Run workflow** (informando a tag). Se o app fechar, o
relatório do crash aparece em **Annotations**.

## 6. Se a execução falhar

O motivo aparece no topo da página da execução, em **Annotations**: o
workflow publica ali o fim do registro do passo que falhou, então não é
preciso abrir o log.

| Mensagem | O que fazer |
|---|---|
| `Faltam secrets` | Criar os secrets citados na mensagem (seção 1) |
| `Certificado e senha não combinam` | Colar de novo `CSC_KEY_PASSWORD` (e, se continuar, `CSC_LINK`), só com a linha do valor |
| `Certificado recusado pelo macOS` | O `.p12` abre com a senha, mas não tem um certificado "Developer ID Application" com a chave privada, ou o macOS não aceitou o formato |
| `Chave de notarização inválida` | Colar de novo `APPLE_API_KEY_P8`, com o conteúdo do arquivo `.p8` |
| `Equipe diferente` | `APPLE_TEAM_ID` não é a equipe do certificado |
| `O app fecha ao abrir` ou `O app abriu sem janela` | O instalador saiu, mas o app não funciona: nada foi publicado. O fim do registro mostra o que o app escreveu antes de cair |
| `O nome ... tem acento` | O app de Mac foi gerado sem passar pelo `npm run dist:mac` (seção 4) |
| `A required agreement is missing or has expired` | Entrar em <https://developer.apple.com/account> e aceitar os contratos pendentes |
| `Invalid credentials` ou erro 401 na notarização | Conferir `APPLE_API_KEY_ID` e `APPLE_API_ISSUER`, e se a chave de API não foi revogada |

Um aviso que não impede o build: **Certificado gravado com a senha errada**.
O `.p12` atual foi criado com um caractere invisível no fim da senha (o
arquivo de onde ela foi lida terminava com uma quebra de linha). O workflow
contorna isso regravando o certificado a cada execução. Para o aviso sumir,
gere o `.p12` de novo, como descrito no fim deste guia, e atualize o secret
`CSC_LINK`.

Outro aviso que não impede o build: **Versão Intel não testada**. O teste
abre a versão Intel pelo Rosetta (o tradutor da Apple); se o runner não tiver
o Rosetta e não der para instalá-lo, só a versão de chip Apple é aberta.

## Gerar num Mac, sem o GitHub

Num Mac com Node.js 22.12 ou mais novo e git:

```bash
npm install
```

```bash
npm run setup
```

```bash
npm run dist:mac
```

Sem certificado instalado no Mac, o resultado sai sem assinatura. Para só
abrir o app em modo de desenvolvimento, use `npm start`.

## Quando o certificado vencer

O certificado atual vale até 13/12/2027. A chave de API não vence, mas pode
ser revogada. Para refazer qualquer um dos dois, os passos são estes, no
**Git Bash**, numa pasta fora do repositório e do OneDrive.

**Certificado.** Só o titular da conta ("Account Holder") consegue criar.

```bash
openssl genrsa -out developer-id.key 2048
```

```bash
MSYS_NO_PATHCONV=1 openssl req -new -key developer-id.key -out developer-id.csr -subj "/CN=Developer ID/C=BR"
```

Envie o `developer-id.csr` em
<https://developer.apple.com/account/resources/certificates/add>, escolhendo
**Developer ID Application** e o tipo **G2 Sub-CA**, e baixe o
`developerID_application.cer` para a mesma pasta.

```bash
openssl x509 -inform DER -in developerID_application.cer -out developer-id.pem
```

```bash
openssl pkcs12 -export -inkey developer-id.key -in developer-id.pem -out developer-id.p12 -name "Developer ID Application" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
```

As três últimas opções fazem o `.p12` sair num formato que o macOS aceita
importar. A senha pedida nesse comando é o `CSC_KEY_PASSWORD`: digite-a
quando o comando pedir. Não troque por `-passout file:arquivo`, porque uma
quebra de linha no fim do arquivo acaba fazendo parte da senha. Para copiar o
`CSC_LINK`:

```bash
base64 -w0 developer-id.p12 | clip
```

**Chave de API.** Em
<https://appstoreconnect.apple.com/access/integrations/api>, aba **Team
Keys**, gere uma chave com acesso **Developer**. O arquivo `.p8` só pode ser
baixado uma vez; o Key ID fica na linha da chave e o Issuer ID no topo da
página.
