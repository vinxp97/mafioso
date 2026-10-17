// Offline Frontier Justice runner. Mixed RuleBot and Mafioso seats.
// Does not open a socket. A live host is checked against the dev allowlist and then refused.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALIGNMENT, createSeededRng, emptyView, isAlive, proposeSeatActions, reduce, ruleBotActions,
  scoreGame, validateAction,
} from "mafioso-engine";
import { assertAllowedBase } from "./client.js";

export const FJ_ROLES = Object.freeze([
  "Villager", "Villager", "Villager", "Cop", "Journalist", "Sheriff", "Mafioso", "Janitor", "Lawyer",
]);

export const DEFAULT_LOG_DIR = fileURLToPath(new URL("../../logs/replays", import.meta.url));

const ILLEGAL_RE = /malformed|unknown meeting|cannot vote|selection not in targets|vote locked|unvote not allowed|cannot speak|empty content|content too long|unsupported event/i;

export function alignOf(role) {
  return ALIGNMENT[role] || "unknown";
}

export function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

export function mixSeed(seed, text) {
  let hash = (Number(seed) >>> 0) || 1;
  const s = String(text);
  for (let i = 0; i < s.length; i++) hash = Math.imul(hash ^ s.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function plurality(votes) {
  const counts = new Map();
  for (const vote of votes) {
    if (!vote || vote === "*") continue;
    counts.set(vote, (counts.get(vote) || 0) + 1);
  }
  let best = null;
  let n = 0;
  let tie = false;
  for (const [id, count] of counts) {
    if (count > n) { best = id; n = count; tie = false; }
    else if (count === n) tie = true;
  }
  return tie ? null : best;
}

function countBlocked(rejections) {
  return (rejections || []).filter((line) => ILLEGAL_RE.test(String(line))).length;
}

function sourceBucket(source) {
  if (source === "selector") return "candidate";
  if (source === "llm") return "llm";
  if (source === "fallback" || source === "rules") return "rules";
  return null;
}

/** Live arena hosts must be on the dev allowlist, in a private Testing lobby. */
export function assertArenaLive({ baseUrl, lobby = "Testing", private: isPrivate = true } = {}) {
  if (isPrivate !== true) throw new Error("arena live: private games only");
  if (lobby !== "Testing") throw new Error("arena live: lobby must be Testing");
  return assertAllowedBase(baseUrl);
}

export function dealGame(seed, mafiosoSeats) {
  const rng = createSeededRng(seed);
  const rolesList = shuffle(FJ_ROLES, rng);
  const ids = rolesList.map((_, i) => `p${i + 1}`);
  const roles = {};
  const names = {};
  ids.forEach((id, i) => {
    roles[id] = rolesList[i];
    names[id] = `Bot${i + 1}`;
  });
  const picked = new Set(shuffle([...ids], rng).slice(0, mafiosoSeats));
  const seats = {};
  for (const id of ids) seats[id] = { id, kind: picked.has(id) ? "mafioso" : "rule", promptId: picked.has(id) ? "mafioso" : "rulebot" };
  return { ids, roles, names, seats, seed };
}

function emptyTrace(setup) {
  return {
    seed: setup.seed,
    game: setup.game ?? null,
    setup: "Frontier Justice",
    winner: null,
    seats: [],
    lynches: [],
    townVotes: [],
    nightActions: [],
    checks: [],
    kills: [],
    decisions: [],
    illegal: { proposed: 0, blocked: 0 },
    speech: [],
    messages: {},
    dayPhases: {},
    speechAllowed: {},
    speechSent: {},
    speechSeen: new Set(),
  };
}

function deliver(game, id, frame) {
  game.views[id] = reduce(game.views[id], { ...frame, t: game.now, accountId: id });
}

function deliverAll(game, frame, ids = game.ids) {
  for (const id of ids) deliver(game, id, frame);
}

function living(game) {
  return game.ids.filter((id) => isAlive(game.views[id], id));
}

function createGame(setup) {
  const views = {};
  for (const id of setup.ids) views[id] = emptyView();
  const game = {
    ...setup,
    views,
    now: 1_700_000_000_000,
    stateId: 0,
    ballots: {},
    cleans: 1,
    trace: emptyTrace(setup),
    winner: null,
  };
  const players = {};
  for (const id of setup.ids) players[id] = { id, name: setup.names[id] };
  for (const id of setup.ids) {
    deliver(game, id, { event: "self", data: id });
    deliver(game, id, { event: "players", data: players });
    deliver(game, id, { event: "reveal", data: { playerId: id, role: setup.roles[id] } });
  }
  return game;
}

function openPhase(game, name, meetings) {
  game.stateId += 1;
  game.now += 30_000;
  game.ballots = {};
  deliverAll(game, { event: "state", data: { id: game.stateId, name } });
  const night = name.startsWith("Night");
  for (const meeting of meetings) {
    for (const id of game.ids) {
      const member = meeting.members.includes(id);
      deliver(game, id, {
        event: "meeting",
        data: {
          id: meeting.id,
          name: meeting.name,
          speech: !!meeting.speech && member,
          voting: !!meeting.voting,
          canVote: !!meeting.voting && member,
          canUpdateVote: true,
          amMember: member,
          targets: member ? [...meeting.targets] : [],
          members: member ? [...meeting.members] : [],
          votes: {},
        },
      });
    }
    if (night && meeting.voting) {
      for (const id of meeting.members) {
        if (!living(game).includes(id)) continue;
        game.trace.nightActions.push({
          playerId: id, role: game.roles[id], meeting: meeting.name, open: true, taken: false, key: `${meeting.id}:${id}`,
        });
      }
    }
  }
}

function applyAction(game, id, action, schedule) {
  const view = game.views[id];
  const meeting = view.meetings?.[action.data.meetingId];
  if (!meeting) return false;
  if (action.event === "vote") {
    const prev = game.ballots[action.data.meetingId]?.[id];
    if (prev === action.data.selection) return false;
    game.ballots[action.data.meetingId] ??= {};
    game.ballots[action.data.meetingId][id] = action.data.selection;
    const faction = meeting.name === "Mafia" || meeting.name === "Cult";
    const who = meeting.name === "Village" ? game.ids : (faction ? meeting.members : [id]);
    for (const viewer of who) {
      deliver(game, viewer, {
        event: "vote",
        data: { meetingId: action.data.meetingId, voterId: id, target: action.data.selection },
      });
    }
    const row = game.trace.nightActions.find((item) => item.key === `${action.data.meetingId}:${id}`);
    if (row && action.data.selection && action.data.selection !== "*") row.taken = true;
    return true;
  }
  if (action.event === "speak") {
    const content = action.data.content;
    const dup = (view.messages || []).some((message) => message?.senderId === id && message.content === content && message.meetingId === action.data.meetingId);
    if (dup) return false;
    const faction = meeting.name === "Mafia" || meeting.name === "Cult";
    const who = faction ? (meeting.members || []) : game.ids;
    for (const viewer of who) {
      deliver(game, viewer, { event: "message", data: { senderId: id, content, meetingId: action.data.meetingId } });
    }
    if (!faction) {
      game.trace.messages[id] = (game.trace.messages[id] || 0) + 1;
      if (schedule?.speak) {
        game.trace.speech.push({ seat: id, phase: view.phase?.name || "", text: content, allowed: true });
        game.trace.speechSent[id] = (game.trace.speechSent[id] || 0) + 1;
      }
    }
    return true;
  }
  return false;
}

async function actSeat(game, id, complete, seed, round) {
  const view = game.views[id];
  const spec = game.seats[id];
  const seatSeed = mixSeed(seed, `${id}:${view.stateId}:${round}`);
  if (spec.kind === "mafioso" && typeof complete === "function") {
    try {
      const result = await proposeSeatActions(view, {
        complete, seed: seatSeed, rng: createSeededRng(seatSeed), now: game.now,
      });
      const bucket = sourceBucket(result.source);
      if (bucket) game.trace.decisions.push({ source: result.source, bucket });
      const blocked = countBlocked(result.rejections);
      game.trace.illegal.proposed += blocked;
      game.trace.illegal.blocked += blocked;
      return result;
    } catch {
      game.trace.decisions.push({ source: "fallback", bucket: "rules" });
      return ruleBotActions(view, { seed: seatSeed, now: game.now });
    }
  }
  return ruleBotActions(view, { seed: seatSeed, now: game.now });
}

async function rounds(game, complete, seed) {
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const id of game.ids) {
      if (!isAlive(game.views[id], id)) continue;
      const result = await actSeat(game, id, complete, seed, round);
      const phaseKey = `${id}:${game.views[id].phase?.name || ""}`;
      if (result.schedule?.speak && !game.trace.speechSeen.has(phaseKey)) {
        game.trace.speechSeen.add(phaseKey);
        game.trace.speechAllowed[id] = (game.trace.speechAllowed[id] || 0) + 1;
      }
      for (const action of result.actions || []) {
        if (!validateAction(game.views[id], action).ok) {
          game.trace.illegal.proposed += 1;
          game.trace.illegal.blocked += 1;
          continue;
        }
        if (applyAction(game, id, action, result.schedule)) changed = true;
      }
    }
    if (!changed) break;
    game.now += 1_000;
  }
}

