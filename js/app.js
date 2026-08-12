/*
 * SHOT LOG - APP.JS
 * UPDATE DATE & TIME: 2026-08-12 13:38:27 CDT
 */

"use strict";

let db = null;
let courses = {};
let currentFix = null;
let currentFixAt = 0;
let currentScreen = null;
let debriefState = null;
let redoStack = [];
let manualClub = null;

function loadCourses() {
  const raw = localStorage.getItem(COURSES_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {}
  }
  return {};
}

function saveCourses() {
  localStorage.setItem(COURSES_KEY, JSON.stringify(courses));
}

function migrate(data) {
  data.schemaVersion = SCHEMA_VERSION;
  data.players = data.players || {
    matt: { name: "Matt", priors: DEFAULT_PRIORS_MATT },
    guest: { name: "Guest Player", priors: DEFAULT_PRIORS_GUEST }
  };
  data.activePlayerId = data.activePlayerId || "matt";

  data.rounds.forEach(round => {
    round.playerId = round.playerId || "matt";
    round.courseId = round.courseId || "glendale";
    round.startHole = round.startHole || 1;
    round.mode = round.mode || "gps";
    round.shots.forEach(shot => {
      shot.penaltyStrokes = shot.penaltyStrokes || 0;
    });
  });
  return data;
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return migrate({ schemaVersion: SCHEMA_VERSION, players: {}, rounds: [] });
  try { return migrate(JSON.parse(raw)); }
  catch (err) { return migrate({ schemaVersion: SCHEMA_VERSION, players: {}, rounds: [] }); }
}

const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
const activeRound = () => db.rounds.find(r => !r.endedAt) || null;
const lastShot = round => round.shots[round.shots.length - 1] ?? null;

const wrapHole = n => ((n - 1) % HOLES_PER_ROUND + HOLES_PER_ROUND) % HOLES_PER_ROUND + 1;
const holesEnded = round => round.shots.filter(s => s.holeEnd).length;
const currentHole = round => wrapHole(round.startHole + holesEnded(round));

function currentGreenPosition() {
  const round = activeRound();
  if (!round) return null;
  const course = courses[round.courseId];
  if (!course) return null;
  const hole = course.holes.find(h => h.number === currentHole(round));
  return hole && hole.green ? [hole.green.lat, hole.green.lng] : null;
}

function setHole(target) {
  const round = activeRound();
  if (!round) return;
  round.startHole = wrapHole(target - holesEnded(round));
  save();
  render();
}

function capture(club, holeEnd) {
  const round = activeRound();
  if (!round) return;

  const greenPos = club === "Putt" ? currentGreenPosition() : null;
  const usingGreen = Boolean(greenPos);

  if (!usingGreen && !currentFix) return;

  const acc = usingGreen ? 0 : currentFix.accuracy;
  const fixAgeSec = usingGreen ? 0 : (Date.now() - currentFixAt) / 1000;

  if (!usingGreen && fixAgeSec > 5 && !holeEnd) {
    if (!confirm("Your GPS fix is " + Math.round(fixAgeSec) + "s old. Log anyway?")) return;
  }

  const prev = lastShot(round);
  const shot = {
    lat: usingGreen ? greenPos[0] : currentFix.latitude,
    lng: usingGreen ? greenPos[1] : currentFix.longitude,
    accuracy: usingGreen ? 0 : currentFix.accuracy,
    club,
    penaltyStrokes: 0,
    at: new Date().toISOString()
  };
  if (usingGreen) shot.fromGreen = true;
  if (!usingGreen && acc > 15) shot.lowConfidence = true;
  if (holeEnd) shot.holeEnd = holeEnd;

  round.shots.push(shot);
  redoStack = [];
  save();

  if (navigator.vibrate) navigator.vibrate(25);

  if (prev && prev.club !== null) showResult(prev, distanceFor(prev, shot));
  else if (holeEnd) showIdle(holeEnd === "holed" ? "Holed out." : "Picked up.");
  else showIdle("Tracking " + club + "\u2026");

  render();
}

function cyclePenalty() {
  const round = activeRound();
  const shot = round && lastShot(round);
  if (!shot || shot.club === null) return;

  shot.penaltyStrokes = (shot.penaltyStrokes + 1) % 3;
  save();
  if (navigator.vibrate) navigator.vibrate(shot.penaltyStrokes ? [20, 40, 20] : 15);

  showIdle(
    shot.penaltyStrokes === 0 ? "Cleared. " + shot.club + " back in play."
    : shot.penaltyStrokes === 1 ? shot.club + " +1 penalty."
    : shot.club + " +2 penalty."
  );
  render();
}

function toggleMishit(kind) {
  const round = activeRound();
  const shot = round && lastShot(round);
  if (!shot || shot.club === null) return;

  shot.mishit = (shot.mishit === kind) ? null : kind;
  save();
  if (navigator.vibrate) navigator.vibrate(shot.mishit ? 20 : 15);
  render();
}

function undo() {
  const round = activeRound();
  if (!round || !round.shots.length) return;
  const dropped = round.shots.pop();
  redoStack.push(dropped);
  save();
  showIdle("Removed " + (dropped.club ?? dropped.holeEnd ?? "mark") + ".");
  render();
}

