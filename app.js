/*
 * SHOT LOG - JS/APP.JS
 * UPDATE DATE & TIME: 2026-08-12 12:41:00 CDT
 * PRIMARY CHANGES: PWA lifecycle, super user deletion guard (Matt), profile isolation,
 * putts isolated from GPS fixes, unconditional course.json fetch.
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

// WISHLIST ITEM: PUTTING DOES NOT PULL GPS; DEFAULTS TO GREEN
function capture(club, holeEnd) {
  const round = activeRound();
  if (!round) return;

  const greenPos = club === "Putt" ? currentGreenPosition() : null;
  const usingGreen = Boolean(greenPos);

  if (!usingGreen && !currentFix) return;

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
  if (holeEnd) shot.holeEnd = holeEnd;

  round.shots.push(shot);
  redoStack = [];
  save();

  if (navigator.vibrate) navigator.vibrate(25);
  render();
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

  [...playerRounds].reverse().forEach(round => {
    const li = document.createElement("li");

    const date = document.createElement("span");
    date.className = "date";
    date.textContent = new Date(round.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = round.shots.length + " shots";

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

// WISHLIST ITEM: MATT IS SUPER USER AND CANNOT BE REMOVED
function deletePlayer(playerId) {
  if (playerId === "matt") {
    alert("Matt is the Super User profile and cannot be removed.");
    return;
  }
  if (!confirm(`Delete profile '${db.players[playerId].name}' and all associated rounds?`)) return;
  delete db.players[playerId];
  db.rounds = db.rounds.filter(r => r.playerId !== playerId);
  db.activePlayerId = "matt";
  save();
  populateSelects();
  render();
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

/* ---- INIT & LISTENERS ---- */
db = load();
courses = loadCourses();

// WISHLIST ITEM: DIRECT TRACER / COURSE JSON WRITER LINK
document.getElementById("tracerLink").addEventListener("click", () => {
  window.location.href = "trace-v2.html";
});

populateSelects();
syncCourseFile();

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