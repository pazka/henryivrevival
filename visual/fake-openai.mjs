// Fake OpenAI for the visual harness (visual/run.sh runs it in its own hardened container from the app image,
// on a docker network of the runner only; the app reaches it through OPENAI_BASE_URL). Fixed text, fixed audio:
// the séance is the same on every run, and no request leaves the runner. Node built-ins only.
//   node visual/fake-openai.mjs [port]      (default 9999)
// Answer chosen from the visitor's LAST message (the system prompt itself contains "bonjour"):
//   contains "BOOM"     -> 400 (the server answers 502: "OpenAI error" use case)
//   contains "SUSPENS"  -> never answers (Henri stays "thinking": the shot is taken while the request waits)
//   contains "bonjour"  -> Henri's apparition ("whouu...": the page shows the apparition, then Henri)
//   contains "adieu"    -> Henri's farewell ("hooo...": the page shows the goodbye)
//   anything else       -> one fixed answer to a question
// Speech: 30 s of silent MPEG-1 Layer III (a real mp3 Chrome decodes; the harness seeks to its end to finish it).
import { createServer } from "node:http";

export const ANSWERS = {
  bonjour: "Whouuuuuuhuuuuuhuhuuuhuhuhuhuhuhuhuuuu ! Je suis l'esprit d'Henri IV, roi de France et de Navarre. Me voici parmi vous : posez-moi trois questions.",
  adieu: "Hoooooooohooooohoohohohhohohohohohooo ! Le monde des rois me rappelle, je dois disparaître. Joyeux anniversaire ! Adieu, Adieu, Adieu.",
  question: "Ventre-saint-gris ! À Ivry, j'ai dit à mes hommes : ralliez-vous à mon panache blanc !",
};

/** n silent frames, 128 kbit/s, 44.1 kHz, mono: header FF FB 90 C4, side info and main data all zero. */
export function silentMp3(seconds = 30) {
  const frame = Buffer.alloc(417); // 144 * 128000 / 44100, no padding
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  const n = Math.ceil((seconds * 44100) / 1152);
  return Buffer.concat(Array.from({ length: n }, () => frame));
}
const MP3 = silentMp3();

// Every request is logged (visual/run.sh checks the log: the app used this fake, with the dummy key).
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let j = {};
    try { j = JSON.parse(body || "{}"); } catch { /* not json */ }
    const json = (status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const key = req.headers.authorization === "Bearer sk-visual-not-a-key" ? "key=dummy" : "key=UNEXPECTED";
    console.log(`fake-openai: ${req.method} ${req.url} ${key}`);
    if (req.url.endsWith("/audio/speech")) {
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": MP3.length });
      return res.end(MP3);
    }
    if (req.url.endsWith("/moderations")) {
      return json(200, { id: "modr-visual", model: "omni-moderation-latest", results: [{ flagged: false, categories: {}, category_scores: {} }] });
    }
    if (!req.url.endsWith("/chat/completions")) return json(404, { error: { message: "not faked" } });
    const last = String((j.messages || []).at(-1)?.content || "");
    console.log(`fake-openai: completion model=${j.model} last=${JSON.stringify(last.slice(0, 40))}`);
    if (last.includes("BOOM")) return json(400, { error: { message: "fake failure", type: "invalid_request_error" } });
    if (last.includes("SUSPENS")) return; // never answered
    const content = /bonjour/i.test(last) ? ANSWERS.bonjour : /adieu/i.test(last) ? ANSWERS.adieu : ANSWERS.question;
    json(200, {
      id: "chatcmpl-visual", object: "chat.completion", created: 1767225600, model: j.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    });
  });
});
server.listen(Number(process.argv[2] || 9999), "0.0.0.0", () => console.log("fake-openai: listening"));
