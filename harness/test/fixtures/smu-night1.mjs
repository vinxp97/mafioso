// Night 1 of dev game GAME06 (2026-10-16), rebuilt from the live log and the server's meeting
// definitions (MeetingFaction: "Mafia" chat, "Mafia Kill", "Mafia Action"; CleanDeath; FlipAlignment "Litigate"; VegKickMeeting).
export const seats = [
  { acc: "BdfxxtT8aV", pid: "a0BHWAcOIlw", name: "Ash", role: "Cop" },
  { acc: "7bCA7smJCA", pid: "rhyFPKXcnH", name: "Bea", role: "Villager" },
  { acc: "UqLogAKcXV", pid: "otU9CsNlbw", name: "Cal", role: "Mafioso" },
  { acc: "5GQkDserB7", pid: "jVE7zbEozZZ", name: "Dot", role: "Villager" },
  { acc: "uHrDvSLMrm", pid: "k9xFo5YsB11", name: "Eli", role: "Villager" },
  { acc: "LvfgopzSZY", pid: "BXHO_QetVp", name: "Fin", role: "Journalist" },
  { acc: "Nmok5Hx23k", pid: "q7Rt2LmXw0a", name: "Gil", role: "Sheriff" },
  { acc: "iuxCERYkJU", pid: "Hsd2JfBMtVt", name: "Hap", role: "Lawyer" },
  { acc: "f6afPipwwT", pid: "kCMt06jKvBp", name: "Ivo", role: "Janitor" },
];
export const MAFIA = new Set(["Mafioso", "Lawyer", "Janitor"]);
export const players = Object.fromEntries(seats.map((s) => [s.pid, { id: s.pid, name: s.name }]));
const all = seats.map((s) => s.pid);
const mafia = seats.filter((s) => MAFIA.has(s.role)).map((s) => s.pid);

export function meetingsFor(seat) {
  const out = [];
  const others = all.filter((id) => id !== seat.pid);
  if (MAFIA.has(seat.role)) {
    out.push({ id: "38S8qkzPMKC", name: "Mafia", speech: true, voting: false, amMember: true, members: mafia.map((id) => ({ id })) });
    out.push({ id: "zbABCg9YSTU", name: "Mafia Kill", actionName: "Mafia Kill", voting: true, canVote: true, amMember: true, targets: all.filter((id) => !mafia.includes(id)), votes: {}, members: mafia.map((id) => ({ id })) });
    out.push({ id: "MafAct01xyz", name: "Mafia Action", actionName: "End Meeting?", voting: true, canVote: true, amMember: true, targets: ["Yes", "No"], votes: {} });
  }
  if (seat.role === "Janitor") out.push({ id: "7d30ffrZhr-", name: "Clean Death", voting: true, canVote: true, amMember: true, targets: ["Yes", "No"], votes: {} });
  if (seat.role === "Lawyer") out.push({ id: "gb0jRjDsD1x", name: "Litigate", voting: true, canVote: true, amMember: true, targets: others, votes: {} });
  if (seat.role === "Cop") out.push({ id: "C2rQUSIK4V6", name: "Cop", actionName: "Learn Alignment", voting: true, canVote: true, amMember: true, targets: others, votes: {} });
  if (seat.role === "Journalist") out.push({ id: "b6EAvZBsoNa", name: "Journalist", voting: true, canVote: true, amMember: true, targets: others, votes: {} });
  return out;
}

export const voteKick = { id: "B2k03Izd6", name: "Vote Kick", voting: true, canVote: true, amMember: true, targets: ["Kick"], votes: {} };
