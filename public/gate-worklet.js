// Portão de ruído (noise gate) do microfone, depois do RNNoise: abaixo da sensibilidade,
// abaixa a voz em 40 dB. Assim teclado, mouse e voz de longe (mais fracos que a voz perto
// do microfone) não passam.
//
// Para não picotar:
// - olha 10 ms adiante: decide com o som que está chegando e aplica no som atrasado,
//   então abre antes de a palavra começar (não come a primeira sílaba);
// - segura aberto 350 ms depois da fala e fecha em rampa de ~200 ms;
// - fechado não é silêncio total, é -40 dB (sílaba baixa não some de vez).
//
// Sensibilidade automática (auto = 1): acompanha o ruído de fundo e o volume da voz e
// põe o limite entre os dois. Manda o nível e o limite em uso para a página desenhar.

const LOOKAHEAD_S = 0.010;
const FLOOR_GAIN = 10 ** (-40 / 20);

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -40, minValue: -120, maxValue: 0, automationRate: 'k-rate' },
      { name: 'auto', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.envCoef = Math.exp(-1 / (0.010 * sr)); // nível medido numa janela de ~10 ms
    this.attackStep = 1 / (0.005 * sr);         // abre em ~5 ms (com 10 ms de antecedência)
    this.releaseStep = 1 / (0.200 * sr);        // fecha em ~200 ms
    this.holdSamples = Math.round(0.35 * sr);   // segura 350 ms depois da última fala
    this.reportEvery = Math.round(0.05 * sr);   // manda o nível a cada 50 ms
    this.blockSamples = Math.round(0.01 * sr);  // a sensibilidade automática olha blocos de 10 ms

    this.delay = new Float32Array(Math.round(LOOKAHEAD_S * sr));
    this.delayPos = 0;
    this.env = 0;
    this.gain = FLOOR_GAIN;
    this.open = false;
    this.holdLeft = 0;
    this.sinceReport = 0;
    this.peak = 0;

    // Sensibilidade automática (em dB).
    this.noiseDb = -70;   // ruído de fundo: segue os mínimos, sobe devagar
    this.speechDb = -25;  // volume da voz: média dos trechos claramente falados
    this.autoDb = -45;
    this.blockSum = 0;
    this.blockCount = 0;
  }

  updateAuto(levelDb) {
    // Mínimo com subida lenta (~3 dB/s): acompanha o ruído sem confundir com a fala.
    if (levelDb < this.noiseDb) this.noiseDb += (levelDb - this.noiseDb) * 0.3;
    else this.noiseDb += 0.03;
    // Voz: só aprende com o que está bem acima do limite (fala de verdade).
    if (levelDb > this.autoDb + 8) this.speechDb += (levelDb - this.speechDb) * 0.02;
    // Limite: 15 dB acima do ruído e no máximo 20 dB abaixo da voz, entre -60 e -25 dB.
    // (Teclado e voz de longe costumam chegar bem mais de 20 dB abaixo da voz perto.)
    const target = Math.max(this.noiseDb + 15, this.speechDb - 20);
    this.autoDb = Math.min(-25, Math.max(-60, target));
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    const auto = parameters.auto[0] >= 0.5;
    const thresholdDb = auto ? this.autoDb : parameters.threshold[0];
    const openAt = 10 ** (thresholdDb / 20);
    const closeAt = openAt * 0.5; // fecha só 6 dB abaixo de onde abre (evita liga-desliga)

    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.env = this.envCoef * this.env + (1 - this.envCoef) * x * x;
      const level = Math.sqrt(this.env);
      if (level > this.peak) this.peak = level;

      if (auto) {
        this.blockSum += x * x;
        if (++this.blockCount >= this.blockSamples) {
          this.updateAuto(10 * Math.log10(this.blockSum / this.blockCount + 1e-12));
          this.blockSum = 0;
          this.blockCount = 0;
        }
      }

      if (level >= openAt) {
        this.open = true;
        this.holdLeft = this.holdSamples;
      } else if (this.open) {
        if (level >= closeAt) this.holdLeft = this.holdSamples;
        else if (this.holdLeft > 0) this.holdLeft--;
        else this.open = false;
      }

      this.gain = this.open
        ? Math.min(1, this.gain + this.attackStep)
        : Math.max(FLOOR_GAIN, this.gain - this.releaseStep);

      // Aplica o ganho no som de 10 ms atrás (a decisão já viu o que vinha).
      const delayed = this.delay[this.delayPos];
      this.delay[this.delayPos] = x;
      this.delayPos = (this.delayPos + 1) % this.delay.length;
      output[i] = delayed * this.gain;
    }

    this.sinceReport += input.length;
    if (this.sinceReport >= this.reportEvery) {
      this.port.postMessage({ db: 20 * Math.log10(this.peak + 1e-9), open: this.open, thresholdDb, auto });
      this.sinceReport = 0;
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('nosso-servidor-noise-gate', NoiseGateProcessor);