function redo() {
  const round = activeRound();
  if (!round || !redoStack.length) return;
  const restored = redoStack.pop();
  round.shots.push(restored);
  save();
  showIdle("Restored " + (restored.club ?? restored.holeEnd ?? "mark") + ".");
  render();
}

function distanceFor(shot, next) {
  if (shot.club === null) return { kind: "none" };
  if (!next)              return { kind: "pending" };
  if (shot.club === "Putt") return { kind: "putt" };
  const yards = haversineYards(shot, next);
  if (shot.penaltyStrokes === 0) return { kind: "measured", yards };
  if (yards < REPLAY_THRESHOLD_YARDS) return { kind: "unknown" };
  return { kind: "floor", yards };
}

function startRound(source, mode) {
  const startHole = wrapHole(Number(document.getElementById("startHole").value) || 1);
  const playerId = document.getElementById("playerSelect").value;
  const courseId = document.getElementById("courseSelect").value;

  db.rounds.push({
    id: Date.now(),
    playerId,
    courseId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    source,
    mode,
    startHole: mode === "gps" ? startHole : null,
    shots: []
  });
  save();
  if (mode === "gps") showIdle("Tap the club in your hand.");
  render();
}

function endRound() {
  const round = activeRound();
  if (!round) return;
  if (!confirm("End this round? Shots are kept.")) return;
  round.endedAt = new Date().toISOString();
  save();
  render();
}

function deleteRound(id) {
  if (!confirm("Delete this round permanently?")) return;
  db.rounds = db.rounds.filter(r => r.id !== id);
  save();
  render();
}

function exportJson() {
  const stamp = new Date().toISOString().slice(0, 10);
  const payload = { ...db, courses };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "shotlog-backup-" + stamp + ".json";
  a.click();
  URL.revokeObjectURL(url);
}

async function importJson(file) {
  try {
    const incoming = JSON.parse(await file.text());
    if (incoming.courses) {
      Object.assign(courses, incoming.courses);
      saveCourses();
    }
    if (incoming.players) {
      Object.assign(db.players, incoming.players);
    }
    if (Array.isArray(incoming.rounds)) {
      const known = new Set(db.rounds.map(r => r.id));
      const fresh = incoming.rounds.filter(r => !known.has(r.id));
      db.rounds.push(...fresh);
    }
    save();
    populateSelects();
    render();
    toast("Imported data successfully.");
  } catch (err) {
    toast("Could not import file: " + err.message, true);
  }
}

async function importCourseJson(file) {
  try {
    const courseData = JSON.parse(await file.text());
    const id = courseData.id || courseData.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    courses[id] = courseData;
    saveCourses();
    populateSelects();
    toast("Added course: " + courseData.name);
  } catch (err) {
    toast("Invalid course file.", true);
  }
}

function toast(text, bad = false) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.toggle("is-bad", bad);
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

navigator.geolocation.watchPosition(
  pos => {
    currentFix = pos.coords;
    currentFixAt = Date.now();
    const m = Math.round(currentFix.accuracy);
    document.getElementById("acc").textContent = "\u00B1" + m + " m";
    document.getElementById("dot").className = "dot " + (m <= 10 ? "is-good" : m <= 20 ? "" : "is-poor");
    refreshControls();
    renderNudge();
  },
  err => {
    document.getElementById("acc").textContent = "No GPS fix — " + err.message;
    document.getElementById("dot").className = "dot is-poor";
    refreshControls();
  },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
);

function showResult(shot, dist) {
  const box = document.getElementById("readout");
  const label = document.getElementById("readoutLabel");
  const value = document.getElementById("readoutValue");
  const idle = document.getElementById("readoutIdle");

  box.className = "readout";
  clearTimeout(showResult.timer);

  if (dist.kind === "unknown") {
    label.textContent = shot.club + " — replayed";
    value.hidden = true;
    idle.hidden = false;
    idle.textContent = "Stroke counted. No distance.";
    box.classList.add("is-penal");
  } else {
    label.textContent = shot.club + (dist.kind === "floor" ? " — penalty" : "");
    idle.hidden = true;
    value.hidden = false;
    value.innerHTML = (dist.kind === "floor" ? '<span class="floor">\u2265</span>' : "")
      + Math.round(dist.yards) + "<small>yards</small>";
    box.classList.add(dist.kind === "floor" ? "is-penal" : "is-fresh");
  }
  showResult.timer = setTimeout(() => { box.className = "readout"; }, 2800);
}

function showIdle(text) {
  document.getElementById("readoutLabel").textContent = "Last shot";
  document.getElementById("readoutValue").hidden = true;
  const idle = document.getElementById("readoutIdle");
  idle.hidden = false;
  idle.textContent = text;
  document.getElementById("readout").className = "readout";
}

