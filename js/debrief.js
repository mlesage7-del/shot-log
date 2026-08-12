/*
 * SHOT LOG - DEBRIEF.JS
 * UPDATE DATE & TIME: 2026-08-12 14:26:36 CDT
 */

"use strict";

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
  const course = window.courses[round.courseId];
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
  const round = window.db.rounds.find(r => r.id === roundId);
  if (!round) return;

  const data = buildDebriefData(round);
  window.debriefState = { data, holeIndex: 0 };
  window.showOverlay("debrief");

  const course = window.courses[round.courseId];
  document.getElementById("debriefTitle").textContent =
    (course ? course.name : "Round") + " \u2014 " + new Date(round.startedAt).toLocaleDateString();

  renderDebriefSummary(data);
  renderDebriefHole();
}

function renderDebriefSummary(data) {
  const swings = window.swingCount(data.round);
  const strokes = window.strokeCount(data.round);
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
  const { data, holeIndex } = window.debriefState;
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

function drawHoleCartoon(hole) {
  const svg = document.getElementById("holeCartoon");
  svg.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  };

  const pts = [];
  if (hole.green) pts.push([hole.green.lat, hole.green.lng]);
  (hole.hazards || []).forEach(hz => hz.polygon.forEach(p => pts.push(p)));
  (hole.corners || []).forEach(c => pts.push([c.lat, c.lng]));
  hole.shots.forEach(s => pts.push([s.lat, s.lng]));
  if (!pts.length) return;

  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const lng0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const toXY = projector(lat0, lng0);

  const anchorFrom = hole.shots.length ? hole.shots[0] : null;
  const anchorTo = hole.green || (hole.shots.length ? hole.shots[hole.shots.length - 1] : null);
  let angle = 0;
  if (anchorFrom && anchorTo) {
    const [fx, fy] = toXY(anchorFrom.lat, anchorFrom.lng);
    const [tx, ty] = toXY(anchorTo.lat, anchorTo.lng);
    angle = Math.atan2(tx - fx, ty - fy);
  }

  const toRotatedXY = (lat, lng) => {
    const [x, y] = toXY(lat, lng);
    return [x * Math.cos(angle) - y * Math.sin(angle),
            x * Math.sin(angle) + y * Math.cos(angle)];
  };

  const xy = pts.map(p => toRotatedXY(p[0], p[1]));
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 20), spanY = Math.max(maxY - minY, 20);
  const PAD = 28, SIZE = 320;
  const scale = Math.min((SIZE - 2 * PAD) / spanX, (SIZE - 2 * PAD) / spanY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

  const project = (lat, lng) => {
    const [x, y] = toRotatedXY(lat, lng);
    return [SIZE / 2 + (x - cx) * scale, SIZE / 2 - (y - cy) * scale];
  };

  (hole.hazards || []).forEach(hz => {
    const points = hz.polygon.map(p => project(p[0], p[1]).join(",")).join(" ");
    svg.appendChild(el("polygon", { points, class: "hz-shape" }));
  });

  (hole.corners || []).forEach(c => {
    const [x, y] = project(c.lat, c.lng);
    svg.appendChild(el("circle", { cx: x, cy: y, r: 6, class: "corner-shape" }));
  });

  if (hole.green) {
    const [x, y] = project(hole.green.lat, hole.green.lng);
    svg.appendChild(el("circle", { cx: x, cy: y, r: 14, class: "green-shape" }));
  }

  if (hole.shots.length > 1) {
    const linePts = hole.shots.map(s => project(s.lat, s.lng).join(",")).join(" ");
    svg.appendChild(el("polyline", { points: linePts, class: "shot-line" }));
  }

  hole.shots.forEach((s, i) => {
    const [x, y] = project(s.lat, s.lng);
    const isTerminal = (s.club === "in" || s.club === "picked up");

    if (isTerminal) return;

    const cls = "shot-dot" + (s.penalty ? " penal" : "");
    svg.appendChild(el("circle", { cx: x, cy: y, r: 6, class: cls }));

    if (s.penalty > 0) {
      const xMarker = el("text", {
        x: x + 10,
        y: y + 4,
        class: "penal-x",
        "text-anchor": "start"
      });
      xMarker.textContent = "X";
      svg.appendChild(xMarker);
    }

    const t = el("text", { x, y: y - 9, class: "shot-num", "text-anchor": "middle" });
    t.textContent = String(i + 1);
    svg.appendChild(t);
  });
}

