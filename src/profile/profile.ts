// "About me" profile shown as a trading-card style card. Fill this in with the real person's details
// (by a caregiver, before use). The values below are a fictional placeholder persona.
// AI-assisted: written with help from Claude (Anthropic).

export interface Ability {
  name: string;
  detail: string;
  /** 1 (weak) – 5 (strong) */
  strength: number;
}

export interface Profile {
  name: string;
  avatar: string; // emoji, or an image path in /public, e.g. "/me.jpg"
  type: string;
  energy: string;
  tagline: string;
  abilities: Ability[];
  weakness: string;
  likes: string[];
  medical: string[];
  tips: string[];
}

export const PROFILE: Profile = {
  name: "Alex Morgan",
  avatar: "🧑‍🦳",
  type: "Gaze Communicator",
  energy: "Best in the morning",
  tagline: "Retired music teacher · Leafs fan · Grandparent of three",
  abilities: [
    { name: "Eye Gaze", detail: "Looks at a tile to choose it", strength: 5 },
    { name: "Brow Raise", detail: "Raises eyebrows to confirm", strength: 3 },
    { name: "Head Turn", detail: "Small turns — tires quickly", strength: 2 },
  ],
  weakness: "Neck fatigue after ~10 minutes. Bright light behind me makes tracking worse.",
  likes: ["Jazz", "Hockey nights", "Audiobooks", "Visits from grandkids"],
  medical: ["Bulbar-onset ALS", "Allergy: penicillin", "Thickened fluids only"],
  tips: [
    "Ask yes/no questions",
    "Give me time to answer",
    "Talk to me, not about me",
    "Sit where I can see you",
  ],
};

/** Short spoken introduction for the "Read aloud" tile. */
export function introText(p: Profile): string {
  return (
    `Hi, I'm ${p.name}. ${p.tagline.replaceAll("·", ",")}. ` +
    `I communicate with my eyes using this screen. ` +
    `Please ${p.tips.map((t) => t.toLowerCase()).join(", and ")}.`
  );
}
