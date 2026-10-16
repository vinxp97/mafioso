// JSDoc typedefs only (no runtime). Shapes per Games/core/Meeting.js getMeetingInfo
// and the Dev API stream envelope {accountId, seq, t, event, data}.
/** @typedef {{accountId?:string, seq?:number, t?:number, event:string, data?:any}} Frame */
/** @typedef {{id:string, name:string, left?:boolean, alive?:boolean}} Player */
/** @typedef {{name:string, phase:'Pregame'|'Day'|'Night'|'Postgame'|string, day:number}} PhaseState */
/** @typedef {{id:string, name:string, actionName?:string, members?:any[], speech?:boolean,
 *   voting?:boolean, canVote?:boolean, canUpdateVote?:boolean, amMember?:boolean,
 *   targets?:string[], inputType?:string, votes?:Record<string,string|string[]>,
 *   multi?:boolean, instant?:boolean, noUnvote?:boolean, anonymous?:boolean}} Meeting */
/** @typedef {{selfId:string|null, players:Record<string,Player>, dead:Record<string,boolean>,
 *   phase:PhaseState|null, meetings:Record<string,Meeting>, messages:any[], winners:any,
 *   leftGame:boolean, finished:boolean, stateId:number|string,
 *   history:Record<string,HistoryState>, reveals:Record<string,string>, role:string|null, claims:ClaimBoard,
 *   notes:object, ledger:{nextId:number, facts:object[]}, beliefs:{entries:object, rejected:object[], source:string, phase:string},
 *   digest:{text:string, phase:string, source:string}, memory:{due:boolean, beliefSource:string, summarizedPhase:string},
 *   speechHoldUntil?:number}} GameView */
/** @typedef {Record<string,{role:string|null, kind:'claim'|'cc'|'retract', history:any[]}>} ClaimBoard */
/** @typedef {{name?:string, meetings?:Record<string,Meeting>, roles?:Record<string,string>,
 *   dead?:Record<string,boolean>, alerts?:any[], winners?:any}} HistoryState */
/** @typedef {{role:string, alwaysAct:'yes'|'no', nights:string, n1Pick:string, laterPick:string, neverNoOne:boolean}} NightSpec */
/** @typedef {{event:'vote'|'unvote'|'speak', data:{meetingId:string, selection?:string, content?:string}}} ProposedAction */
export const DEV_HOSTS = Object.freeze(["https://dev.ultimafia.gg", "http://127.0.0.1:3000"]);
export const MAX_SPEECH = 240;
export const NO_ONE = "*";
