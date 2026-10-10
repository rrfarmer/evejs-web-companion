"use strict";

// The ballpark: the simulation the retail client runs to know where things are.
//
// In space the server does not send positions. It sends each ball's state once
// and then the orders the ball is given; the client steps every ball itself,
// one tick a second, with CCP's simulation library, destiny. This is that
// library ported from CCP's open source (C:\...\destiny, MIT), so that the web
// client computes what the retail client computes.
//
//   destiny/src/Ballpark.cpp   Evolve (421), Integrate (751), EvolveBehaviorForBall (789),
//                              EvolveMissile (972), EvolveFollow (1066), EvolveOldStyleOrbit (1249),
//                              EvolveStop (1339), GotoThrust (1398),
//                              Gradient (2746), Potential (2789), AddBall (3303),
//                              MissileFollow (3798), FollowBall (3879), Orbit (4007),
//                              the orders (4471-4650) and the setters (4652-5090)
//   destiny/src/Ball.cpp       ClientBall::InterpolatedPosition (1208) and InforceContinuity (877):
//                              a ball between two ticks, as the client draws and measures it
//   destiny/src/Collision.cpp  CollideTwoSpheres (108), Quadratic (136)
//   destiny/src/Partition.cpp  which balls a ball can collide with (302, 344)
//   destiny/src/Thunkers.cpp   LaunchMissile (857), reading a state into the park (2083, 2463, 2897) and
//                              writing the park out as one (2145, 2202, 3180)
//   destiny/src/Vector3d.h     the arithmetic, which is part of the result
//
// docs/game-port-destiny-notes.md is the map; this file is made from the source.
//
// EXACTNESS. The aim is the same bits. Three rules from the source decide them:
//
//   - radius, maxVelocity, agility, speedFraction and followRange are `float`
//     members. Every store rounds to float32 (Math.fround); every use promotes
//     back to double.
//   - A vector divided by a number is multiplied by its reciprocal.
//   - Integrate is evaluated as written. `p * k2 * ook2` is not `p`.
//
// CCP's own evolve tests give expected positions to the last digit, and
// test/destinyBallpark.test.js requires them exactly.
//
// PORTED SO FAR: the integrator, STOP, GOTO, FOLLOW and ORBIT (the old style,
// which is the library's default), WARP, MISSILE and its launch, a massive
// ball's collisions with other balls, adding and removing balls, the orders
// and setters those need, and reading and writing the state blob.
// NOT YET, and each stops here or is counted rather than be guessed at:
// FORMATION, MUSHROOM (evolve throws); the facing a missile is launched along
// from a launcher at rest when it is not aimed (counted in
// `unported.orientation`: launched along the unturned nose); a fixed ball's collision
// shapes, its miniballs, capsules and boxes (counted in `unported.minis`: a
// massive ball is stepped without them); the spatial partition, which here
// only decides the order a ball's neighbours are taken in (counted in
// `unported.collisionOrder` whenever a ball touches two at once);
// orientation (yaw, pitch and roll do not move a ball); moribund balls.

const { FLAG, MODE, MODE_NAME, PACKET, readState, writeState } = require("./state");

/**
 * Collision.cpp Quadratic (136): the roots of a s^2 + b s + c, the larger
 * first, or null when there are none. With no s^2 term the source sets both
 * roots and then goes on to divide by a all the same; so does this.
 */
function quadratic(a, b, c) {
  if (a === 0.0 && b === 0.0) return null;
  let det = b * b - 4.0 * a * c;
  if (det < 0.0) return null;
  det = Math.sqrt(det);
  return [((-b + det) * 0.5) / a, ((-b - det) * 0.5) / a];
}

/**
 * Collision.cpp CollideTwoSpheres (108): two spheres, each going in a straight
 * line through the tick (p0 to p1, q0 to q1), radii adding up to collRadius.
 * When in the tick they first touch, from 0 to 1; 0 if they overlap already;
 * -1 if they do not touch.
 */
function collideTwoSpheres(p0, p1, q0, q1, collRadius) {
  const p0q0 = { x: p0.x - q0.x, y: p0.y - q0.y, z: p0.z - q0.z };
  const p0q0_2 = p0q0.x * p0q0.x + p0q0.y * p0q0.y + p0q0.z * p0q0.z;
  if (p0q0_2 <= collRadius * collRadius) return 0.0;
  const dpq = { x: p1.x - p0.x - (q1.x - q0.x), y: p1.y - p0.y - (q1.y - q0.y), z: p1.z - p0.z - (q1.z - q0.z) };
  const dpq_2 = dpq.x * dpq.x + dpq.y * dpq.y + dpq.z * dpq.z;
  const p0q0dpq = p0q0.x * dpq.x + p0q0.y * dpq.y + p0q0.z * dpq.z;
  const roots = quadratic(dpq_2, 2.0 * p0q0dpq, p0q0_2 - collRadius * collRadius);
  // The smaller root is the first touch. Not overlapping at the start, both are ahead or both behind.
  if (roots && roots[1] >= 0.0 && roots[1] <= 1.0) return roots[1];
  return -1.0;
}

/** IDstConstants.h: ids below this are the client's own balls, and are not written into a state. */
const DSTLOCALBALLS = -1073741824;

// ── Vector3d.h ───────────────────────────────────────────────────────────────

const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
/** v * c, and c * v, which the header defines as the same thing. */
const scale = (v, c) => ({ x: v.x * c, y: v.y * c, z: v.z * c });
/** v / c: `c = 1.0/c; return Vector3d(x*c, y*c, z*c)`. */
const divide = (v, c) => scale(v, 1.0 / c);
const lengthSq = (v) => v.x * v.x + v.y * v.y + v.z * v.z;
const length = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
/** Normalize(): a zero vector is returned as it is. */
function normalize(v) {
  let norm = length(v);
  if (norm === 0.0) return v;
  norm = 1.0 / norm;
  return { x: v.x * norm, y: v.y * norm, z: v.z * norm };
}
const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** a x b, as Vector3d::Cross computes it. */
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

const f32 = Math.fround;

/** Ballpark.h 31. */
const AU = 0.1495978707e12;
/** Ballpark.cpp 61-63: what a warp factor (thousandths of an AU a second) means for speed and for how hard the warp starts and ends. */
const WARP_FACTOR_TO_AU_PER_SECOND = 0.001;
const WARP_FACTOR_TO_ACCELERATION = 1.0 / 1000;
const WARP_FACTOR_TO_DECELERATION = 1.0 / 3000;
/** Ball.h 23: a ship that has not lined up after this many ticks warps anyway. */
const MAX_ALIGN_TICKS = 180;
/** Ballpark.cpp 70. */
const ORBITAL_PRECESSION = 0.001;
/** "(double)((int64_t)(x*10000000))/10000000": cut, not rounded, at seven decimals. */
const cutToSevenDecimals = (x) => Math.trunc(x * 10000000) / 10000000;
/** The low sixteen bits of a ball's id, which give each orbiter its own plane. */
const lowSixteenBits = (id) => Number(BigInt(id) & 0xffffn);

class DestinyNotPorted extends Error {
  constructor(what) {
    super(`${what} is not ported from destiny yet.`);
    this.name = "DestinyNotPorted";
  }
}

/** Ball::IsWarping (Ball.cpp 1895): in warp proper, not still aligning for it. */
const isWarping = (ball) => ball.mode === MODE.WARP && !(ball.effectStamp < 0);

/** The modes whose ball follows another (Ballpark.cpp 68). */
const FOLLOW_MODES = new Set([MODE.FOLLOW, MODE.ORBIT, MODE.MISSILE, MODE.FORMATION]);

/** Ball ids in the order a std::map<int64> keeps them. */
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

