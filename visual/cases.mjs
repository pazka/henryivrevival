// Visual use cases covered by the harness (ids from TESTING.md "Visual use cases").
// Each: { id, steps?, ready }: the page "/" is opened by a NEW visitor (new browser context) on
// http://henry.test:<port>, steps(page, ctx) is what the visitor does, `ready` (a JS expression) must become true
// before the shot. ctx = { mobile }: a phone taps, a desktop clicks.
//
// The séance is driven by the visitor's VOICE (Web Speech API) and Henri's answer is AUDIO. Neither exists in a
// headless Chrome on a runner, so VISITOR (injected before the page's own scripts, visual/shoot.mjs) replaces
// window.webkitSpeechRecognition with a stand-in the harness makes "hear" a sentence (window.__say), and
// records the status of every POST /chat/send. Everything else is the page's own code; Henri's text and audio
// come from the app server, which gets them from the fake OpenAI (visual/fake-openai.mjs).
export const WIDTHS = [1400, 1024, 390];

const js = (v) => JSON.stringify(v);

/** Runs in the page before its scripts (Page.addScriptToEvaluateOnNewDocument). */
export const VISITOR = `(() => {
  class FakeSpeechRecognition {
    constructor() { window.__s2t = this; this.listening = false; }
    start() { this.listening = true; setTimeout(() => this.onstart && this.onstart({}), 0); }
    stop() { this.listening = false; }
    abort() { this.listening = false; }
  }
  window.webkitSpeechRecognition = FakeSpeechRecognition;
  window.SpeechRecognition = FakeSpeechRecognition;
  /** The visitor starts speaking (speechstart): the page shows Henri's ear while he listens. */
  window.__speechStart = () => window.__s2t.onspeechstart({});
  /** The visitor says text: speechstart, then the recognition result, as Chrome's recognizer fires them. */
  window.__say = (text) => {
    window.__s2t.onspeechstart({});
    window.__s2t.onresult({ results: [[{ transcript: text, confidence: 0.99 }]] });
  };
  window.__sends = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const r = await realFetch(input, init);
    if (String(input).includes("/chat/send")) window.__sends.push(r.status);
    return r;
  };
})();`;

// ---------- page state, read from the DOM (the classes sceance.mjs sets) ----------
const has = (id, cls) => `document.getElementById(${js(id)}).classList.contains(${js(cls)})`;
const not = (e) => `!(${e})`;
const all = (...e) => e.map((x) => `(${x})`).join(" && ");
/** every picture of the scene is loaded (a missing image fails the shot) */
const imagesLoaded = `[...document.images].every((i) => i.complete && i.naturalWidth > 0)`;
const popupShown = `!!document.getElementById("popupWrapper") && getComputedStyle(document.getElementById("popupWrapper")).display !== "none"`;
const audioPlaying = `(() => { const a = document.getElementById("audio"); return !a.paused && !a.ended && a.readyState >= 1 && isFinite(a.duration) && a.duration > 1; })()`;
const audioEnded = `document.getElementById("audio").ended`;
const sends = (n) => `window.__sends.length === ${n}`;

const STATE = {
  welcome: all(imagesLoaded, popupShown, has("init_1", "active"), not(has("init_2", "active"))),
  // "Commencer" hides the popup and asks for the APPARITION state, under a name sceance.mjs does not know
  // ("APPARITION" vs STATES.APPARITION = "APARTION"): the state stays INIT, the picture stays scene.jpg.
  started: all(imagesLoaded, not(popupShown), has("init_1", "active"), not(has("init_2", "active"))),
  // Henri's first answer ("whouu...") brings the apparition, shown while he speaks
  apparition: all(imagesLoaded, has("init_2", "active"), has("init_2", "animate"), has("mouth", "animate"),
    not(has("bg", "active")), audioPlaying),
  listening: all(has("bg", "active"), has("eyes", "active"), has("mouth", "active"), not(has("eyes", "animate")),
    not(has("mouth", "animate")), not(has("ear", "active")), not(has("init_1", "active")), not(has("init_2", "active"))),
  hearing: all(has("bg", "active"), has("ear", "active"), has("ear", "animate")),
  thinking: all(has("bg", "active"), has("eyes", "animate"), not(has("ear", "active")), not(has("mouth", "animate"))),
  talking: all(has("bg", "active"), has("mouth", "animate"), not(has("eyes", "animate")), audioPlaying),
  goodbye: all(not(has("bg", "active")), not(has("eyes", "active")), has("init_2", "active"), has("init_2", "animate"), audioPlaying),
  afterGoodbye: all(has("init_1", "active"), not(has("init_2", "active")), not(has("bg", "active")), audioEnded),
};

