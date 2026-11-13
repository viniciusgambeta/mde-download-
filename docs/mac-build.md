# Versão para macOS: como gerar o instalador

O instalador de Mac (`.dmg`) não sai do computador com Windows: quem gera é o
GitHub, numa máquina com macOS, pelo workflow **Build macOS**
([.github/workflows/build-mac.yml](../.github/workflows/build-mac.yml)). Ele
produz dois arquivos, um para Macs com chip Apple (M1 em diante) e outro para
Macs com processador Intel, assina os dois com o seu certificado **Developer
ID** e manda para a Apple conferir (a "notarização"). Com isso o app abre no
Mac de qualquer pessoa sem aviso de segurança.

Para assinar e notarizar, o GitHub precisa de cinco valores guardados como
**secrets** do repositório. Você cria e cola cada um uma única vez, seguindo
os passos abaixo. Nenhum desses valores deve ser colado em conversa, e-mail ou
dentro do repositório.

## 1. Certificado "Developer ID Application"

Os comandos são para o **Git Bash** (vem junto com o Git para Windows). Só o
titular da conta de desenvolvedor ("Account Holder") consegue criar esse tipo
de certificado.

1. Crie uma pasta fora do repositório e do OneDrive e entre nela:

   ```bash
   mkdir -p ~/apple-cert && cd ~/apple-cert
   ```

2. Gere a chave privada e o pedido de certificado:

   ```bash
   openssl genrsa -out developer-id.key 2048
   ```

   ```bash
   MSYS_NO_PATHCONV=1 openssl req -new -key developer-id.key -out developer-id.csr -subj "/CN=Developer ID/C=BR"
   ```

3. Abra <https://developer.apple.com/account/resources/certificates/add>,
   marque **Developer ID Application** (fica na seção "Software") e clique em
   Continue. Em "Profile Type" deixe **G2 Sub-CA**. Envie o arquivo
   `developer-id.csr` e baixe o certificado. Mova o arquivo baixado
   (`developerID_application.cer`) para a pasta `apple-cert`.

4. Baixe o certificado intermediário da Apple e junte tudo num arquivo `.p12`:

   ```bash
   curl -fsSLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
   ```

   ```bash
   openssl x509 -inform DER -in DeveloperIDG2CA.cer -out DeveloperIDG2CA.pem
   ```

   ```bash
   openssl x509 -inform DER -in developerID_application.cer -out developer-id.pem
   ```

   ```bash
   openssl pkcs12 -export -inkey developer-id.key -in developer-id.pem -certfile DeveloperIDG2CA.pem -out developer-id.p12 -name "Developer ID Application" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
   ```

   O último comando pede uma senha (duas vezes; nada aparece enquanto você
   digita). Invente uma e guarde: ela é o secret `MAC_CERT_PASSWORD`.

5. Copie o certificado, já convertido em texto, para a área de transferência:

   ```bash
   base64 -w0 developer-id.p12 | clip
   ```

   O que foi copiado é o secret `MAC_CERT_P12_BASE64`.

Guarde a pasta `apple-cert` e a senha num lugar seguro (um gerenciador de
senhas, por exemplo). O certificado vale por cinco anos e a Apple limita
quantos podem ser criados.

Se preferir fazer no Mac: no app Acesso às Chaves, menu Assistente de
Certificado › Solicitar um Certificado de uma Autoridade de Certificação,
salve o pedido em disco, envie no mesmo site, instale o `.cer` com dois
cliques e exporte o item "Developer ID Application" como `.p12`. Depois, no
Terminal, `base64 -i arquivo.p12 | pbcopy`.

## 2. Chave para a notarização

Os nomes abaixo estão em inglês; se o site aparecer em português, os botões
equivalentes ficam no mesmo lugar.

1. Abra <https://appstoreconnect.apple.com/access/integrations/api> (menu
   Users and Access › Integrations › App Store Connect API) e fique na aba
   **Team Keys**. Na primeira vez a Apple pede para solicitar o acesso
   (**Request Access**): aceite.
2. Clique em **+** (Generate API Key). Nome: `Notarizacao GitHub`. Em
   "Access", escolha **Developer**.
3. Anote o **Key ID** (aparece na linha da chave) e o **Issuer ID** (aparece
   no topo da página).
4. Clique em **Download** na linha da chave. O arquivo
   `AuthKey_XXXXXXXXXX.p8` só pode ser baixado uma vez: guarde-o na pasta
   `apple-cert`.
5. Copie o conteúdo do arquivo para a área de transferência:

   ```bash
   cat ~/apple-cert/AuthKey_*.p8 | clip
   ```

## 3. Onde colar: secrets do repositório

Abra <https://github.com/viniciusgambeta/mde-download-/settings/secrets/actions>
e crie um secret (botão **New repository secret**) para cada linha:

| Nome do secret | O que colar |
|---|---|
| `MAC_CERT_P12_BASE64` | O texto copiado no passo 5 do certificado |
| `MAC_CERT_PASSWORD` | A senha que você inventou ao gerar o `.p12` |
| `APPLE_API_KEY_P8` | O conteúdo do arquivo `.p8`, inteiro, com as linhas `BEGIN` e `END` |
| `APPLE_API_KEY_ID` | O Key ID |
| `APPLE_API_ISSUER` | O Issuer ID |

Os nomes precisam ser exatamente esses.

## 4. Gerar o instalador

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

Se nenhum dos cinco secrets existir, o workflow ainda gera os instaladores,
mas **sem assinatura** (o artefato sai com o nome
`MeDaUmDownload-mac-SEM-ASSINATURA`). Serve para um primeiro teste, não para
distribuir. Para abrir um app assim no Mac: tente abrir, feche o aviso, vá em
Ajustes do Sistema › Privacidade e Segurança e clique em **Abrir Mesmo Assim**.

Se só alguns secrets existirem, ou se a execução for de uma tag, o workflow
para logo no começo e diz quais estão faltando.

## 5. Ícone

O Mac pede um ícone de 1024×1024. O arquivo
[build/icon-mac.png](../build/icon-mac.png) é provisório: foi ampliado do
original de 200×200 e fica borrado em tamanhos grandes. Para trocar, salve a
versão nova por cima dele, em PNG de 1024×1024. O desenho deve ocupar um
quadrado de cerca de 824×824 no centro, com o resto transparente, que é a
proporção dos ícones do macOS.

O ícone da barra de menus
([tray-mac.png](../src/renderer/assets/tray-mac.png) e a versão `@2x`) é o
mesmo ícone reduzido.

## 6. Se a execução falhar

| Mensagem no log | O que fazer |
|---|---|
| `Faltam secrets` | Criar os secrets citados na mensagem (seção 3) |
| `MAC verification failed` ou `wrong password` | `MAC_CERT_PASSWORD` não é a senha do `.p12` |
| `not a valid Developer ID` ou `0 identities found` | O `.p12` não contém um certificado "Developer ID Application" |
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