function renderNudge() {
  const panel = document.getElementById("nudge");
  const quiet = document.getElementById("nudgeQuiet");
  const verdict = document.getElementById("nudgeVerdict");
  const detail = document.getElementById("nudgeDetail");
  const round = activeRound();

  panel.className = "nudge is-quiet";
  verdict.hidden = true;
  detail.innerHTML = "";
  quiet.hidden = false;

  if (!round) return;
  if (!currentFix) { quiet.textContent = "Waiting for a fix\u2026"; return; }

  const course = courses[round.courseId];
  if (!course) { quiet.textContent = "Selected course layout missing."; return; }

  const clubTable = calculateClubTable(round.playerId || "matt");
  const hole = course.holes.find(h => h.number === currentHole(round));
  const n = computeNudge([currentFix.latitude, currentFix.longitude], hole, clubTable);

  const yds = x => Math.round(x) + " yds";

  if (n.kind === "no_data")  { quiet.textContent = "Hole " + currentHole(round) + " isn't traced."; return; }
  if (n.kind === "in_water") { quiet.textContent = "Your ball appears to be in the water. Take your drop."; return; }
  if (n.kind === "out_of_range") {
    quiet.textContent = "Water starts at " + Math.round(n.near) + " yds \u2014 out of range even on best day. Hit away.";
    return;
  }
  if (n.kind === "clear") {
    quiet.textContent = n.dogleg
      ? "Dogleg \u2014 play to corner, " + yds(n.toTarget) + ". No water on line."
      : yds(n.toGreen) + " to green. No water on line.";
    return;
  }

  quiet.hidden = true;
  verdict.hidden = false;

  const lines = [];
  if (n.dogleg) lines.push(`Dogleg. Target corner: ${Math.round(n.toTarget)} (${Math.round(n.toGreen)} to green).`);
  const span = n.merged[0];
  lines.push(`Water ${Math.round(span[0])}\u2013${Math.round(span[1])} yds out. Carry ${Math.round(n.carryNeeded)} to clear.`);

  if (n.kind === "go") {
    panel.className = "nudge is-go";
    verdict.textContent = "Go";
    const [name, c] = n.club;
    lines.push(`${name} carries ${Math.round(c.carrySafe)} yds on a poor strike.`);
    if (n.windowEnd < Infinity) {
      lines.push(`Flushed it goes ${Math.round(c.long)} — short of next water.`);
    }
  } else {
    panel.className = "nudge is-layup";
    verdict.textContent = "Lay up";
    if (n.reckless) {
      const [name, c] = n.reckless;
      lines.push(`${name} clears first water, but flushed goes ${Math.round(c.long)} — into water beyond.`);
    } else {
      const [name, c] = n.best;
      lines.push(`Longest safe carry is ${name} at ${Math.round(c.carrySafe)}. You don't have this shot.`);
    }
    if (n.layup) {
      const [name, c] = n.layup;
      lines.push(`Lay up: ${name}. Even flushed stops at ${Math.round(c.long)}.`);
      lines.push(`Leaves ${Math.round(n.toTarget - c.typical)} to the ${n.dogleg ? "corner" : "green"}.`);
    } else {
      lines.push("Nothing lays up cleanly. Aim away from water.");
    }
  }

  for (const line of lines) {
    const p = document.createElement("p");
    p.className = "detail";
    p.textContent = line;
    detail.append(p);
  }
}

function addManualShot() {
  const round = activeRound();
  if (!round || round.mode !== "manual" || !manualClub) return;

  const carry = Number(document.getElementById("carryInput").value);
  const total = Number(document.getElementById("totalInput").value);
  if (!carry) return;

  round.shots.push({
    club: manualClub,
    carry,
    total: total || carry,
    at: new Date().toISOString()
  });
  save();

  if (navigator.vibrate) navigator.vibrate(20);

  document.getElementById("carryInput").value = "";
  document.getElementById("totalInput").value = "";
  document.getElementById("carryInput").focus();
  render();
}

function undoManual() {
  const round = activeRound();
  if (!round || !round.shots.length) return;
  round.shots.pop();
  save();
  render();
}

function selectManualClub(name) {
  manualClub = (manualClub === name) ? null : name;
  document.querySelectorAll("#manualClubs .club").forEach(b =>
    b.classList.toggle("is-last", b.textContent === manualClub)
  );
  refreshManual();
}

function refreshManual() {
  const round = activeRound();
  const carry = Number(document.getElementById("carryInput").value);
  document.getElementById("manualAddBtn").disabled = !(manualClub && carry);
  document.getElementById("manualUndoBtn").disabled = !(round && round.shots.length);
  document.getElementById("manualHint").textContent = !manualClub
    ? "Pick a club, then type what the screen shows."
    : !carry
    ? "Type carry for " + manualClub + "."
    : "Add shot, or keep typing.";
}

function showOverlay(name) {
  currentScreen = name;
  document.getElementById("startScreen").hidden = true;
  document.getElementById("roundScreen").hidden = true;
  document.getElementById("manualScreen").hidden = true;
  document.getElementById("statsScreen").hidden = name !== "stats";
  document.getElementById("debriefScreen").hidden = name !== "debrief";
}

function closeOverlay() {
  currentScreen = null;
  debriefState = null;
  document.getElementById("statsScreen").hidden = true;
  document.getElementById("debriefScreen").hidden = true;
  render();
}

