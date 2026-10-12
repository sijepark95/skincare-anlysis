/** Public brand copy and media. Keep product and privacy claims aligned with docs/SPEC.md. */
export const aelune = {
  name: "AELUNE",
  tagline: "Beauty, seen differently.",
  navigation: [
    { label: "The experience", href: "#experience" },
    { label: "How it works", href: "#how-it-works" },
    { label: "For stores", href: "#for-stores" },
  ],
  links: {
    kiosk: "/kiosk",
    workspace: "/management",
    signup: "/management/signup",
    signin: "/management/login",
    styleTile: "/brand",
  },
  media: {
    drop: "/media/aelune/drop-poster.webp",
    skin: "/media/aelune/skin-poster.webp",
    film: "/media/aelune/inside-the-drop.mp4",
    filmPreview: "/media/aelune/inside-the-drop-web.mp4",
    storyManifest: "/media/aelune/story/manifest.json",
  },
  hero: {
    eyebrow: "A NEW PERSPECTIVE ON BEAUTY",
    firstLine: "A little closer.",
    secondLine: "A lot clearer.",
    description:
      "Your colors. Your style. A beauty book shaped around your choices, with lip shades to explore in your store.",
    primary: "Find your beauty direction",
    secondary: "Inside the drop",
  },
  discovery: {
    eyebrow: "FROM YOUR MIRROR TO YOUR BEAUTY BOOK",
    title: "Less guesswork.\nMore understanding.",
    description:
      "Explore a personal palette, makeup moods, hair and jewelry ideas. Confirm what feels like you, then discover matching registered lip shades.",
    steps: [
      {
        number: "01",
        title: "A moment for your style.",
        description:
          "Choose a makeup mood and hair length. With separate permission, a fresh photo can suggest an approximate color direction and face shape. You can also explore without a photo.",
      },
      {
        number: "02",
        title: "Make the choices yours.",
        description:
          "Confirm a palette and face shape, then explore makeup moods, haircuts, hair colors and jewelry in your personal beauty book.",
      },
      {
        number: "03",
        title: "Find it in your store.",
        description:
          "Explore reviewed lip shades that match your confirmed palette, finish and ingredient exclusions. Only eligible products currently available in the paired store can appear.",
      },
    ],
  },
  retailer: {
    eyebrow: "THE OTHER SIDE OF THE MIRROR",
    title: "A beautiful experience.\nA considered workspace.",
    description:
      "Simple for your guests. Clear for your team. Bring the experience to a tablet or browser-based smart mirror, and manage your stores from a computer.",
    features: [
      {
        title: "Your catalog, thoughtfully curated.",
        description:
          "Register products and complete formulas, review lip shades and publish when you’re ready.",
      },
      {
        title: "Every store, its own shelf.",
        description:
          "Set prices, availability and visibility for each location.",
      },
      {
        title: "Connect. Pair. Welcome.",
        description: "Pair and revoke store devices from your staff workspace.",
      },
    ],
  },
  questions: [
    {
      question: "What does the photo analysis tell me?",
      answer:
        "With separate permission, OpenAI suggests an approximate undertone, color intensity and face shape. Lighting, makeup and camera settings affect the result. You confirm your choices; these are exploratory styling directions, not calibrated personal-color measurements. A separate skincare experience remains available.",
    },
    {
      question: "Do I have to take a photo?",
      answer:
        "No. Choose your own palette, face shape and styling preferences to build a beauty book. No photo is sent when you continue without one.",
    },
    {
      question: "What happens to my photo?",
      answer:
        "Photo analysis needs a separate opt-in before sending an image to OpenAI. Photos stay in application memory and are not saved or used for training. Provider retention may apply. Finish clears the temporary kiosk session. An optional seven-day QR guide contains confirmed choices and product references, without the photo.",
    },
    {
      question: "How are products recommended?",
      answer:
        "Lip shades match your confirmed palette and preferred finish. They must have reviewed shade details and a published complete formula, be visible and in stock in this store, and respect your ingredient exclusions. Screen swatches are approximate; matching is not an allergy-safety assessment.",
    },
  ],
} as const;

export interface AeluneStoryChapter {
  number: string;
  title: string;
  body: string;
  action?: string;
  href?: string;
}

export const aeluneStoryChapters: readonly AeluneStoryChapter[] = [
  {
    number: "01 / THE BEGINNING",
    title: "A little curiosity.\nA closer look.",
    body: "Every beauty story begins with a moment of curiosity. Step inside the drop, and see your style from a different perspective.",
  },
  {
    number: "02 / THE DISCOVERY",
    title: "Your beauty.\nSeen with care.",
    body: "An optional photo suggests a direction. Your choices make it yours. Explore a personal palette and styling ideas with room to experiment.",
  },
  {
    number: "03 / YOUR NEXT CHAPTER",
    title: "From inspiration\nto your own style.",
    body: "Discover makeup, hair and jewelry ideas, plus matching lip shades available in your store. Save your confirmed beauty book when phone sharing is enabled.",
    action: "See how it works",
    href: "#how-it-works",
  },
];