function winnerOf(game) {
  return winnerFor(game.roles, living(game));
}

/** FJ win check on the living: no mafia is a Village win; mafia at or above town is a Mafia win. */
export function winnerFor(roles, live) {
  const mafia = live.filter((id) => alignOf(roles[id]) === "Mafia").length;
  const town = live.filter((id) => alignOf(roles[id]) === "Village").length;
  if (mafia === 0 && town === 0) return "draw";
  if (mafia === 0) return "Village";
  if (mafia >= town) return "Mafia";
  return null;
}

function serverLine(game, id, meetingId, content) {
  deliver(game, id, { event: "message", data: { senderId: "server", content, meetingId } });
}

function resolveNight(game, day) {
  const live = living(game);
  const mafia = live.filter((id) => alignOf(game.roles[id]) === "Mafia");
  const killBallot = game.ballots[`n${day}-mafia`] || {};
  const killVotes = mafia
    .map((id) => killBallot[id])
    .filter((target) => target && target !== "*" && live.includes(target) && alignOf(game.roles[target]) !== "Mafia");
  const kill = plurality(killVotes);

  const lawyerId = live.find((id) => /lawyer/i.test(game.roles[id]));
  const lawyerVote = lawyerId ? game.ballots[`n${day}-lawyer`]?.[lawyerId] : null;
  const litigated = lawyerVote && mafia.includes(lawyerVote) ? lawyerVote : null;

  const copId = live.find((id) => game.roles[id] === "Cop");
  const copTarget = copId ? game.ballots[`n${day}-cop`]?.[copId] : null;
  let copResult = null;
  if (copId && copTarget && live.includes(copTarget) && copTarget !== copId) {
    const guilty = alignOf(game.roles[copTarget]) === "Mafia" && copTarget !== litigated;
    copResult = { target: copTarget, align: guilty ? "Mafia" : "Village" };
    serverLine(game, copId, `n${day}-cop`, `${game.names[copTarget]} is sided with the ${copResult.align}`);
    game.trace.checks.push({
      actorRole: "Cop", targetAlignment: alignOf(game.roles[copTarget]), targetRole: game.roles[copTarget],
    });
  }

  const janitorId = live.find((id) => game.roles[id] === "Janitor");
  const janitorVote = janitorId && game.cleans > 0 ? game.ballots[`n${day}-janitor`]?.[janitorId] : null;
  const cleaned = !!(kill && janitorVote && (janitorVote === kill || /^yes$/i.test(String(janitorVote))));
  if (cleaned) game.cleans -= 1;

  const journalistId = live.find((id) => game.roles[id] === "Journalist");
  const journalistTarget = journalistId ? game.ballots[`n${day}-journalist`]?.[journalistId] : null;
  if (journalistId && journalistTarget && live.includes(journalistTarget)) {
    let sawReport = false;
    if (journalistTarget === copId && copResult) {
      sawReport = true;
      serverLine(game, journalistId, `n${day}-journalist`, `${game.names[copResult.target]} is sided with the ${copResult.align}`);
    } else if (journalistTarget === janitorId && cleaned && kill) {
      sawReport = true;
      serverLine(game, journalistId, `n${day}-journalist`, `${game.names[kill]} was cleaned.`);
    }
    game.trace.checks.push({
      actorRole: "Journalist", targetRole: game.roles[journalistTarget], targetAlignment: alignOf(game.roles[journalistTarget]), sawReport,
    });
  }

  if (kill) {
    game.trace.kills.push({ targetRole: game.roles[kill], living: live.map((id) => game.roles[id]) });
    deliverAll(game, { event: "death", data: kill });
    if (!cleaned) deliverAll(game, { event: "reveal", data: { playerId: kill, role: game.roles[kill] } });
  }
}

