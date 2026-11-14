// Text-to-speech output via the browser Web Speech API (speechSynthesis) — built into the browser,
// works offline with the OS voices. Output only; there is no speech *input* anywhere in the app.
// AI-assisted: written with help from Claude (Anthropic).

export function speak(text: string, rate = 0.95): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // newest message wins
  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
