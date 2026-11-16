# Na Tela

Compartilhamento de tela entre amigos, no navegador: salas com senha opcional, transmissão até 1080p 60fps com áudio estéreo do sistema, chat de voz, chat de texto e salas favoritas com status ao vivo.

## Rodando

```bash
npm install
npm start
```

Acesse http://localhost:3000. Para testar sozinho, abra duas abas na mesma sala.

## Como funciona

- **Servidor** ([server.js](server.js)): Express + Socket.IO. Ele só cuida das salas (nome, senha com hash scrypt, quem está dentro) e repassa a sinalização WebRTC. O vídeo não passa por ele.
- **Cliente** ([public/app.js](public/app.js)): conexões WebRTC P2P em malha (cada pessoa conecta direto com as outras), usando o padrão *perfect negotiation*.
  - Tela: `getDisplayMedia` com o preset escolhido (resolução, FPS, bitrate, `contentHint` e `degradationPreference`); dá para trocar a qualidade durante a transmissão.
  - Codec: H.264 por padrão (encoder de GPU na maioria dos PCs), com opção de AV1, VP9 ou VP8. O bitrate inicial é forçado perto do alvo (`x-google-start-bitrate`), então a imagem já começa nítida.
  - Estatísticas: o botão 📊 no vídeo mostra resolução, FPS, bitrate, codec, perda e ping; em quem transmite, mostra o upload por espectador e o que está limitando (CPU ou rede).
  - Áudio: Opus estéreo forçado no SDP, então o som do jogo chega em estéreo.
  - Voz: microfone com supressão de ruído/eco do navegador, indicador de quem está falando, volume por pessoa, atalho **M** para mutar.
- A senha é definida por quem cria a sala. A sala some quando fica vazia.

## Limitações

- **Malha P2P**: quem transmite envia um fluxo para cada espectador. Em 1080p60 (~8 Mbps), 4 espectadores pedem ~32 Mbps de upload. Para muitos espectadores seria preciso um SFU (LiveKit, mediasoup). O limite padrão é de 10 pessoas por sala (`MAX_PEERS`).
- **Áudio do sistema**: o Chrome/Edge compartilha o áudio de abas e, no Windows, da tela inteira. Firefox e Safari não compartilham áudio.
- **Redes restritas**: só há STUN por padrão. Atrás de NAT simétrico ou de firewall corporativo a conexão pode falhar sem um servidor TURN:

```bash
TURN_URL=turn:seu-servidor:3478 TURN_USERNAME=user TURN_CREDENTIAL=senha npm start
```

## Deploy

O servidor precisa de WebSocket persistente, e as funções serverless da Vercel não oferecem isso. Use Render, Railway, Fly.io ou uma VPS (`npm start`, porta pela variável `PORT`). A captura de tela e de microfone só funciona em **HTTPS** (ou localhost).