class Ballpark {
  /**
   * `tickInterval` is in milliseconds. The client sets it to
   * const.simulationTimeStep, 1000; the library's own default is the same.
   */
  constructor({ tickInterval = 1000, friction = 1000000.0, onPost = null } = {}) {
    this.tickInterval = tickInterval;
    this.friction = friction;
    /**
     * Told of the events the engine posts to the client's Python:
     * ("OnActivatingWarp", id, tick), ("OnDeactivatingWarp", id, tick) and
     * ("OnExitWarp", id, 0 or 1).
     */
    this.onPost = onPost;
    /** dt = mTickInterval * 0.001: the step, in seconds. */
    this.dt = tickInterval * 0.001;
    /** mCurrentTime: the tick counter. */
    this.currentTime = 0;
    /** mTime: the sim clock's reading at the last step the engine's driver took, in milliseconds, less what was left over (Park.onTick). */
    this.time = 0;
    this.balls = new Map();
    this.freeBalls = new Map();
    /** moribundBalls: removed from play, kept until their time is up. */
    this.moribundBalls = new Set();
    /** How many times a massive ball's neighbours were looked at for collisions (Gradient). */
    this.gradients = 0;
    /**
     * What a step did without, because it is not ported: counted, never hidden.
     * `minis`: a massive ball stepped while a fixed ball in the park had collision shapes of its own.
     * `collisionOrder`: a ball that touched two others in one tick, taken here in order of id.
     */
    this.unported = { minis: 0, collisionOrder: 0, orientation: 0 };
  }

  /** Ballpark::ClearAll (5896). */
  clearAll() {
    this.balls.clear();
    this.freeBalls.clear();
    this.moribundBalls.clear();
  }

  ball(id) {
    return this.balls.get(id) ?? null;
  }

  _post(name, id, value) {
    if (typeof this.onPost === "function") this.onPost(name, id, value);
  }

  /** Ball::SetMode (Ball.cpp 905): a ball that leaves warp mode says so. The state reader writes the mode straight in instead. */
  _setMode(ball, mode) {
    if (mode !== ball.mode && mode !== MODE.WARP && ball.mode === MODE.WARP) this._post("OnExitWarp", ball.id, 0);
    ball.mode = mode;
  }

  // ── adding ────────────────────────────────────────────────────────────────

  /** Ballpark::AddBall (3303). An id already in the park is updated in place. */
  addBall({
    id, mass = 1.0e34, radius = 0, maxVelocity = 0, isFree = false, isGlobal = false, isMassive = false,
    isInteractive = false, isSpaceJunk = false, x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, agility = 1, speedFraction = 0,
  }) {
    let ball = this.balls.get(id);
    const created = !ball;
    if (created) {
      ball = {
        id,
        mode: MODE.STOP,
        formationID: -1,
        effectStamp: 0,
        ownerId: 0,
        followId: 0,
        followRange: 10.0,
        followPtr: null,
        followers: new Set(),
        corporationID: -1,
        allianceID: -1,
        harmonic: -1,
        isCloaked: 0,
        isMoribund: false,
        goto: vec(),
        lastG: vec(),
        lastC: vec(),
        collisions: [],
        // What the client keeps for drawing the ball between ticks (Ball.h 181-182, 424-427): the clock's
        // reading at its last two steps, and what was last drawn, when, and in which tick.
        newTime: 0,
        oldTime: 0,
        posUpdateTime: 0,
        lastPos: vec(),
        lastVel: vec(),
        lastTick: -1,
      };
      this.balls.set(id, ball);
    }
    [radius, maxVelocity, agility, speedFraction] = [f32(radius), f32(maxVelocity), f32(agility), f32(speedFraction)];
    ball.newPos = vec(x, y, z);
    ball.newVel = vec(vx, vy, vz);
    if (created) {
      // mOldPos = mNewPos - dt*mNewVel
      ball.oldPos = sub(ball.newPos, scale(ball.newVel, this.dt));
      ball.oldVel = vec(vx, vy, vz);
    } else {
      ball.formationID = -1;
      ball.effectStamp = 0;
      ball.ownerId = 0;
      ball.followId = 0;
      ball.followRange = 10.0;
      ball.corporationID = -1;
      ball.allianceID = -1;
      ball.harmonic = -1;
      ball.isMoribund = false;
    }
    ball.radius = radius < 0.0 ? 0.0 : radius;
    ball.mass = mass < 0.0 ? 0.0 : mass;
    ball.isFree = Boolean(isFree);
    ball.isGlobal = Boolean(isGlobal);
    ball.isMassive = Boolean(isMassive);
    ball.isInteractive = Boolean(isInteractive);
    ball.isSpaceJunk = Boolean(isSpaceJunk);
    ball.maxVelocity = maxVelocity < 0.0 ? 0.0 : maxVelocity;
    ball.agility = agility <= 0.0 ? 1.0 : agility;
    ball.speedFraction = speedFraction < 0.0 ? 0.0 : speedFraction;
    this._setTimeFactor(ball);
    if (!created && !ball.isFree) this.freeBalls.delete(id);
    else if (ball.isFree) this.freeBalls.set(id, ball);
    this._setMode(ball, MODE.STOP);
    return ball;
  }

  /** Ballpark::SetBallTimeFactor (4968): exp(-k*dt/m), kept for whole-tick steps. */
  _setTimeFactor(ball) {
    const mass = ball.mass * ball.agility;
    ball.timeFactor = mass <= 0.0 ? 0.0 : Math.exp((-this.friction * this.dt) / mass);
  }

  // ── setters (4652-5090) ───────────────────────────────────────────────────

  setBallMass(id, mass) {
    if (mass <= 0.0) return;
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.mass = mass;
    this._setTimeFactor(ball);
  }

  setBallAgility(id, agility) {
    agility = f32(agility);
    const ball = this.balls.get(id);
    if (!ball || agility <= 0.0) return;
    ball.agility = agility;
    this._setTimeFactor(ball);
  }

  setMaxSpeed(id, speed) {
    speed = f32(speed);
    if (speed < 0.0) return;
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.maxVelocity = speed;
  }

  setSpeedFraction(id, fraction) {
    fraction = f32(fraction);
    if (!Number.isFinite(fraction)) return;
    const ball = this.balls.get(id);
    if (!ball) return;
    if (fraction < 0.0) fraction = 0.0;
    else if (fraction > 1.0) fraction = 1.0;
    ball.speedFraction = fraction;
  }

  setBallRadius(id, radius) {
    radius = f32(radius);
    const ball = this.balls.get(id);
    if (!ball || radius < 0.0) return;
    ball.radius = radius;
  }

  /** Sets where the ball is, and where it was: nothing is left to interpolate from. */
  setBallPosition(id, x, y, z) {
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.newPos = vec(x, y, z);
    ball.oldPos = vec(x, y, z);
  }

  setBallVelocity(id, vx, vy, vz) {
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.newVel = vec(vx, vy, vz);
    ball.oldVel = vec(vx, vy, vz);
  }

  setBallMassive(id, flag) {
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.isMassive = Boolean(flag);
  }

  setBallGlobal(id, flag) {
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.isGlobal = Boolean(flag);
  }

  setBallInteractive(id, flag) {
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.isInteractive = Boolean(flag);
  }

  /** Ballpark::SetBallHarmonic (4852): a ball made a field stops, and stays put as one. */
  setBallHarmonic(id, harmonic, corporationID, allianceID, field) {
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.harmonic = harmonic;
    ball.corporationID = corporationID;
    ball.allianceID = allianceID;
    if (field) {
      this.stop(id);
      this._setMode(ball, MODE.FIELD);
    } else if (ball.mode === MODE.FIELD) {
      this.stop(id);
    }
  }

  /** Ballpark::SetBallRigid (6278). */
  setBallRigid(id) {
    const ball = this.balls.get(id);
    if (!ball) return;
    this.stop(id);
    this._setMode(ball, MODE.RIGID);
  }

