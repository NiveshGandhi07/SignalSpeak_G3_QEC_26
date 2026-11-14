// Short audio cues (Web Audio API) — for feedback when the user's eyes are closed.
// AI-assisted: written with help from Claude (Anthropic).

let ctx: AudioContext | null = null;

/** Play a short tone sequence, e.g. chirp([660, 880]). Fails silently if audio is blocked. */
export function chirp(freqs: number[], durS = 0.12, gap = 0.05, volume = 0.15): void {
  try {
    ctx ??= new AudioContext();
    freqs.forEach((f, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.frequency.value = f;
      gain.gain.value = volume;
      osc.connect(gain).connect(ctx!.destination);
      const t = ctx!.currentTime + i * (durS + gap);
      osc.start(t);
      osc.stop(t + durS);
    });
  } catch {
    /* audio unavailable */
  }
}
