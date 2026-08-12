/*
 * SHOT LOG - JS/DEBRIEF.JS
 * UPDATE DATE & TIME: 2026-08-12 12:41:00 CDT
 * PRIMARY CHANGES:
 * 1. Enlarged green circle radius in SVG hole cartoon view.
 * 2. Offset 'X' penalty marker next to hazard entry shot circle.
 * 3. Removed terminal holed-out duplicate shot numbers.
 * 4. Added hole-specific club performance table below cartoon view.
 * 5. Added advanced debrief penalty analytics (5-round trend & net stroke impact).
 */

"use strict";

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

  // 1. Draw Hazards
  (hole.hazards || []).forEach(hz => {
    const points = hz.polygon.map(p => project(p[0], p[1]).join(",")).join(" ");
    svg.appendChild(el("polygon", { points, class: "hz-shape" }));
  });

  // 2. Draw Dogleg Corners
  (hole.corners || []).forEach(c => {
    const [x, y] = project(c.lat, c.lng);
    svg.appendChild(el("circle", { cx: x, cy: y, r: 6, class: "corner-shape" }));
  });

  // 3. Draw Green (WISHLIST ITEM: ENLARGED RADIUS TO 14px)
  if (hole.green) {
    const [x, y] = project(hole.green.lat, hole.green.lng);
    svg.appendChild(el("circle", { cx: x, cy: y, r: 14, class: "green-shape" }));
  }

  // 4. Draw Shot Trajectory Line
  if (hole.shots.length > 1) {
    const linePts = hole.shots.map(s => project(s.lat, s.lng).join(",")).join(" ");
    svg.appendChild(el("polyline", { points: linePts, class: "shot-line" }));
  }

  // 5. Draw Shot Circles, Penalty 'X' Badges, and Shot Numbers
  hole.shots.forEach((s, i) => {
    const [x, y] = project(s.lat, s.lng);
    const isTerminal = (s.club === "in" || s.club === "picked up");

    // Skip drawing duplicate shot numbers for terminal holed out marks
    if (isTerminal) return;

    const cls = "shot-dot" + (s.penalty ? " penal" : "");
    svg.appendChild(el("circle", { cx: x, cy: y, r: 6, class: cls }));

    // WISHLIST ITEM: OFFSET 'X' PENALTY MARKER TO SHOW LOST BALL
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
  const playerRounds = db.rounds.filter(r => (r.playerId || "matt") === activePlayer && r.mode === "gps" && r.endedAt);
  
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
