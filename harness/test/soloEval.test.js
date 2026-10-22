// Night 5 single-bot eval (src/soloEval.js): who sat at the fixture tables, the one-seat counterfactual replay,
// and its scoring against the true roles and the five Night 5 rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { surveyFixture, tableFacts, publicLines, soloReplay, scoreSolo, aggregate } from "../src/soloEval.js";

const dir = (d) => new URL(`./fixtures/${d}/`, import.meta.url);
const read = (d, f) => fs.readFileSync(new URL(f, dir(d)), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const manifest = (d) => JSON.parse(fs.readFileSync(new URL("manifest.json", dir(d)), "utf8")).fixtures;
const timed = (n) => read("solo-timeline", `${n}.jsonl`);
const seatOf = (E, role) => { const f = tableFacts(E); return Object.keys(f.pidOf).find((a) => f.roles[f.pidOf[a]] === role); };

test("survey: every fixture table (g01-g16, L2-L10) is nine harness bot seats, with no human seat and no human line", () => {
  let n = 0; let lines = 0;
  for (const d of ["replays", "live-1018", "live-1019"]) for (const m of manifest(d)) {
    const s = surveyFixture(read(d, m.fixture), m);
    n += 1; lines += s.publicLines;
    assert.equal(s.botSeats, 9, m.fixture);
    assert.equal(s.humanSeats, 0, m.fixture);
    assert.equal(s.humanLines, 0, m.fixture);
    if (d !== "replays") assert.equal(s.rolesTrusted, true, m.fixture); // L2-L10: seatmap binding, meeting roles
  }
  assert.equal(n, 25);
  assert.ok(lines > 700, `${lines}`); // 761 public lines in all, every one from a harness seat
  // Each line once: L10's public chat is 15 lines, not 15 x the nine seats' copies.
  assert.equal(publicLines(read("live-1019", "l10.jsonl")).length, 15);
});

test("solo-timeline fixtures: the same games and chat as live-1018/1019, on the log's clock", () => {
  const pair = { l05: ["live-1018", "l05"], l06: ["live-1018", "l06"], l07: ["live-1018", "l07"], l08: ["live-1018", "l08"], l09: ["live-1019", "l09"], l10: ["live-1019", "l10"] };
  const msgs = (E) => E.filter((e) => e.event === "message").map((e) => `${e.accountId}|${e.data.senderId}|${e.data.content}`).sort();
  for (const [n, [d, f]] of Object.entries(pair)) {
    const a = timed(n); const b = read(d, `${f}.jsonl`);
    assert.deepEqual(msgs(a), msgs(b), n);
    assert.equal(tableFacts(a).winner, tableFacts(b).winner, n);
    // Days take minutes, not the ~5 s of the order-only build.
    const fa = tableFacts(a); const fb = tableFacts(b);
    const len = (f) => f.dayStart["Night 2"] - f.dayStart["Day 1"];
    assert.ok(len(fa) > 60_000 && len(fb) < 20_000, `${n} ${len(fa)} ${len(fb)}`);
  }
});

test("soloReplay: the occupant's own votes and lines leave the seat's stream, the bot's own sends are echoed back to it", async () => {
  const E = timed("l10"); const f = tableFacts(E); const acc = seatOf(E, "Sheriff");
  const run = await soloReplay(E, acc, { facts: f });
  assert.deepEqual(run.errors, []);
  assert.equal(run.logged.length, 6); // 3 lines, 3 ballots (one of them the gun)
  // Its view holds its own claim (echoed), not the logged one.
  const said = (run.view.messages || []).filter((m) => m.senderId === run.pid).map((m) => m.content);
  assert.ok(said.includes("im sheriff"));
  assert.equal(said.filter((x) => x === "im sheriff").length, 1);
  const s = scoreSolo(E, run, f);
  // Rule 4 on the log's clock.
  assert.ok(s.rules.r4_sheriffClaimDelay.ok && s.rules.r4_sheriffClaimDelay.claim.ms >= 1000 && s.rules.r4_sheriffClaimDelay.claim.ms <= 10_500);
  // Night 5 (pre sheriff-target) shot the Cop-accused Mafioso p07 here, contested by the logged Journalist counterclaim.
  // Since sheriff-target (4f4d269, merged in chat-pass-eval) a weak contested pair waits for the vote, so the bot asks
  // p07 and holds; the log's own shot then lands first and the seat's gun is spent. Either way the gun never hits town.
  assert.deepEqual(s.gun.bot, []);
  assert.ok(run.proposals.some((p) => p.event === "speak" && /player07 claim before i shoot/i.test(p.data.content)));
  assert.deepEqual(s.gun.logged.map((g) => [g.phase, g.target, g.align]), [["Day 1", "p07", "Mafia"]]);
});

test("rule 2 in a one-bot lobby: the counterclaimer pick can land on a (human) teammate, and then nobody counterclaims", async () => {
  const E = timed("l08"); const f = tableFacts(E);
  const byRole = async (r) => scoreSolo(E, await soloReplay(E, seatOf(E, r), { facts: f }), f).rules.r2_mafiaCounterclaim;
  const mafioso = await byRole("Mafioso");
  assert.equal(mafioso.opportunities.length, 1);
  assert.equal(mafioso.opportunities[0].role, "Journalist");
  assert.equal(mafioso.opportunities[0].mine, true);
  assert.ok(mafioso.opportunities[0].cc.delayMs >= 3000 && mafioso.opportunities[0].cc.delayMs <= 7000, `${mafioso.opportunities[0].cc.delayMs}`);
  assert.equal(mafioso.sent, 1);
  for (const r of ["Janitor", "Lawyer"]) {
    const x = await byRole(r);
    // The hash picks the Mafioso: right at an all-bot table, silence at a table where he is a person.
    assert.equal(x.opportunities[0].picker, f.pidOf[seatOf(E, "Mafioso")], r);
    assert.equal(x.sent, 0, r);
    assert.equal(x.ok, true, r);
  }
});

test("a Vote Kick meeting opening trips the Sheriff's gun at once (kept), and the builder's day-start kick is dropped by default", async () => {
  const E = timed("l06"); const f = tableFacts(E); const acc = seatOf(E, "Sheriff");
  const keep = scoreSolo(E, await soloReplay(E, acc, { facts: f, voteKick: "keep" }), f);
  assert.ok(keep.gun.bot.length >= 1 && keep.gun.bot[0].ms < 3000 && keep.gun.bot[0].status === "unasked", JSON.stringify(keep.gun.bot));
  const drop = scoreSolo(E, await soloReplay(E, acc, { facts: f }), f);
  assert.ok(drop.gun.bot.every((g) => g.ms > 60_000), JSON.stringify(drop.gun.bot));
});

test("every seat of L5-L10 on the rules path: no errors, never vt, Cop claims one line, Sheriff claims in 1-10 s", async () => {
  const scored = [];
  for (const n of ["l05", "l06", "l07", "l08", "l09", "l10"]) {
    const E = timed(n); const f = tableFacts(E);
    for (const acc of Object.keys(f.pidOf).sort()) scored.push({ fixture: n, ...scoreSolo(E, await soloReplay(E, acc, { facts: f }), f) });
  }
  const agg = aggregate(scored);
  assert.equal(agg.seats, 54);
  assert.deepEqual(agg.errors, []);
  for (const k of ["r1_sheriffWaitsOnVillager", "r2_mafiaCounterclaim", "r3_copOneLine", "r4_sheriffClaimDelay", "r5_noVt"]) assert.deepEqual(agg.rules[k].fails, [], k);
  assert.equal(agg.rules.r5_noVt.seats, 54);
  assert.equal(agg.rules.r3_copOneLine.seats, 6);
  assert.equal(agg.rules.r4_sheriffClaimDelay.seats, 5); // L9's Sheriff died Night 1
  // Every town claim the bot made says villager (or a power role), never vt.
  assert.ok(scored.flatMap((s) => s.claims.bot).every((c) => c.role !== "vt"));
});
