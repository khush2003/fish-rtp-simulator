# Fish-Shooter RTP Simulator

An OceanKing-style fish-shooter casino game replicated **in pure numbers** — plus a playable canvas mini-game — to make every RTP mechanic visible and verifiable.

**[▶ Play it live](https://khush2003.github.io/fish-rtp-simulator/)**

## What it demonstrates

| Mechanic | Where to see it |
|---|---|
| Per-shot pricing `p = RTP / M` | every fish row shows its live kill chance; EV per shot is always `0.96 × bet` |
| Aiming = volatility, not edge | aim only at sharks vs only at minnows — same RTP, wildly different drought/win profile |
| Variable-prize features (snapshot rule) | chain ⚡ and hammer 🔨 prizes are computed from screen contents *at the trigger roll* |
| Real boss multipliers | the dragon's 1–5× is rolled server-side (E=1.88) and priced into its kill chance |
| Boss wipe-immunity | hammers kill everything *except* the boss |
| The miss tax | bullets that whiff still cost the bet — drag the slider and watch delivered RTP = `0.96 × (1 − miss)` |
| HP bars are theater | bars drain randomly on failed rolls; only the probability decides the kill |
| Spawn director | keeps screen value Σ(M) inside a band; feature fish need a minimum screen value |
| Stage cycle | NORMAL → BOSS → BONUS swaps spawn tables (volatility scheduling) — total RTP never moves |

## Files

- `sim-core.js` — the money engine. Wager at fire time, CSPRNG-style roll at contact time, per-feature RTP buckets. Runs in browser and node.
- `index.html` — number panels + canvas mini-game (pure view layer; deleting it wouldn't change a cent).

## Verify the math yourself

```bash
node -e "
const { Sim } = require('./sim-core.js');
const sim = new Sim();
for (let i = 0; i < 1_000_000; i++) sim.shoot();
console.log('RTP after 1M shots:', sim.rtp().toFixed(4)); // → ~0.96
"
```

## Run locally

Just open `index.html` in a browser — no build, no dependencies.