function renderHoleClubTable(hole) {
  const tbody = document.querySelector("#holeClubTable tbody");
  tbody.innerHTML = "";

  const shots = hole.shots.filter(s => s.club !== "in" && s.club !== "picked up" && s.club !== "Putt");
  if (!shots.length) {
    tbody.innerHTML = "<tr><td colspan='5' style='text-align:center;color:var(--muted)'>No full swings on this hole.</td></tr>";
    return;
  }

  shots.forEach((shot, idx) => {
    const tr = document.createElement("tr");
    const totalYds = shot.dist ? shot.dist + " yds" : "—";
    const contact = shot.mishit ? shot.mishit : (shot.penalty ? "Penalty" : "Clean");
    const estCarry = shot.dist ? Math.round(shot.dist * 0.90) + " yds" : "—";

    tr.innerHTML = `
      <td>${shot.club}</td>
      <td>#${idx + 1}</td>
      <td>${totalYds}</td>
      <td>${estCarry}</td>
      <td>${contact}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDebriefPenaltyAnalysis(data) {
  const activePlayer = data.round.playerId || "matt";
  const playerRounds = window.db.rounds.filter(r => (r.playerId || "matt") === activePlayer && r.mode === "gps" && r.endedAt);
  
  let currentPenalties = 0;
  let currentMishits = 0;

  data.round.shots.forEach(s => {
    currentPenalties += (s.penaltyStrokes || 0);
    if (s.mishit) currentMishits++;
  });

  const last5 = playerRounds.slice(-5);
  let historicalPenSum = 0;
  last5.forEach(r => {
    r.shots.forEach(s => { historicalPenSum += (s.penaltyStrokes || 0); });
  });
  const avgPenalties = last5.length ? (historicalPenSum / last5.length).toFixed(1) : currentPenalties.toFixed(1);
  const diff = (currentPenalties - avgPenalties).toFixed(1);
  const diffTxt = diff > 0 ? `+${diff} worse than avg` : diff < 0 ? `${diff} better than avg` : "on par with avg";

  const container = document.getElementById("debriefPenaltyAnalysis");
  container.innerHTML = `
    <div class="mishit-line"><span class="label">Penalty Strokes Incurred</span><span>${currentPenalties}</span></div>
    <div class="mishit-line"><span class="label">5-Round Baseline Avg</span><span>${avgPenalties} (${diffTxt})</span></div>
    <div class="mishit-line"><span class="label">Bad Contact / Mishits</span><span>${currentMishits}</span></div>
    <div class="mishit-line"><span class="label">Net Stroke Cost</span><span>+${currentPenalties} strokes</span></div>
  `;
}

function openStats() {
  const playerId = document.getElementById("playerSelect").value;
  const table = calculateClubTable(playerId);
  window.showOverlay("stats");

  const playerName = (window.db.players[playerId] && window.db.players[playerId].name) ? window.db.players[playerId].name : "Player";
  document.getElementById("statsPlayerTitle").textContent = playerName + "'s Club Distances";

  const tally = {};
  window.db.rounds.forEach(r => {
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
      const mishitTxt = t && t.swings ? Math.round(100 * bad / t.swings) + "% (" + bad + "/" + t.swings + ")" : "\u2014";

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

window.openDebrief = openDebrief;
window.renderDebriefHole = renderDebriefHole;
window.openStats = openStats;