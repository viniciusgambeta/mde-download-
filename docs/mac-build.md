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

## 2. Gerar o instalador

O workflow roda sozinho em três situações:

- a cada push na branch `mac` (enquanto a versão de Mac está em teste);
- quando uma tag que começa com `v` é enviada (por exemplo `v1.1.0`);
- pelo botão **Run workflow**, na aba Actions (o botão só aparece depois que
  o arquivo do workflow estiver na branch `main`).

Acompanhe em <https://github.com/viniciusgambeta/mde-download-/actions>. Leva
de 15 a 30 minutos. No fim da página da execução, em **Artifacts**, fica o
arquivo `MeDaUmDownload-mac`, um zip com os dois instaladores:

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

O Mac pede um ícone de 1024×1024. O arquivo
[build/icon-mac.png](../build/icon-mac.png) é provisório: foi ampliado do
original de 200×200 e fica borrado em tamanhos grandes. Para trocar, salve a
versão nova por cima dele, em PNG de 1024×1024. O desenho deve ocupar um
quadrado de cerca de 824×824 no centro, com o resto transparente, que é a
proporção dos ícones do macOS.

O ícone da barra de menus
([tray-mac.png](../src/renderer/assets/tray-mac.png) e a versão `@2x`) é o
mesmo ícone reduzido.

## 4. Se a execução falhar

| Mensagem no log | O que fazer |
|---|---|
| `Faltam secrets` | Criar os secrets citados na mensagem (seção 1) |
| `MAC verification failed` ou `wrong password` | `CSC_KEY_PASSWORD` não é a senha do `.p12` |
| `not a valid Developer ID` ou `0 identities found` | O `CSC_LINK` não contém um certificado "Developer ID Application" com a chave privada |
| `Equipe diferente` | `APPLE_TEAM_ID` não é a equipe do certificado |
| `A required agreement is missing or has expired` | Entrar em <https://developer.apple.com/account> e aceitar os contratos pendentes |
| `Invalid credentials` ou erro 401 na notarização | Conferir `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` e `APPLE_API_ISSUER` |

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
importar. A senha pedida nesse comando é o `CSC_KEY_PASSWORD`. Para copiar o
`CSC_LINK`:

```bash
base64 -w0 developer-id.p12 | clip
```

**Chave de API.** Em
<https://appstoreconnect.apple.com/access/integrations/api>, aba **Team
Keys**, gere uma chave com acesso **Developer**. O arquivo `.p8` só pode ser
baixado uma vez; o Key ID fica na linha da chave e o Issuer ID no topo da
página.
