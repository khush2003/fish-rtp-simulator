// RTP Simulator core — the fishing game replicated in pure numbers.
// Every mechanic from the building-fish-shooter-games skill, money-path only.
// Works in browser (window.SimCore) and node (module.exports) for headless verification.

const RTP = 0.96;
const P_CAP = 0.95;          // never let a single fish be a near-coinflip jackpot
const MIN_PRIZE_M = 10;      // variable-prize floor: feature never priced below 10x
const BAND_LOW = 160;        // director keeps sum(M) on screen >= this (dense, like the original's 20-per-spawner screens)
const BAND_HIGH = 260;       // ...and stops spawning above this
const FEATURE_GUARD = 60;    // chain/crab fish only spawn while screen value >= this

// Species table. M = payout multiplier. Ranking mirrors the original game's
// Score/HP values (fodder ~2x ... sharks 40x ... bosses huge).
// kind: normal | chain (pays all same-`chains` species) | crab (hammer: 3 screen wipes) | boss
// Weights tuned for game feel: dense schools of fodder (fuller screens, steady
// small wins), features rare enough to be events. Weights NEVER affect RTP —
// every fish self-prices — so this table is free to tune.
const SPECIES = [
  { id: 'minnow',    M: 2,   kind: 'normal', w: { normal: 42, boss: 10, bonus: 0  } },
  { id: 'clownfish', M: 3,   kind: 'normal', w: { normal: 28, boss: 8,  bonus: 0  } },
  { id: 'angelfish', M: 5,   kind: 'normal', w: { normal: 16, boss: 5,  bonus: 10 } },
  { id: 'puffer',    M: 8,   kind: 'normal', w: { normal: 10, boss: 4,  bonus: 12 } },
  { id: 'lionfish',  M: 12,  kind: 'normal', w: { normal: 7,  boss: 3,  bonus: 14 } },
  { id: 'turtle',    M: 18,  kind: 'normal', w: { normal: 5,  boss: 2,  bonus: 14 } },
  { id: 'ray',       M: 25,  kind: 'normal', w: { normal: 3,  boss: 2,  bonus: 16 } },
  { id: 'shark',     M: 40,  kind: 'normal', w: { normal: 2,  boss: 1,  bonus: 18 } },
  { id: 'goldclown', M: 6,   kind: 'chain', chains: 'clownfish',
                                             w: { normal: 2,  boss: 0,  bonus: 8  } },
  { id: 'powercrab', M: 0,   kind: 'crab',   w: { normal: 1,  boss: 0,  bonus: 6  } },
  { id: 'dragon',    M: 200, kind: 'boss',   w: { normal: 0,  boss: 1,  bonus: 0  } },
];

// Boss bonus multiplier — rolled FOR REAL on kill (the original only showed sprites).
const BOSS_MULT = { values: [1, 2, 3, 4, 5], weights: [50, 25, 15, 7, 3] };
const BOSS_EMULT = BOSS_MULT.values.reduce((s, v, i) => s + v * BOSS_MULT.weights[i], 0) / 100; // 1.88

// GOLDEN KILL multiplier — every normal-fish kill rolls a bonus multiplier.
// Its mean is priced into the kill chance (p = RTP / (M × E)), so it adds
// pure volatility/excitement at exactly zero RTP cost.
const KILL_MULT = { values: [1, 2, 3, 5, 10], weights: [85, 10, 3, 1.5, 0.5] };
const KILL_EMULT = KILL_MULT.values.reduce((s, v, i) => s + v * KILL_MULT.weights[i], 0) / 100; // 1.265

// Stage cycle (shot-based instead of the original's 180s timers — same idea)
const STAGES = [
  { name: 'NORMAL', shots: 300 },
  { name: 'BOSS',   shots: 150 },
  { name: 'BONUS',  shots: 150 },
];

function weightedPick(rng, entries, weightOf) {
  const total = entries.reduce((s, e) => s + weightOf(e), 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const e of entries) { r -= weightOf(e); if (r <= 0) return e; }
  return entries[entries.length - 1];
}

function rollMult(rng) {
  return weightedPick(rng, BOSS_MULT.values.map((v, i) => ({ v, w: BOSS_MULT.weights[i] })), e => e.w).v;
}
function rollKillMult(rng) {
  return weightedPick(rng, KILL_MULT.values.map((v, i) => ({ v, w: KILL_MULT.weights[i] })), e => e.w).v;
}