function resolveDay(game, day) {
  const live = living(game);
  const sheriff = live.find((id) => game.roles[id] === "Sheriff");
  const shot = sheriff ? game.ballots[`d${day}-shoot`]?.[sheriff] : null;
  if (day === 1 && shot && shot !== "*" && shot !== sheriff && live.includes(shot)) {
    deliverAll(game, { event: "death", data: shot });
    deliverAll(game, { event: "reveal", data: { playerId: shot, role: game.roles[shot] } });
    deliverAll(game, { event: "reveal", data: { playerId: sheriff, role: "Sheriff" } });
  }
  const still = living(game);
  const ballots = game.ballots[`d${day}-village`] || {};
  const votes = [];
  for (const id of still) {
    const target = ballots[id];
    if (!target || target === "*" || !still.includes(target)) continue;
    votes.push(target);
    if (alignOf(game.roles[id]) === "Village") {
      game.trace.townVotes.push({ targetAlignment: alignOf(game.roles[target]) });
    }
  }
  const best = plurality(votes);
  const need = Math.floor(still.length / 2) + 1;
  const tally = best ? votes.filter((target) => target === best).length : 0;
  if (best && tally >= need) {
    game.trace.lynches.push({ targetAlignment: alignOf(game.roles[best]), targetRole: game.roles[best] });
    deliverAll(game, { event: "death", data: best });
    deliverAll(game, { event: "reveal", data: { playerId: best, role: game.roles[best] } });
  }
}

