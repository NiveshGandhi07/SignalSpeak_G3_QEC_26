// Renders the "About me" profile as a trading-card style card (original design).
// AI-assisted: written with help from Claude (Anthropic).
import type { Profile } from "../profile/profile";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const pips = (n: number) => "●".repeat(n) + "○".repeat(Math.max(0, 5 - n));

export function renderAboutCard(p: Profile): HTMLElement {
  const card = document.createElement("div");
  card.className = "aboutCard";
  const avatar = /^[/.]|^https?:/.test(p.avatar)
    ? `<img src="${esc(p.avatar)}" alt="">`
    : `<span class="avatarEmoji">${esc(p.avatar)}</span>`;
  card.innerHTML = `
    <div class="cardInner">
      <div class="cardHead">
        <span class="cardName">${esc(p.name)}</span>
        <span class="cardEnergy">${esc(p.energy)}</span>
      </div>
      <div class="cardArt">${avatar}</div>
      <div class="cardType">${esc(p.type)} — ${esc(p.tagline)}</div>
      <div class="cardBody">
        <div class="cardCol">
          ${p.abilities
            .map(
              (a) => `<div class="ability">
                <div class="abilityHead"><b>${esc(a.name)}</b><span class="pips">${pips(a.strength)}</span></div>
                <div class="abilityText">${esc(a.detail)}</div>
              </div>`,
            )
            .join("")}
          <div class="weak"><b>Weakness</b> ${esc(p.weakness)}</div>
        </div>
        <div class="cardCol">
          <div class="section"><b>Talk to me</b><ul>${p.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
          <div class="section"><b>Likes</b> ${p.likes.map(esc).join(" · ")}</div>
          <div class="section medical"><b>Medical</b> ${p.medical.map(esc).join(" · ")}</div>
        </div>
      </div>
    </div>`;
  return card;
}