  /**
   * Ballpark::SetBallTroll (6290): free and coasting for `delay` ticks, after
   * which the step turns it to stone (a wreck drifting to a halt).
   */
  setBallTroll(id, delay) {
    const ball = this.balls.get(id);
    if (!ball) return;
    if (delay < 1) delay = 1;
    this.stop(id);
    this.setBallFree(id, true);
    this.setBallInteractive(id, true);
    ball.effectStamp = this.currentTime + delay;
    this._setMode(ball, MODE.TROLL);
  }

  /** Ballpark::CloakBall (5223). */
  cloakBall(id, cloakMode) {
    const ball = this.balls.get(id);
    if (!ball) return;
    if (cloakMode <= 0) return;
    this.stopAllFollowers(ball);
    ball.isCloaked = cloakMode;
    ball.isMassive = false;
  }

  /** Ballpark::UncloakBall (5257): massive again, unless it is in warp proper. */
  uncloakBall(id) {
    const ball = this.balls.get(id);
    if (!ball) return;
    ball.isCloaked = 0;
    if (!isWarping(ball)) ball.isMassive = true;
  }

  /** Ballpark::SetBallFree (4887). A ball made unfree is stopped where it is. */
  setBallFree(id, flag) {
    const ball = this.balls.get(id);
    if (!ball) return;
    flag = Boolean(flag);
    if (flag === ball.isFree) return;
    ball.isFree = flag;
    if (ball.isFree) {
      this.freeBalls.set(id, ball);
      // "Set ball time to a tick ago so that we don't snap back and forth during first tick of client interpolation"
      ball.newTime = this.time - this.tickInterval;
    } else {
      this.stop(id);
      this.setBallVelocity(id, 0.0, 0.0, 0.0);
      this.freeBalls.delete(id);
      ball.lastG = vec();
    }
  }

  // ── removing (5416-5765) ──────────────────────────────────────────────────

  /**
   * Ballpark::StopAllFollowers (5416): whoever was following this ball is told
   * to stop, except a missile or an interactive orbiter, which flies on the way
   * it was going.
   */
  stopAllFollowers(ball) {
    if (!ball || ball.followers.size === 0) return;
    for (const id of [...ball.followers]) {
      const follower = this.balls.get(id);
      if (!follower || follower.followId !== ball.id || follower.followPtr !== ball) {
        ball.followers.delete(id);
        continue;
      }
      if (follower.mode === MODE.MISSILE || (follower.isInteractive && follower.mode === MODE.ORBIT)) {
        if (follower.mode === MODE.MISSILE) follower.isMassive = false;
        this.gotoDirection(id, follower.newVel.x, follower.newVel.y, follower.newVel.z);
      } else {
        this.stop(id);
      }
    }
  }

  /**
   * Ballpark::RemoveBall (5471). With a delay the ball is only marked: it stops
   * taking part at once, and is taken out of the park when its time is up
   * (bringOutDeadBalls).
   */
  removeBall(id, delay = 0) {
    const ball = this.balls.get(id);
    if (!ball) return;
    this.stop(id);
    this.stopAllFollowers(ball);
    ball.isMoribund = true;
    if (delay > 0) {
      ball.isMassive = false;
      ball.effectStamp = this.currentTime + delay;
      this.moribundBalls.add(ball);
      return;
    }
    this.moribundBalls.delete(ball);
    if (ball.isFree) this.freeBalls.delete(id);
    this.balls.delete(id);
  }

  /**
   * Ballpark::BringOutDeadBalls (5708), which the engine runs every frame: a
   * moribund ball goes once its time has passed, and up to seven a call go
   * early once they are within two ticks of it.
   */
  bringOutDeadBalls() {
    let killCounter = 0;
    const toDelete = [];
    for (const ball of this.moribundBalls) {
      if (!ball.isMoribund) toDelete.push(ball);
      else if (ball.effectStamp - this.currentTime < 0) toDelete.push(ball);
      else if (ball.effectStamp - this.currentTime - 2 < 0 && killCounter < 7) {
        toDelete.push(ball);
        killCounter += 1;
      }
    }
    for (const ball of toDelete) {
      if (ball.isMoribund) this.removeBall(ball.id);
      this.moribundBalls.delete(ball);
    }
  }

  // ── the state blob (Thunkers.cpp) ─────────────────────────────────────────

  /**
   * ReadFullStateFromStream. `partial` is what the client passes: 0 for a
   * SetState, 2 for an AddBalls, 1 for its own rewind. Whatever it is, the
   * park's tick counter becomes the blob's stamp.
   *
   * A read never removes a ball. A full read (0) only empties the list of balls
   * that are stepped; the caller clears the park first when it means to.
   */
  readState(bytes, partial = 0) {
    const state = readState(bytes);
    if (state.packet === null) return [];
    if (!partial) this.freeBalls.clear();
    this.currentTime = state.stamp;
    const read = [];
    for (const record of state.balls) {
      const ball = this.addBall({
        id: record.id,
        mass: record.mass,
        radius: record.radius,
        maxVelocity: record.maxVelocity,
        isFree: Boolean(record.flags & FLAG.FREE),
        isGlobal: Boolean(record.flags & FLAG.GLOBAL),
        isMassive: Boolean(record.flags & FLAG.MASSIVE),
        isInteractive: Boolean(record.flags & FLAG.INTERACTIVE),
        isSpaceJunk: Boolean(record.flags & FLAG.SPACE_JUNK),
        x: record.position.x,
        y: record.position.y,
        z: record.position.z,
        vx: record.velocity.x,
        vy: record.velocity.y,
        vz: record.velocity.z,
        agility: record.agility,
        speedFraction: record.speedFraction,
      });
      ball.formationID = record.formationID;
      // A fixed ball's collision shapes are replaced by the record's; a rewind leaves them as they are.
      if (partial !== 1 && !(record.flags & FLAG.FREE)) {
        ball.miniBalls = record.miniBalls;
        ball.miniCapsules = record.miniCapsules;
        ball.miniBoxes = record.miniBoxes;
      }
      ball.harmonic = record.harmonic;
      ball.corporationID = record.corporationID;
      ball.allianceID = record.allianceID;
      // The mode is written straight in: no order is given, and nothing is told.
      ball.mode = record.mode;
      ball.isCloaked = record.isCloaked;
      if (record.followId !== undefined) ball.followId = record.followId;
      if (record.followRange !== undefined) ball.followRange = record.followRange;
      if (record.ownerId !== undefined) ball.ownerId = record.ownerId;
      if (record.effectStamp !== undefined) ball.effectStamp = record.effectStamp;
      if (record.goto !== undefined) ball.goto = { ...record.goto };
      if (record.mode === MODE.WARP) {
        // The C++ keeps these three in members named for other things.
        ball.lastCollision = record.totalWarpLength;
        ball.warpMinRange = record.minRange;
        ball.ownerId = record.warpFactor;
      }
      if (record.mode === MODE.MUSHROOM) ball.goto = vec(record.span, ball.goto.y, ball.goto.z);
      read.push(ball);
    }
    // Once every ball is in: hook each follower to its leader. One whose leader
    // is not in the park is left flying at whatever point it had.
    for (const ball of read) {
      if (!FOLLOW_MODES.has(ball.mode)) continue;
      const leader = this.balls.get(ball.followId);
      if (!leader) {
        ball.mode = MODE.GOTO;
      } else {
        ball.followPtr = leader;
        leader.followers.add(ball.id);
      }
    }
    return read;
  }