function closeGame(game, winner) {
  const result = winner || "draw";
  game.winner = result;
  const players = result === "draw" ? [] : game.ids.filter((id) => alignOf(game.roles[id]) === result);
  if (result === "draw") deliverAll(game, { event: "winners", data: null });
  else deliverAll(game, { event: "winners", data: { groups: [result], players } });
  game.trace.winner = result;
  game.trace.seats = game.ids.map((id) => ({
    id,
    role: game.roles[id],
    alignment: alignOf(game.roles[id]),
    kind: game.seats[id].kind,
    promptId: game.seats[id].promptId,
    messages: game.trace.messages[id] || 0,
    dayPhases: game.trace.dayPhases[id] || 0,
    speechAllowed: game.trace.speechAllowed[id] || 0,
    speechSent: game.trace.speechSent[id] || 0,
    won: result !== "draw" && alignOf(game.roles[id]) === result,
  }));
}

function nightMeetings(game, day) {
  const live = living(game);
  const mafia = live.filter((id) => alignOf(game.roles[id]) === "Mafia");
  const town = live.filter((id) => alignOf(game.roles[id]) === "Village");
  const meetings = [];
  if (mafia.length) {
    meetings.push({
      id: `n${day}-mafia`, name: "Mafia", speech: true, voting: true, members: mafia, targets: town,
    });
  }
  const one = (role, id, name, targets) => {
    const seat = live.find((playerId) => game.roles[playerId] === role);
    if (!seat) return;
    meetings.push({ id, name, speech: false, voting: true, members: [seat], targets });
  };
  one("Cop", `n${day}-cop`, "Investigate", live.filter((id) => game.roles[id] !== "Cop"));
  one("Journalist", `n${day}-journalist`, "Receive Reports", live.filter((id) => game.roles[id] !== "Journalist"));
  if (game.cleans > 0) one("Janitor", `n${day}-janitor`, "Clean", town);
  const lawyer = live.find((id) => /lawyer/i.test(game.roles[id]));
  if (lawyer) {
    meetings.push({
      id: `n${day}-lawyer`, name: "Litigate", speech: false, voting: true, members: [lawyer],
      targets: live.filter((id) => id !== lawyer),
    });
  }
  return meetings;
}

