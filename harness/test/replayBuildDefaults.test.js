// The fixture builder's default output is pinned byte for byte. The real logs are not in the repo (real names),
// so a synthetic log that exercises every path the builder options touch stands in for them: a seatmap, a
// Janitor-cleaned Night 1 victim with the Janitor's alert, a Cop alert, Day 1 ballots before and after the
// Sheriff's shot, the shot victim's own ballot, public chat with handles and the nicknames bots make of them
// (plural, "ck" spelling), a rejected line, and the winners. The hash was taken from the builder at 0cbb98f,
// before any Night 5 fixture work. Each option must leave it alone when off, and must change it when on.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { build, parseLog, realNamesIn, BUILD_DEFAULTS } from "../src/replayBuild.js";

const A = (i) => `AcSeat${i}xQz`; const P = (i) => `plPlay${i}xQz`;
// Made-up handles in the dev naming shape (FirstLast + digits). s1 Cop, s2 Mafioso, s3 Sheriff, s4 Janitor,
// s5 Journalist (killed and cleaned Night 1, so no Journalist meeting), s6 Villager, s7 Villager.
const H = { 1: "TokHallow33", 2: "BrennaQuill8", 3: "OswinMarrow51", 4: "PellaGrist70", 5: "DaxFenwold12", 6: "IlseCarrow4", 7: "WendNorrow19" };
const FRAMES = { "game:self": 7, "game:players": 7, "game:state": 20, "game:meeting": 20, "game:message": 40, "game:vote": 20, "game:death": 5, "game:reveal": 5, "game:roleReveal": 7, "game:gunshot": 7, "game:obituaries": 7, "game:winners": 7 };
const meet = (a, phase, id, name) => `meeting ${A(a)} [${phase}] ${id} name="${name}" role=${name === "Mafia Kill" ? "kill" : "-"} vote=true canVote=true targets=6`;
const vote = (a, phase, id, val) => `send ${A(a)} [${phase}] vote ${id} ${val} source=rules prompt=seed`;
const speak = (a, phase, id, text) => `send ${A(a)} [${phase}] speak ${id} ${JSON.stringify(text)} source=llm`;
const chat = (phase, a, text) => `chat [${phase}] Village ${H[a]}: ${JSON.stringify(text)}`;
const dead = (a) => `sched ${A(a)} skip u=0/0 path=dead reason=seat is dead; queue stopped`;
export const SYNTH_LOG = [
  `game GmSynth05x accounts=${[1, 2, 3, 4, 5, 6, 7].map(A).join(",")}`,
  `frames ${JSON.stringify(FRAMES)}`,
  `seatmap ${[1, 2, 3, 4, 5, 6, 7].map((s) => `s${s}=${P(s)}:"${H[s]}"`).join(" ")}`,
  meet(2, "Night 1", "KillMtg01x", "Mafia Kill"), meet(4, "Night 1", "KillMtg01x", "Mafia Kill"), meet(4, "Night 1", "CleanMtg1x", "Clean Death"), meet(1, "Night 1", "InvMtg001x", "Investigate"),
  vote(2, "Night 1", "KillMtg01x", P(5)), vote(4, "Night 1", "KillMtg01x", P(5)), vote(4, "Night 1", "CleanMtg1x", "Yes"), vote(1, "Night 1", "InvMtg001x", P(2)), dead(5),
  `alert ${A(4)} [Day 1] kind=janitor target="${H[5]}" result="Journalist"`, `alert ${A(1)} [Day 1] kind=cop target="${H[2]}" result="Mafia"`,
  meet(3, "Day 1", "GunMtg001x", "Shoot Gun"), meet(1, "Day 1", "VilMtg001x", "Village"),
  speak(1, "Day 1", "VilMtg001x", "im cop. brenna guilty"), chat("Day 1", 1, "im cop. brenna guilty"),
  speak(6, "Day 1", "VilMtg001x", "tok, toks claim is loud. tock why now"), chat("Day 1", 6, "tok, toks claim is loud. tock why now"),
  vote(4, "Day 1", "VilMtg001x", P(1)), vote(7, "Day 1", "VilMtg001x", P(4)),
  speak(3, "Day 1", "VilMtg001x", "im sheriff. pella what are you"), chat("Day 1", 3, "im sheriff. pella what are you"),
  speak(4, "Day 1", "VilMtg001x", "im villager, pellas just blue"), chat("Day 1", 4, "im villager, pellas just blue"),
  vote(3, "Day 1", "GunMtg001x", P(4)), dead(4),
  `speech-reject ${A(2)} [Day 1] source=llm reasons=["chat-audit: DEAD_TARGET dead-sus pellas is sus"] line="pellas is sus"`,
  speak(7, "Day 1", "VilMtg001x", "wend here, brennas next"), chat("Day 1", 7, "wend here, brennas next"),
  vote(1, "Day 1", "VilMtg001x", P(2)), vote(3, "Day 1", "VilMtg001x", P(2)), vote(6, "Day 1", "VilMtg001x", P(2)), vote(7, "Day 1", "VilMtg001x", P(2)), vote(2, "Day 1", "VilMtg001x", P(6)), dead(2),
  `winners {"groups":["Village"],"players":[${[1, 3, 5, 6, 7].map((i) => `"${P(i)}"`).join(",")}],"messages":[],"playersByGroup":{"Village":[${[1, 3, 5, 6, 7].map((i) => `"${P(i)}"`).join(",")}]}}`,
  "",
].join("\n");

const bytes = (r) => { const { out, rejects, types, ...facts } = r; return JSON.stringify({ out, rejects, types, facts }); };
const run = (opts) => { const [g] = parseLog(SYNTH_LOG); return build(g, { source: "synthetic.log", realNames: realNamesIn([SYNTH_LOG]), ...opts }); };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// sha256 of the default build at 0cbb98f (harness/src/replayBuild.js before Night 5's fixture work).
const GOLDEN = "2551d8539d2a9e40648bd9b5f50869f1b78d28e388fd23fa3acd20400117b494";