  /** A ball as a record of the state blob (WriteBallToStream reads these members). */
  _record(ball) {
    return {
      id: ball.id,
      mode: ball.mode,
      radius: ball.radius,
      position: ball.newPos,
      flags: (ball.isFree ? FLAG.FREE : 0) | (ball.isGlobal ? FLAG.GLOBAL : 0) | (ball.isMassive ? FLAG.MASSIVE : 0) |
        (ball.isInteractive ? FLAG.INTERACTIVE : 0) | (ball.isSpaceJunk ? FLAG.SPACE_JUNK : 0),
      mass: ball.mass,
      isCloaked: ball.isCloaked,
      harmonic: ball.harmonic,
      corporationID: ball.corporationID,
      allianceID: ball.allianceID,
      maxVelocity: ball.maxVelocity,
      velocity: ball.newVel,
      agility: ball.agility,
      speedFraction: ball.speedFraction,
      formationID: ball.formationID,
      followId: ball.followId,
      followRange: ball.followRange,
      ownerId: ball.ownerId,
      effectStamp: ball.effectStamp,
      goto: ball.goto,
      totalWarpLength: ball.lastCollision ?? 0,
      minRange: ball.warpMinRange ?? 0,
      warpFactor: ball.ownerId,
      span: ball.goto.x,
      miniBalls: ball.miniBalls ?? [],
      miniCapsules: ball.miniCapsules ?? [],
      miniBoxes: ball.miniBoxes ?? [],
    };
  }

  /**
   * WriteFullStateToStream (every ball) or, given ids, WriteBallsToStream. A
   * moribund ball is left out, and so is a ball of the client's own.
   */
  writeState(ids = null) {
    const chosen = ids === null ? [...this.balls.values()] : ids.map((id) => this.balls.get(id)).filter(Boolean);
    return writeState({
      packet: ids === null ? PACKET.FULL_STATE : PACKET.BALLS,
      stamp: this.currentTime,
      balls: chosen.filter((ball) => !ball.isMoribund && !(ids === null && ball.id < DSTLOCALBALLS)).map((ball) => this._record(ball)),
    });
  }

  // ── orders (4471-4650) ────────────────────────────────────────────────────

  /** Ballpark::Stop(const ID&) (4556), which is what the Stop order reaches: nothing to do for a ball already stopped. */
  stopOrder(id) {
    const ball = this.balls.get(id);
    if (!ball) return;
    if (ball.mode === MODE.STOP) return;
    this.stop(id);
  }

  /** Ballpark::Stop(Ball*) (4578): leave whoever was being followed, and stop steering. */
  stop(id) {
    const ball = this.balls.get(id);
    if (!ball) return;
    if (FOLLOW_MODES.has(ball.mode)) {
      // A client (not master) looks the leader up by id and only unhooks itself
      // if that is still the ball it holds.
      const leader = this.balls.get(ball.followId);
      if (leader && ball.followPtr === leader) ball.followPtr.followers.delete(ball.id);
      ball.effectStamp = 0;
      ball.followPtr = null;
      ball.followId = 0;
      ball.ownerId = 0;
      ball.followRange = 0.0;
    }
    this._setMode(ball, MODE.STOP);
  }

  /**
   * Ballpark::FollowBall (3879) and Ballpark::Orbit (4007): the same order but
   * for the mode. The Python entry points default the range to 1.0.
   */
  _follow(mode, id, targetId, range) {
    range = f32(range);
    if (!Number.isFinite(range)) return;
    const ball = this.balls.get(id);
    if (!ball) return;
    if (id === targetId) return;
    const target = this.balls.get(targetId);
    if (!target) return;
    if (target.isMoribund) return; // a dead ball cannot be followed
    if (target.isCloaked) return;
    this.stop(id);
    ball.followId = targetId;
    ball.followPtr = target;
    ball.followRange = range;
    this._setMode(ball, mode);
    target.followers.add(id);
  }

  followBall(id, targetId, range = 1.0) {
    this._follow(MODE.FOLLOW, id, targetId, range);
  }

  orbit(id, targetId, range = 1.0) {
    this._follow(MODE.ORBIT, id, targetId, range);
  }

  /**
   * Ballpark::MissileFollow (3798): the missile flies at what it is aimed at,
   * straight along its launch for a moment first. It is stopped before the
   * last two checks, so a missile refused by them is left stopped.
   */
  missileFollow(id, targetId, ownerId) {
    if (id === targetId || id === ownerId || targetId === ownerId) return;
    const missile = this.balls.get(id);
    const target = this.balls.get(targetId);
    if (!missile || !target) return;
    if (target.isMoribund) return; // a dead ball cannot be followed
    this.stop(id);
    // The source also refuses a target in another bubble. A client's balls carry no bubble of their own.
    if (target.isCloaked) return;
    missile.followId = targetId;
    missile.followPtr = target;
    // Negative, so that it makes for the target's centre and not its surface. A float sum, stored as a float.
    missile.followRange = -f32(missile.radius + target.radius);
    missile.ownerId = ownerId;
    // Counted from here, the ticks it flies straight before it turns to follow.
    missile.effectStamp = this.currentTime;
    missile.goto = scale(normalize(missile.newVel), 1.0e16);
    missile.speedFraction = 1.0;
    this._setMode(missile, MODE.MISSILE);
    target.followers.add(id);
  }

  /**
   * Ballpark::PyLaunchMissile (Thunkers.cpp 857): the missile is put where its
   * launcher is, given its launch velocity, and sent after the target. An aimed
   * launch is a unit velocity at the target; any other is the launcher's own
   * velocity and at least 150 m/s more along it. A negative owner id marks a
   * defender missile; its launcher is the ball of the id without the sign.
   */
  launchMissile(id, targetId, ownerId, aimedLaunch, massive) {
    if (targetId < 0) throw new Error("Can not launch missile on a negative ballID");
    const launcher = this.balls.get(ownerId < 0 ? -ownerId : ownerId);
    if (!launcher) return;
    const target = targetId !== ownerId ? this.balls.get(targetId) ?? null : null;
    let maxVelocity = 0.0;
    const ps = launcher.newPos;
    let v0;
    if (target && Number(aimedLaunch) === 1 && !target.isCloaked) {
      v0 = normalize(sub(target.newPos, ps));
    } else {
      const vs = launcher.newVel;
      maxVelocity = launcher.maxVelocity;
      let direction = normalize(vs);
      if (lengthSq(direction) === 0.0) {
        // A launcher at rest launches along its nose, (0, 0, -1) turned by its yaw, pitch and roll. Orientation
        // is not ported: this is the nose of a ball that has never turned, which is what CCP's own test sees.
        this.unported.orientation += 1;
        direction = vec(0.0, 0.0, -1.0);
      }
      // std::max(150.0, maxVelocity)
      v0 = add(vs, scale(direction, 150.0 < maxVelocity ? maxVelocity : 150.0));
    }
    if (massive) this.setBallMassive(id, 1);
    this.setBallPosition(id, ps.x, ps.y, ps.z);
    this.setBallVelocity(id, v0.x, v0.y, v0.z);
    if (target && target.isCloaked) return;
    if (!target) {
      if (maxVelocity > 0.0) this.gotoDirection(id, v0.x, v0.y, v0.z);
      return;
    }
    this.missileFollow(id, targetId, ownerId);
  }

  /** Ballpark::GotoPoint (4529). */
  gotoPoint(id, x, y, z) {
    const ball = this.balls.get(id);
    if (!ball) return;
    const p = vec(x, y, z);
    if (!finite(p)) return;
    this.stop(id);
    ball.goto = p;
    if (ball.speedFraction === 0.0) ball.speedFraction = 1.0;
    this._setMode(ball, MODE.GOTO);
  }

  // ── warp (Ballpark.cpp 4087-4400, Ball.cpp 1885-1925) ─────────────────────
  //
  // One mode, two phases. effectStamp below zero: lining up, flown as a GOTO at
  // the destination while the stamp counts the ticks downwards. Zero or above:
  // the warp proper, and the stamp is the tick it began. In the warp proper the
  // ball is not stepped at all: where it is, is worked out from how long ago
  // the warp began.
  //
  // The C++ keeps three of the warp's numbers in members named for other
  // things, and so does the state blob: the distance to stop short of the
  // destination in mFollowId (here warpMinRange), the warp factor in mOwnerId
  // (ownerId), and the warp's whole length in mLastCollision (lastCollision).

