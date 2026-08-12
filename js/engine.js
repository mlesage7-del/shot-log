/*
 * SHOT LOG - ENGINE.JS
 * UPDATE DATE & TIME: 2026-08-12 14:26:36 CDT
 */

"use strict";

var STORAGE_KEY = "shotlog:v1";
var COURSES_KEY = "shotlog:courses";
var SCHEMA_VERSION = 6;
var HOLES_PER_ROUND = 18;

var BAG = ["Dr","3w","5h","3i","6i","7i","8i","9i","PW","S","LW","?"];
var PUTT_BUTTON = "Putt";
var CLUB_ALIAS = { P: "PW" };
var displayClub = c => (c == null ? c : (CLUB_ALIAS[c] || c));

var REPLAY_THRESHOLD_YARDS = 20;
var CLEAR_MARGIN_YARDS = 8;
var LAYUP_MARGIN_YARDS = 10;

var EARTH_RADIUS_M = 6371000;
var M_PER_DEG_LAT = 111320;
var M_TO_YARDS = 1.09361;

var DEFAULT_PRIORS_MATT = {
  Dr: [202, 24], '3w': [195, 23], '5h': [180, 18], '3i': [170, 17],
  '6i': [160, 14], '7i': [150, 14], '8i': [140, 13], '9i': [125, 11],
  PW: [115, 10], S: [75, 8], LW: [60, 7]
};

var DEFAULT_PRIORS_GUEST = {
  Dr: [210, 25], '3w': [190, 22], '5h': [175, 18], '3i': [165, 16],
  '6i': [155, 14], '7i': [145, 13], '8i': [135, 12], '9i': [120, 11],
  PW: [110, 10], S: [80, 8], LW: [60, 7]
};

var Z75 = 0.6745;
var Z20 = -0.8416;
var Z80 = 0.8416;
var PRIOR_WEIGHT = 5.0;

var DEFAULT_ROLLOUT = {
  Dr: 0.82, '3w': 0.84, '5h': 0.86, '3i': 0.88,
  '6i': 0.91, '7i': 0.92, '8i': 0.93, '9i': 0.94,
  PW: 0.95, S: 0.97, LW: 0.97
};

function normalPdf(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

function normalErfc(x) {
  const t = 1.0 / (1.0 + 0.5 * Math.abs(x));
  const tau = t * Math.exp(-x * x - 1.26551223 +
    t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? tau : 2.0 - tau;
}

function truncatedMean(mu, sigma, floor) {
  if (sigma <= 0) return Math.max(mu, floor);
  const z = (floor - mu) / sigma;
  const cdfUpper = 0.5 * normalErfc(z / Math.sqrt(2));
  if (cdfUpper < 1e-9) return floor;
  return mu + sigma * (normalPdf(z) / cdfUpper);
}

function fitClubEngine(club, clean, censored, ratiosFromSim, playerPriors) {
  const prior = playerPriors[club] || [null, null];
  const goodStrike = prior[0];
  const spread = prior[1];

  const obsRatios = ratiosFromSim[club] || [];
  const frac = obsRatios.length >= 3
    ? obsRatios.reduce((a, b) => a + b, 0) / obsRatios.length
    : (DEFAULT_ROLLOUT[club] || 0.90);

  let priorMu, priorSigma, kappa, mu, sigma;

  if (goodStrike === null) {
    if (clean.length < 2) return null;
    mu = clean.reduce((a, b) => a + b, 0) / clean.length;
    sigma = 10.0;
    priorMu = priorSigma = null;
    kappa = 0.0;
  } else {
    priorMu = goodStrike - Z75 * spread;
    priorSigma = spread;
    kappa = PRIOR_WEIGHT;
    mu = priorMu;
    sigma = priorSigma;
  }

  const n = clean.length;
  if (n === 0 && censored.length === 0) {
    return {
      club, n: 0, censored: 0, mean: mu, sd: sigma,
      safe: mu + Z20 * sigma,
      long: mu + Z80 * sigma,
      carrySafe: (mu + Z20 * sigma) * frac,
      typical: mu,
      rolloutFraction: frac
    };
  }

  for (let iter = 0; iter < 25; iter++) {
    const imputed = censored.map(f => truncatedMean(mu, sigma, f));
    const sample = clean.concat(imputed);
    const m = sample.length;

    const sampleMean = sample.reduce((a, b) => a + b, 0) / m;
    mu = kappa ? (kappa * priorMu + m * sampleMean) / (kappa + m) : sampleMean;

    if (m >= 2) {
      let variance = sample.reduce((sum, x) => sum + (x - mu) ** 2, 0) / m;
      if (kappa) variance = (kappa * (priorSigma ** 2) + m * variance) / (kappa + m);
      sigma = Math.max(Math.sqrt(variance), 1.0);
    } else if (priorSigma) {
      sigma = priorSigma;
    }
  }

  return {
    club, n, censored: censored.length, mean: mu, sd: sigma,
    safe: mu + Z20 * sigma,
    long: mu + Z80 * sigma,
    carrySafe: (mu + Z20 * sigma) * frac,
    typical: mu,
    rolloutFraction: frac
  };
}

function calculateClubTable(playerId) {
  const player = (window.db && window.db.players[playerId]) ? window.db.players[playerId] : (window.db ? window.db.players.matt : { priors: DEFAULT_PRIORS_MATT });
  const playerRounds = window.db ? window.db.rounds.filter(r => (r.playerId || "matt") === playerId) : [];

  const measured = {};
  const floors = {};
  const rolloutRatios = {};

  BAG.forEach(c => { measured[c] = []; floors[c] = []; rolloutRatios[c] = []; });

  playerRounds.forEach(rnd => {
    if (rnd.mode === "manual") {
      rnd.shots.forEach(s => {
        if (s.club && s.total) {
          if (!measured[s.club]) measured[s.club] = [];
          measured[s.club].push(Number(s.total));
          if (s.carry && s.total > 0) {
            const ratio = s.carry / s.total;
            if (ratio >= 0.3 && ratio <= 1.0) {
              if (!rolloutRatios[s.club]) rolloutRatios[s.club] = [];
              rolloutRatios[s.club].push(ratio);
            }
          }
        }
      });
      return;
    }

    const shots = rnd.shots;
    shots.forEach((shot, i) => {
      let club = shot.club;
      if (!club || i + 1 >= shots.length || club === "Putt" || shot.lowConfidence || shot.mishit) return;
      club = displayClub(club);
      if (!measured[club]) measured[club] = [];
      if (!floors[club]) floors[club] = [];

      const yards = haversineYards(shot, shots[i + 1]);
      if ((shot.penaltyStrokes || 0) === 0) {
        measured[club].push(yards);
      } else if (yards >= REPLAY_THRESHOLD_YARDS) {
        floors[club].push(yards);
      }
    });
  });

  const clubsOut = {};
  BAG.filter(c => c !== "?" && c !== "Putt").forEach(club => {
    const fit = fitClubEngine(club, measured[club] || [], floors[club] || [], rolloutRatios, player.priors);
    if (fit) clubsOut[club] = fit;
  });

  return { generatedAt: new Date().toISOString(), clubs: clubsOut };
}