// ---------- steps ----------
async function must(p, expression, what, ms = 15000) {
  if (!(await p.waitFor(expression, ms))) {
    const dbg = await p.evaluate(`JSON.stringify({ sends: window.__sends, classes: [...document.images].map((i) => i.id + ":" + i.className),
      audio: (() => { const a = document.getElementById("audio"); return { src: a.src, paused: a.paused, ended: a.ended, readyState: a.readyState, duration: a.duration, error: a.error && a.error.message }; })() })`).catch(() => "?");
    throw new Error(`step failed: ${what}\n    page: ${dbg}`);
  }
}

/** A real click (desktop) or tap (phone) in the middle of the element: a user gesture, as the visitor's. */
async function press(p, sel, { mobile }) {
  await must(p, `!!document.querySelector(${js(sel)})`, `find ${sel}`);
  const { x, y } = await p.evaluate(`(() => { const r = document.querySelector(${js(sel)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (mobile) {
    await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
}

const say = (p, text) => p.evaluate(`(window.__say(${js(text)}), true)`);
/** Henri's answer is 30 s of (silent) audio: jump to its end, as if he had finished speaking. */
async function finishAudio(p) {
  await must(p, audioPlaying, "Henri's answer is playing");
  await p.evaluate(`(() => { const a = document.getElementById("audio"); a.currentTime = a.duration; return true; })()`);
  await must(p, audioEnded, "Henri's answer ended");
}

/** "Commencer": the popup closes. */
async function begin(p, ctx) {
  await must(p, STATE.welcome, "welcome page with its popup");
  await must(p, "!!window.__s2t", "the page started listening");
  await press(p, "#popupButton", ctx);
  await must(p, STATE.started, "popup closed after Commencer");
}

/** The visitor says "Bonjour": Henri appears (whouu...) and speaks. */
async function greet(p, ctx) {
  await begin(p, ctx);
  await say(p, "Bonjour Henri");
  await must(p, all(sends(1), `window.__sends[0] === 200`), "first answer received");
}

/** ... then, his first answer over, Henri listens (his face on the neutral scene). */
async function summon(p, ctx) {
  await greet(p, ctx);
  await must(p, STATE.apparition, "apparition while Henri speaks");
  await finishAudio(p);
  await must(p, STATE.listening, "Henri listens");
}

export const CASES = [
  { id: "V1-welcome", ready: STATE.welcome },
  { id: "V2-started", steps: begin, ready: STATE.started },
  { id: "V3-apparition", steps: greet, ready: STATE.apparition },
  { id: "V4-listening", steps: summon, ready: STATE.listening },
  {
    id: "V5-hearing",
    steps: async (p, ctx) => { await summon(p, ctx); await p.evaluate("(window.__speechStart(), true)"); },
    ready: STATE.hearing,
  },
  {
    // the fake OpenAI never answers "SUSPENS": the request is still waiting when the shot is taken
    id: "V6-thinking",
    steps: async (p, ctx) => { await summon(p, ctx); await say(p, "SUSPENS : quel est votre plat préféré ?"); },
    ready: all(STATE.thinking, sends(1)),
  },
  {
    id: "V7-talking",
    steps: async (p, ctx) => {
      await summon(p, ctx);
      await say(p, "Quelle fut votre plus grande bataille ?");
      await must(p, all(sends(2), `window.__sends[1] === 200`), "answer received");
    },
    ready: STATE.talking,
  },
  {
    id: "V8-goodbye",
    steps: async (p, ctx) => {
      await summon(p, ctx);
      await say(p, "Adieu Henri");
      await must(p, all(sends(2), `window.__sends[1] === 200`), "farewell received");
    },
    ready: STATE.goodbye,
  },
  {
    id: "V9-after-goodbye",
    steps: async (p, ctx) => {
      await summon(p, ctx);
      await say(p, "Adieu Henri");
      await must(p, all(sends(2), `window.__sends[1] === 200`), "farewell received");
      await finishAudio(p);
    },
    ready: STATE.afterGoodbye,
  },
  {
    // the fake OpenAI fails on "BOOM": the server answers 502, the page stays as it was while Henri thinks
    id: "V10-openai-error",
    steps: async (p, ctx) => {
      await summon(p, ctx);
      await say(p, "BOOM");
      await must(p, all(sends(2), `window.__sends[1] === 502`), "502 from /chat/send");
    },
    ready: all(STATE.thinking, sends(2)),
  },
];