function dayMeetings(game, day) {
  const live = living(game);
  const meetings = [{
    id: `d${day}-village`, name: "Village", speech: true, voting: true, members: live, targets: [...live, "*"],
  }];
  if (day === 1) {
    const sheriff = live.find((id) => game.roles[id] === "Sheriff");
    if (sheriff) {
      meetings.push({
        id: `d${day}-shoot`, name: "Shoot", speech: false, voting: true, members: [sheriff],
        targets: live.filter((id) => id !== sheriff),
      });
    }
  }
  return meetings;
}

export async function playGame({ seed = 1, mafiosoSeats = 0, complete = null, maxDays = 6, game = 0, keepViews = false } = {}) {
  const setup = dealGame(mixSeed(seed, `game:${game}`), mafiosoSeats);
  setup.game = game;
  setup.seed = seed;
  const table = createGame(setup);
  for (let day = 1; day <= maxDays && !table.winner; day++) {
    openPhase(table, `Night ${day}`, nightMeetings(table, day));
    await rounds(table, complete, seed);
    resolveNight(table, day);
    const afterNight = winnerOf(table);
    if (afterNight) { closeGame(table, afterNight); break; }
    for (const id of living(table)) table.trace.dayPhases[id] = (table.trace.dayPhases[id] || 0) + 1;
    openPhase(table, `Day ${day}`, dayMeetings(table, day));
    await rounds(table, complete, seed);
    resolveDay(table, day);
    const afterDay = winnerOf(table);
    if (afterDay) { closeGame(table, afterDay); break; }
  }
  if (!table.winner) closeGame(table, "draw");
  const record = scoreGame(table.trace);
  return keepViews ? { record, views: table.views } : { record };
}

/**
 * Play `games` Frontier Justice games offline.
 * mode "live" checks the dev allowlist and does not connect.
 */
