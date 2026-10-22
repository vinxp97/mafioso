// Night 6 part 6: flag presets. Code defaults stay off; a preset only names a set of flags to turn on.
// "recommended" = every flag recommended on in morning-review-20261021.md. voteHold is for single-bot (solo /
// mixed) tables only: on an all-bot table (self-play) it is left off, as recommended (nine-bot self-play −2.2 pts).
export const RECOMMENDED = Object.freeze({
  soloCounterclaim: "on", groundedSpeech: "on", voteKickGuard: "on", gunOnce: "on", chatPassthrough: true,
  sheriffLateGrace: "on", teamClaimGuard: "on", wideClaimParse: "on",
});
export const PRESETS = Object.freeze({ off: Object.freeze({}), recommended: RECOMMENDED });

/** The flag options of a preset; solo: a single-bot table (adds voteHold to "recommended"). */
export function presetFlags(name, { solo = false } = {}) {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown preset ${name} (known: ${Object.keys(PRESETS).join(", ")})`);
  return { ...p, ...(name === "recommended" && solo ? { voteHold: "on" } : {}) };
}
