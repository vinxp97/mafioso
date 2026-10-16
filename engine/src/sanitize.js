// Chat is untrusted. Flatten it, defang injection markers, and quote it before an LLM sees it.
const INJECTION = /(ignore (all |any )?(previous|prior|above)|system prompt|you are (now )?(an? )?(ai|assistant|chatgpt)|<\/?(system|assistant|user|tool)[^>]*>|```|\b(assistant|system|developer)\s*:|reply with|respond with|new instructions?)/gi;

/** One line, length-capped, injection markers defanged. Not JSON-quoted. */
export function defang(s, max = 200) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(INJECTION, (m) => `[${m.replace(/[<>`:]/g, "")}]`);
}

/** Neutralize chat: one line, length-capped, injection markers defanged, quoted. */
export function sanitizeChat(s, max = 200) {
  return JSON.stringify(defang(s, max));
}
