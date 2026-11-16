# Na Tela

Compartilhamento de tela entre amigos, no navegador: salas com senha opcional, transmissão até 1080p 60fps com áudio estéreo do sistema, chat de voz, chat de texto e salas favoritas com status ao vivo.

## Rodando

```bash
npm install
npm start
```

Acesse http://localhost:3000. Para testar sozinho, abra duas abas na mesma sala.

Sem configuração nenhuma, a mídia vai P2P em malha. Para salas maiores ou upload fraco, use o SFU (abaixo).

## SFU com LiveKit (recomendado)

Na malha P2P, quem transmite envia um fluxo para **cada** espectador. Com o [LiveKit](https://livekit.io) como SFU, envia **um só** para o servidor, que repassa para todos. A tela vai em simulcast (qualidade escolhida + 720p + 360p), e o servidor manda a cada espectador a camada que a conexão dele aguenta, pausando as que ninguém usa.

Basta definir três variáveis. Com elas, todas as salas passam a usar o SFU:

```bash
LIVEKIT_URL=wss://seu-projeto.livekit.cloud \
LIVEKIT_API_KEY=APIxxxx \
LIVEKIT_API_SECRET=xxxx \
npm start
```

- **LiveKit Cloud:** crie um projeto em cloud.livekit.io e copie a URL e as chaves (o plano gratuito serve para um grupo de amigos).
- **Servidor próprio:** `livekit-server --dev` sobe um local com `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_KEY=devkey` e `LIVEKIT_API_SECRET=secret`. Em produção, siga o guia de deploy do LiveKit (precisa de portas UDP abertas e HTTPS).

O Na Tela continua cuidando de salas, senhas, chat e presença. O token do LiveKit só é entregue depois que a senha confere, vale só para aquela sala, e quem sai da sala é removido do LiveKit também.

## Como funciona

- **Servidor** ([server.js](server.js)): Express + Socket.IO. Ele só cuida das salas (nome, senha com hash scrypt, quem está dentro) e repassa a sinalização WebRTC. O vídeo não passa por ele.
- **Cliente** ([public/app.js](public/app.js)): com LiveKit configurado, publica e assina as faixas pelo SFU (`livekit-client`, servido em `/vendor/livekit-client.js`). Sem ele, usa conexões WebRTC P2P em malha (cada pessoa conecta direto com as outras), com o padrão *perfect negotiation*.
  - Tela: `getDisplayMedia` com o preset escolhido (resolução, FPS, bitrate, `contentHint` e `degradationPreference`); dá para trocar a qualidade durante a transmissão.
  - Codec: H.264 por padrão (encoder de GPU na maioria dos PCs), com opção de AV1, VP9 ou VP8. O bitrate inicial é forçado perto do alvo (`x-google-start-bitrate`), então a imagem já começa nítida.
  - Estatísticas: o botão 📊 no vídeo mostra resolução, FPS, bitrate, codec, perda e ping; em quem transmite, mostra o upload por espectador e o que está limitando (CPU ou rede).
  - Áudio: Opus estéreo forçado no SDP, então o som do jogo chega em estéreo.
  - Voz: microfone com supressão de ruído/eco do navegador, indicador de quem está falando, volume por pessoa, atalho **M** para mutar.
- A senha é definida por quem cria a sala. A sala some quando fica vazia.

## Limitações

- **Malha P2P (sem LiveKit)**: quem transmite envia um fluxo para cada espectador. Em 1080p60 (~8 Mbps), 4 espectadores pedem ~32 Mbps de upload. O limite padrão é de 10 pessoas por sala, ou 30 com o SFU (`MAX_PEERS`).
- **Trocar qualidade ou codec no SFU** republica a tela, então a imagem pisca por um instante.
- **Áudio do sistema**: o Chrome/Edge compartilha o áudio de abas e, no Windows, da tela inteira. Firefox e Safari não compartilham áudio.
- **Redes restritas (malha P2P)**: só há STUN por padrão. O LiveKit tem TURN embutido. Atrás de NAT simétrico ou de firewall corporativo a conexão pode falhar sem um servidor TURN:

```bash
TURN_URL=turn:seu-servidor:3478 TURN_USERNAME=user TURN_CREDENTIAL=senha npm start
```

## Deploy

O servidor precisa de WebSocket persistente, e as funções serverless da Vercel não oferecem isso. Use Render, Railway, Fly.io ou uma VPS (`npm start`, porta pela variável `PORT`). A captura de tela e de microfone só funciona em **HTTPS** (ou localhost).