test("default build of the synthetic log is byte-identical to the 0cbb98f builder", () => {
  const def = bytes(run());
  assert.equal(sha(def), GOLDEN);
  // Passing the defaults by name, or every option at its default, gives the same bytes.
  assert.equal(bytes(run({ ...BUILD_DEFAULTS })), def);
});

test("each builder option changes the synthetic build when it is on (the golden would notice a default flip)", () => {
  const def = bytes(run());
  for (const [k, on] of [["alertRoles", true], ["voteOrder", "log"], ["nickVariants", true]]) assert.notEqual(bytes(run({ [k]: on })), def, k);
  // timeline needs a timed log (below).
  assert.notEqual(bytes(runOn(TIMED_LOG, { timeline: "log" })), def, "timeline");
});

test("nickVariants: a short first name's plural and 'ck' spellings are scrubbed like the name; off, they pass (g14)", () => {
  const chatOf = (r, from) => r.out.filter((e) => e.event === "message" && e.accountId === "acc07" && e.data.senderId === from).map((e) => e.data.content);
  const off = run(); const on = run({ nickVariants: true });
  // s6 (p06) says "tok, toks claim is loud. tock why now" about TokHallow33 (p01).
  assert.deepEqual(chatOf(off, "p06"), ["player01, toks claim is loud. tock why now"], "default: the variants stay (the 0cbb98f behaviour)");
  assert.deepEqual(chatOf(on, "p06"), ["player01, player01 claim is loud. player01 why now"]);
  // Only those words change: same frames, same order, same everything else.
  assert.equal(on.out.length, off.out.length);
  const diff = on.out.map((e, i) => [e, off.out[i]]).filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b));
  assert.ok(diff.length > 0 && diff.every(([a, b]) => a.event === "message" && b.event === "message" && a.data.senderId === "p06"), "only p06's line differs");
});

test("nickVariants leaves ordinary words alone", () => {
  const text = SYNTH_LOG.replace('"tok, toks claim is loud. tock why now"', '"stock lock toss tokens talks"').replaceAll("tok, toks claim is loud. tock why now", "stock lock toss tokens talks");
  const [g] = parseLog(text);
  const r = build(g, { source: "synthetic.log", realNames: realNamesIn([text]), nickVariants: true });
  assert.ok(r.out.some((e) => e.event === "message" && e.data.content === "stock lock toss tokens talks"));
});

// The same log with the L4+ timestamps: "send <acct> [<phase>] t=<ms> ..." and "chat ... t=<ms>", 4 s apart.
const TIMED_LOG = (() => {
  let ms = 1_760_000_000_000;
  return SYNTH_LOG.split("\n").map((l) => {
    if (/^send /.test(l)) return l.replace(/^(send \S+ \[[^\]]*\]) /, (_m, head) => `${head} t=${(ms += 4000)} `);
    if (/^chat /.test(l)) return `${l} t=${ms + 300}`;
    return l;
  }).join("\n");
})();
const runOn = (text, opts) => { const [g] = parseLog(text); return build(g, { source: "synthetic.log", realNames: realNamesIn([text]), ...opts }); };

test("timeline: a log's t= stamps change nothing by default (same bytes as the untimed log)", () => {
  assert.notEqual(TIMED_LOG, SYNTH_LOG);
  assert.equal(bytes(runOn(TIMED_LOG)), bytes(run()));
  assert.equal(sha(bytes(runOn(TIMED_LOG))), GOLDEN);
  assert.notEqual(bytes(runOn(TIMED_LOG, { timeline: "log" })), bytes(runOn(TIMED_LOG)), "on, it changes the build");
  // An untimed log has nothing to place: the option is a no-op there.
  assert.equal(bytes(run({ timeline: "log" })), bytes(run()));
});

test("timeline log: frames carry the log's gaps, and a day's lines, ballots and shot go out in log order", () => {
  const r = runOn(TIMED_LOG, { timeline: "log" });
  const seen = r.out.filter((e) => e.accountId === "acc06"); // a Villager who lives to the end
  const day = seen.slice(seen.findIndex((e) => e.event === "state" && e.data.name === "Day 1"));
  const lines = day.filter((e) => e.event === "message" && e.data.senderId !== "server");
  // Every logged send is 4 s after the one before; the chat copy is the line itself (said once).
  const gaps = lines.slice(1).map((e, i) => e.t - lines[i].t);
  assert.ok(gaps.every((g) => g >= 4000), `gaps ${gaps}`);
  // The day starts TIMELINE_LEAD_MS before its first line (less when the night's own frames ran past that).
  assert.ok(lines[0].t - day[0].t > 1000 && lines[0].t - day[0].t <= 2000, `${lines[0].t - day[0].t}`);
  // Log order: p04's and p07's early ballots land between the Cop's line and the Sheriff's, the shot before p07's last line.
  const order = day.filter((e) => (e.event === "message" && e.data.senderId !== "server") || e.event === "vote" || e.event === "death").map((e) => e.event === "vote" ? `v:${e.data.voterId}` : e.event === "death" ? `x:${e.data}` : `m:${e.data.senderId}`);
  assert.deepEqual(order.slice(0, 6), ["m:p01", "m:p06", "v:p04", "v:p07", "m:p03", "m:p04"]);
  assert.ok(order.indexOf("x:p04") < order.indexOf("m:p07"), order.join(" "));
  // The shot victim's ballots after his death are gone; the default build keeps every ballot after the shot.
  assert.ok(!order.slice(order.indexOf("x:p04")).includes("v:p04"));
});