function reconstructRoundHoles(round) {
  let holeNum = round.startHole || 1;
  const holes = [];
  let cur = [];
  for (const shot of round.shots) {
    cur.push(shot);
    if (shot.holeEnd) {
      holes.push({ number: holeNum, shots: cur });
      cur = [];
      holeNum++;
    }
  }
  if (cur.length) holes.push({ number: holeNum, shots: cur });
  return holes;
}

function gradeShot(club, clubEntry, nudgeResult) {
  if (nudgeResult.kind !== "go" && nudgeResult.kind !== "layup") return null;

  const recommendsGo = nudgeResult.kind === "go";
  const carry = clubEntry.carrySafe;
  const totalLong = clubEntry.long;
  const wentForIt = carry >= nudgeResult.carryNeeded;

  if (recommendsGo && wentForIt) {
    return { verdict: "SOLID GO", reason: `${club} carries water (${carry.toFixed(0)} vs ${nudgeResult.carryNeeded.toFixed(0)} needed).` };
  }
  if (recommendsGo && !wentForIt) {
    return { verdict: "CAUTIOUS", reason: `Nudge said go; ${club} played safe (${carry.toFixed(0)} vs ${nudgeResult.carryNeeded.toFixed(0)}).` };
  }
  if (!recommendsGo && wentForIt) {
    return { verdict: "BLUNDER", reason: `Nudge said lay up; ${club} went for carry (${carry.toFixed(0)} vs ${nudgeResult.carryNeeded.toFixed(0)}).` };
  }
  if (totalLong > nudgeResult.layupLimit) {
    return { verdict: "BLUNDER", reason: `${club} total rollout (${totalLong.toFixed(0)}) risks reaching hazard at ${(nudgeResult.layupLimit + 10).toFixed(0)}.` };
  }
  return { verdict: "SOLID LAYUP", reason: `${club} stays short of hazard, as advised.` };
}

function buildDebriefData(round) {
  const course = courses[round.courseId];
  const clubTable = calculateClubTable(round.playerId || "matt");
  const holeGroups = reconstructRoundHoles(round);
  const holesOut = [];
  const events = [];
  const todayShots = {};
  const todayMishits = {};
  const todaySwings = {};
  let totalPutts = 0;
  const perHolePutts = [];

  for (const { number, shots } of holeGroups) {
    const holeDef = course ? course.holes.find(h => h.number === number) : null;
    const pts = [];
    let putts = 0;

    shots.forEach((shot, i) => {
      const clubDisp = displayClub(shot.club) ?? (shot.holeEnd === "picked_up" ? "picked up" : "in");
      if (shot.club === "Putt") putts++;

      const next = shots[i + 1];
      let dist = null;
      if (next && shot.club !== null && shot.club !== "Putt") {
        const yards = haversineYards(shot, next);
        if (!shot.penaltyStrokes) dist = Math.round(yards);
        else if (yards >= REPLAY_THRESHOLD_YARDS) dist = "\u2265" + Math.round(yards);
      }
      pts.push({ lat: shot.lat, lng: shot.lng, club: clubDisp, dist, penalty: shot.penaltyStrokes || 0, mishit: shot.mishit || null });

      if (shot.club && !shot.lowConfidence) {
        todaySwings[clubDisp] = (todaySwings[clubDisp] || 0) + 1;
        if (shot.mishit) {
          todayMishits[clubDisp] = todayMishits[clubDisp] || {};
          todayMishits[clubDisp][shot.mishit] = (todayMishits[clubDisp][shot.mishit] || 0) + 1;
        } else if (!shot.penaltyStrokes && next && shot.club !== "Putt") {
          const yards = haversineYards(shot, next);
          todayShots[clubDisp] = todayShots[clubDisp] || [];
          todayShots[clubDisp].push(yards);
        }
      }

      const prevPenalty = i > 0 ? (shots[i - 1].penaltyStrokes || 0) : 0;
      if (shot.club && shot.club !== "Putt" && shot.club !== "?" && clubTable.clubs[clubDisp] && !prevPenalty && holeDef) {
        const nudgeResult = computeNudge([shot.lat, shot.lng], holeDef, clubTable);
        const g = gradeShot(clubDisp, clubTable.clubs[clubDisp], nudgeResult);
        if (g) events.push({ hole: number, verdict: g.verdict, reason: g.reason, penalty: shot.penaltyStrokes || 0 });
      }
    });

    totalPutts += putts;
    perHolePutts.push({ hole: number, putts });
    holesOut.push({
      number,
      green: holeDef ? holeDef.green : null,
      hazards: holeDef ? holeDef.hazards : [],
      corners: holeDef ? holeDef.corners : null,
      shots: pts,
    });
  }

  const sumVals = obj => Object.values(obj).reduce((a, b) => a + b, 0);

  const clubRows = Object.keys(todayShots).sort().map(club => {
    const vals = todayShots[club];
    const todayAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const standing = clubTable.clubs[club] ? clubTable.clubs[club].typical : null;
    const bad = todayMishits[club] ? sumVals(todayMishits[club]) : 0;
    const swings = todaySwings[club] || (vals.length + bad);
    return {
      club, n: vals.length,
      todayAvg: Math.round(todayAvg * 10) / 10,
      standing: standing != null ? Math.round(standing * 10) / 10 : null,
      diff: standing != null ? Math.round((todayAvg - standing) * 10) / 10 : null,
      mishitBad: bad, mishitSwings: swings,
    };
  });

  const mishitRows = Object.entries(todayMishits).map(([club, kinds]) => {
    const bad = Object.values(kinds).reduce((a, b) => a + b, 0);
    return { club, swings: todaySwings[club] || bad, bad, breakdown: kinds };
  });

  const verdictCounts = {};
  events.forEach(e => { verdictCounts[e.verdict] = (verdictCounts[e.verdict] || 0) + 1; });

  return {
    round, holes: holesOut, clubRows, mishitRows,
    putts: { total: totalPutts, perHole: perHolePutts },
    nudge: { events, counts: verdictCounts },
  };
}

