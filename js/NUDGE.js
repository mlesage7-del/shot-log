/*
 * SHOT LOG - JS/NUDGE.JS
 * UPDATE DATE & TIME: 2026-08-12 12:41:00 CDT
 * PRIMARY CHANGES: Spatial geometry, Haversine distance, hazard boundary crossings.
 */

"use strict";

function haversineYards(a, b) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)) * M_TO_YARDS;
}

function projector(lat0, lng0) {
  const mLng = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
  return (lat, lng) => [(lng - lng0) * mLng, (lat - lat0) * M_PER_DEG_LAT];
}

function segIntersectT(p, q, a, b) {
  const [px, py] = p, [qx, qy] = q, [ax, ay] = a, [bx, by] = b;
  const rx = qx - px, ry = qy - py, sx = bx - ax, sy = by - ay;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((ax - px) * sy - (ay - py) * sx) / denom;
  const u = ((ax - px) * ry - (ay - py) * rx) / denom;
  return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? t : null;
}

function crossings(ball, green, polygon, toXY) {
  const p = toXY(...ball), q = toXY(...green);
  const pts = polygon.map(([la, ln]) => toXY(la, ln));
  const ts = [];
  for (let i = 0; i < pts.length; i++) {
    const t = segIntersectT(p, q, pts[i], pts[(i + 1) % pts.length]);
    if (t !== null) ts.push(t);
  }
  return ts.sort((a, b) => a - b);
}

const yardsBetween = (a, b, toXY) => {
  const [ax, ay] = toXY(...a), [bx, by] = toXY(...b);
  return Math.hypot(bx - ax, by - ay) * M_TO_YARDS;
};

function chooseTarget(ball, hole, toXY) {
  const green = [hole.green.lat, hole.green.lng];
  const corners = hole.corners || [];
  if (!corners.length) return { target: green, label: "green" };

  const greenXY = toXY(...green);
  const ballXY = toXY(...ball);
  const ballToGreen = Math.hypot(ballXY[0] - greenXY[0], ballXY[1] - greenXY[1]);

  for (let i = 0; i < corners.length; i++) {
    const cLL = [corners[i].lat, corners[i].lng];
    const cXY = toXY(...cLL);
    const cornerToGreen = Math.hypot(cXY[0] - greenXY[0], cXY[1] - greenXY[1]);
    if (ballToGreen > cornerToGreen + 1) return { target: cLL, label: "corner " + (i + 1), index: i };
  }
  return { target: green, label: "green" };
}

function computeNudge(ball, hole, clubTable) {
  if (!hole || !hole.green) return { kind: "no_data" };

  const green = [hole.green.lat, hole.green.lng];
  const toXY = projector(...ball);
  const toGreen = yardsBetween(ball, green, toXY);

  const { target, label } = chooseTarget(ball, hole, toXY);
  const toTarget = yardsBetween(ball, target, toXY);
  const dogleg = label !== "green";

  const wet = [];
  for (const hz of (hole.hazards || [])) {
    const ts = crossings(ball, target, hz.polygon, toXY);
    if (ts.length % 2 === 1) return { kind: "in_water", toGreen, toTarget, dogleg, label };
    for (let i = 0; i < ts.length; i += 2) wet.push([ts[i] * toTarget, ts[i + 1] * toTarget]);
  }
  if (!wet.length) return { kind: "clear", toGreen, toTarget, dogleg, label };

  wet.sort((a, b) => a[0] - b[0]);
  const merged = [wet[0].slice()];
  for (const [s, e] of wet.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const [near, far] = merged[0];
  const clubs = clubTable.clubs;
  const reachCeiling = Math.max(...Object.values(clubs).map(c => c.long));
  if (reachCeiling < near - LAYUP_MARGIN_YARDS) {
    return { kind: "out_of_range", toGreen, toTarget, dogleg, label, near, reachCeiling };
  }

  const carryNeeded = far + CLEAR_MARGIN_YARDS;
  const layupLimit = near - LAYUP_MARGIN_YARDS;
  const windowEnd = merged.length > 1 ? merged[1][0] - LAYUP_MARGIN_YARDS : Infinity;

  const order = Object.entries(clubs).sort((a, b) => b[1].carrySafe - a[1].carrySafe);

  const clearing = order.filter(([, c]) => c.carrySafe >= carryNeeded && c.long <= windowEnd);
  const reckless = order.filter(([, c]) => c.carrySafe >= carryNeeded);

  const layups = order
    .filter(([, c]) => c.long <= layupLimit)
    .sort((a, b) => b[1].long - a[1].long);

  return {
    kind: clearing.length ? "go" : "layup",
    toGreen, toTarget, dogleg, label, merged, carryNeeded, layupLimit, windowEnd,
    club: clearing.length ? clearing[clearing.length - 1] : null,
    reckless: (!clearing.length && reckless.length) ? reckless[reckless.length - 1] : null,
    best: order[0],
    layup: layups[0] ?? null
  };
}