class Sim {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.fish = [];          // { uid, sp } where sp is a SPECIES entry
    this.uid = 0;
    this.bet = 100;
    this.missProb = 0;       // 0 = bounce-until-hit (original behavior, every bet gets a roll)
    this.shotCount = 0;
    this.stageIdx = 0;
    this.stageShots = 0;
    this.stats = {
      wagered: 0, paid: 0, misses: 0, kills: 0, shots: 0,
      buckets: { base: { wagered: 0, paid: 0 }, chain: { paid: 0 }, hammer: { paid: 0 }, boss: { paid: 0 } },
      biggestWin: 0, drought: 0, maxDrought: 0,
      rtpHistory: [],        // sampled cumulative RTP for the chart
    };
    this.log = [];
    this.director();
  }

  stage() { return STAGES[this.stageIdx]; }
  screenValue() { return this.fish.reduce((s, f) => s + this.effectiveM(f), 0); }

  // For display/snapshot purposes a feature fish carries its prize potential, not its own M.
  effectiveM(f) {
    if (f.sp.kind === 'chain') return f.sp.M; // chained value computed at snapshot time
    if (f.sp.kind === 'crab') return 0;
    return f.sp.M * (f.sp.kind === 'boss' ? BOSS_EMULT : KILL_EMULT);
  }

  // p shown in the fish table — what one shot at this fish rolls right now
  pFor(f) {
    if (f.sp.kind === 'chain') return Math.min(P_CAP, RTP / this.chainSnapshotM(f));
    if (f.sp.kind === 'crab')  return Math.min(P_CAP, RTP / this.hammerSnapshotM());
    if (f.sp.kind === 'boss')  return Math.min(P_CAP, RTP / (f.sp.M * BOSS_EMULT));
    return Math.min(P_CAP, RTP / (f.sp.M * KILL_EMULT));   // golden-kill mean priced in
  }

  chainSnapshotM(f) {
    const sum = f.sp.M + this.fish
      .filter(o => o.uid !== f.uid && o.sp.id === f.sp.chains)
      .reduce((s, o) => s + o.sp.M, 0);
    return Math.max(sum, MIN_PRIZE_M);
  }

  hammerSnapshotM() {
    // 3 screen wipes; respawns between wipes are why prize = 3x current screen
    return Math.max(3 * this.fish.filter(o => o.sp.kind === 'normal').reduce((s, o) => s + o.sp.M, 0), MIN_PRIZE_M);
  }

  director() {
    const st = this.stage().name.toLowerCase();
    let guard = 64; // safety
    while (this.screenValue() < BAND_LOW && this.fish.length < 55 && guard-- > 0) {
      const eligible = SPECIES.filter(sp => {
        if ((sp.w[st] || 0) <= 0) return false;
        if ((sp.kind === 'chain' || sp.kind === 'crab') && this.screenValue() < FEATURE_GUARD) return false;
        if (sp.kind === 'boss' && this.fish.some(f => f.sp.kind === 'boss')) return false; // one boss
        return true;
      });
      const sp = weightedPick(this.rng, eligible, e => e.w[st] || 0);
      if (!sp) break;
      // schools: fodder arrives 5-12 at a time, mid fish sometimes in trios —
      // the original's wave-pattern spawners. Pure feel; every fish self-prices.
      const school = sp.kind === 'normal' && sp.M <= 5 ? 5 + Math.floor(this.rng() * 8)
                   : sp.kind === 'normal' && sp.M <= 12 && this.rng() < 0.4 ? 3 : 1;
      for (let i = 0; i < school; i++) this.fish.push({ uid: ++this.uid, sp });
    }
  }

  advanceStage() {
    this.stageShots++;
    if (this.stageShots >= this.stage().shots) {
      this.stageShots = 0;
      this.stageIdx = (this.stageIdx + 1) % STAGES.length;
      // stage swap clears the screen (original destroys fish on transitions)
      this.fish = [];
      this.director();
      this.pushLog({ type: 'stage', stage: this.stage().name });
    }
  }

  pushLog(entry) {
    entry.shot = this.shotCount;
    this.log.push(entry);
    if (this.log.length > 14) this.log.shift();
  }

  win(amount, bucket, entry) {
    this.stats.paid += amount;
    this.stats.buckets[bucket].paid += amount;
    this.stats.kills++;
    if (amount > this.stats.biggestWin) this.stats.biggestWin = amount;
    this.stats.maxDrought = Math.max(this.stats.maxDrought, this.stats.drought);
    this.stats.drought = 0;
    entry.payout = amount;
  }

  // --- split money path: debit at fire time, roll at contact time (server semantics) ---

  wagerShot() {
    const s = this.stats;
    this.shotCount++; s.shots++;
    s.wagered += this.bet;
    s.buckets.base.wagered += this.bet;
    s.drought++;
    this.advanceStage();
    if (s.shots % 25 === 0) {
      s.rtpHistory.push(s.paid / s.wagered);
      if (s.rtpHistory.length > 400) s.rtpHistory.shift();
    }
  }

  resolveMiss() {
    this.stats.misses++;
    const entry = { type: 'shot', result: 'WHIFF (no contact — bet lost, no roll!)' };
    this.pushLog(entry);
    return entry;
  }

  // Void a shot and give the bet back — the RTP-neutral way to retire a bullet
  // that never found a fish (vs WHIFF, which eats the bet and lowers delivered RTP).
  refundShot(bet = this.bet) {
    const s = this.stats;
    s.wagered -= bet;
    s.buckets.base.wagered -= bet;
    s.refunds = (s.refunds || 0) + 1;
    const entry = { type: 'shot', result: 'REFUND — bullet voided, bet returned (RTP-neutral)' };
    this.pushLog(entry);
    return entry;
  }

  // Inject a feature fish so it can be tried on demand. RTP-invariant:
  // every fish self-prices (p = RTP/M), so spawning more of anything changes
  // feel and bucket mix, never the total RTP.
  forceSpawn(speciesId) {
    const sp = SPECIES.find(s => s.id === speciesId);
    if (!sp) return [];
    const spawned = [];
    const add = (species) => { const f = { uid: ++this.uid, sp: species }; this.fish.push(f); spawned.push(f); };
    if (sp.kind === 'boss' && this.fish.some(f => f.sp.kind === 'boss')) return spawned; // one boss rule
    if (sp.kind === 'chain') {
      const prey = SPECIES.find(s => s.id === sp.chains);
      for (let i = 0; i < 4; i++) add(prey);   // give the chain something to chain
    }
    add(sp);
    this.pushLog({ type: 'stage', stage: `force-spawned ${sp.id} (RTP unchanged — it self-prices)` });
    return spawned;
  }

  // The server answer to "bullet touched fish <uid> on a shot that wagered `bet`"
  resolveContact(uid, bet = this.bet) {
    const f = this.fish.find(o => o.uid === uid);
    // contact raced a despawn (chain/hammer/stage wipe in the same tick):
    // VOID the round and refund — a server must never eat a bet without a roll
    if (!f) return this.refundShot(bet);
    const entry = { type: 'shot' };
    const p = this.pFor(f);
    const roll = this.rng();
    entry.target = f.sp.id; entry.p = p; entry.roll = roll;

    if (roll < p) {
      if (f.sp.kind === 'normal') {
        const mult = rollKillMult(this.rng);          // golden kill, rolled server-side
        this.win(f.sp.M * mult * bet, 'base', entry);
        entry.mult = mult;
        entry.detail = mult > 1 ? `M=${f.sp.M} × GOLDEN ${mult}x` : `M=${f.sp.M}`;
        entry.killedUids = [f.uid];
        this.fish = this.fish.filter(o => o.uid !== f.uid);
      } else if (f.sp.kind === 'chain') {
        const snapM = this.chainSnapshotM(f);
        this.win(snapM * bet, 'chain', entry);
        entry.detail = `CHAIN snapshot ΣM=${snapM} (self + all ${f.sp.chains})`;
        entry.killedUids = this.fish.filter(o => o.uid === f.uid || o.sp.id === f.sp.chains).map(o => o.uid);
        this.fish = this.fish.filter(o => !entry.killedUids.includes(o.uid));
      } else if (f.sp.kind === 'crab') {
        const snapM = this.hammerSnapshotM();
        this.win(snapM * bet, 'hammer', entry);
        entry.detail = `HAMMER snapshot 3×screen=${snapM} (3 wipes = payout animation)`;
        entry.killedUids = this.fish.filter(o => o.sp.kind !== 'boss').map(o => o.uid); // bosses immune!
        this.fish = this.fish.filter(o => o.sp.kind === 'boss');
      } else if (f.sp.kind === 'boss') {
        const mult = rollMult(this.rng);
        this.win(f.sp.M * mult * bet, 'boss', entry);
        entry.detail = `BOSS M=${f.sp.M} × rolled ${mult}x (E[mult]=${BOSS_EMULT})`;
        entry.killedUids = [f.uid];
        this.fish = this.fish.filter(o => o.uid !== f.uid);
      }
      entry.result = 'KILL';
    } else {
      entry.result = 'no kill (HP bar animates down — pure theater)';
    }
    this.pushLog(entry);
    this.director();
    return entry;
  }

  // One numeric shot (turbo mode). targetUid optional; otherwise random fish.
  shoot(targetUid) {
    this.wagerShot();
    if (this.rng() < this.missProb) return this.resolveMiss();
    let f = targetUid != null ? this.fish.find(o => o.uid === targetUid) : null;
    if (!f) f = this.fish[Math.floor(this.rng() * this.fish.length)];
    return f ? this.resolveContact(f.uid) : this.resolveMiss();
  }

  rtp() { return this.stats.wagered ? this.stats.paid / this.stats.wagered : 0; }
  expectedRtp() { return RTP * (1 - this.missProb); }
}

const SimCore = { Sim, SPECIES, RTP, P_CAP, MIN_PRIZE_M, BAND_LOW, BAND_HIGH, FEATURE_GUARD, BOSS_EMULT, KILL_MULT, KILL_EMULT, STAGES };
if (typeof module !== 'undefined') module.exports = SimCore;
if (typeof window !== 'undefined') window.SimCore = SimCore;