function openDebrief(roundId) {
  const round = db.rounds.find(r => r.id === roundId);
  if (!round) return;

  const data = buildDebriefData(round);
  debriefState = { data, holeIndex: 0 };
  showOverlay("debrief");

  const course = courses[round.courseId];
  document.getElementById("debriefTitle").textContent =
    (course ? course.name : "Round") + " \u2014 " + new Date(round.startedAt).toLocaleDateString();

  renderDebriefSummary(data);
  renderDebriefHole();
}

function renderDebriefSummary(data) {
  const swings = swingCount(data.round);
  const strokes = strokeCount(data.round);
  const sumVals = obj => Object.values(obj).reduce((a, b) => a + b, 0);
  const total = sumVals(data.nudge.counts);
  const solid = (data.nudge.counts["SOLID GO"] || 0) + (data.nudge.counts["SOLID LAYUP"] || 0);
  const acc = total ? Math.round(100 * solid / total) : null;

  document.getElementById("debriefStats").innerHTML = `
    <div><span class="n">${swings}</span><span class="l">swings</span></div>
    <div><span class="n">${strokes}</span><span class="l">strokes</span></div>
    <div><span class="n">${data.putts.total}</span><span class="l">putts</span></div>
    <div><span class="n">${acc != null ? acc + "%" : "\u2014"}</span><span class="l">decisions</span></div>
  `;

  renderDebriefPenaltyAnalysis(data);

  const tbody = document.querySelector("#debriefClubTable tbody");
  tbody.innerHTML = "";
  data.clubRows.forEach(row => {
    const diffTxt = row.diff == null ? "\u2014" : (row.diff >= 0 ? "+" : "") + row.diff;
    const diffClass = row.diff > 0 ? "pos" : row.diff < 0 ? "neg" : "";
    const mishitTxt = row.mishitSwings
      ? Math.round(100 * row.mishitBad / row.mishitSwings) + "% (" + row.mishitBad + "/" + row.mishitSwings + ")"
      : "\u2014";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.club}</td><td>${row.n}</td><td>${row.todayAvg}</td>`
      + `<td>${row.standing ?? "\u2014"}</td><td class="${diffClass}">${diffTxt}</td>`
      + `<td>${mishitTxt}</td>`;
    tbody.appendChild(tr);
  });

  const mEl = document.getElementById("debriefMishits");
  mEl.innerHTML = data.mishitRows.length ? "" : "<p style='color:var(--muted);font-size:0.8125rem'>No bad contact taps.</p>";
  data.mishitRows.forEach(row => {
    const rate = Math.round(100 * row.bad / row.swings);
    const parts = Object.entries(row.breakdown).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + " " + n).join(", ");
    const div = document.createElement("div");
    div.className = "mishit-line";
    div.innerHTML = `<span class="label">${row.club} \u2014 ${parts}</span><span>${rate}% (${row.bad}/${row.swings})</span>`;
    mEl.appendChild(div);
  });

  const threePlus = data.putts.perHole.filter(p => p.putts >= 3).map(p => p.hole);
  const onePutts = data.putts.perHole.filter(p => p.putts === 1).map(p => p.hole);
  const pillRow = (arr, cls) => arr.length
    ? `<p class="pill-row">${arr.map(h => `<span class="pill ${cls}">H${h}</span>`).join("")}</p>` : "";
  document.getElementById("debriefPutts").innerHTML =
    `<div class="mishit-line"><span class="label">Total</span><span>${data.putts.total}</span></div>`
    + pillRow(threePlus, "three") + pillRow(onePutts, "one");

  document.getElementById("debriefNudgeSummary").innerHTML = total === 0
    ? "<p style='color:var(--muted);font-size:0.8125rem'>No water decisions graded.</p>"
    : `<div class="mishit-line"><span class="label">Decisions graded</span><span>${total}</span></div>`
    + `<div class="mishit-line"><span class="label">Blunders</span><span>${data.nudge.counts["BLUNDER"] || 0}</span></div>`
    + `<div class="mishit-line"><span class="label">Cautious</span><span>${data.nudge.counts["CAUTIOUS"] || 0}</span></div>`;

  const neEl = document.getElementById("debriefNudgeEvents");
  neEl.innerHTML = "";
  data.nudge.events.forEach(e => {
    const cls = e.verdict === "BLUNDER" ? "blunder" : e.verdict === "CAUTIOUS" ? "cautious" : "solid";
    const div = document.createElement("div");
    div.className = "nudge-event";
    div.innerHTML = `<span class="tag ${cls}">H${e.hole}</span>${e.reason}`
      + (e.penalty ? ` \u2192 cost ${e.penalty} stroke(s)` : "");
    neEl.appendChild(div);
  });
}

function renderDebriefHole() {
  const { data, holeIndex } = debriefState;
  const hole = data.holes[holeIndex];

  document.getElementById("holeNavLabel").textContent = "Hole " + hole.number;
  document.getElementById("holePrev").disabled = holeIndex === 0;
  document.getElementById("holeNext").disabled = holeIndex === data.holes.length - 1;

  drawHoleCartoon(hole);
  renderHoleClubTable(hole);

  const swings = hole.shots.filter(s => s.club !== "in" && s.club !== "picked up").length;
  const putts = hole.shots.filter(s => s.club === "Putt").length;
  document.getElementById("holeCartoonCaption").textContent = swings + " shots, " + putts + " putts";
}

function openStats() {
  const playerId = document.getElementById("playerSelect").value;
  const table = calculateClubTable(playerId);
  showOverlay("stats");

  document.getElementById("statsPlayerTitle").textContent = db.players[playerId].name + "'s Club Distances";

  const tally = {};
  db.rounds.forEach(r => {
    if (r.playerId !== playerId || r.source !== "real" || r.mode !== "gps") return;
    r.shots.forEach(shot => {
      if (!shot.club || shot.lowConfidence) return;
      const club = displayClub(shot.club);
      tally[club] = tally[club] || { swings: 0, bad: {} };
      tally[club].swings++;
      if (shot.mishit) tally[club].bad[shot.mishit] = (tally[club].bad[shot.mishit] || 0) + 1;
    });
  });

  const sumVals = obj => Object.values(obj).reduce((a, b) => a + b, 0);
  const tbody = document.querySelector("#statsDistanceTable tbody");
  tbody.innerHTML = "";

  Object.entries(table.clubs)
    .sort((a, b) => (b[1].typical || 0) - (a[1].typical || 0))
    .forEach(([club, c]) => {
      const t = tally[club];
      const bad = t ? sumVals(t.bad) : 0;
      const mishitTxt = t ? Math.round(100 * bad / t.swings) + "% (" + bad + "/" + t.swings + ")" : "\u2014";

      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${club}</td><td>${c.n}</td><td>${Math.round(c.mean)}</td>`
        + `<td>${Math.round(c.safe)}</td>`
        + `<td>${Math.round(c.mean * c.rolloutFraction)}</td>`
        + `<td>${Math.round(c.carrySafe)}</td>`
        + `<td>${mishitTxt}</td>`;
      tbody.appendChild(tr);
    });

  const mEl = document.getElementById("statsMishits");
  mEl.innerHTML = "";
  const rows = Object.entries(tally)
    .filter(([, v]) => Object.keys(v.bad).length)
    .sort((a, b) => sumVals(b[1].bad) - sumVals(a[1].bad));

  if (!rows.length) {
    mEl.innerHTML = "<p style='color:var(--muted);font-size:0.8125rem'>No bad contact taps recorded.</p>";
  }
  rows.forEach(([club, v]) => {
    const bad = sumVals(v.bad);
    const rate = Math.round(100 * bad / v.swings);
    const parts = Object.entries(v.bad).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + " " + n).join(", ");
    const div = document.createElement("div");
    div.className = "mishit-line";
    div.innerHTML = `<span class="label">${club} \u2014 ${parts}</span><span>${rate}% (${bad}/${v.swings})</span>`;
    mEl.appendChild(div);
  });
}

