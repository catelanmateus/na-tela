// Portão de ruído (noise gate) do microfone, depois do RNNoise: abaixo da sensibilidade
// escolhida, silencia. Assim teclado, mouse e voz de longe (mais fracos que a voz perto
// do microfone) não passam. Abre rápido para não comer o começo das palavras, segura
// aberto um pouco depois da fala e fecha em rampa, para não picotar nem estalar.
// Também manda o nível de entrada para a página desenhar o medidor de sensibilidade.

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: -40, minValue: -120, maxValue: 0, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.envCoef = Math.exp(-1 / (0.010 * sr)); // nível medido numa janela de ~10 ms
    this.attackStep = 1 / (0.003 * sr);         // abre em ~3 ms
    this.releaseStep = 1 / (0.120 * sr);        // fecha em ~120 ms
    this.holdSamples = Math.round(0.25 * sr);   // segura 250 ms depois da última fala
    this.reportEvery = Math.round(0.05 * sr);   // manda o nível a cada 50 ms
    this.env = 0;
    this.gain = 0;
    this.open = false;
    this.holdLeft = 0;
    this.sinceReport = 0;
    this.peak = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    const openAt = 10 ** (parameters.threshold[0] / 20);
    const closeAt = openAt * 0.5; // fecha só 6 dB abaixo de onde abre (evita liga-desliga)

    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.env = this.envCoef * this.env + (1 - this.envCoef) * x * x;
      const level = Math.sqrt(this.env);
      if (level > this.peak) this.peak = level;

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
        : Math.max(0, this.gain - this.releaseStep);
      output[i] = x * this.gain;
    }

    this.sinceReport += input.length;
    if (this.sinceReport >= this.reportEvery) {
      this.port.postMessage({ db: 20 * Math.log10(this.peak + 1e-9), open: this.open });
      this.sinceReport = 0;
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('nosso-servidor-noise-gate', NoiseGateProcessor);
