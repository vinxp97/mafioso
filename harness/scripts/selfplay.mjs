// Offline self-play: full Frontier Justice 9p games on the real harness decision path, no server.
// Usage: npm run selfplay -- --games 50 --seed 1 [--days 8] [--cop-rule vinman|wait] [--sheriff-rule vinman|evidence] [--lawyer loyal|plain] [--mafia adaptive|script] [--town rules|suspicion|random] [--chat-audit enforce|measure] [--stale-votes clear|server] [--hammer on|off] [--plant-audit [held|held2]] [--qt-filler facts] [--qt-repair intent] [--qt-keyfirst on] [--out ../logs/selfplay] [--quiet]
// Never opens a socket and never calls a model.
import path from "node:path";
import { SELFPLAY_DIR, runSelfplay, writeSelfplay } from "../src/selfplay.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const games = Number(flag("--games", "50"));
const seed = Number(flag("--seed", "1"));
const maxDays = Number(flag("--days", "8"));
const outDir = path.resolve(flag("--out", SELFPLAY_DIR));
const quiet = args.includes("--quiet");
// --plant-audit: test-only chatAudit positive control (plants known-bad and known-clean lines, audits, never sends); "held"/"held2" use held-out phrasings
const plantAt = args.indexOf("--plant-audit");
const plantAudit = plantAt < 0 ? false : ["held", "held2"].includes(args[plantAt + 1]) ? args[plantAt + 1] : true;
// --cop-rule vinman (default: claim once a Sheriff is out and alive, or a guilty, or counterclaimed) | wait
const copRule = flag("--cop-rule", "vinman");
// --sheriff-rule vinman (default: always shoot on Day 1) | evidence (Day 1 shot only on a strong read, else hold)
const sheriffRule = flag("--sheriff-rule", "vinman");
if (!["vinman", "evidence"].includes(sheriffRule)) { console.error(`--sheriff-rule must be vinman or evidence, got ${sheriffRule}`); process.exit(2); }
// --lawyer loyal (default, FJ: litigates teammates only) | plain (also frames town as Guilty)
const lawyer = flag("--lawyer", "loyal");
// --mafia adaptive (default: Vinman's FJ strategy from the mafia side) | script (the old fixed plan)
const mafia = flag("--mafia", "adaptive");
// --town rules (default: the live day-vote path) | suspicion (townVote) | random (uniform legal vote)
const town = flag("--town", "rules");
if (!["rules", "suspicion", "random"].includes(town)) { console.error(`--town must be rules, suspicion or random, got ${town}`); process.exit(2); }
// --chat-audit enforce (default: flagged public lines are dropped/regenerated) | measure (audit only, nothing blocked)
const chatAudit = flag("--chat-audit", "enforce");
// --audit-tight on: chatAudit also checks the held-out phrasings (fake vote/count shapes, faction admits, 'x plays r', 'x showed r'); off by default
const auditTight = flag("--audit-tight", "off");
if (!["on", "off"].includes(auditTight)) { console.error(`--audit-tight must be on or off, got ${auditTight}`); process.exit(2); }
if (!["enforce", "measure"].includes(chatAudit)) { console.error(`--chat-audit must be enforce or measure, got ${chatAudit}`); process.exit(2); }
// --stale-votes clear (default: every vote on the dead is cleared, as on dev since Pranay's fix 2026-10-18) | server
// (legacy: reproduce Meeting.generateTargets' early return, so some votes on a player who just died stay and count)
const staleVotes = flag("--stale-votes", "clear");
// --hammer on (default: Vinman 10/18, the revealed Sheriff asks for self-votes and hammers) | off
const hammer = flag("--hammer", "on");
if (!["on", "off"].includes(hammer)) { console.error(`--hammer must be on or off, got ${hammer}`); process.exit(2); }
// --hammer-gate read:margin (tuning only; default HAMMER.minRead:minMargin)
const hammerGate = flag("--hammer-gate", "");
// --qt-filler facts | --qt-repair intent | --qt-keyfirst on (10/19 quiet-table variants; all off by default)
const qtFiller = flag("--qt-filler", "default"), qtRepair = flag("--qt-repair", "default"), qtKey = flag("--qt-keyfirst", "off");
if (!["default", "facts"].includes(qtFiller) || !["default", "intent"].includes(qtRepair) || !["on", "off"].includes(qtKey)) { console.error("--qt-filler default|facts, --qt-repair default|intent, --qt-keyfirst on|off"); process.exit(2); }
const quietTable = qtFiller !== "default" || qtRepair !== "default" || qtKey === "on" ? { filler: qtFiller, repair: qtRepair, keyFirst: qtKey === "on" } : null;
// --claim-pressure l1 (audit-fp 10/19, off by default): any seat may claim at L-1 even when that is one vote (3 alive)
const claimPressure = flag("--claim-pressure", "");
if (!["", "l1"].includes(claimPressure)) { console.error(`--claim-pressure must be l1 (or omitted), got ${claimPressure}`); process.exit(2); }
// --sim-latency live1018 (stale-latency 10/19, off by default): logged live model latency, one call at a time
const simLatency = flag("--sim-latency", "");
if (!["", "live1018"].includes(simLatency)) { console.error(`--sim-latency must be live1018 (or omitted), got ${simLatency}`); process.exit(2); }
// --stale-recheck on | --stale-cancel on | --stale-fallback <seconds> (stale-latency 10/19 variants; all off by default)
const staleRecheck = flag("--stale-recheck", "off"), staleCancel = flag("--stale-cancel", "off"), staleFallback = Number(flag("--stale-fallback", "0"));
if (!["on", "off"].includes(staleRecheck) || !["on", "off"].includes(staleCancel) || !(staleFallback >= 0)) { console.error("--stale-recheck on|off, --stale-cancel on|off, --stale-fallback <seconds>"); process.exit(2); }
const staleFix = staleRecheck === "on" || staleCancel === "on" || staleFallback > 0 ? { recheck: staleRecheck === "on", cancel: staleCancel === "on", fallbackMs: staleFallback * 1000 } : null;
if (!["server", "clear"].includes(staleVotes)) { console.error(`--stale-votes must be server or clear, got ${staleVotes}`); process.exit(2); }
if (!["adaptive", "script"].includes(mafia)) { console.error(`--mafia must be adaptive or script, got ${mafia}`); process.exit(2); }
if (!["vinman", "wait"].includes(copRule)) { console.error(`--cop-rule must be vinman or wait, got ${copRule}`); process.exit(2); }
if (!["loyal", "plain"].includes(lawyer)) { console.error(`--lawyer must be loyal or plain, got ${lawyer}`); process.exit(2); }
const started = Date.now();
const run = await runSelfplay({
  games, seed, maxDays, copRule, sheriffRule, lawyer, mafia, town, chatAudit, plantAudit, staleVotes, hammer, hammerGate, quietTable, ...(claimPressure ? { claimPressure } : {}), ...(simLatency ? { simLatency } : {}), ...(staleFix ? { staleFix } : {}), ...(auditTight === "on" ? { auditTight } : {}),
  onGame: (r) => { if (!quiet) console.error(`game ${r.game}: ${r.winner}${r.error ? ` (${r.error})` : ""} after ${r.days} day(s)`); },
});
const files = await writeSelfplay(run, { outDir });
const c = run.scorecard;
const pct = (x) => (x == null ? "n/a" : `${(100 * x).toFixed(1)}%`);
console.log(`self-play: ${games} games, seed ${seed}, cop rule ${copRule}, sheriff rule ${sheriffRule}, lawyer ${lawyer}, mafia ${mafia}, town ${town}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`win rate: Village ${pct(c.winRate.Village)}, Mafia ${pct(c.winRate.Mafia)}, draw/error ${c.winRate.counts.draw || 0}/${c.winRate.counts.error || 0}`);
console.log(`town ballots on scum: ${pct(c.townVotes.share)} (${c.townVotes.onScum}/${c.townVotes.cast}) vs random ${pct(c.townVotes.randomBaseline)}`);
console.log(`illegal actions: ${c.illegalActions.total}`);
const a = c.chatAudit;
console.log(`chat audit (${a.mode}): ${a.checked} public lines, ${a.LEAK} leaks, ${a.CONTRADICTION} contradictions, ${a.SCUM_MISTAKE} scum mistakes; dropped ${a.dropped}, regenerated ${a.regenerated}`);
console.log(`game length: mean ${c.gameLength.meanDays?.toFixed(2)} days (min ${c.gameLength.minDays}, max ${c.gameLength.maxDays})`);
if (c.plantAudit) for (const [cat, r] of Object.entries(c.plantAudit)) console.log(`plant ${cat}: ${r.planted} planted, ${r.expect === "CLEAN" ? `${r.falsePositives} false positives` : `${r.flagged} flagged`}${r.examples.length ? `; e.g. ${r.examples[0]}` : ""}`);
if (c.topWeakness) console.log(`top weakness: ${c.topWeakness.title}: ${c.topWeakness.evidence}`);
console.log(`wrote ${files.json}\nwrote ${files.md}\nwrote ${files.jsonl}\nwrote ${files.games}`);
process.exit(c.illegalActions.total || c.errors.length ? 1 : 0);