const swingCount = round => round.shots.filter(s => s.club !== null).length;
const strokeCount = round => round.shots.reduce((n, s) => n + (s.club === null ? 0 : 1) + (s.penaltyStrokes || 0), 0);

function refreshControls() {
  const round = activeRound();
  const ready = Boolean(currentFix && round);
  const shot = round && lastShot(round);
  const taggable = Boolean(round && shot && shot.club !== null);

  document.querySelectorAll("#clubs .club").forEach(b => { b.disabled = !ready; });
  document.getElementById("puttBtn").disabled = !(round && (ready || currentGreenPosition()));

  const pen = document.getElementById("penaltyBtn");
  pen.disabled = !taggable;
  const n = taggable ? shot.penaltyStrokes : 0;
  pen.dataset.strokes = String(n);
  pen.textContent = n === 0 ? "Add penalty" : "Penalty +" + n + " — tap to change";

  document.querySelectorAll(".mishit").forEach(b => {
    b.disabled = !taggable;
    b.setAttribute("aria-pressed", String(taggable && shot.mishit === b.dataset.kind));
  });

  const hasShots = Boolean(round && round.shots.length);
  document.getElementById("undoBtn").disabled = !hasShots;
  document.getElementById("redoBtn").disabled = !redoStack.length;
  document.getElementById("holedBtn").disabled = !(ready && hasShots);
  document.getElementById("pickedUpBtn").disabled = !(ready && hasShots);
}