  /** Ballpark::WarpTo (4069). The Python entry point defaults minRange to 20000.0 and warpFactor to 20. */
  warpTo(id, x, y, z, minRange = 20000.0, warpFactor = 20) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (minRange < 0.0) minRange = 0.0;
    if (warpFactor <= 0) warpFactor = 1;
    const ball = this.balls.get(id);
    if (!ball) return;
    const dst = vec(x, y, z);
    const delta = sub(ball.newPos, dst);
    if (lengthSq(delta) < 10000000000.0) {
      // Nearer than 100 km: no warp, just fly there.
      this.gotoPoint(id, x, y, z);
      this._post("OnExitWarp", id, 1);
      return;
    }
    // Already on its way there: leave it, and its count of ticks spent lining up.
    if (ball.mode === MODE.WARP && dst.x === ball.goto.x && dst.y === ball.goto.y && dst.z === ball.goto.z) return;
    this.stop(id);
    ball.goto = dst;
    ball.effectStamp = -1;
    ball.followRange = 0.0;
    ball.warpMinRange = minRange;
    ball.ownerId = warpFactor;
    this._setMode(ball, MODE.WARP);
  }

  /** Ball::IsAlignedForWarp (Ball.cpp 1900): pointing within about eight degrees at three quarters of top speed, or out of patience. */
  isAlignedForWarp(ball) {
    if (!(ball.mode === MODE.WARP && ball.effectStamp < 0)) return false;
    const dir = normalize(sub(ball.goto, ball.newPos));
    const velDir = normalize(ball.newVel);
    if (Math.abs(1.0 - dot(velDir, dir)) < 0.01 && lengthSq(ball.newVel) > 0.5625 * ball.maxVelocity * ball.maxVelocity) return true;
    if (Math.abs(ball.effectStamp) > MAX_ALIGN_TICKS) return true;
    return false;
  }

  /**
   * Ballpark::RealWarp (4142): the warp proper begins. The destination is
   * pulled back towards the ball by minRange, and the warp's length is fixed
   * from where the ball is now.
   */
  realWarp(ball) {
    if (!ball) return;
    this.stopAllFollowers(ball);
    let dst = ball.goto;
    let delta = normalize(sub(ball.newPos, dst));
    dst = add(dst, scale(delta, ball.warpMinRange ?? 0));
    delta = sub(dst, ball.newPos);
    ball.goto = dst;
    ball.effectStamp = this.currentTime;
    ball.lastCollision = length(delta);
    ball.isMassive = false;
  }

  /**
   * Ballpark::EntityWarpIn (4368): a ball that arrives already in warp, as if
   * it had begun five ticks ago. The velocity it is given points along the
   * destination's own coordinates, not at it; the source says it does not care.
   */
  entityWarpIn(id, x, y, z, warpFactor) {
    this.warpTo(id, x, y, z, 0.0, warpFactor);
    const ball = this.balls.get(id);
    if (!ball) return;
    if (ball.mode === MODE.GOTO) return;
    this.realWarp(ball);
    ball.newVel = scale(normalize(vec(x, y, z)), AU);
    ball.effectStamp = Math.max(this.currentTime - 5, 0);
    ball.lastCollision = length(sub(ball.newPos, ball.goto));
  }

  /**
   * Ballpark::SetupWarpConstants (4165). A warp is three stretches: speeding up
   * (distance grows as exp(rate * t)), cruising, and slowing down
   * (speed falls as exp(-rate * t)). A warp too short to reach top speed has
   * its top speed lowered until the cruise takes no time.
   */
  setupWarpConstants(warpFactor, warpDistance) {
    let warpSpeed = warpFactor * WARP_FACTOR_TO_AU_PER_SECOND * AU;
    const accelRate = warpFactor * WARP_FACTOR_TO_ACCELERATION;
    // Never above 2, so that a fast ship does not stop in an instant.
    const decelRate = Math.min(warpFactor * WARP_FACTOR_TO_DECELERATION, 2.0);
    warpSpeed = Math.min(warpSpeed, (warpDistance + 1) * accelRate * decelRate / (accelRate + decelRate));
    const accelDuration = Math.log(warpSpeed / accelRate) / accelRate;
    const cruiseDuration = (warpDistance / warpSpeed) - (1.0 / accelRate) - (1.0 / decelRate) + (1.0 / warpSpeed);
    const decelDuration = Math.log(warpSpeed / decelRate) / decelRate;
    const accelDistance = warpSpeed / accelRate;
    const cruiseDistance = warpSpeed * cruiseDuration;
    const decelDistance = warpSpeed / decelRate - 1;
    return { accelDuration, cruiseDuration, decelDuration, accelDistance, cruiseDistance, decelDistance, accelRate, decelRate, warpSpeed };
  }

  /**
   * Ballpark::WarpDistance (4259): where a warping ball is, and how fast, `t`
   * seconds into its warp, given where it was (`p`, only for the direction)
   * and how fast (`v`, only so the speed never drops as the warp begins).
   * When the speed has fallen below 100 m/s, or half the ball's top speed if
   * that is less, the ball drops out of warp: massive again, and stopped.
   * `interpolating` is the engine asking between ticks for drawing, when
   * nothing may change.
   */
  warpDistance(ball, p, v, t, interpolating = false) {
    const { accelDuration, cruiseDuration, decelDuration, accelDistance, cruiseDistance, decelDistance, accelRate, decelRate, warpSpeed } =
      this.setupWarpConstants(ball.ownerId, ball.lastCollision);
    let speed;
    let distance;
    const dir = normalize(sub(ball.goto, p));
    const drop = () => {
      this._post("OnDeactivatingWarp", ball.id, this.currentTime);
      ball.isMassive = true;
      this.stop(ball.id);
    };
    if (t < accelDuration) {
      speed = accelRate * Math.exp(accelRate * t);
      // "Faking the speed to be continuous even though it actually isn't."
      const currSpeed = length(v);
      if (currSpeed > speed) speed = currSpeed;
      v = scale(dir, speed);
      distance = Math.exp(accelRate * t);
      p = sub(ball.goto, scale(dir, accelDistance + cruiseDistance + decelDistance - distance));
    } else if ((t - accelDuration) < cruiseDuration) {
      speed = warpSpeed;
      v = scale(dir, speed);
      distance = warpSpeed * (t - accelDuration) + accelDistance;
      p = sub(ball.goto, scale(dir, accelDistance + cruiseDistance + decelDistance - distance));
    } else if ((t - cruiseDuration - accelDuration) < (decelDuration + 1)) {
      // The extra second lets the last tick of the warp finish.
      speed = warpSpeed * Math.exp(-decelRate * (t - cruiseDuration - accelDuration));
      v = scale(dir, speed);
      distance = warpSpeed / decelRate - (warpSpeed / decelRate) * Math.exp(-decelRate * (t - cruiseDuration - accelDuration)) + accelDistance + cruiseDistance;
      p = sub(ball.goto, scale(dir, accelDistance + cruiseDistance + decelDistance - distance));
      if (speed < Math.min(ball.maxVelocity / 2.0, 100.0) && !interpolating) drop();
    } else {
      // "Ship stuck in extended warp": put it at the end, at rest.
      p = { ...ball.goto };
      v = vec();
      distance = 0;
      if (!interpolating) drop();
    }
    return { p, v, distance };
  }

  /**
   * ClientBall::InterpolatedPosition (Ball.cpp 1208) with
   * Ballpark::CalculateBallPositionVelocity (2715): where the client draws a
   * ball `fraction` of a tick after the park last stepped, and how fast.
   *
   * A ball not in warp is stepped from where it was a tick ago by the same
   * push that took it to where it is now, for that much of the tick: at 0 it
   * is where it was, at 1 where the park has it. A ball in warp is placed by
   * the warp's own clock, which runs a tick ahead of that: at 0 it is where
   * the park has it, at 1 where the next tick will put it.
   *
   * The client keeps what it last drew and hands that to the warp for its
   * heading and its least speed; here the ball of a tick ago is handed over,
   * so the speed returned as a warp begins can differ from the client's. The
   * place does not depend on it. Not ported: the tick's collisions worked out
   * step by step (mCollisionLocations), which this park does not keep.
   */
  between(ball, fraction, from = null) {
    if (isWarping(ball)) {
      const t = ((this.currentTime - ball.effectStamp) - 1 + fraction) * this.dt;
      const placed = this.warpDistance(ball, from ? from.p : ball.oldPos, from ? from.v : ball.oldVel, t, true);
      return { p: placed.p, v: placed.v };
    }
    return this.integrate(ball.oldPos, ball.oldVel, add(ball.lastG, ball.lastC), ball.mass * ball.agility, this.friction, ball.timeFactor, fraction * this.dt);
  }

  /**
   * ClientBall::InterpolatedPosition (Ball.cpp 1208) and what GetValueDotAt
   * reads after it (1438): where the client draws a ball, and how fast it says
   * the ball is going, when its sim clock reads `time` (milliseconds). This is
   * what the client measures with too: an overview row's distance and speed,
   * the HUD's speed.
   *
   * The client looks two ticks back from its clock, and each step leaves on a
   * ball the clock's reading at the step before (evolve). The two cancel: in
   * the second after the park has stepped, a ball is drawn from where it was a
   * tick ago to where the park now has it. What is drawn is one tick behind
   * what the park knows.
   *
   * A ball no step has yet been timed for (a fixed one, or one that has just
   * arrived) is where the park has it. Asked again for the same reading, or
   * for an earlier one, the answer is the last one given.
   */
  drawn(ball, time) {
    const shifted = time - 2 * this.tickInterval;
    if (ball.posUpdateTime === shifted || shifted < ball.posUpdateTime) return { p: ball.lastPos, v: ball.lastVel };
    if (ball.oldTime === ball.newTime) {
      // "No interpolation possible. Just return the newest value"
      ball.lastPos = { ...ball.newPos };
      ball.posUpdateTime = shifted;
      return { p: ball.lastPos, v: ball.lastVel };
    }
    // InforceContinuity (877): the first drawing of a ball begins from where it was.
    if (ball.lastTick !== this.currentTime) {
      if (ball.lastTick === -1) {
        ball.lastPos = { ...ball.oldPos };
        ball.lastVel = { ...ball.oldVel };
      }
      ball.lastTick = this.currentTime;
    }
    const fraction = (shifted - ball.oldTime) / this.tickInterval;
    const placed = this.between(ball, fraction, { p: ball.lastPos, v: ball.lastVel });
    ball.lastPos = placed.p;
    ball.lastVel = placed.v;
    ball.posUpdateTime = shifted;
    return { p: ball.lastPos, v: ball.lastVel };
  }

  /**
   * Ballpark::AdjustTimes (4416): every time the park keeps by the sim clock
   * moved by `delta` milliseconds: its own, and what each ball keeps for
   * drawing. The client does this when it is told its sim clock was rebased.
   */
  adjustTimes(delta) {
    this.time += delta;
    for (const ball of this.balls.values()) {
      ball.posUpdateTime += delta;
      if (ball.newTime !== 0) ball.newTime += delta;
      if (ball.oldTime !== 0) ball.oldTime += delta;
    }
  }

  /** Ballpark::EvolveWarp (915): lining up is a GOTO at the destination; once lined up the warp proper begins, in this same tick. */
  _evolveWarp(ball) {
    if (isWarping(ball)) return vec();
    if (this.isAlignedForWarp(ball)) {
      this._post("OnActivatingWarp", ball.id, this.currentTime);
      this.realWarp(ball);
      return vec();
    }
    ball.effectStamp -= 1;
    return this.gotoThrust(ball, ball.goto);
  }

  /**
   * Ballpark::GotoDirection (4483): a point 1e17 m away along the direction,
   * from where the ball is now. The ball then steers at that point; it is not
   * told to hold a heading.
   */
  gotoDirection(id, x, y, z) {
    const ball = this.balls.get(id);
    if (!ball) return;
    let dir = vec(x, y, z);
    if (!finite(dir)) return;
    dir = normalize(dir);
    dir = add(ball.newPos, scale(dir, 1.0e17));
    this.gotoPoint(id, dir.x, dir.y, dir.z);
  }

  // ── the step ──────────────────────────────────────────────────────────────

  /**
   * Ballpark::Integrate (751): the closed-form step of m dv/dt = m a - k v over
   * time t, with a held constant. Returns the new { p, v }. Evaluated exactly
   * as the source writes it.
   */
  integrate(p, v, a, m, k, timeFactor, t) {
    if (t === 0.0) return { p, v };
    if (t !== this.dt) timeFactor = Math.exp((-k / m) * t);
    const k2 = k * k;
    const ook2 = 1.0 / k2;
    const ook = 1.0 / k;
    const ma = scale(a, m);
    let newP;
    if (k < 1e-10 * m * t) {
      // p = (m * (a * (-k * t) + k * (a * t + v * k / m * t)) + p * k2) * ook2;
      const inner = add(scale(a, t), scale(divide(scale(v, k), m), t));
      newP = scale(add(scale(add(scale(a, -k * t), scale(inner, k)), m), scale(p, k2)), ook2);
    } else {
      // p = (m * (m * a * (timeFactor - 1.0) + k * (a * t + v - timeFactor * v)) + p * k2) * ook2;
      const inner = sub(add(scale(a, t), v), scale(v, timeFactor));
      newP = scale(add(scale(add(scale(ma, timeFactor - 1.0), scale(inner, k)), m), scale(p, k2)), ook2);
    }
    // v = (m * a - (m * a - v * k) * timeFactor) * ook;
    const newV = scale(sub(ma, scale(sub(ma, scale(v, k)), timeFactor)), ook);
    return { p: newP, v: newV };
  }

  /**
   * Ballpark::GotoThrust (1398): full thrust straight at the target, eased off
   * by the fourth power of the distance once the target is within a tick's travel.
   */
  gotoThrust(ball, target, missile = false) {
    let a = sub(target, ball.newPos);
    const length2 = lengthSq(a);
    const dist = ball.speedFraction * ball.maxVelocity * this.dt;
    const maxThrust = (this.friction * ball.speedFraction * ball.maxVelocity) / (ball.mass * ball.agility);
    a = normalize(a);
    if (!missile && length2 < dist * dist) {
      const coff = length2 / (dist * dist);
      a = scale(a, maxThrust * coff * coff);
    } else {
      a = scale(a, maxThrust);
    }
    return a;
  }

  /**
   * Ballpark::EvolveFollow (1066): steer at the point on the line between the
   * two, at the range asked for measured surface to surface. Where the leader
   * is going plays no part.
   */
  _evolveFollow(ball) {
    const other = ball.followPtr;
    const otherPos = other.newPos;
    const delta = sub(ball.newPos, otherPos);
    const dist = length(delta);
    const r = ball.followRange + ball.radius + other.radius;
    // Right on top of it: go out along x.
    const target = dist === 0.0 ? add(otherPos, scale(vec(1.0, 0.0, 0.0), r)) : add(otherPos, divide(scale(delta, r), dist));
    ball.goto = target;
    return this.gotoThrust(ball, target, ball.mode === MODE.MISSILE);
  }

  /**
   * Ballpark::EvolveMissile (972): straight on along the launch while the
   * launch is no more than 800 ms old, which with one-second ticks is the
   * launch tick alone. Then at where the target will be by the time the
   * missile could reach it standing still, with no easing off at the end.
   */
  _evolveMissile(ball) {
    if ((this.currentTime - ball.effectStamp) * this.tickInterval <= 800) return this.gotoThrust(ball, ball.goto);
    const other = ball.followPtr;
    const otherPos = other.newPos;
    const delta = sub(ball.newPos, otherPos);
    const dist = length(delta);
    const cT = dist / ball.maxVelocity;
    let target = add(otherPos, scale(other.newVel, cT));
    const r = ball.followRange + ball.radius + other.radius;
    // Right on top of it: go out along x. Otherwise the range along the line between them.
    target = dist === 0.0 ? add(otherPos, scale(vec(1.0, 0.0, 0.0), r)) : add(target, divide(scale(delta, r), dist));
    ball.goto = target;
    return this.gotoThrust(ball, target, true);
  }

  /**
   * Ballpark::EvolveOldStyleOrbit (1249). The plane of the orbit comes from the
   * low sixteen bits of the orbiter's id and from the tick counter, so two
   * simulations agree only if they agree on what tick it is.
   */
  _evolveOrbit(ball, currentTime) {
    const cruiseVelocity = ball.speedFraction * ball.maxVelocity;
    const k = this.friction;
    const maxThrust = (k * cruiseVelocity) / (ball.mass * ball.agility);
    const other = ball.followPtr;
    const otherPos = other.newPos;
    const r = ball.followRange + ball.radius + other.radius;
    let toVector = sub(otherPos, ball.newPos);
    const dist = length(toVector);
    toVector = normalize(toVector);

    let phi1 = currentTime * ORBITAL_PRECESSION;
    const phi2 = lowSixteenBits(ball.id) + currentTime * ORBITAL_PRECESSION;
    let radialVector = vec(
      cutToSevenDecimals(Math.cos(phi1) * Math.cos(phi2)),
      cutToSevenDecimals(Math.sin(phi2)),
      cutToSevenDecimals(Math.sin(phi1) * Math.cos(phi2)),
    );
    // Despite its name, after this it is across the line to the other ball, not along it.
    radialVector = normalize(cross(radialVector, toVector));

    // Aim at the tangent of the orbit when outside it.
    const toComp = dist * dist - r * r;
    if (toComp >= 0.0) {
      const radComp = (r * Math.sqrt(toComp)) / dist;
      toVector = normalize(add(scale(toVector, toComp / dist), scale(radialVector, radComp)));
    }

    // How much of the thrust goes sideways. exp() is cut to seven decimals
    // because CCP found it differed between their own platforms.
    const radialFactor = cutToSevenDecimals(Math.exp((-(r - dist) * (r - dist)) / 40000.0));
    phi1 = -dot(toVector, radialVector);
    let transverseFactor = 1.0 + radialFactor * radialFactor * (phi1 * phi1 - 1.0);
    transverseFactor = transverseFactor > 0.0 ? radialFactor * phi1 + Math.sqrt(transverseFactor) : radialFactor * phi1;
    transverseFactor *= dist - r >= 0.0 ? 1.0 : -1.0;

    const a = scale(add(scale(radialVector, radialFactor), scale(toVector, transverseFactor)), maxThrust);
    ball.goto = add(ball.newPos, scale(a, 10.0 * AU));
    return a;
  }

  /** Ballpark::EvolveBehaviorForBall (789): this tick's acceleration, by mode. */
  _evolveBehavior(ball) {
    ball.lastG = vec();
    ball.lastC = vec();
    ball.collisions = [];
    let a = vec();
    switch (ball.mode) {
      case MODE.GOTO:
        a = this.gotoThrust(ball, ball.goto);
        break;
      case MODE.STOP: {
        // EvolveStop (1339): the vertical speed is damped by more than friction alone.
        const v = ball.newVel;
        ball.newVel = vec(v.x, (v.y - 0.07 * v.y) * 0.9345794392523364485981308411215, v.z);
        break;
      }
      case MODE.FOLLOW:
        a = this._evolveFollow(ball);
        break;
      case MODE.ORBIT:
        a = this._evolveOrbit(ball, this.currentTime);
        break;
      case MODE.WARP:
        a = this._evolveWarp(ball);
        break;
      case MODE.MISSILE:
        a = this._evolveMissile(ball);
        break;
      case MODE.FORMATION:
        throw new DestinyNotPorted(`The ${MODE_NAME[ball.mode]} mode`);
      default:
        // MUSHROOM, BOID, TROLL, MINIBALL, FIELD, RIGID: no acceleration.
        break;
    }
    ball.lastG = a;
  }

  /**
   * Ballpark::Gradient (2746), with Partition::GetCollisionCandidates (302):
   * what a massive ball's neighbours do to it this tick, left in its lastC.
   * `all` is every ball in the park in order of id.
   *
   * The source asks its partition for the balls near enough to matter; this
   * asks every ball, and Potential answers "no contact" for the far ones. What
   * the partition also decides is the order, which is its boxes' and then id.
   * Here it is id alone.
   */
  _gradient(ball, all) {
    this.gradients += 1;
    const missile = ball.mode === MODE.MISSILE;
    // GetCollisionCandidates: a missile's only candidate is what it is aimed at, unless its owner id is negative
    // (a defender missile), which sees what any ball sees and missiles too. The source checks the two share a
    // bubble; a client's balls carry no bubble of their own.
    const aimedOnly = missile && !(ball.ownerId < 0);
    const candidates = aimedOnly ? (ball.followPtr ? [ball.followPtr] : []) : all;
    for (const neighbor of candidates) {
      if (!aimedOnly) {
        // Partition::GetNearbyBalls (344): not itself, not the dead, not the cloaked or the massless, not a
        // missile unless the ball is a defender; and a force field is no obstacle to its own.
        if (neighbor === ball || neighbor.isMoribund) continue;
        if (neighbor.isCloaked || !neighbor.isMassive) continue;
        if (neighbor.mode === MODE.FIELD) {
          if (ball.harmonic === -2) continue;
          if (neighbor.harmonic !== -1 && neighbor.harmonic === ball.harmonic) continue;
          if (neighbor.corporationID !== -1 && neighbor.corporationID === ball.corporationID) continue;
          if (neighbor.allianceID !== -1 && neighbor.allianceID === ball.allianceID) continue;
        }
        if (!missile && neighbor.mode === MODE.MISSILE) continue;
      }
      // Gradient itself: a missile does not hit its launcher, nor a miniball of its launcher's; a launcher is not
      // hit by its own missile or mushroom, nor a target by the missile aimed at it; and wreckage only troubles
      // wreckage.
      if (missile && (byId(neighbor.id, ball.ownerId) === 0 || (neighbor.mode === MODE.MINIBALL && byId(neighbor.ownerId, ball.ownerId) === 0))) continue;
      if ((neighbor.mode === MODE.MISSILE || neighbor.mode === MODE.MUSHROOM) && byId(ball.id, neighbor.ownerId) === 0) continue;
      if (neighbor.mode === MODE.MISSILE && byId(ball.id, neighbor.followId) === 0) continue;
      if (neighbor.isSpaceJunk && !ball.isSpaceJunk) continue;
      this._potential(ball, neighbor, 0);
    }
    if (new Set(ball.collisions).size > 1) this.unported.collisionOrder += 1;
  }

  /**
   * Ballpark::Potential (2789): what one neighbour does to a ball this tick.
   * Both are carried a tick ahead on their own steering alone. If they touch
   * on the way, the ball bounces: off a fixed neighbour its speed along the
   * line between them is turned round, off a free one the two exchange it as
   * their masses say. If they overlap already, the ball is pushed clear. Either
   * way the answer is the steady acceleration that gets the ball there over the
   * whole tick, damped to 0.85, and of several neighbours the one touched
   * latest in the tick is kept. Only `me` is changed.
   */
  _potential(me, other, recursionDepth) {
    const k = this.friction;
    const dt = this.dt;
    const collRadius = me.radius + other.radius;
    const m1 = me.isFree ? me.mass * me.agility : 1.0e34;
    const m2 = other.isFree ? other.mass * other.agility : 1.0e34;
    const p0 = me.newPos;
    const q0 = other.newPos;
    const p1 = this.integrate(p0, me.newVel, me.lastG, m1, k, me.timeFactor, dt).p;
    const q1 = this.integrate(q0, other.newVel, other.lastG, m2, k, other.timeFactor, dt).p;
    const s = collideTwoSpheres(p0, p1, q0, q1, collRadius);
    if (s === -1.0) return;

    let a1;
    if (s > 0.0) {
      // They touch later in the tick: both to that moment, and the line between them there.
      const mine = this.integrate(p0, me.newVel, me.lastG, m1, k, me.timeFactor, s * dt);
      const theirs = this.integrate(q0, other.newVel, other.lastG, m2, k, other.timeFactor, s * dt);
      const normal = normalize(sub(theirs.p, mine.p));
      const v1 = dot(mine.v, normal);
      const v2 = dot(theirs.v, normal);
      let vp1;
      if (!other.isFree) {
        vp1 = sub(mine.v, scale(normal, 2.0 * v1));
      } else {
        // The exchange uses the masses themselves, not mass times agility.
        const mm1 = me.mass;
        const mm2 = other.mass;
        const v1p = (mm1 * v1 - mm2 * v1 + 2.0 * mm2 * v2) / (mm1 + mm2);
        vp1 = add(mine.v, scale(normal, v1p - v1));
      }
      vp1 = this.integrate(mine.p, vp1, me.lastG, m1, k, me.timeFactor, (1.0 - s) * dt).v;
      // a1 = -(-m1 * G + tf * m1 * G - tf * v * k + vp1 * k) / m1 / (tf - 1.0)
      const tf = me.timeFactor;
      const sum = add(sub(add(scale(me.lastG, -m1), scale(me.lastG, tf * m1)), scale(scale(me.newVel, tf), k)), scale(vp1, k));
      a1 = divide(divide(vec(-sum.x, -sum.y, -sum.z), m1), tf - 1.0);
    } else {
      // They overlap already. The line between them; for two at the very same point, along x by whose id is greater.
      const p0q0 = sub(q0, p0);
      const p0q0_2 = dot(p0q0, p0q0);
      const normal = p0q0_2 === 0.0 ? (byId(me.id, other.id) > 0 ? vec(1.0, 0.0, 0.0) : vec(-1.0, 0.0, 0.0)) : normalize(sub(q0, p0));
      // How far apart they must come to be clear, and a metre over; shared out by the other's weight.
      const dist = collRadius - Math.sqrt(p0q0_2) + 1;
      const d1 = (m2 / (m1 + m2)) * dist;
      const d2 = (m1 / (m1 + m2)) * dist;
      if (me.isFree && other.isFree && recursionDepth < 2) {
        // Both can move: set them apart, work the collision out from there, and put them back.
        me.newPos = sub(p0, scale(normal, d1));
        other.newPos = add(q0, scale(normal, d2));
        this._potential(me, other, recursionDepth + 1);
        me.newPos = p0;
        other.newPos = q0;
        // Much the lighter of the two: its answer is stretched to the whole distance, to get it out.
        if (m2 / m1 > 25.0) me.lastC = scale(normalize(me.lastC), dist);
        if (lengthSq(sub(me.newVel, other.newVel)) > 0.0001) return;
      }
      // A fixed neighbour, or two moving as one: the ball is simply pushed out.
      const normalComp = dot(me.lastG, normal);
      const tmp = 1.0 / (m1 + dt * k);
      a1 = sub(divide(sub(scale(normal, -d1 / (dt * tmp * m1)), me.newVel), dt), scale(normal, normalComp));
    }

    // A missile is not turned aside by what it is aimed at. Otherwise the neighbour touched latest in the
    // tick is the one that counts, and of two touched at the same moment, the stronger.
    if ((me.mode !== MODE.MISSILE || byId(other.id, me.followId) !== 0) && s >= me.lastCollision) {
      const lastC = scale(a1, 0.85);
      if (s === me.lastCollision) {
        if (lengthSq(lastC) > lengthSq(me.lastC)) me.lastC = lastC;
      } else {
        me.lastC = lastC;
        me.lastCollision = s;
      }
    }
    me.collisions.push(other.id);
  }

  /**
   * Ballpark::Evolve (421): one tick. Every free ball's acceleration is found
   * first, then every ball is stepped from the same picture of the others, then
   * all of them move at once. Balls are taken in ascending id.
   *
   * `timestamp` is the sim clock's reading the engine's driver hands over with
   * the step, in milliseconds: the reading at the step before this one. Each
   * ball keeps it and the one before, for drawing (drawn). A step taken without
   * one, as every step the park takes to catch up or go back is, leaves those
   * times alone.
   */
  evolve(timestamp = 0) {
    const free = [...this.freeBalls.values()].filter((ball) => !ball.isMoribund).sort((a, b) => byId(a.id, b.id));
    for (const ball of free) this._evolveBehavior(ball);
    let all = null;
    for (const ball of free) {
      if (ball.isMassive) {
        // What its neighbours do to it, from where they all are before anyone has moved. mLastCollision
        // is when in the tick it last touched something: nothing yet.
        all ??= [...this.balls.values()].sort((a, b) => byId(a.id, b.id));
        // A missile or a mushroom never meets a fixed ball's shapes (Gradient, 2780).
        const seesShapes = ball.mode !== MODE.MISSILE && ball.mode !== MODE.MUSHROOM;
        if (seesShapes && all.some((each) => !each.isFree && (each.miniBalls?.length || each.miniCapsules?.length || each.miniBoxes?.length))) this.unported.minis += 1;
        ball.lastCollision = -1.0;
        this._gradient(ball, all);
      }
      let stepped;
      if (isWarping(ball)) {
        // Not stepped: placed, by how long the warp has been going.
        stepped = this.warpDistance(ball, ball.newPos, ball.newVel, (this.currentTime - ball.effectStamp) * this.dt, false);
        if (ball.mode === MODE.STOP) {
          // It dropped out of warp this tick. Where the warp left it becomes
          // where it was, and one ordinary step is taken from there.
          ball.newPos = stepped.p;
          ball.newVel = stepped.v;
          stepped = this.integrate(stepped.p, stepped.v, add(ball.lastG, ball.lastC), ball.mass * ball.agility, this.friction, ball.timeFactor, this.dt);
        }
      } else {
        stepped = this.integrate(ball.newPos, ball.newVel, add(ball.lastG, ball.lastC), ball.mass * ball.agility, this.friction, ball.timeFactor, this.dt);
      }
      // Kept in the "old" pair until every ball is done: the others still see where this one was.
      ball.oldPos = stepped.p;
      ball.oldVel = stepped.v;
    }
    const trolls = [];
    for (const ball of free) {
      // TrollReady (6315): its time has come.
      if (ball.mode === MODE.TROLL && !(ball.effectStamp > this.currentTime)) trolls.push(ball);
      if (timestamp !== 0) {
        // "Assume that we are one time step ahead of time..."
        ball.oldTime = ball.newTime === 0 ? timestamp - this.tickInterval : ball.newTime;
        ball.newTime = timestamp;
      }
      if (ball.mode === MODE.MUSHROOM) throw new DestinyNotPorted("The MUSHROOM mode");
      [ball.newPos, ball.oldPos] = [ball.oldPos, ball.newPos];
      [ball.newVel, ball.oldVel] = [ball.oldVel, ball.newVel];
    }
    // PetrifyTroll (6325): stopped dead, fixed, and no longer anyone's business.
    for (const ball of trolls) {
      if (ball.mode !== MODE.TROLL || ball.effectStamp > this.currentTime) continue;
      this.setBallFree(ball.id, false);
      this.setBallInteractive(ball.id, false);
      this._setMode(ball, MODE.RIGID);
    }
    this.currentTime += 1;
  }
}

module.exports = { AU, Ballpark, DSTLOCALBALLS, DestinyNotPorted, FOLLOW_MODES, MAX_ALIGN_TICKS, add, collideTwoSpheres, cross, divide, dot, isWarping, length, lengthSq, normalize, quadratic, scale, sub, vec };