export async function runArena({
  games = 1, seed = 1, mafiosoSeats = 0, complete = null, maxDays = 6,
  outDir = DEFAULT_LOG_DIR, write = true, file = null, mode = "offline",
  baseUrl = null, lobby = "Testing", private: isPrivate = true, fetch: fetchImpl = null, keepViews = false,
} = {}) {
  if (mode === "live") {
    assertArenaLive({ baseUrl, lobby, private: isPrivate });
    if (typeof fetchImpl === "function") {
      /* The allowlist passed. Still do not call fetch. */
    }
    const error = new Error("arena plays offline and does not open a live socket");
    error.code = "ARENA_OFFLINE";
    throw error;
  }
  if (!Number.isInteger(games) || games < 1 || games > 200) throw new Error("games must be an integer 1..200");
  if (!Number.isInteger(mafiosoSeats) || mafiosoSeats < 0 || mafiosoSeats > FJ_ROLES.length) {
    throw new Error(`mafiosoSeats must be an integer 0..${FJ_ROLES.length}`);
  }
  const records = [];
  let views = null;
  for (let i = 0; i < games; i++) {
    const played = await playGame({ seed, mafiosoSeats, complete, maxDays, game: i, keepViews: keepViews && i === games - 1 });
    records.push(played.record);
    if (played.views) views = played.views;
  }
  let pathWritten = null;
  if (write) {
    await fs.mkdir(outDir, { recursive: true });
    const name = file || `arena-${seed}.jsonl`;
    pathWritten = path.join(outDir, name);
    await fs.writeFile(pathWritten, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }
  return keepViews ? { records, file: pathWritten, views } : records;
}

/** Deterministic stand-in for llmDecide / CandidateGen. Ignores nothing random. */
export function createMockComplete() {
  return async ({ user, purpose } = {}) => {
    const text = String(user || "");
    if (purpose === "memory" || text.includes("Update beliefs and the digest")) {
      return JSON.stringify({ beliefs: [], digest: "Phase resolved." });
    }
    if (purpose === "scheduler" || text.includes("You decide only WHETHER")) {
      return JSON.stringify({ urgency: 2, speak: true, reason: "engine" });
    }
    if (purpose === "candidates" || text.includes("OPEN DECISIONS:")) {
      const decisions = [];
      for (const line of text.split("\n")) {
        const id = line.match(/^- id=(\S+)/);
        if (!id) continue;
        const decisionId = id[1].replace(/:$/, "");
        if (decisionId === "claim") {
          decisions.push({
            id: "claim",
            options: [
              { action: "claim", claim: false, reason: "stay quiet" },
              { action: "claim", claim: true, role: "Villager", reason: "claim town" },
              { action: "no-claim", claim: false, reason: "no claim" },
            ],
          });
          continue;
        }
        if (decisionId === "speech") {
          decisions.push({
            id: "speech",
            options: [
              { action: "goal", goal: "vote the suspect", reason: "push a vote" },
              { action: "goal", goal: "ask for claims", reason: "ask" },
              { action: "goal", goal: "defend yourself", reason: "defend" },
            ],
          });
          continue;
        }
        const meeting = (line.match(/meeting=(\S+)/) || [])[1] || "";
        const targets = ((line.match(/targets=\[([^\]]*)\]/) || [])[1] || "").split(",").map((part) => part.trim()).filter(Boolean);
        const picks = targets.filter((target) => target && target !== "nope").slice(0, 3);
        while (picks.length < 3 && targets.length) picks.push(targets[picks.length % targets.length]);
        decisions.push({
          id: decisionId,
          options: [
            ...picks.slice(0, 3).map((target, index) => ({ action: "vote", meeting, target, reason: `option ${index} ${target}` })),
            { action: "vote", meeting, target: "nope", reason: "illegal target" },
          ],
        });
      }
      return JSON.stringify({ decisions });
    }
    if (purpose === "speech" || text.includes("Reply with one speak")) {
      const meeting = (text.match(/approved one public message in meeting (\S+)/) || [])[1] || "Village";
      return JSON.stringify({ action: "speak", meeting, text: "Voting the lead." });
    }
    const voteLine = text.split("\n").find((line) => line.startsWith("- vote meeting="));
    if (!voteLine) return JSON.stringify({ action: "wait" });
    const meeting = (voteLine.match(/meeting=(\S+)/) || [])[1];
    const targets = ((voteLine.match(/targets=\[([^\]]*)\]/) || [])[1] || "").split(",").map((part) => part.trim()).filter(Boolean);
    const target = targets.find((item) => item !== "*") || targets[0] || "*";
    return JSON.stringify({ action: "vote", meeting, target });
  };
}

/** Same seeds for the current prompt and a candidate. Score is the Mafioso seats' win rate. */
export function createArenaScorer({ seed = 1, games = 2, mafiosoSeats = 3, complete, maxDays = 4 } = {}) {
  if (typeof complete !== "function") throw new Error("createArenaScorer requires complete");
  return async ({ prompt, label }) => {
    const bound = (input) => complete({
      ...input,
      system: input?.purpose === "memory" || input?.purpose === "scheduler" || input?.purpose === "candidates"
        ? input?.system
        : (prompt?.text || input?.system),
      purpose: input?.purpose,
    });
    const records = await runArena({
      seed, games, mafiosoSeats, complete: bound, maxDays, write: false, mode: "offline",
    });
    const rates = records.map((record) => {
      const seats = (record.seats || []).filter((seat) => seat.kind === "mafioso");
      if (!seats.length) return record.winner === "Mafia" ? 1 : 0;
      return seats.filter((seat) => seat.won).length / seats.length;
    });
    const n = rates.length || 1;
    const mean = rates.reduce((sum, rate) => sum + rate, 0) / n;
    const variance = n > 1 ? rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / (n - 1) : 0;
    return { mean, se: Math.sqrt(variance / n), games: rates.length, seed, label };
  };
}

export async function readMetrics(file) {
  const raw = await fs.readFile(file, "utf8");
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