function populateSelects() {
  const pSelect = document.getElementById("playerSelect");
  pSelect.innerHTML = "";
  Object.entries(db.players).forEach(([id, p]) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.name + (id === "matt" ? " (Super User)" : "");
    pSelect.appendChild(opt);
  });
  pSelect.value = db.activePlayerId;

  const cSelect = document.getElementById("courseSelect");
  cSelect.innerHTML = "";
  Object.entries(courses).forEach(([id, c]) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = c.name;
    cSelect.appendChild(opt);
  });
}

function renderRounds() {
  const list = document.getElementById("rounds");
  list.innerHTML = "";

  const activePlayer = db.activePlayerId;
  const playerRounds = db.rounds.filter(r => (r.playerId || "matt") === activePlayer);
  document.getElementById("roundsEmpty").hidden = playerRounds.length > 0;
  document.getElementById("exportBtn").disabled = db.rounds.length === 0;

  [...playerRounds].reverse().forEach(round => {
    const li = document.createElement("li");

    const date = document.createElement("span");
    date.className = "date";
    date.textContent = new Date(round.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

    const meta = document.createElement("span");
    meta.className = "meta" + (round.source === "sim" ? " is-sim" : "");
    meta.textContent = (db.players[round.playerId]?.name || "Player") + " \u00B7 " +
      (round.mode === "manual" ? round.shots.length + " typed" : swingCount(round) + " swings \u00B7 " + strokeCount(round) + " strokes");

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "\u00D7";
    del.onclick = e => { e.stopPropagation(); deleteRound(round.id); };

    li.append(date, meta, del);

    if (round.mode === "gps" && round.shots.length) {
      li.classList.add("tappable");
      li.addEventListener("click", () => openDebrief(round.id));
    }

    list.append(li);
  });
}

function renderManual(round) {
  document.getElementById("manualCount").textContent = round.shots.length + " shots";

  const log = document.getElementById("manualLog");
  log.innerHTML = "";
  document.getElementById("manualEmpty").hidden = round.shots.length > 0;

  [...round.shots].reverse().forEach((shot, idx) => {
    const i = round.shots.length - idx;
    const li = document.createElement("li");

    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(i).padStart(2, "0");

    const club = document.createElement("span");
    club.className = "club-name";
    club.textContent = shot.club;

    const roll = shot.total - shot.carry;
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = roll > 0 ? "+" + Math.round(roll) + " roll" : "no roll";

    const yds = document.createElement("span");
    yds.className = "yds";
    yds.innerHTML = Math.round(shot.carry) + ' <span class="total">/ ' + Math.round(shot.total) + "</span>";

    li.append(n, club, note, yds);
    log.append(li);
  });

  refreshManual();
}

function render() {
  if (currentScreen) return;
  const round = activeRound();
  const manual = round && round.mode === "manual";

  document.getElementById("startScreen").hidden = Boolean(round);
  document.getElementById("roundScreen").hidden = !round || manual;
  document.getElementById("manualScreen").hidden = !manual;

  if (!round) { renderRounds(); return; }
  if (manual) { renderManual(round); return; }

  const tag = document.getElementById("sourceTag");
  tag.textContent = round.source === "sim" ? "SIMULATOR" : "REAL";
  tag.classList.toggle("is-sim", round.source === "sim");

  document.getElementById("strokes").textContent = swingCount(round) + " swings \u00B7 " + strokeCount(round) + " strokes";
  document.getElementById("holeNum").textContent = currentHole(round);

  const last = lastShot(round);
  document.querySelectorAll("#clubs .club").forEach(b =>
    b.classList.toggle("is-last", Boolean(last) && b.textContent === displayClub(last.club))
  );

  const log = document.getElementById("log");
  log.innerHTML = "";
  document.getElementById("empty").hidden = round.shots.length > 0;

  round.shots.forEach((shot, i) => {
    const dist = distanceFor(shot, round.shots[i + 1]);
    const li = document.createElement("li");
    if (shot.club === null) li.classList.add("is-end");

    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(i + 1).padStart(2, "0");

    const club = document.createElement("span");
    club.className = "club-name";
    club.textContent = displayClub(shot.club) ?? (shot.holeEnd === "picked_up" ? "up" : "in");

    const note = document.createElement("span");
    note.className = "note" + (shot.penaltyStrokes ? " is-penal" : "");
    note.textContent = shot.penaltyStrokes ? "+" + shot.penaltyStrokes + " penalty"
      : shot.mishit ? shot.mishit + " \u2014 excluded"
      : shot.holeEnd === "picked_up" ? "picked up"
      : shot.fromGreen ? "green (traced)"
      : "\u00B1" + Math.round(shot.accuracy) + "m";

    const yds = document.createElement("span");
    if (dist.kind === "measured")      { yds.className = "yds";              yds.textContent = Math.round(dist.yards) + " yds"; }
    else if (dist.kind === "floor")    { yds.className = "yds floor";        yds.textContent = "\u2265 " + Math.round(dist.yards) + " yds"; }
    else if (dist.kind === "unknown")  { yds.className = "yds void";         yds.textContent = "replayed"; }
    else if (dist.kind === "pending")  { yds.className = "yds pending";      yds.textContent = "in play"; }
    else if (dist.kind === "putt")     { yds.className = "yds pending";      yds.textContent = "putt"; }
    else                               { yds.className = "yds pending";      yds.textContent = "\u2014"; }

    li.append(n, club, note, yds);
    log.append(li);
  });

  refreshControls();
  renderNudge();
}

function buildClubs() {
  const wrap = document.getElementById("clubs");
  wrap.innerHTML = "";
  BAG.forEach(name => {
    const b = document.createElement("button");
    b.className = "club";
    b.type = "button";
    b.textContent = name;
    b.addEventListener("click", () => capture(name));
    wrap.append(b);
  });

  const mwrap = document.getElementById("manualClubs");
  mwrap.innerHTML = "";
  BAG.filter(c => c !== "?").forEach(name => {
    const b = document.createElement("button");
    b.className = "club";
    b.type = "button";
    b.textContent = name;
    b.addEventListener("click", () => selectManualClub(name));
    mwrap.append(b);
  });
}

async function syncCourseFile() {
  try {
    const res = await fetch("course.json?v=" + Date.now());
    if (res.ok) {
      const data = await res.json();
      courses[data.id || "glendale"] = data;
      saveCourses();
      populateSelects();
      render();
    }
  } catch (err) {
    console.warn("Could not fetch course.json automatically:", err);
  }
}

/* ---- INIT APP ---- */
db = load();
courses = loadCourses();

buildClubs();
populateSelects();
syncCourseFile();

document.getElementById("tracerLink").addEventListener("click", () => {
  window.location.href = "trace-v2.html";
});

document.getElementById("playerSelect").addEventListener("change", e => {
  db.activePlayerId = e.target.value;
  save();
  renderRounds();
});

document.getElementById("newPlayerBtn").addEventListener("click", () => {
  const name = prompt("Player Name:");
  if (name) {
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    db.players[id] = { name, priors: DEFAULT_PRIORS_GUEST };
    db.activePlayerId = id;
    save();
    populateSelects();
    render();
  }
});

document.querySelectorAll(".start-choice").forEach(btn =>
  btn.addEventListener("click", () => startRound(btn.dataset.source, btn.dataset.mode))
);

document.getElementById("penaltyBtn").addEventListener("click", cyclePenalty);
document.getElementById("undoBtn").addEventListener("click", undo);
document.getElementById("redoBtn").addEventListener("click", redo);
document.querySelectorAll(".mishit").forEach(b =>
  b.addEventListener("click", () => toggleMishit(b.dataset.kind))
);
document.getElementById("holedBtn").addEventListener("click", () => capture(null, "holed"));
document.getElementById("puttBtn").addEventListener("click", () => capture(PUTT_BUTTON));
document.getElementById("pickedUpBtn").addEventListener("click", () => capture(null, "picked_up"));
document.getElementById("endBtn").addEventListener("click", endRound);
document.getElementById("exportBtn").addEventListener("click", exportJson);

document.getElementById("statsLink").addEventListener("click", openStats);
document.getElementById("statsBack").addEventListener("click", closeOverlay);
document.getElementById("debriefBack").addEventListener("click", closeOverlay);
document.getElementById("holePrev").addEventListener("click", () => {
  if (debriefState && debriefState.holeIndex > 0) {
    debriefState.holeIndex--;
    renderDebriefHole();
  }
});
document.getElementById("holeNext").addEventListener("click", () => {
  if (debriefState && debriefState.holeIndex < debriefState.data.holes.length - 1) {
    debriefState.holeIndex++;
    renderDebriefHole();
  }
});

document.getElementById("manualAddBtn").addEventListener("click", addManualShot);
document.getElementById("manualUndoBtn").addEventListener("click", undoManual);
document.getElementById("manualEndBtn").addEventListener("click", endRound);
document.getElementById("carryInput").addEventListener("input", refreshManual);
document.getElementById("totalInput").addEventListener("input", refreshManual);
document.getElementById("totalInput").addEventListener("keydown", e => { if (e.key === "Enter") addManualShot(); });
document.getElementById("carryInput").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("totalInput").focus(); });

document.getElementById("holeStrip").addEventListener("click", () => {
  const round = activeRound();
  if (!round) return;
  const answer = prompt("Which hole are you on?", currentHole(round));
  const n = Number(answer);
  if (n >= 1 && n <= HOLES_PER_ROUND) setHole(n);
});

document.getElementById("importInput").addEventListener("change", e => {
  if (e.target.files[0]) importJson(e.target.files[0]);
  e.target.value = "";
});

document.getElementById("importCourseInput").addEventListener("change", e => {
  if (e.target.files[0]) importCourseJson(e.target.files[0]);
  e.target.value = "";
});

showIdle("Tap the club in your hand.");
render();
