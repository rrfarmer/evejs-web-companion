"use strict";

// src/gamePort/destiny/ballpark.js is CCP's destiny ported to JavaScript. The
// expected numbers here are CCP's own, from the evolve tests that ship with its
// source (destiny/python/destiny/test/ballpark/evolve/test_goto.py, test_stop.py,
// test_follow.py, test_orbit.py and test_simple_collision.py), each a position or velocity after every tick. CCP's tests
// accept four decimal places. These require every digit: the point of the
// port is the same bits the retail client computes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AU, Ballpark, DestinyNotPorted, MAX_ALIGN_TICKS, collideTwoSpheres, divide, isWarping, normalize, quadratic, scale, vec } = require("../src/gamePort/destiny/ballpark");
const { MODE } = require("../src/gamePort/destiny/state");

/**
 * destiny.test.helpers.create_space_ball: a ball added still and unfree, then
 * set up through the same setters the Python attributes go through.
 */
function spaceBall(park, { id = 1, x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, mass = 13000000.0, maxVelocity = 10.0 } = {}) {
  park.addBall({ id, x, y, z, vx, vy, vz });
  park.setBallFree(id, true);
  park.setMaxSpeed(id, maxVelocity);
  park.setBallAgility(id, 0.9);
  park.setBallMass(id, mass);
  park.setBallRadius(id, 2.0);
  park.setBallMassive(id, true);
  park.setSpeedFraction(id, 0.95);
  return park.ball(id);
}

/** Evolve `ticks` times, reading `what` after each. */
function run(park, ball, ticks, what) {
  const rows = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    park.evolve();
    const v = ball[what];
    rows.push([v.x, v.y, v.z]);
  }
  return rows;
}

// ── CCP's fixtures ───────────────────────────────────────────────────────────

test("CCP test_goto_direction: ten ticks toward (10, 20, 30), to the last digit", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  park.gotoDirection(ball.id, 10, 20, 30);
  assert.deepEqual(run(park, ball, 10, "newPos"), [
    [0.10547716886968704, 0.21095433773937408, 0.31643150660906116],
    [0.4103055632728434, 0.8206111265456868, 1.2309166898185293],
    [0.8981544513244618, 1.7963089026489236, 2.6944633539733838],
    [1.5540309048233936, 3.108061809646787, 4.662092714470173],
    [2.364170207183284, 4.728340414366568, 7.0925106215498435],
    [3.315935239079564, 6.631870478159128, 9.947805717238685],
    [4.397724106363411, 8.795448212726821, 13.19317231909023],
    [5.598885335041164, 11.197770670082328, 16.796656005123484],
    [6.909640013429747, 13.819280026859493, 20.728920040289236],
    [8.321010312379675, 16.64202062475935, 24.96303093713902],
  ]);
});

test("CCP test_goto_point: eighteen ticks to the point (10, 20, 30), homing in at the end", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  park.gotoPoint(ball.id, 10, 20, 30);
  assert.deepEqual(run(park, ball, 18, "newPos"), [
    [0.10547716886968671, 0.21095433773937342, 0.31643150660906116],
    [0.4103055632728427, 0.8206111265456854, 1.2309166898185306],
    [0.898154451324462, 1.796308902648924, 2.694463353973384],
    [1.5540309048233925, 3.108061809646785, 4.662092714470175],
    [2.364170207183283, 4.728340414366566, 7.092510621549848],
    [3.3159352390795633, 6.631870478159127, 9.947805717238683],
    [4.397724106363411, 8.795448212726821, 13.193172319090227],
    [5.598885335041161, 11.197770670082322, 16.79665600512348],
    [6.909640013429744, 13.819280026859488, 20.728920040289225],
    [8.321010312379672, 16.642020624759343, 24.96303093713901],
    [9.739446987259553, 19.478893974519107, 29.218340961778658],
    [11.061301666724546, 22.122603333449092, 33.18390500017364],
    [12.271662033494039, 24.543324066988077, 36.814986100482116],
    [13.312148751580072, 26.624297503160143, 39.93644625474022],
    [14.096228724360666, 28.19245744872133, 42.288686173082],
    [14.608085488313941, 29.216170976627883, 43.82425646494182],
    [14.870019404144168, 29.740038808288336, 44.610058212432506],
    [14.902504000487617, 29.805008000975235, 44.70751200146285],
  ]);
});

test("CCP test_stop_ball_in_goto_mode: a stopping ball's velocity, the vertical part falling fastest", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  park.setBallVelocity(ball.id, 10.0, 20.0, 30.0);
  park.stop(ball.id);
  assert.deepEqual(run(park, ball, 10, "newVel"), [
    [9.180806045144438, 15.959158171933325, 27.542418135433316],
    [8.428719963856068, 12.73473647783931, 25.286159891568197],
    [7.738244319699939, 10.161783686386327, 23.21473295909981],
    [7.104332022910581, 8.108675658000553, 21.312996068731735],
    [6.522349438265067, 6.470381869546817, 19.567048314795194],
    [5.9880425151368355, 5.163092384445365, 17.9641275454105],
    [5.497505692155016, 4.119930400983397, 16.49251707646504],
    [5.047153349175273, 3.2875310463325356, 15.141460047525813],
    [4.633693597887935, 2.6233113981781195, 13.901080793663798],
    [4.254104219483663, 2.0932920768880083, 12.762312658450982],
  ]);
});

test("CCP test_stopped_ball_is_stopped: a ball at rest at the origin stays exactly there", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  for (const [x, y, z] of run(park, ball, 10, "newPos")) assert.deepEqual([x, y, z], [0, 0, 0]);
  assert.equal(park.currentTime, 10);
});

test("CCP test_follow_stopped_ball: ten ticks toward a ball that is standing still", () => {
  const park = new Ballpark();
  const follower = spaceBall(park, { id: 1 });
  const leader = spaceBall(park, { id: 2, x: 100, y: 200, z: 300 });
  park.followBall(follower.id, leader.id);
  assert.deepEqual(run(park, follower, 10, "newPos"), [
    [0.10547716886968704, 0.21095433773937408, 0.3164315066090625],
    [0.41030556327284373, 0.8206111265456875, 1.2309166898185306],
    [0.8981544513244621, 1.7963089026489243, 2.694463353973384],
    [1.5540309048233925, 3.108061809646785, 4.662092714470175],
    [2.364170207183283, 4.728340414366566, 7.092510621549848],
    [3.3159352390795633, 6.631870478159127, 9.94780571723868],
    [4.397724106363411, 8.795448212726821, 13.193172319090223],
    [5.59888533504116, 11.19777067008232, 16.796656005123477],
    [6.909640013429743, 13.819280026859486, 20.72892004028922],
    [8.321010312379672, 16.642020624759343, 24.963030937139006],
  ]);
});

test("CCP test_follow_moving_ball: ten ticks after a ball that is itself under way", () => {
  const park = new Ballpark();
  const follower = spaceBall(park, { id: 1 });
  const leader = spaceBall(park, { id: 2, x: 100, y: 0, z: 0 });
  park.followBall(follower.id, leader.id);
  park.gotoPoint(leader.id, 0, 100, 200);
  assert.deepEqual(run(park, follower, 10, "newPos"), [
    [0.3946594280372685, 0.0, 0.0],
    [1.5352202516956626, 0.0006394210607791958, 0.0012788421215583917],
    [3.360538351919784, 0.00437328037960026, 0.00874656075920052],
    [5.814319316187089, 0.01591817574944254, 0.03183635149888508],
    [8.844475669456193, 0.042139697272792834, 0.08427939454558567],
    [12.402376916827746, 0.09207177010911027, 0.18414354021822055],
    [16.441932909387862, 0.17705502464375017, 0.35411004928750034],
    [20.918410162782422, 0.31098291710272036, 0.6219658342054407],
    [25.786827618186656, 0.5106319284615736, 1.0212638569231471],
    [30.99971869544917, 0.796013087027414, 1.592026174054828],
  ]);
});

test("CCP TestOldOrbit.test_orbit_ball: ball 2 orbiting ball 1 from tick 0, its plane set by its id", () => {
  const park = new Ballpark();
  const orbitee = spaceBall(park, { id: 1 });
  const orbiter = spaceBall(park, { id: 2, x: 5.0 });
  assert.equal(park.currentTime, 0);
  park.orbit(orbiter.id, orbitee.id, 1.0);
  assert.deepEqual(run(park, orbiter, 10, "newPos"), [
    [5.0, 0.0, 0.3946594280372685],
    [4.968965087530276, -0.014060509698578017, 1.533749375235321],
    [4.7948197558341885, -0.09342506603769896, 3.3353413772468783],
    [4.303462228867957, -0.3182911817228117, 5.664861650309143],
    [3.341010762290748, -0.7601346870799338, 8.325917825178466],
    [1.826888038965309, -1.4570571575293851, 11.103680716692217],
    [-0.25072581197636695, -2.415534207332392, 13.808614450861453],
    [-2.860769892110699, -3.6221094985835713, 16.289471089613752],
    [-5.948838546575331, -5.052297043579673, 18.42935795458875],
    [-9.447930869309866, -6.675507070626672, 20.138672333159825],
  ]);
});

// ── what the source says, beyond the fixtures ────────────────────────────────

test("the arithmetic is destiny's: division is by the reciprocal, and a zero vector normalises to itself", () => {
  // 1/3 is not exact, so x * (1/3) and x / 3 can differ in the last place.
  const third = divide(vec(5, 7, 0.1), 3);
  assert.deepEqual(third, { x: 5 * (1 / 3), y: 7 * (1 / 3), z: 0.1 * (1 / 3) });
  assert.notEqual(third.x, 5 / 3);
  const zero = vec(0, 0, 0);
  assert.equal(normalize(zero), zero);
  const unit = normalize(vec(3, 4, 0));
  assert.deepEqual(unit, { x: 3 * (1 / 5), y: 4 * (1 / 5), z: 0 });
  assert.deepEqual(scale(vec(1, 2, 3), 2), { x: 2, y: 4, z: 6 });
});

test("the float fields are stored as float32, and the time factor is made from them", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  assert.equal(ball.agility, Math.fround(0.9));
  assert.notEqual(ball.agility, 0.9);
  assert.equal(ball.speedFraction, Math.fround(0.95));
  assert.equal(ball.maxVelocity, 10);
  assert.equal(ball.radius, 2);
  // exp(-k*dt/m) with m = mass * agility, agility already rounded.
  assert.equal(ball.timeFactor, Math.exp((-1000000.0 * 1.0) / (13000000.0 * Math.fround(0.9))));
  // Mass and agility each remake it; nothing else does.
  const before = ball.timeFactor;
  park.setMaxSpeed(ball.id, 400);
  park.setSpeedFraction(ball.id, 0.5);
  assert.equal(ball.timeFactor, before);
  park.setBallMass(ball.id, 1157000);
  assert.equal(ball.timeFactor, Math.exp((-1000000.0 * 1.0) / (1157000 * Math.fround(0.9))));
  park.setBallAgility(ball.id, 4.35);
  assert.equal(ball.timeFactor, Math.exp((-1000000.0 * 1.0) / (1157000 * Math.fround(4.35))));
});

test("the setters refuse what destiny's refuse", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  const before = { ...ball };
  park.setBallMass(ball.id, 0);
  park.setBallMass(ball.id, -5);
  park.setBallAgility(ball.id, 0);
  park.setBallAgility(ball.id, -1);
  park.setMaxSpeed(ball.id, -1);
  park.setSpeedFraction(ball.id, NaN);
  park.setSpeedFraction(ball.id, Infinity);
  assert.deepEqual([ball.mass, ball.agility, ball.maxVelocity, ball.speedFraction], [before.mass, before.agility, before.maxVelocity, before.speedFraction]);
  // A fraction is held to [0, 1].
  park.setSpeedFraction(ball.id, 1.5);
  assert.equal(ball.speedFraction, 1);
  park.setSpeedFraction(ball.id, -0.5);
  assert.equal(ball.speedFraction, 0);
  // A ball that is not there is left alone, quietly.
  for (const call of [() => park.setBallMass(99, 1), () => park.stop(99), () => park.gotoPoint(99, 1, 2, 3), () => park.setBallFree(99, true), () => park.setBallPosition(99, 1, 2, 3)]) call();
  assert.equal(park.ball(99), null);
});

test("an order to go somewhere stops what the ball was doing first, and wakes a ball whose throttle was at zero", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  park.setSpeedFraction(ball.id, 0);
  park.gotoPoint(ball.id, 100, 0, 0);
  assert.deepEqual([ball.mode, ball.speedFraction, ball.goto], [MODE.GOTO, 1, { x: 100, y: 0, z: 0 }]);
  // A point that is not a point is ignored: the ball keeps its order.
  park.gotoPoint(ball.id, NaN, 0, 0);
  park.gotoDirection(ball.id, Infinity, 0, 0);
  assert.deepEqual(ball.goto, { x: 100, y: 0, z: 0 });
  // A direction becomes a point 1e17 m away from where the ball is now.
  park.setBallPosition(ball.id, 1000, 2000, 3000);
  park.gotoDirection(ball.id, 0, 0, -2);
  assert.deepEqual(ball.goto, { x: 1000, y: 2000, z: 3000 + -1 * 1.0e17 });
  park.stop(ball.id);
  assert.equal(ball.mode, MODE.STOP);
});

test("adding a ball: where it was a tick ago is worked out, and a ball added again is the same ball reset", () => {
  const park = new Ballpark();
  const ball = park.addBall({ id: 7, x: 100, y: 200, z: 300, vx: 1, vy: 2, vz: 3, isFree: true, mass: 5, agility: -1, radius: -3, maxVelocity: -1, speedFraction: -1 });
  assert.deepEqual(ball.oldPos, { x: 99, y: 198, z: 297 });
  assert.deepEqual(ball.oldVel, { x: 1, y: 2, z: 3 });
  assert.deepEqual([ball.mode, ball.agility, ball.radius, ball.maxVelocity, ball.speedFraction], [MODE.STOP, 1, 0, 0, 0], "bad values fall to destiny's floors");
  assert.equal(park.freeBalls.has(7), true);

  park.gotoPoint(7, 1, 1, 1);
  ball.followRange = 99;
  const again = park.addBall({ id: 7, x: 5, y: 5, z: 5 });
  assert.equal(again, ball, "the same ball");
  assert.deepEqual(again.oldPos, { x: 99, y: 198, z: 297 }, "its past is left as it was");
  assert.deepEqual([again.mode, again.followRange, again.isFree], [MODE.STOP, 10, false]);
  assert.equal(park.freeBalls.has(7), false, "no longer free, no longer stepped");
  park.evolve();
  assert.deepEqual(again.newPos, { x: 5, y: 5, z: 5 });
});

test("a ball made unfree is stopped dead and no longer stepped; made free again it moves", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  park.gotoDirection(ball.id, 1, 0, 0);
  park.evolve();
  assert.ok(ball.newPos.x > 0);
  park.setBallFree(ball.id, false);
  assert.deepEqual([ball.mode, ball.newVel, ball.oldVel, ball.lastG], [MODE.STOP, vec(), vec(), vec()]);
  const where = { ...ball.newPos };
  park.evolve();
  assert.deepEqual(ball.newPos, where);
  park.setBallFree(ball.id, false); // again: nothing to do
  park.setBallFree(ball.id, true);
  park.gotoDirection(ball.id, 1, 0, 0);
  park.evolve();
  assert.ok(ball.newPos.x > where.x);
});

test("every ball is stepped from the same picture, in id order, and all move together", () => {
  const park = new Ballpark();
  const far = spaceBall(park, { id: 20, x: 1e6 });
  const near = spaceBall(park, { id: 3 });
  park.gotoDirection(20, 1, 0, 0);
  park.gotoDirection(3, 0, 1, 0);
  park.evolve();
  // Each is where it would be alone: neither's step saw the other's new position.
  const alone = new Ballpark();
  const single = spaceBall(alone, { id: 3 });
  alone.gotoDirection(3, 0, 1, 0);
  alone.evolve();
  assert.deepEqual(near.newPos, single.newPos);
  assert.deepEqual(near.oldPos, vec(0, 0, 0), "and where it was is kept");
  assert.ok(far.newPos.x > 1e6);
  assert.equal(park.currentTime, 1);
});

test("a partial step uses its own time factor, and no time at all changes nothing", () => {
  const park = new Ballpark();
  const p = vec(1, 2, 3);
  const v = vec(4, 5, 6);
  const still = park.integrate(p, v, vec(1, 1, 1), 1e7, 1e6, 0.5, 0.0);
  assert.equal(still.p, p);
  assert.equal(still.v, v);
  // Half a tick: the cached factor is ignored and exp(-k/m*t) used.
  const half = park.integrate(p, v, vec(), 1e7, 1e6, 123, 0.5);
  const factor = Math.exp((-1e6 / 1e7) * 0.5);
  assert.equal(half.v.x, (0 - (0 - 4 * 1e6) * factor) * (1 / 1e6));
  // A whole tick uses the factor it is given.
  const whole = park.integrate(p, v, vec(), 1e7, 1e6, 0.25, 1.0);
  assert.equal(whole.v.x, (0 - (0 - 4 * 1e6) * 0.25) * (1 / 1e6));
});

test("a ball with no friction to speak of takes the series form of the step", () => {
  const park = new Ballpark({ friction: 1e-9 });
  // k < 1e-10 * m * t
  const { p, v } = park.integrate(vec(0, 0, 0), vec(10, 0, 0), vec(), 1e6, 1e-9, 1.0, 1.0);
  assert.ok(Math.abs(p.x - 10) < 1e-6, `it coasts: ${p.x}`);
  assert.ok(Math.abs(v.x - 10) < 1e-9);
});

test("what is not ported yet stops the step by name instead of being guessed at", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  ball.mode = MODE.FORMATION;
  assert.throws(() => park.evolve(), (error) => error instanceof DestinyNotPorted && /mode is not ported/.test(error.message));
  // Modes that have no thrust coast like any other ball.
  ball.mode = MODE.TROLL;
  park.setBallVelocity(ball.id, 5, 0, 0);
  park.evolve();
  assert.ok(ball.newPos.x > 0 && ball.newVel.x < 5);
  // A massive ball's neighbours are looked at each tick; one that is not massive collides with nothing.
  assert.equal(park.gradients, 1);
  park.setBallMassive(ball.id, false);
  park.evolve();
  assert.equal(park.gradients, 1);
  assert.deepEqual(park.unported, { minis: 0, collisionOrder: 0, orientation: 0 });
});

test("a moribund ball is not stepped", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  park.setBallVelocity(ball.id, 5, 0, 0);
  ball.isMoribund = true;
  park.evolve();
  assert.deepEqual(ball.newPos, vec(0, 0, 0));
});

// ── found by breaking the code: each of these let a wrong version through ────

test("a ball added with float fields has them rounded to float32, as AddBall's float parameters do", () => {
  const park = new Ballpark();
  const ball = park.addBall({ id: 1, isFree: true, mass: 1157000, agility: 4.35, radius: 38.4, maxVelocity: 341.7, speedFraction: 0.95 });
  assert.deepEqual([ball.agility, ball.radius, ball.maxVelocity, ball.speedFraction], [Math.fround(4.35), Math.fround(38.4), Math.fround(341.7), Math.fround(0.95)]);
  assert.equal(ball.timeFactor, Math.exp((-1000000.0 * 1.0) / (1157000 * Math.fround(4.35))));
});

test("the time factor is exp((-k*dt)/m), in that order, which shows when a tick is not one second", () => {
  const park = new Ballpark({ tickInterval: 300 });
  const ball = park.addBall({ id: 1, isFree: true, mass: 1200000, agility: 3.1 });
  const m = 1200000 * Math.fround(3.1);
  assert.equal(park.dt, 300 * 0.001);
  assert.equal(ball.timeFactor, Math.exp((-1000000.0 * park.dt) / m));
  assert.notEqual(ball.timeFactor, Math.exp(-1000000.0 * (park.dt / m)), "the other grouping differs in the last place here");
});

test("thrust is ((k*sf)*maxVel)/(mass*agility), in that order", () => {
  const park = new Ballpark();
  const ball = park.addBall({ id: 1, isFree: true, mass: 1157000, agility: 0.9, maxVelocity: 341, speedFraction: 1 });
  const thrust = park.gotoThrust(ball, { x: 1e9, y: 0, z: 0 });
  const expected = (1000000.0 * 1 * 341) / (1157000 * Math.fround(0.9));
  assert.deepEqual(thrust, { x: 1 * expected, y: 0 * expected, z: 0 * expected });
  assert.notEqual(expected, 1000000.0 * 1 * (341 / (1157000 * Math.fround(0.9))), "the other grouping differs in the last place here");
  // A missile never eases off, however close.
  ball.newPos = { x: 0, y: 0, z: 0 };
  const close = { x: 1, y: 0, z: 0 };
  assert.equal(park.gotoThrust(ball, close, true).x, expected);
  assert.ok(park.gotoThrust(ball, close, false).x < expected * 1e-6);
});

test("putting a ball somewhere, or giving it a velocity, rewrites its past as well", () => {
  const park = new Ballpark();
  const ball = spaceBall(park, { x: 5, y: 5, z: 5, vx: 1 });
  park.setBallPosition(ball.id, 100, 200, 300);
  assert.deepEqual([ball.newPos, ball.oldPos], [vec(100, 200, 300), vec(100, 200, 300)]);
  park.setBallVelocity(ball.id, 7, 8, 9);
  assert.deepEqual([ball.newVel, ball.oldVel], [vec(7, 8, 9), vec(7, 8, 9)]);
});

test("telling a ball it is what it already is changes nothing", () => {
  const park = new Ballpark();
  const fixed = park.addBall({ id: 1, vx: 3 });
  park.setBallFree(1, false);
  assert.deepEqual(fixed.newVel, vec(3, 0, 0), "an unfree ball told to be unfree is not stopped again");
  const free = spaceBall(park, { id: 2 });
  park.gotoDirection(2, 1, 0, 0);
  park.setBallFree(2, true);
  assert.equal(free.mode, MODE.GOTO);
});

test("an order to go somewhere lets go of the ball that was being followed", () => {
  const park = new Ballpark();
  const leader = spaceBall(park, { id: 1 });
  const follower = spaceBall(park, { id: 2 });
  // Following is not ported; set the state a follow leaves, as the reader of a state blob does.
  Object.assign(follower, { mode: MODE.FOLLOW, followId: 1, followPtr: leader, followRange: 500, effectStamp: 9, ownerId: 4 });
  leader.followers.add(2);
  park.gotoPoint(2, 10, 0, 0);
  assert.equal(leader.followers.has(2), false);
  assert.deepEqual([follower.mode, follower.followId, follower.followPtr, follower.followRange, follower.effectStamp, follower.ownerId], [MODE.GOTO, 0, null, 0, 0, 0]);
  // A follower whose leader is no longer the ball it holds does not touch that ball's list.
  const other = spaceBall(park, { id: 3 });
  Object.assign(follower, { mode: MODE.ORBIT, followId: 3, followPtr: leader });
  leader.followers.add(2);
  other.followers.add(2);
  park.stop(2);
  assert.deepEqual([leader.followers.has(2), other.followers.has(2), follower.mode], [true, true, MODE.STOP]);
});

// Committing each ball as it is stepped, instead of all together, is told
// apart by collisions alone: they are worked out during the stepping pass,
// from where the neighbours still are.
test("a ball's collisions are worked out from where its neighbours were, not where they have just been moved to", () => {
  // Two alike, overlapping, at rest: each is pushed by where the other was, so they part by the same amount.
  const park = new Ballpark();
  const a = spaceBall(park, { id: 1, y: 1.9 });
  const b = spaceBall(park, { id: 2 });
  park.evolve();
  assert.ok(Math.abs(a.newPos.y - 1.9 + b.newPos.y) < 1e-12, "the second was pushed from where the first had been");
  assert.deepEqual([a.newPos.x, a.newPos.z, b.newPos.x, b.newPos.z], [0, 0, 0, 0]);
});

// ── CCP's collision fixtures (test_simple_collision.py) ──────────────────────

/** Evolve `ticks` times, reading both balls' positions after each. */
function runTwo(park, a, b, ticks) {
  const rows = { a: [], b: [] };
  for (let tick = 0; tick < ticks; tick += 1) {
    park.evolve();
    rows.a.push([a.newPos.x, a.newPos.y, a.newPos.z]);
    rows.b.push([b.newPos.x, b.newPos.y, b.newPos.z]);
  }
  return rows;
}

test("CCP test_stopped_balls_with_same_location: two balls at one point are pushed apart along x, to the last digit", () => {
  const park = new Ballpark();
  const a = spaceBall(park, { id: 1 });
  const b = spaceBall(park, { id: 2 });
  const rows = runTwo(park, a, b, 10);
  const x = [1.121144335565424, 3.2401005010556143, 5.185473058408457, 6.9714818718687654, 8.61118192299853, 10.116558737162107, 11.498615992731432, 12.76745595339809, 13.93235331151902, 15.001822982259961];
  // The lower id goes up the axis, the higher down it.
  assert.deepEqual(rows.a, x.map((each) => [each, 0, 0]));
  assert.deepEqual(rows.b, x.map((each) => [-each, 0, 0]));
});

test("CCP test_stopped_balls_intersecting: two overlapping balls are pushed clear along the line between them", () => {
  const park = new Ballpark();
  const a = spaceBall(park, { id: 1, y: 1.9 });
  const b = spaceBall(park, { id: 2 });
  const rows = runTwo(park, a, b, 10);
  assert.deepEqual(rows.a.map(([, y]) => y), [2.5951094880505643, 3.736969417977334, 4.648125579572035, 5.375189844683108, 5.955356525086511, 6.418305116018683, 6.787718605426691, 7.082495020842102, 7.317714192790605, 7.505409191300473]);
  assert.deepEqual(rows.b.map(([, y]) => y), [-0.6951094880505645, -1.836969417977334, -2.7481255795720347, -3.4751898446831078, -4.055356525086512, -4.5183051160186825, -4.8877186054266915, -5.182495020842103, -5.417714192790607, -5.605409191300473]);
  assert.ok([...rows.a, ...rows.b].every(([x, , z]) => x === 0 && z === 0));
});

test("CCP test_goto_collision: two balls sent at each other meet, bounce, and close again, twenty ticks to the last digit", () => {
  const park = new Ballpark();
  const a = spaceBall(park, { id: 1 });
  const b = spaceBall(park, { id: 2, x: 10, y: 10, z: 10 });
  park.gotoPoint(1, 10, 10, 10);
  park.gotoPoint(2, 0, 0, 0);
  const rows = runTwo(park, a, b, 20);
  const expectedA = [0.22785672701553972, 0.8863613208951594, 1.9402353687182086, 3.3570904438241858, 3.745389410116848, 3.2276392358401793, 3.2016165950513056, 3.627039465463305, 3.8640182292625984, 3.9449236847646176,
    4.014836947038442, 4.087400730922078, 4.152795682608074, 4.2242631173879985, 4.289057014884843, 4.360366727534607, 4.425074016382081, 4.496360773851808, 4.561055454563248, 4.624809527703686];
  const expectedB = [9.772143272984462, 9.113638679104842, 8.059764631281793, 6.642909556175815, 6.254610589883153, 6.772360764159822, 6.7983834049486935, 6.372960534536694, 6.1359817707374, 6.055076315235381,
    5.985163052961557, 5.912599269077921, 5.847204317391924, 5.775736882612, 5.710942985115155, 5.639633272465392, 5.574925983617919, 5.503639226148192, 5.438944545436752, 5.375190472296313];
  assert.deepEqual(rows.a, expectedA.map((each) => [each, each, each]));
  assert.deepEqual(rows.b, expectedB.map((each) => [each, each, each]));
});

test("CCP test_balls_in_warp_should_not_collide: two balls warping through each other pass", () => {
  const park = new Ballpark();
  const a = spaceBall(park, { id: 1, x: -4, vx: 1000.0, maxVelocity: 1000.0, mass: 1.0 });
  const b = spaceBall(park, { id: 2, x: 4, vx: -1000.0, maxVelocity: 1000.0, mass: 1.0 });
  park.warpTo(1, 100000.0, 0, 0);
  park.warpTo(2, -100000.0, 0, 0);
  for (let tick = 0; tick < 80; tick += 1) park.evolve();
  assert.ok(a.newPos.x > b.newPos.x);
  assert.deepEqual([a.newPos.y, a.newPos.z, b.newPos.y, b.newPos.z], [0, 0, 0, 0]);
});

// ── FOLLOW and ORBIT, beyond the fixtures ────────────────────────────────────

test("an order to follow or orbit is refused for what cannot be followed, and otherwise hooks the two together", () => {
  const park = new Ballpark();
  const a = spaceBall(park, { id: 1 });
  const b = spaceBall(park, { id: 2, x: 1000 });
  for (const refuse of [
    () => park.followBall(1, 1), // itself
    () => park.followBall(1, 99), // nothing there
    () => park.followBall(99, 2),
    () => park.followBall(1, 2, NaN),
    () => { b.isMoribund = true; park.orbit(1, 2); b.isMoribund = false; },
    () => { b.isCloaked = 1; park.followBall(1, 2); b.isCloaked = 0; },
  ]) {
    refuse();
    assert.deepEqual([a.mode, a.followId, a.followPtr, b.followers.size], [MODE.STOP, 0, null, 0]);
  }
  park.followBall(1, 2, 2500.4);
  assert.deepEqual([a.mode, a.followId, a.followPtr === b, a.followRange, [...b.followers]], [MODE.FOLLOW, 2, true, Math.fround(2500.4), [1]]);
  // A new order lets go of the old leader first.
  const c = spaceBall(park, { id: 3, y: 1000 });
  park.orbit(1, 3);
  assert.deepEqual([a.mode, a.followId, a.followRange, [...b.followers], [...c.followers]], [MODE.ORBIT, 3, 1, [], [1]]);
});

test("a follower keeps its range surface to surface, and steers out along x when it sits on its leader", () => {
  const park = new Ballpark();
  const follower = spaceBall(park, { id: 1 });
  const leader = spaceBall(park, { id: 2, x: 1000 });
  park.followBall(1, 2, 100);
  park.evolve();
  // The goto point: on the line between them, 100 + 2 + 2 metres short of the leader's centre.
  assert.deepEqual(follower.goto, { x: 1000 + -1000 * 104 * (1 / 1000), y: 0, z: 0 });
  park.setBallPosition(1, 1000, 0, 0);
  park.evolve();
  assert.deepEqual(follower.goto, { x: 1000 + 104, y: 0, z: 0 });
  assert.equal(leader.newPos.x, 1000);
});

test("an orbiter's plane turns with the tick counter and differs with its id", () => {
  const first = (id, tick) => {
    const park = new Ballpark();
    spaceBall(park, { id: 1 });
    // Off every axis, so that the plane is not decided by a sign alone.
    const orbiter = spaceBall(park, { id, x: 5000, y: 3000, z: 1000 });
    park.currentTime = tick;
    park.orbit(id, 1, 1000);
    park.evolve();
    return orbiter.newPos;
  };
  assert.notDeepEqual(first(2, 0), first(3, 0), "another id, another plane");
  assert.notDeepEqual(first(2, 0), first(2, 500), "a later tick, a turned plane");
  // Only the low sixteen bits of the id count.
  assert.deepEqual(first(2, 0), first(2 + 65536, 0));
  assert.deepEqual(first(2, 0), first(9988400103291 - (9988400103291 % 65536) + 2, 0));
});

test("inside its orbit a ball thrusts outward, outside it inward along the tangent", () => {
  const radial = (x) => {
    const park = new Ballpark();
    spaceBall(park, { id: 1 });
    const orbiter = spaceBall(park, { id: 2, x });
    park.orbit(2, 1, 1000); // the orbit is at 1004 m between centres
    park.evolve();
    return orbiter.lastG.x;
  };
  assert.ok(radial(5000) < 0, "outside: drawn in");
  assert.ok(radial(200) > 0, "inside: pushed out");
});

test("the follow point is (delta * r) * (1/dist), in that order", () => {
  const park = new Ballpark();
  const follower = spaceBall(park, { id: 1 });
  spaceBall(park, { id: 2, x: 1234.5 });
  park.followBall(1, 2, 2500);
  park.evolve();
  const r = 2500 + 2 + 2;
  assert.equal(follower.goto.x, 1234.5 + -1234.5 * r * (1 / 1234.5));
  assert.notEqual(follower.goto.x, 1234.5 + -1234.5 * (r / 1234.5), "the other grouping differs in the last place here");
});

test("one orbit step, set beside the source's lines written out again", () => {
  // Orbitee 1 at the origin, orbiter 2 at 5000 m on the x axis, tick 0, range 1000.
  const park = new Ballpark();
  spaceBall(park, { id: 1 });
  const orbiter = spaceBall(park, { id: 2, x: 5000 });
  park.orbit(2, 1, 1000);
  park.evolve();

  // EvolveOldStyleOrbit, line by line, for this case.
  const cut = (x) => Math.trunc(x * 10000000) / 10000000;
  const [sf, maxVel, mass, agility] = [Math.fround(0.95), 10, 13000000.0, Math.fround(0.9)];
  const maxThrust = (1000000.0 * (sf * maxVel)) / (mass * agility);
  const r = 1000 + 2 + 2;
  const dist = 5000;
  const toVector = [-1, 0, 0];
  // phi1 = 0, phi2 = 2: radial = (cos 2, sin 2, 0) cut, then crossed with toVector and made unit.
  const radialCut = [cut(Math.cos(0) * Math.cos(2)), cut(Math.sin(2)), cut(Math.sin(0) * Math.cos(2))];
  const crossed = [radialCut[1] * toVector[2] - radialCut[2] * toVector[1], radialCut[2] * toVector[0] - radialCut[0] * toVector[2], radialCut[0] * toVector[1] - radialCut[1] * toVector[0]];
  const crossedLength = 1.0 / Math.sqrt(crossed[0] * crossed[0] + crossed[1] * crossed[1] + crossed[2] * crossed[2]);
  const radial = crossed.map((c) => c * crossedLength);
  assert.deepEqual(radial, [0, 0, 1], "for this geometry the tangent is straight up the z axis");
  const toComp = dist * dist - r * r;
  const radComp = (r * Math.sqrt(toComp)) / dist;
  assert.notEqual(radComp, r * (Math.sqrt(toComp) / dist), "the other grouping differs in the last place here");
  const aim = toVector.map((c, i) => c * (toComp / dist) + radial[i] * radComp);
  const aimLength = 1.0 / Math.sqrt(aim[0] * aim[0] + aim[1] * aim[1] + aim[2] * aim[2]);
  const to = aim.map((c) => c * aimLength);
  const radialFactor = cut(Math.exp((-(r - dist) * (r - dist)) / 40000.0));
  const phi = -(to[0] * radial[0] + to[1] * radial[1] + to[2] * radial[2]);
  let transverse = 1.0 + radialFactor * radialFactor * (phi * phi - 1.0);
  transverse = transverse > 0.0 ? radialFactor * phi + Math.sqrt(transverse) : radialFactor * phi;
  transverse *= dist - r >= 0.0 ? 1.0 : -1.0;
  const a = to.map((c, i) => (radial[i] * radialFactor + c * transverse) * maxThrust);

  assert.deepEqual(orbiter.lastG, { x: a[0], y: a[1], z: a[2] });
  // It also leaves a goto point ten AU along that acceleration, for whoever reads the ball's heading.
  assert.deepEqual(orbiter.goto, { x: 5000 + a[0] * (10.0 * 0.1495978707e12), y: 0 + a[1] * (10.0 * 0.1495978707e12), z: 0 + a[2] * (10.0 * 0.1495978707e12) });
  // Far outside the orbit almost none of the thrust goes sideways: it flies at the tangent point.
  assert.ok(radialFactor < 1e-6 && a[0] < 0 && a[2] > 0);
});

// ── a state read into the park, and written out of it ────────────────────────

const recording = require("./fixtures/destinyUndock.json");
const { stateBlobs } = require("./helpers/destinyRecording");
const { FLAG, PACKET, readState: readRecords, writeState: writeRecords } = require("../src/gamePort/destiny/state");
const { DSTLOCALBALLS } = require("../src/gamePort/destiny/ballpark");

/** A blob of records, for the cases the recording does not hold. */
const blobOf = (balls, { packet = PACKET.BALLS, stamp = 500 } = {}) => writeRecords({ packet, stamp, balls });
const record = (fields) => ({
  mode: MODE.STOP, radius: 10, position: vec(), flags: FLAG.FREE, mass: 1000, isCloaked: 0, harmonic: -1, corporationID: -1, allianceID: -1,
  maxVelocity: 100, velocity: vec(), agility: 1, speedFraction: 1, formationID: -1, ...fields,
});

test("the recorded states read into a park and come back out as the server's own bytes", () => {
  const [ship, grid, later] = stateBlobs(recording);
  const park = new Ballpark();

  // The ship alone, as an addition: the park's clock becomes the blob's stamp.
  park.readState(ship.blob, 2);
  assert.equal(park.currentTime, ship.stamp);
  assert.equal(park.balls.size, 1);
  assert.ok(park.writeState([recording.shipID]).equals(ship.blob));

  // The grid's state: the client clears the park, then reads.
  park.clearAll();
  park.readState(grid.blob, 0);
  assert.equal(park.currentTime, grid.stamp);
  assert.equal(park.balls.size, 76);
  assert.deepEqual([...park.freeBalls.keys()], [recording.shipID], "one ball is stepped: the ship");
  assert.ok(park.writeState().equals(grid.blob), "all 3,054 bytes");

  // What is added after joins it.
  const added = park.readState(later.blob, 2);
  assert.equal(park.currentTime, later.stamp);
  assert.equal(park.balls.size, 95);
  assert.equal(park.freeBalls.size, 17);
  assert.ok(park.writeState(added.map((ball) => ball.id)).equals(later.blob), "all 1,747 bytes");
});

test("the ship as the state gives it: flying at its goto point, ready to step", () => {
  const [, grid] = stateBlobs(recording);
  const park = new Ballpark();
  park.readState(grid.blob, 0);
  const ship = park.ball(recording.shipID);
  assert.deepEqual([ship.mode, ship.isFree, ship.isInteractive, ship.isMassive, ship.maxVelocity, ship.mass], [MODE.GOTO, true, true, false, 341, 1157000]);
  assert.equal(ship.timeFactor, Math.exp((-1000000.0 * 1.0) / (1157000 * Math.fround(4.35))));
  // Where it was a tick ago is worked out from its velocity, since the blob does not say.
  assert.deepEqual(ship.oldPos, { x: ship.newPos.x - 1.0 * ship.newVel.x, y: ship.newPos.y - 1.0 * ship.newVel.y, z: ship.newPos.z - 1.0 * ship.newVel.z });
  // A tick on, it has moved along its velocity at about its speed, and nothing else has moved at all.
  const before = { ...ship.newPos };
  const station = { ...park.ball(recording.stationID).newPos };
  park.evolve();
  const moved = Math.hypot(ship.newPos.x - before.x, ship.newPos.y - before.y, ship.newPos.z - before.z);
  // It left the station at its top speed, 341 m/s, and holds it. This far from the sun a
  // coordinate is only good to about a tenth of a millimetre, hence the margin.
  assert.ok(Math.abs(moved - 341) < 1e-3, `it moved ${moved} m`);
  assert.deepEqual(park.ball(recording.stationID).newPos, station);
  assert.equal(park.currentTime, grid.stamp + 1);
  assert.equal(park.gradients, 0, "the ship is not massive while it leaves the station");
});

test("a follower read from a state is hooked to its leader once every ball is in, whatever the order", () => {
  const park = new Ballpark();
  park.readState(blobOf([
    record({ id: 2, mode: MODE.ORBIT, followId: 1, followRange: 5000 }),
    record({ id: 3, mode: MODE.FOLLOW, followId: 99, followRange: 100 }),
    record({ id: 1, mode: MODE.STOP }),
  ]));
  const [leader, orbiter, lost] = [park.ball(1), park.ball(2), park.ball(3)];
  assert.deepEqual([orbiter.mode, orbiter.followPtr === leader, orbiter.followRange, [...leader.followers]], [MODE.ORBIT, true, 5000, [2]]);
  // A leader that is not in the park: the follower is left flying at whatever point it had.
  assert.deepEqual([lost.mode, lost.followPtr, lost.goto], [MODE.GOTO, null, vec()]);
  park.evolve(); // and it can be stepped
});

test("a read sets fields without giving orders, and resets a ball it already knew", () => {
  const park = new Ballpark();
  const ball = spaceBall(park, { id: 7 });
  park.gotoPoint(7, 1, 2, 3);
  Object.assign(ball, { effectStamp: 55, ownerId: 9 });
  park.readState(blobOf([record({ id: 7, mode: MODE.TROLL, effectStamp: 600, isCloaked: 1, harmonic: 12, corporationID: 98000001, allianceID: 99000001, formationID: 2, position: vec(5, 6, 7), velocity: vec(1, 0, 0) })]), 2);
  assert.equal(park.ball(7), ball, "the same ball");
  assert.deepEqual(
    [ball.mode, ball.effectStamp, ball.ownerId, ball.isCloaked, ball.harmonic, ball.corporationID, ball.allianceID, ball.formationID, ball.newPos, ball.newVel],
    [MODE.TROLL, 600, 0, 1, 12, 98000001, 99000001, 2, vec(5, 6, 7), vec(1, 0, 0)],
  );
  assert.equal(park.currentTime, 500);
});

test("a warping ball keeps its warp across a read and a write", () => {
  const warp = record({ id: 4, mode: MODE.WARP, goto: vec(1e12, 2e12, 3e12), effectStamp: -1, totalWarpLength: 4.5e12, minRange: 15000, warpFactor: 3 });
  const park = new Ballpark();
  park.readState(blobOf([warp]), 2);
  const ball = park.ball(4);
  assert.deepEqual([ball.goto, ball.effectStamp, ball.lastCollision, ball.warpMinRange, ball.ownerId], [vec(1e12, 2e12, 3e12), -1, 4.5e12, 15000, 3]);
  assert.ok(park.writeState([4]).equals(blobOf([warp])));
});

test("a full read empties the list of balls that are stepped and removes nothing; an addition keeps the list", () => {
  const park = new Ballpark();
  const old = spaceBall(park, { id: 1 });
  park.readState(blobOf([record({ id: 2 })], { packet: PACKET.FULL_STATE }), 0);
  assert.equal(park.ball(1), old, "still in the park");
  assert.deepEqual([...park.freeBalls.keys()], [2], "but no longer stepped");
  park.readState(blobOf([record({ id: 3 })]), 2);
  assert.deepEqual([...park.freeBalls.keys()].sort(), [2, 3]);
  assert.deepEqual(park.readState(Buffer.alloc(0)), [], "no bytes, no change");
  assert.equal(park.currentTime, 500);
});

test("a fixed ball's collision shapes come from the record, except on a rewind, which leaves them", () => {
  const shapes = { miniBalls: [{ center: vec(1, 2, 3), radius: 4 }], miniCapsules: [], miniBoxes: [] };
  const fixed = (extra = {}) => record({ id: 1, mode: MODE.RIGID, flags: FLAG.GLOBAL, ...extra });
  const park = new Ballpark();
  park.readState(blobOf([fixed(shapes)]), 2);
  assert.deepEqual(park.ball(1).miniBalls, shapes.miniBalls);
  park.readState(blobOf([fixed()]), 1);
  assert.deepEqual(park.ball(1).miniBalls, shapes.miniBalls, "a rewind leaves them");
  park.readState(blobOf([fixed()]), 2);
  assert.deepEqual(park.ball(1).miniBalls, [], "an addition replaces them");
});

test("a state written by the park leaves out the dead and, when it is the whole park, the client's own balls", () => {
  const park = new Ballpark();
  spaceBall(park, { id: 1 });
  spaceBall(park, { id: 2 });
  spaceBall(park, { id: DSTLOCALBALLS - 1 });
  park.currentTime = 42;
  park.removeBall(2, 5);
  const ids = (bytes) => readRecords(bytes).balls.map((ball) => ball.id);
  const full = park.writeState();
  assert.deepEqual([full[0], full.readInt32LE(1), ids(full)], [PACKET.FULL_STATE, 42, [1]]);
  // Asked for by id, a local ball is written; a dead one still is not.
  const some = park.writeState([DSTLOCALBALLS - 1, 2, 999]);
  assert.deepEqual([some[0], ids(some)], [PACKET.BALLS, [DSTLOCALBALLS - 1]]);
});

// ── removing ─────────────────────────────────────────────────────────────────

test("a ball removed at once is gone; one removed with a delay stops taking part and goes when its time is up", () => {
  const park = new Ballpark();
  spaceBall(park, { id: 1 });
  const dying = spaceBall(park, { id: 2 });
  park.setBallVelocity(2, 5, 0, 0);
  park.currentTime = 100;
  park.removeBall(1);
  assert.deepEqual([park.ball(1), park.freeBalls.has(1)], [null, false]);
  park.removeBall(99); // nothing there

  park.removeBall(2, 5);
  assert.deepEqual([dying.isMoribund, dying.isMassive, dying.effectStamp, dying.mode, park.ball(2) === dying], [true, false, 105, MODE.STOP, true]);
  const where = { ...dying.newPos };
  park.evolve();
  assert.deepEqual(dying.newPos, where, "not stepped");
  // Not yet: more than two ticks to go.
  park.bringOutDeadBalls();
  assert.equal(park.ball(2), dying);
  // Two whole ticks to go is still too soon; within two, it may go early.
  park.currentTime = 103;
  park.bringOutDeadBalls();
  assert.equal(park.ball(2), dying);
  park.currentTime = 104;
  park.bringOutDeadBalls();
  assert.equal(park.ball(2), null);
  assert.equal(park.moribundBalls.size, 0);
});

test("only seven go early in one call; the rest wait for their time to pass", () => {
  const park = new Ballpark();
  for (let id = 1; id <= 10; id += 1) {
    spaceBall(park, { id });
    park.removeBall(id, 3);
  }
  park.currentTime = 2; // one tick to go: within the buffer of two
  park.bringOutDeadBalls();
  assert.equal(park.balls.size, 3);
  park.bringOutDeadBalls();
  assert.equal(park.balls.size, 0);
  // Past its time, a ball goes whatever the count.
  for (let id = 1; id <= 10; id += 1) {
    spaceBall(park, { id });
    park.removeBall(id, 1);
  }
  park.currentTime = 10;
  park.bringOutDeadBalls();
  assert.equal(park.balls.size, 0);
});

test("when a ball goes, its followers stop, except a missile or an interactive orbiter, which fly on", () => {
  const park = new Ballpark();
  const leader = spaceBall(park, { id: 1 });
  const follower = spaceBall(park, { id: 2, x: 100 });
  const orbiter = spaceBall(park, { id: 3, x: 200 });
  const dull = spaceBall(park, { id: 4, x: 300 });
  park.followBall(2, 1);
  park.orbit(3, 1);
  park.orbit(4, 1);
  orbiter.isInteractive = true;
  park.setBallVelocity(3, 0, 7, 0);
  // A follower the leader lists but that no longer follows it is only struck off.
  leader.followers.add(77);
  park.removeBall(1);
  assert.deepEqual([follower.mode, follower.followPtr, follower.followId], [MODE.STOP, null, 0]);
  assert.equal(dull.mode, MODE.STOP, "an orbiter that is not interactive stops");
  assert.equal(orbiter.mode, MODE.GOTO, "an interactive one flies on the way it was going");
  assert.deepEqual(orbiter.goto, { x: 200 + 0 * 1.0e17, y: 0 + 1 * 1.0e17, z: 0 + 0 * 1.0e17 });
  assert.equal(leader.followers.size, 0);
});

test("a ball that goes lets go of its own leader first", () => {
  const park = new Ballpark();
  const leader = spaceBall(park, { id: 1 });
  const follower = spaceBall(park, { id: 2, x: 100 });
  park.followBall(2, 1);
  park.removeBall(2, 5);
  assert.deepEqual([[...leader.followers], follower.mode, follower.followPtr, follower.followId], [[], MODE.STOP, null, 0]);
});

test("a missile whose target goes flies on, and stops being massive", () => {
  const park = new Ballpark();
  spaceBall(park, { id: 1 });
  const missile = spaceBall(park, { id: 2, x: 100 });
  Object.assign(missile, { mode: MODE.MISSILE, followId: 1, followPtr: park.ball(1), isMassive: true });
  park.ball(1).followers.add(2);
  park.setBallVelocity(2, -3, 0, 0);
  park.removeBall(1);
  assert.deepEqual([missile.mode, missile.isMassive, missile.goto.x < -1e16], [MODE.GOTO, false, true]);
});

test("clearing the park leaves nothing", () => {
  const park = new Ballpark();
  spaceBall(park, { id: 1 });
  spaceBall(park, { id: 2 });
  park.removeBall(2, 9);
  park.clearAll();
  assert.deepEqual([park.balls.size, park.freeBalls.size, park.moribundBalls.size], [0, 0, 0]);
});

// ── the small setters, and the balls that are not ships ──────────────────────

test("global and interactive are plain flags", () => {
  const park = new Ballpark();
  const ball = spaceBall(park, { id: 1 });
  park.setBallGlobal(1, 1);
  park.setBallInteractive(1, 1);
  assert.deepEqual([ball.isGlobal, ball.isInteractive], [true, true]);
  park.setBallGlobal(1, 0);
  park.setBallInteractive(1, 0);
  assert.deepEqual([ball.isGlobal, ball.isInteractive], [false, false]);
  park.setBallGlobal(404, 1); // a ball that is not there is nothing
  park.setBallInteractive(404, 1);
});

test("a ball made a field lets go of what it followed and stays put as one; unmade, it is stopped", () => {
  const park = new Ballpark();
  const leader = spaceBall(park, { id: 1 });
  const tower = spaceBall(park, { id: 2, x: 5000 });
  park.orbit(2, 1, 1000);
  park.setBallHarmonic(2, 77, 98000001, 99000001, 1);
  assert.deepEqual([tower.mode, tower.harmonic, tower.corporationID, tower.allianceID, tower.followId, [...leader.followers]], [MODE.FIELD, 77, 98000001, 99000001, 0, []]);
  // Only the numbers change while it stays a field.
  park.setBallHarmonic(2, 78, 98000002, 99000002, 1);
  assert.deepEqual([tower.mode, tower.harmonic, tower.corporationID, tower.allianceID], [MODE.FIELD, 78, 98000002, 99000002]);
  park.setBallHarmonic(2, -1, -1, -1, 0);
  assert.deepEqual([tower.mode, tower.harmonic], [MODE.STOP, -1]);
  // A ball that was never a field keeps doing what it was doing.
  park.orbit(2, 1, 1000);
  park.setBallHarmonic(2, 5, 1, 2, 0);
  assert.deepEqual([tower.mode, tower.harmonic, tower.followId], [MODE.ORBIT, 5, 1]);
});

test("a ball made rigid lets go of what it followed", () => {
  const park = new Ballpark();
  const leader = spaceBall(park, { id: 1 });
  const ball = spaceBall(park, { id: 2, x: 5000 });
  park.followBall(2, 1, 100);
  park.setBallRigid(2);
  assert.deepEqual([ball.mode, ball.followId, [...leader.followers]], [MODE.RIGID, 0, []]);
});

test("a troll is made free and interactive, given at least a tick, and petrified when its stamp is no longer ahead", () => {
  const park = new Ballpark();
  const leader = spaceBall(park, { id: 1 });
  park.addBall({ id: 2, x: 5000 }); // fixed, as a wreck's ball arrives
  park.addBall({ id: 3, x: 9000 });
  const wreck = park.ball(2);
  park.currentTime = 40;
  park.setBallTroll(2, 0);
  assert.deepEqual([wreck.mode, wreck.effectStamp, wreck.isFree, wreck.isInteractive, park.freeBalls.has(2)], [MODE.TROLL, 41, true, true, true], "no delay is one tick");
  park.setBallTroll(3, 2);
  assert.equal(park.ball(3).effectStamp, 42);
  park.evolve(); // the step taken at 40: 41 is still ahead
  assert.deepEqual([wreck.mode, park.ball(3).mode], [MODE.TROLL, MODE.TROLL]);
  park.evolve(); // at 41: no longer ahead
  assert.deepEqual([wreck.mode, wreck.isFree, wreck.isInteractive, park.freeBalls.has(2), park.ball(3).mode], [MODE.RIGID, false, false, false, MODE.TROLL]);
  park.evolve();
  assert.equal(park.ball(3).mode, MODE.RIGID);
  // A ball that was following something lets go when it is made a troll.
  const drone = spaceBall(park, { id: 4, x: 100 });
  park.followBall(4, 1, 50);
  park.setBallTroll(4, 5);
  assert.deepEqual([drone.mode, drone.followId, [...leader.followers]], [MODE.TROLL, 0, []]);
});

test("a free mushroom is not stepped: the park says so rather than leave it standing", () => {
  const park = new Ballpark();
  const ball = spaceBall(park, { id: 1 });
  ball.mode = MODE.MUSHROOM;
  assert.throws(() => park.evolve(), DestinyNotPorted);
});

test("a ball that cloaks shakes off its followers and stops being massive; uncloaked, it is massive again", () => {
  const park = new Ballpark();
  const ship = spaceBall(park, { id: 1 });
  const hunter = spaceBall(park, { id: 2, x: 3000 });
  park.followBall(2, 1, 500);
  park.cloakBall(1, 0); // a cloak mode of nothing is no cloak
  assert.deepEqual([ship.isCloaked, ship.isMassive, hunter.mode], [0, true, MODE.FOLLOW]);
  park.cloakBall(1, 2);
  assert.deepEqual([ship.isCloaked, ship.isMassive, hunter.mode, hunter.followId, [...ship.followers]], [2, false, MODE.STOP, 0, []]);
  park.uncloakBall(1);
  assert.deepEqual([ship.isCloaked, ship.isMassive], [0, true]);
});

test("a ball uncloaked in warp proper stays unmassive; one still lining up for it does not", () => {
  const park = new Ballpark();
  const ship = spaceBall(park, { id: 1 });
  park.cloakBall(1, 1);
  Object.assign(ship, { mode: MODE.WARP, effectStamp: 12 });
  assert.equal(isWarping(ship), true);
  park.uncloakBall(1);
  assert.deepEqual([ship.isCloaked, ship.isMassive], [0, false]);
  // effectStamp below zero: the warp has been ordered but the ship is still turning to it.
  Object.assign(ship, { effectStamp: -1 });
  assert.equal(isWarping(ship), false);
  park.uncloakBall(1);
  assert.equal(ship.isMassive, true);
  assert.equal(isWarping({ mode: MODE.GOTO, effectStamp: 12 }), false);
  assert.equal(isWarping({ mode: MODE.WARP, effectStamp: 0 }), true);
});

test("the Stop order leaves a stopped ball alone and stops any other", () => {
  const park = new Ballpark();
  const leader = spaceBall(park, { id: 1 });
  const ball = spaceBall(park, { id: 2, x: 100 });
  park.followBall(2, 1, 50);
  park.stopOrder(2);
  assert.deepEqual([ball.mode, ball.followId, [...leader.followers]], [MODE.STOP, 0, []]);
  park.stopOrder(2);
  park.stopOrder(404);
  assert.equal(ball.mode, MODE.STOP);
  park.setBallRigid(2);
  park.stopOrder(2);
  assert.equal(ball.mode, MODE.STOP, "a rigid ball told to stop is a stopped ball");
});

// ── warp ─────────────────────────────────────────────────────────────────────
//
// CCP ships one fixture for warp, and it covers lining up only. The warp proper
// is checked here against the equations the source itself states in the comment
// above SetupWarpConstants (Ballpark.cpp 4181-4232), worked out in the test
// from those equations rather than copied from the code, and by flying whole
// warps tick by tick.

const warpEvents = (park) => {
  const posted = [];
  park.onPost = (...event) => posted.push(event);
  return posted;
};
/** Vector3d::Length of the difference, as the engine works it out (Math.hypot can differ in the last place). */
const distance = (a, b) => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z));
const speedOf = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

test("CCP test_warpto: ten ticks lining up for a warp, to the last digit", () => {
  const park = new Ballpark();
  const ball = spaceBall(park);
  ball.newVel = vec(1.0, 2.0, 3.0);
  park.warpTo(ball.id, 100000.0, 200000.0, 300000.0);
  const stamps = [];
  const rows = [];
  for (let tick = 0; tick < 10; tick += 1) {
    park.evolve();
    assert.equal(ball.mode, MODE.WARP);
    stamps.push(ball.effectStamp);
    rows.push([ball.newPos.x, ball.newPos.y, ball.newPos.z]);
  }
  assert.deepEqual(rows, [
    [1.0639340706602571, 2.1278681413205143, 3.1918022119807685],
    [2.248703156860341, 4.497406313720682, 6.746109470581021],
    [3.544408527173739, 7.088817054347478, 10.633225581521215],
    [4.941962348268478, 9.883924696536956, 14.825887044805434],
    [6.433021256625409, 12.866042513250818, 19.299063769876224],
    [8.00992537202119, 16.01985074404238, 24.029776116063566],
    [9.665642306989863, 19.331284613979726, 28.99692692096958],
    [11.393715762995505, 22.78743152599101, 34.18114728898651],
    [13.188218337575332, 26.376436675150664, 39.56465501272599],
    [15.043708197493105, 30.08741639498621, 45.13112459247932],
  ]);
  // The stamp counts the ticks spent lining up, downwards from -1.
  assert.deepEqual(stamps, [-2, -3, -4, -5, -6, -7, -8, -9, -10, -11]);
  assert.equal(ball.isMassive, true, "still massive while lining up");
});

test("WarpTo: what it sets, its defaults, and what it will not do", () => {
  const park = new Ballpark();
  const posted = warpEvents(park);
  const leader = spaceBall(park, { id: 1 });
  const ball = spaceBall(park, { id: 2, x: 1000 });
  park.followBall(2, 1, 500);
  park.warpTo(2, 5e8, 6e8, 7e8);
  assert.deepEqual([ball.mode, ball.goto, ball.effectStamp, ball.followRange, ball.warpMinRange, ball.ownerId], [MODE.WARP, { x: 5e8, y: 6e8, z: 7e8 }, -1, 0, 20000, 20]);
  assert.deepEqual([[...leader.followers], ball.followPtr], [[], null], "it lets go of what it followed");
  assert.equal(isWarping(ball), false, "lining up, not yet warping");
  // A negative range is none; a warp factor of nothing is 1.
  park.warpTo(2, 5e8, 6e8, 7.5e8, -5, 0);
  assert.deepEqual([ball.warpMinRange, ball.ownerId], [0, 1]);
  park.warpTo(2, 5e8, 6e8, 7.5e8, 1500.5, -3);
  assert.deepEqual([ball.warpMinRange, ball.ownerId], [0, 1], "told again to go where it is already going: left alone");
  // Lining up for some ticks, then told the same place again: the count is kept. A new place starts it over.
  park.evolve();
  park.evolve();
  assert.equal(ball.effectStamp, -3);
  park.warpTo(2, 5e8, 6e8, 7.5e8);
  assert.equal(ball.effectStamp, -3);
  park.warpTo(2, 5e8, 6e8, 8e8, 1500.5, 3000);
  assert.deepEqual([ball.effectStamp, ball.goto.z, ball.warpMinRange, ball.ownerId], [-1, 8e8, 1500.5, 3000]);
  // Whatever range the ball was keeping from something is forgotten, in any mode.
  park.stop(2);
  ball.followRange = 7;
  park.warpTo(2, 5e8, 6e8, 8e8, 1500.5, 3000);
  assert.equal(ball.followRange, 0);
  // Not a number, or no such ball: nothing.
  park.warpTo(2, NaN, 0, 0);
  park.warpTo(2, 0, Infinity, 0);
  park.warpTo(404, 5e8, 6e8, 7e8);
  assert.deepEqual([ball.goto.z, ball.effectStamp], [8e8, -1]);
  // Each change of destination went by way of a stop, which is leaving warp mode, and so did the stop itself; nothing else was.
  assert.deepEqual(posted, [["OnExitWarp", 2, 0], ["OnExitWarp", 2, 0], ["OnExitWarp", 2, 0]]);
});

test("WarpTo a place nearer than 100 km is a flight there, not a warp", () => {
  const park = new Ballpark();
  const posted = warpEvents(park);
  const ball = spaceBall(park, { id: 1 });
  park.warpTo(1, 99999.9, 0, 0);
  assert.deepEqual([ball.mode, ball.goto], [MODE.GOTO, { x: 99999.9, y: 0, z: 0 }]);
  assert.deepEqual(posted, [["OnExitWarp", 1, 1]]);
  // At exactly 100 km it is a warp.
  park.warpTo(1, 100000, 0, 0);
  assert.equal(ball.mode, MODE.WARP);
  // A warping ball sent somewhere near is taken out of warp mode, which is said twice: by the mode change, and by WarpTo.
  posted.length = 0;
  park.warpTo(1, 0, 50000, 0);
  assert.deepEqual([ball.mode, posted], [MODE.GOTO, [["OnExitWarp", 1, 0], ["OnExitWarp", 1, 1]]]);
});

test("lined up for warp: within about eight degrees of the heading and faster than three quarters of top speed, or out of patience", () => {
  const park = new Ballpark();
  const ball = spaceBall(park, { id: 1, maxVelocity: 200 });
  assert.equal(park.isAlignedForWarp(ball), false, "not in warp mode at all");
  // Not even if it is flying fast at the place with a stamp below zero left over from something else.
  park.gotoPoint(1, 1e9, 0, 0);
  Object.assign(ball, { newVel: vec(200, 0, 0), effectStamp: -5 });
  assert.equal(park.isAlignedForWarp(ball), false);
  Object.assign(ball, { newVel: vec(), effectStamp: 0 });
  park.warpTo(1, 1e9, 0, 0);
  const at = (vx, vy) => {
    ball.newVel = vec(vx, vy, 0);
    return park.isAlignedForWarp(ball);
  };
  // Straight at it: the speed must be more than 150, not 150.
  assert.deepEqual([at(150, 0), at(150.0000001, 0), at(200, 0), at(0, 0)], [false, true, true, false]);
  // Fast enough: the cosine of the angle off the heading must be more than 0.99.
  const off = (cosine) => at(180 * cosine, 180 * Math.sqrt(1 - cosine * cosine));
  assert.deepEqual([off(0.9901), off(0.9899), off(-1)], [true, false, false]);
  // The top speed is the ball's own, whatever fraction of it was asked for.
  park.setSpeedFraction(1, 0.5);
  assert.equal(at(149, 0), false);
  // Patience: more than 180 ticks spent lining up.
  ball.newVel = vec(0, 0, 0);
  ball.effectStamp = -180;
  assert.equal(park.isAlignedForWarp(ball), false);
  ball.effectStamp = -181;
  assert.equal(park.isAlignedForWarp(ball), true);
  assert.equal(MAX_ALIGN_TICKS, 180);
  // Already in the warp proper: no.
  ball.effectStamp = 5;
  ball.newVel = vec(200, 0, 0);
  assert.equal(park.isAlignedForWarp(ball), false);
});

test("the tick a ball is lined up, the warp proper begins: the destination pulled back, the length fixed, the ball placed a metre on", () => {
  const park = new Ballpark();
  const posted = warpEvents(park);
  const ball = spaceBall(park, { id: 1, x: 1000, y: 2000, z: 3000, maxVelocity: 200 });
  const chaser = spaceBall(park, { id: 2, x: 500 });
  park.followBall(2, 1, 100);
  park.currentTime = 40;
  const destination = vec(3e9, 4e9, 0);
  park.warpTo(1, destination.x, destination.y, destination.z, 15000, 3000);
  ball.newVel = vec(96, 128, 0); // 160 m/s, along (0.6, 0.8, 0): almost exactly at it
  const from = { ...ball.newPos };
  const before = park.gradients;
  park.evolve();
  assert.deepEqual(posted, [["OnActivatingWarp", 1, 40]]);
  assert.deepEqual([ball.mode, ball.effectStamp, ball.isMassive, isWarping(ball)], [MODE.WARP, 40, false, true]);
  assert.deepEqual([chaser.mode, [...ball.followers]], [MODE.STOP, []], "whoever followed it is shaken off");
  assert.deepEqual(ball.lastG, { x: 0, y: 0, z: 0 }, "and it is no longer steering");
  // The destination moves 15 km back along the line from it to the ball.
  const back = normalize({ x: from.x - destination.x, y: from.y - destination.y, z: from.z - destination.z });
  const pulled = { x: destination.x + 15000 * back.x, y: destination.y + 15000 * back.y, z: destination.z + 15000 * back.z };
  assert.deepEqual(ball.goto, pulled);
  assert.equal(ball.lastCollision, distance(pulled, from), "the warp's whole length, from where the ball was");
  // In the same tick it is placed by the warp's own curve at t = 0, which is one metre along, at the speed it had.
  assert.ok(Math.abs(distance(ball.newPos, from) - 1) < 1e-3, `${distance(ball.newPos, from)} m from where it was`);
  assert.ok(Math.abs(distance(ball.newPos, pulled) - (ball.lastCollision - 1)) < 1e-3);
  assert.ok(Math.abs(speedOf(ball.newVel) - 160) < 1e-9, "its speed does not drop as the warp begins");
  assert.equal(park.gradients - before, 1, "only the chaser: the warping ball stopped being massive before it was stepped");
  park.evolve();
  assert.equal(park.gradients - before, 2);
});

/** The numbers of a warp, from the equations in the source's comment: [3] [4] [6] [8] [11] [12]. */
function warpByTheBook(warpFactor, D) {
  const ACC = warpFactor / 1000;
  const DEC = Math.min(warpFactor / 3000, 2);
  const S = Math.min(warpFactor * 0.001 * AU, ((D + 1) * ACC * DEC) / (ACC + DEC));
  return {
    S, ACC, DEC,
    tA: Math.log(S / ACC) / ACC,
    dA: S / ACC,
    tD: Math.log(S / DEC) / DEC,
    dD: S / DEC - 1,
    dC: D - S / ACC - S / DEC + 1,
    tC: D / S - 1 / ACC - 1 / DEC + 1 / S,
  };
}
const near = (actual, expected, relative = 1e-12) => Math.abs(actual - expected) <= Math.abs(expected) * relative;

test("a warp's three stretches are the ones the source's own equations give, and add up to its length", () => {
  const park = new Ballpark();
  // 3 AU/s over 40 AU: a long warp with a cruise.
  const D = 40 * AU;
  const book = warpByTheBook(3000, D);
  const warp = park.setupWarpConstants(3000, D);
  assert.deepEqual([warp.warpSpeed, warp.accelRate, warp.decelRate], [3000 * 0.001 * AU, 3, 1]);
  assert.ok(near(warp.accelDuration, book.tA) && near(warp.decelDuration, book.tD) && near(warp.cruiseDuration, book.tC));
  assert.ok(near(warp.accelDistance, book.dA) && near(warp.decelDistance, book.dD) && near(warp.cruiseDistance, book.dC, 1e-9));
  assert.ok(near(warp.accelDistance + warp.cruiseDistance + warp.decelDistance, D));
  assert.ok(warp.cruiseDuration > 8 && warp.cruiseDuration < 13, `${warp.cruiseDuration} s at top speed`);
  // Speeding up takes a third as long as slowing down takes, at this warp factor.
  assert.ok(near(warp.decelDuration / warp.accelDuration, 3 * Math.log(warp.warpSpeed) / Math.log(warp.warpSpeed / 3), 1e-12));

  // 3 AU/s over 150,000 km: too short to reach top speed. The top speed comes down until there is no cruise.
  const short = park.setupWarpConstants(3000, 1.5e8);
  const shortBook = warpByTheBook(3000, 1.5e8);
  assert.equal(short.warpSpeed, (1.5e8 + 1) * 3 * 1 / (3 + 1));
  assert.ok(short.warpSpeed < 3 * AU);
  assert.ok(Math.abs(short.cruiseDuration) < 1e-9 && Math.abs(short.cruiseDistance) < 1, `${short.cruiseDuration} s of cruise`);
  assert.ok(near(short.accelDuration, shortBook.tA) && near(short.decelDuration, shortBook.tD));
  assert.ok(near(short.accelDistance + short.cruiseDistance + short.decelDistance, 1.5e8, 1e-9));

  // However fast the ship, it never slows at more than 2 a second.
  assert.deepEqual([park.setupWarpConstants(6000, D).decelRate, park.setupWarpConstants(9000, D).decelRate, park.setupWarpConstants(9000, D).accelRate], [2, 2, 9]);
  assert.equal(park.setupWarpConstants(4500, D).decelRate, 4500 * (1.0 / 3000));
});

/** A ball lined up and at speed for a warp along x, about to enter it. */
function readyToWarp(park, { id = 1, far, warpFactor = 3000, minRange = 15000, maxVelocity = 200 } = {}) {
  const ball = spaceBall(park, { id, maxVelocity });
  park.warpTo(id, far, 0, 0, minRange, warpFactor);
  ball.newVel = vec(0.8 * maxVelocity, 0, 0);
  return ball;
}

test("where a warping ball is, by the clock: each stretch against the source's equations", () => {
  const park = new Ballpark();
  const ball = readyToWarp(park, { far: 40 * AU });
  park.evolve(); // enters warp
  const D = ball.lastCollision;
  assert.equal(D, 40 * AU - 15000);
  const book = warpByTheBook(3000, D);
  const end = ball.goto.x;
  const where = (t) => park.warpDistance(ball, ball.newPos, vec(), t, true);
  // Speeding up: distance exp(ACC t), speed ACC exp(ACC t).
  for (const t of [1, 3, 6]) {
    const { p, v, distance: gone } = where(t);
    assert.ok(near(gone, Math.exp(3 * t)) && near(v.x, 3 * Math.exp(3 * t)) && near(end - p.x, D - Math.exp(3 * t), 1e-12), `speeding up, ${t} s`);
    assert.deepEqual([p.y, p.z, v.y, v.z], [0, 0, 0, 0]);
  }
  // Cruising: top speed, and distance growing by it.
  for (const t of [book.tA + 0.5, book.tA + book.tC / 2, book.tA + book.tC - 0.5]) {
    const { v, distance: gone } = where(t);
    assert.equal(v.x, 3 * AU);
    assert.ok(near(gone, book.dA + 3 * AU * (t - book.tA), 1e-12), `cruising, ${t} s`);
  }
  // Slowing down: speed S exp(-DEC t), distance S/DEC (1 - exp(-DEC t)) past the cruise.
  for (const since of [0.5, 5, 15, book.tD]) {
    const { p, v, distance: gone } = where(book.tA + book.tC + since);
    assert.ok(near(v.x, 3 * AU * Math.exp(-since), 1e-10), `slowing, ${since} s: speed`);
    assert.ok(near(gone, book.dA + book.dC + 3 * AU * (1 - Math.exp(-since)), 1e-10), `slowing, ${since} s: distance`);
    assert.ok(near(end - p.x, D - gone, 1e-6) || Math.abs(end - p.x - (D - gone)) < 1);
  }
  // Slowing down ends at the destination, with the speed down to the rate itself, 1 m/s.
  // (At 6e12 m from the origin a double holds a position to about a millimetre.)
  const last = where(book.tA + book.tC + book.tD);
  assert.ok(Math.abs(last.v.x - 1) < 1e-9 && Math.abs(end - last.p.x) < 5e-3, `${last.v.x} m/s, ${end - last.p.x} m short`);
  // A second before that it is still e - 1 metres short, at e m/s.
  const secondBefore = where(book.tA + book.tC + book.tD - 1);
  assert.ok(Math.abs(secondBefore.v.x - Math.E) < 1e-9 && Math.abs(end - secondBefore.p.x - (Math.E - 1)) < 5e-3);
  // Asked between ticks, for drawing, nothing changes: still in warp.
  assert.deepEqual([ball.mode, ball.isMassive], [MODE.WARP, false]);
  // The speed never drops as the warp begins: a ball already faster than the curve keeps its speed.
  assert.equal(park.warpDistance(ball, ball.newPos, vec(500, 0, 0), 0, true).v.x, 500);
  assert.equal(park.warpDistance(ball, ball.newPos, vec(1, 0, 0), 0, true).v.x, 3);
});

test("a whole warp, tick by tick: it never overshoots, peaks at its top speed, and drops out stopped once it is slow", () => {
  const park = new Ballpark();
  const posted = warpEvents(park);
  const ball = readyToWarp(park, { far: 10 * AU, maxVelocity: 300 });
  park.evolve();
  const startedAt = ball.effectStamp;
  const D = ball.lastCollision;
  const end = { ...ball.goto };
  const book = warpByTheBook(3000, D);
  let previous = distance(ball.newPos, end);
  let peak = 0;
  let ticks = 0;
  const gradientBefore = park.gradients;
  let lastInWarp = null;
  while (ball.mode === MODE.WARP) {
    lastInWarp = { p: { ...ball.newPos }, v: { ...ball.newVel } };
    park.evolve();
    ticks += 1;
    assert.ok(ticks < 200, "the warp ends");
    const left = distance(ball.newPos, end);
    assert.ok(left < previous && ball.newPos.x < end.x, `tick ${ticks}: ${left} m left, after ${previous}`);
    previous = left;
    peak = Math.max(peak, speedOf(ball.newVel));
  }
  assert.equal(peak, 3 * AU, "it cruises at exactly its top speed");
  // It drops out on the first tick at which its speed is under 100 m/s (its own top speed, halved, is more).
  const dropAfter = book.tA + book.tC + Math.log((3 * AU) / 100) / book.DEC;
  assert.equal(ticks, Math.ceil(dropAfter), `${ticks} ticks; the curve passes 100 m/s at ${dropAfter} s`);
  assert.deepEqual(posted, [["OnActivatingWarp", 1, startedAt], ["OnDeactivatingWarp", 1, startedAt + ticks], ["OnExitWarp", 1, 0]]);
  assert.deepEqual([ball.mode, ball.isMassive, park.gradients - gradientBefore], [MODE.STOP, true, 0]);
  // The tick it drops out: the warp's own place and speed for that moment become where it was...
  const t = ticks * park.dt;
  const out = warpByTheBook(3000, D);
  const speedOut = 3 * AU * Math.exp(-out.DEC * (t - out.tA - out.tC));
  assert.ok(speedOut < 100 && near(speedOf(ball.oldVel), speedOut, 1e-9), `${speedOf(ball.oldVel)} m/s out of warp`);
  assert.ok(Math.abs(distance(ball.oldPos, end) - (speedOut / out.DEC - 1)) < 0.05, "as far short of the end as its speed says");
  // ...and one ordinary step is taken from there, as a ball that has stopped steering.
  const stepped = park.integrate(ball.oldPos, ball.oldVel, vec(), ball.mass * ball.agility, park.friction, ball.timeFactor, park.dt);
  assert.deepEqual([ball.newPos, ball.newVel], [stepped.p, stepped.v]);
  // From then on it is an ordinary stopped ball, coasting down.
  const speed = speedOf(ball.newVel);
  park.evolve();
  assert.ok(speedOf(ball.newVel) < speed && ball.mode === MODE.STOP);
  assert.equal(park.gradients - gradientBefore, 1, "and massive again");
  assert.ok(lastInWarp.v.x > 100);
});

test("dropping out of warp is by speed: under 100 m/s, or under half the ship's top speed if that is less", () => {
  const drops = (maxVelocity, speed) => {
    const park = new Ballpark();
    const ball = readyToWarp(park, { far: 10 * AU, maxVelocity });
    park.evolve();
    const warp = park.setupWarpConstants(3000, ball.lastCollision);
    // The moment in the slowing-down stretch at which the curve's speed is `speed`.
    const t = warp.accelDuration + warp.cruiseDuration + Math.log(warp.warpSpeed / speed) / warp.decelRate;
    const result = park.warpDistance(ball, ball.newPos, ball.newVel, t, false);
    assert.ok(Math.abs(speedOf(result.v) - speed) < 1e-6);
    return ball.mode === MODE.STOP;
  };
  assert.deepEqual([drops(300, 120), drops(300, 100.001), drops(300, 99.999)], [false, false, true], "a fast ship: 100 m/s");
  assert.deepEqual([drops(120, 99), drops(120, 60.001), drops(120, 59.999)], [false, false, true], "a slow ship: half of 120");
});

test("a slow ship drops out of warp at half its own top speed", () => {
  const park = new Ballpark();
  const ball = readyToWarp(park, { far: 2 * AU, maxVelocity: 120 });
  park.evolve();
  let ticks = 0;
  let speedBefore = null;
  while (ball.mode === MODE.WARP && ticks < 200) {
    speedBefore = speedOf(ball.newVel);
    park.evolve();
    ticks += 1;
  }
  assert.equal(ball.mode, MODE.STOP);
  assert.ok(speedBefore >= 60 && speedOf(ball.oldVel) < 60, `in warp at ${speedBefore} m/s, out at ${speedOf(ball.oldVel)}`);
});

test("a warp that has run past its end puts the ball there, at rest", () => {
  const park = new Ballpark();
  const posted = warpEvents(park);
  const ball = readyToWarp(park, { far: 2 * AU });
  park.evolve();
  const warp = park.setupWarpConstants(3000, ball.lastCollision);
  const tooLong = warp.accelDuration + warp.cruiseDuration + warp.decelDuration + 1;
  // Asked for drawing: placed, nothing changed.
  const drawn = park.warpDistance(ball, ball.newPos, ball.newVel, tooLong, true);
  assert.deepEqual([drawn.p, drawn.v, drawn.distance, ball.mode], [ball.goto, { x: 0, y: 0, z: 0 }, 0, MODE.WARP]);
  // Just inside the extra second it is still slowing down, and slow enough to drop out.
  posted.length = 0;
  const inside = park.warpDistance(ball, ball.newPos, ball.newVel, tooLong - 0.001, true);
  assert.ok(inside.v.x > 0 && inside.v.x < 1);
  // In the step: dropped out.
  park.warpDistance(ball, ball.newPos, ball.newVel, tooLong, false);
  assert.deepEqual([ball.mode, ball.isMassive, posted], [MODE.STOP, true, [["OnDeactivatingWarp", 1, park.currentTime], ["OnExitWarp", 1, 0]]]);
});

test("EntityWarpIn: a ball that arrives already in warp, as if it began five ticks ago", () => {
  const park = new Ballpark();
  const posted = warpEvents(park);
  const ball = spaceBall(park, { id: 1, x: 1e9, y: 2e9, z: 3e9 });
  park.currentTime = 20;
  park.entityWarpIn(1, 3e11, 4e11, 0, 4500);
  assert.deepEqual([ball.mode, ball.effectStamp, ball.isMassive, ball.ownerId, ball.warpMinRange], [MODE.WARP, 15, false, 4500, 0]);
  assert.deepEqual(ball.goto, { x: 3e11, y: 4e11, z: 0 }, "no stopping short");
  assert.equal(ball.lastCollision, distance(ball.newPos, ball.goto));
  // Its speed is an AU a second along the destination's own coordinates (the unit vector made the engine's way).
  assert.deepEqual(ball.newVel, scale(normalize(vec(3e11, 4e11, 0)), AU));
  assert.ok(Math.abs(ball.newVel.x - 0.6 * AU) < 1e-3 && Math.abs(ball.newVel.y - 0.8 * AU) < 1e-3);
  assert.deepEqual(posted, [], "the client is not told a warp is being activated");
  // It is stepped as five seconds into its warp.
  park.evolve();
  const expected = park.warpDistance(ball, { x: 1e9, y: 2e9, z: 3e9 }, scale(normalize(vec(3e11, 4e11, 0)), AU), 5, true);
  assert.deepEqual(ball.newPos, expected.p);
  // Early in the park's life the start cannot be before tick 0.
  const early = new Ballpark();
  spaceBall(early, { id: 1 });
  early.currentTime = 3;
  early.entityWarpIn(1, 3e11, 4e11, 0, 3000);
  assert.equal(early.ball(1).effectStamp, 0);
  // Somewhere near: an ordinary flight, and nothing more.
  const near100 = new Ballpark();
  const walker = spaceBall(near100, { id: 1 });
  near100.entityWarpIn(1, 5000, 0, 0, 3000);
  assert.deepEqual([walker.mode, walker.isMassive, walker.newVel], [MODE.GOTO, true, { x: 0, y: 0, z: 0 }]);
  near100.entityWarpIn(404, 3e11, 0, 0, 3000);
});

test("leaving warp mode is said once, whatever takes the ball out of it", () => {
  const park = new Ballpark();
  const posted = warpEvents(park);
  const ball = spaceBall(park, { id: 1 });
  spaceBall(park, { id: 2, x: 500 });
  const leave = (how) => {
    park.warpTo(1, 5e8, 0, 0);
    posted.length = 0;
    how();
    return posted.splice(0);
  };
  assert.deepEqual(leave(() => park.stop(1)), [["OnExitWarp", 1, 0]]);
  assert.deepEqual(leave(() => park.gotoDirection(1, 0, 1, 0)), [["OnExitWarp", 1, 0]]);
  assert.deepEqual(leave(() => park.followBall(1, 2)), [["OnExitWarp", 1, 0]]);
  assert.deepEqual(leave(() => park.warpTo(1, 6e8, 0, 0)), [["OnExitWarp", 1, 0]], "a new warp goes by way of a stop");
  assert.deepEqual(leave(() => park.setBallRigid(1)), [["OnExitWarp", 1, 0]]);
  // Other changes of mode say nothing.
  park.stop(1);
  posted.length = 0;
  park.gotoDirection(1, 1, 0, 0);
  park.stop(1);
  park.orbit(1, 2);
  assert.deepEqual(posted, []);
  assert.equal(ball.mode, MODE.ORBIT);
});

test("a warp survives being written to a state and read back, lining up or under way", () => {
  const park = new Ballpark();
  const ball = readyToWarp(park, { far: 10 * AU, minRange: 12345.5, warpFactor: 4500 });
  const copyOf = (source) => {
    const copy = new Ballpark();
    copy.readState(source.writeState(), 0);
    return copy;
  };
  const lining = copyOf(park).ball(1);
  assert.deepEqual([lining.mode, lining.effectStamp, lining.goto, lining.warpMinRange, lining.ownerId], [MODE.WARP, -1, ball.goto, 12345.5, 4500]);
  for (let tick = 0; tick < 4; tick += 1) park.evolve();
  const copy = copyOf(park);
  const under = copy.ball(1);
  assert.deepEqual([under.mode, under.effectStamp, under.goto, under.lastCollision, under.ownerId, under.isMassive], [MODE.WARP, ball.effectStamp, ball.goto, ball.lastCollision, 4500, false]);
  // And the two then fly the same warp.
  for (let tick = 0; tick < 6; tick += 1) {
    park.evolve();
    copy.evolve();
    assert.deepEqual([under.newPos, under.newVel], [ball.newPos, ball.newVel]);
  }
});

// ── collisions, beyond the fixtures ──────────────────────────────────────────

const closeTo = (actual, expected, margin = 1e-9) => assert.ok(Math.abs(actual - expected) <= margin * Math.max(1, Math.abs(expected)), `${actual} is not ${expected}`);
/** A fixed, massive ball of radius 2: something to run into. */
const wall = (park, id, x, y = 0, z = 0) => park.addBall({ id, x, y, z, radius: 2, isMassive: true });
/** The standard ball at the origin doing 8 m/s along x, with whatever `build` puts in its way; stepped once. */
function charge(build = () => {}) {
  const park = new Ballpark();
  const ball = spaceBall(park, { id: 1, vx: 8 });
  build(park, ball);
  park.evolve();
  return { park, ball, at: [{ ...ball.newPos }, { ...ball.newVel }] };
}

test("Quadratic and CollideTwoSpheres: when two spheres moving in straight lines first touch", () => {
  assert.deepEqual(quadratic(1, -3, 2), [2, 1]);
  assert.equal(quadratic(1, 0, 1), null, "no roots");
  assert.equal(quadratic(0, 0, 5), null, "not an equation");
  assert.deepEqual(quadratic(1, 0, 0), [0, -0]);
  // No s^2 term: the source goes on to divide by it, and nothing usable comes out.
  assert.ok(quadratic(0, 2, 1).every((root) => !Number.isFinite(root)));
  const still = vec(8, 0, 0);
  // Ten metres along x at a sphere 8 m off, radii adding up to 2: they touch when the gap is 2, 6 m in.
  closeTo(collideTwoSpheres(vec(), vec(10, 0, 0), still, still, 2), 0.6);
  // Both moving: closing at 20 m a tick, 6 m to close.
  closeTo(collideTwoSpheres(vec(), vec(10, 0, 0), still, vec(-2, 0, 0), 2), 0.3);
  assert.equal(collideTwoSpheres(vec(), vec(10, 0, 0), vec(1.5, 0, 0), still, 2), 0, "overlapping already");
  assert.equal(collideTwoSpheres(vec(), vec(10, 0, 0), vec(2, 0, 0), still, 2), 0, "touching counts as overlapping");
  assert.equal(collideTwoSpheres(vec(), vec(), vec(2, 0, 0), vec(2, 0, 0), 2), 0, "and does so with neither of them moving");
  assert.equal(collideTwoSpheres(vec(), vec(5, 0, 0), still, still, 2), -1, "it stops short this tick");
  assert.equal(collideTwoSpheres(vec(), vec(-10, 0, 0), still, still, 2), -1, "going the other way");
  assert.equal(collideTwoSpheres(vec(), vec(10, 0, 0), vec(8, 3, 0), vec(8, 3, 0), 2), -1, "passing wide");
  assert.equal(collideTwoSpheres(vec(), vec(10, 0, 0), still, vec(18, 0, 0), 2), -1, "moving together, never closing");
  assert.equal(collideTwoSpheres(vec(), vec(6, 0, 0), still, still, 2), 1, "touching at the very end of the tick");
});

test("a ball that runs into a fixed one bounces: its speed along the line between them is turned round, damped to 0.85", () => {
  const { park, ball } = charge((p) => wall(p, 2, 9));
  // Worked out here from what the collision means, not from its formula: the ball's own step with nothing in
  // the way; the moment it touches, 5 m in; its speed there turned round; the rest of the tick from there.
  const m = ball.mass * ball.agility;
  const k = park.friction;
  const tf = ball.timeFactor;
  const free = park.integrate(vec(), vec(8, 0, 0), vec(), m, k, tf, park.dt);
  const s = 5 / free.p.x;
  const touch = park.integrate(vec(), vec(8, 0, 0), vec(), m, k, tf, s * park.dt);
  const bounced = park.integrate(touch.p, vec(-touch.v.x, 0, 0), vec(), m, k, tf, (1 - s) * park.dt);
  // The steady push that would have brought it to that speed over the whole tick; 0.85 of it is applied.
  const push = (bounced.v.x * k - 8 * k * tf) / (m * (1 - tf));
  const stepped = park.integrate(vec(), vec(8, 0, 0), vec(0.85 * push, 0, 0), m, k, tf, park.dt);
  assert.ok(s > 0.6 && s < 0.7 && bounced.v.x < 0);
  closeTo(ball.lastCollision, s);
  closeTo(ball.lastC.x, 0.85 * push);
  closeTo(ball.newVel.x, stepped.v.x);
  closeTo(ball.newPos.x, stepped.p.x);
  closeTo(ball.newVel.x, free.v.x + 0.85 * (bounced.v.x - free.v.x));
  assert.ok(ball.newVel.x < 0 && ball.newPos.x < 5, "it is coming back, and never got inside");
  assert.deepEqual([ball.newPos.y, ball.newPos.z, ball.lastC.y, ball.lastC.z, ball.collisions], [0, 0, 0, 0, [2]]);
  assert.deepEqual(park.ball(2).newPos, { x: 9, y: 0, z: 0 }, "the fixed one does not move");
  // What is fixed is a wall whatever it weighs.
  const lightWall = charge((p) => p.addBall({ id: 2, x: 9, radius: 2, isMassive: true, mass: 1000 }));
  assert.deepEqual(lightWall.at, [{ ...ball.newPos }, { ...ball.newVel }]);
  // With nothing in the way the tick leaves no mark; with something there but out of reach, none either.
  const clear = charge();
  assert.deepEqual([clear.at, clear.ball.lastCollision, clear.ball.collisions, clear.ball.lastC], [[free.p, free.v], -1, [], vec()]);
  const far = charge((p) => wall(p, 2, 20));
  assert.deepEqual([far.at, far.ball.lastCollision, far.ball.collisions], [[free.p, free.v], -1, []]);
  // The mark is this tick's only: the next tick, clear of everything, starts again.
  park.evolve();
  assert.deepEqual([ball.lastCollision, ball.collisions, ball.lastC], [-1, [], vec()]);
});

test("a ball already inside a fixed one is pushed out along the line between them, a metre clear", () => {
  // At rest, its centre 3 m from a fixed ball's: a metre inside, so two to clear with the metre over.
  const park = new Ballpark();
  const ball = spaceBall(park, { id: 1 });
  wall(park, 2, 3);
  park.evolve();
  const m = ball.mass * ball.agility;
  const k = park.friction;
  // The push is the one that would move a ball at rest the whole distance in a tick; 0.85 of it is applied.
  const push = -2 / (park.dt * (1 / (m + park.dt * k)) * m) / park.dt;
  closeTo(ball.lastC.x, 0.85 * push);
  assert.deepEqual([ball.lastCollision, ball.collisions], [0, [2]]);
  assert.ok(ball.newPos.x < -0.5 && ball.newPos.x > -2, `it moved ${ball.newPos.x} m`);
  // The same whatever the fixed ball weighs.
  const light = new Ballpark();
  const inLight = spaceBall(light, { id: 1 });
  light.addBall({ id: 2, x: 3, radius: 2, isMassive: true, mass: 1000 });
  light.evolve();
  assert.deepEqual(inLight.newPos, ball.newPos);
  // Moving, the push also takes off the speed it has: it is to end the tick clear, not to arrive there coasting.
  const moving = new Ballpark();
  const mover = spaceBall(moving, { id: 1, vx: 5 });
  wall(moving, 2, 3);
  moving.evolve();
  closeTo(mover.lastC.x, 0.85 * (push - 5 / moving.dt));
  // Steering into it, the push takes off that steering too.
  const steering = new Ballpark();
  const helm = spaceBall(steering, { id: 1 });
  wall(steering, 2, 3);
  steering.gotoPoint(1, 1000, 0, 0);
  steering.evolve();
  assert.ok(helm.lastG.x > 0.1, `steering at ${helm.lastG.x} m/s2`);
  closeTo(helm.lastC.x, 0.85 * (push - helm.lastG.x));
});

test("what a ball can run into: the massive, the uncloaked and the living, and a force field only if it is not its own", () => {
  const hit = charge((p) => wall(p, 2, 9)).at;
  const miss = charge().at;
  assert.notDeepEqual(hit, miss);
  const through = (change) => charge((p, ball) => change(wall(p, 2, 9), ball, p)).at;
  // Not massive, cloaked, on its way out, a missile: the ball goes through.
  assert.deepEqual(through((w) => { w.isMassive = false; }), miss);
  assert.deepEqual(through((w) => { w.isCloaked = 1; }), miss);
  assert.deepEqual(through((w) => { w.isMoribund = true; }), miss);
  assert.deepEqual(through((w) => { w.mode = MODE.MISSILE; }), miss);
  // Wreckage does not trouble a ship, but does trouble wreckage.
  assert.deepEqual(through((w) => { w.isSpaceJunk = true; }), miss);
  assert.deepEqual(through((w, ball) => { w.isSpaceJunk = true; ball.isSpaceJunk = true; }), hit);
  assert.deepEqual(through((w, ball) => { ball.isSpaceJunk = true; }), hit);
  // A mushroom is no obstacle to the ball it came from.
  assert.deepEqual(through((w) => { w.mode = MODE.MUSHROOM; w.ownerId = 1; }), miss);
  assert.deepEqual(through((w) => { w.mode = MODE.MUSHROOM; w.ownerId = 7; }), hit);
  // A force field stops a stranger, and lets through its own: by harmonic, corporation or alliance, or the pass.
  const field = (set) => through((w, ball) => { w.mode = MODE.FIELD; set(w, ball); });
  assert.deepEqual(field(() => {}), hit, "nothing in common, and nothing set on either");
  assert.deepEqual(field((w, ball) => { ball.harmonic = -2; }), miss);
  assert.deepEqual(field((w, ball) => { w.harmonic = 5; ball.harmonic = 5; }), miss);
  assert.deepEqual(field((w, ball) => { w.harmonic = 5; ball.harmonic = 6; }), hit);
  assert.deepEqual(field((w, ball) => { w.corporationID = 98; ball.corporationID = 98; }), miss);
  assert.deepEqual(field((w, ball) => { w.corporationID = 98; ball.corporationID = 99; }), hit);
  assert.deepEqual(field((w, ball) => { w.allianceID = 77; ball.allianceID = 77; }), miss);
  assert.deepEqual(field((w, ball) => { w.allianceID = 77; ball.allianceID = 78; }), hit);
  // The same harmonic means nothing on a ball that is not a field.
  assert.deepEqual(through((w, ball) => { w.harmonic = 5; ball.harmonic = 5; }), hit);
  // A ball that is not massive itself runs into nothing, and nothing is looked for.
  const ghost = charge((p, ball) => { wall(p, 2, 9); p.setBallMassive(ball.id, false); });
  assert.deepEqual([ghost.at, ghost.park.gradients], [miss, 0]);
});

test("of several touched in one tick the latest counts, and of two touched at the same moment the stronger", () => {
  const far = charge((p) => wall(p, 2, 9));
  // A nearer one in the same line is touched earlier in the tick; the farther is still the one that counts,
  // whichever comes first by id. That a ball touched two at once is counted: the order here is by id.
  for (const [nearID, farID] of [[2, 3], [3, 2]]) {
    const both = charge((p) => { wall(p, farID, 9); wall(p, nearID, 7); });
    assert.deepEqual(both.at, far.at);
    // Taken in order of id, whichever was put in the park first.
    assert.deepEqual([both.ball.collisions, both.park.unported.collisionOrder, far.park.unported.collisionOrder], [[2, 3], 1, 0]);
    closeTo(both.ball.lastCollision, far.ball.lastCollision);
  }
  // Two in the same place, one fixed and one free and light: both are touched at the same moment. The fixed
  // one turns the ball right round and the light one barely slows it, so the fixed one's answer is kept.
  for (const [fixedID, lightID] of [[2, 3], [3, 2]]) {
    const pair = charge((p) => { wall(p, fixedID, 9); spaceBall(p, { id: lightID, x: 9, mass: 1000 }); });
    assert.deepEqual(pair.at, far.at);
  }
  const light = charge((p) => spaceBall(p, { id: 2, x: 9, mass: 1000 }));
  assert.ok(light.ball.newVel.x > 0 && light.ball.newVel.x < charge().ball.newVel.x, "off something light it only slows");
});

test("two free balls exchange speed by their masses, and a light one inside a heavy one is pushed back by the whole way out", () => {
  // Head on into a ball of the same mass at rest: the two exchange their speed along the line, less the damping.
  const even = charge((p) => spaceBall(p, { id: 2, x: 9 }));
  const other = even.park.ball(2);
  assert.ok(even.ball.newVel.x < charge().ball.newVel.x && other.newVel.x > 0, "the one slows and the other is set moving");
  // It is the masses themselves that are exchanged by, not mass times agility. Into one of the same mass and
  // half the agility, at rest: the ball's speed along the line at the touch becomes the other's, nothing.
  const sluggish = charge((p) => { spaceBall(p, { id: 2, x: 9 }); p.setBallAgility(2, 0.45); });
  {
    const { park, ball } = sluggish;
    const m = ball.mass * ball.agility;
    const k = park.friction;
    const tf = ball.timeFactor;
    const free = park.integrate(vec(), vec(8, 0, 0), vec(), m, k, tf, park.dt);
    const s = 5 / free.p.x;
    closeTo(ball.lastCollision, s);
    closeTo(ball.lastC.x, 0.85 * ((0 * k - 8 * k * tf) / (m * (1 - tf))));
  }
  // Head on into one a thousand times heavier: all but a bounce off a wall.
  const heavy = charge((p) => spaceBall(p, { id: 2, x: 9, mass: 13e9 }));
  assert.ok(heavy.ball.newVel.x < 0 && heavy.park.ball(2).newVel.x > 0 && heavy.park.ball(2).newVel.x < 0.1);
  // A light ball a metre inside a heavy one, and moving into it: its answer is stretched to the whole way out,
  // two metres here, as an acceleration. (In one tick that only slows it: it does not come back out.) The
  // heavy one's is not stretched; nor is either's between equals.
  const park = new Ballpark();
  const small = spaceBall(park, { id: 1, vx: 5, mass: 13e6 });
  const big = spaceBall(park, { id: 2, x: 3, mass: 13e9 });
  park.evolve();
  const size = (v) => Math.hypot(v.x, v.y, v.z);
  closeTo(size(small.lastC), 2);
  assert.ok(small.lastC.x < 0 && small.newVel.x > 0 && small.newVel.x < 3, "pushed back the way it came, and slowed by it");
  assert.ok(size(big.lastC) > 0 && Math.abs(size(big.lastC) - 2) > 0.1);
  const equals = new Ballpark();
  const one = spaceBall(equals, { id: 1, vx: 5 });
  spaceBall(equals, { id: 2, x: 3 });
  equals.evolve();
  assert.ok(size(one.lastC) > 0 && Math.abs(size(one.lastC) - 2) > 0.1);
});

test("a fixed ball's own collision shapes are not ported, and a massive ball stepped beside one is counted", () => {
  const plain = charge((p) => wall(p, 2, 50));
  assert.equal(plain.park.unported.minis, 0);
  for (const shape of ["miniBalls", "miniCapsules", "miniBoxes"]) {
    const shaped = charge((p) => { wall(p, 2, 50)[shape] = [{}]; });
    assert.equal(shaped.park.unported.minis, 1, shape);
    shaped.park.evolve();
    assert.equal(shaped.park.unported.minis, 2);
  }
  // A free ball's shapes are not in the park, and a ball that is not massive is not stepped against any.
  assert.equal(charge((p) => { const free = spaceBall(p, { id: 2, x: 50 }); free.miniBalls = [{}]; }).park.unported.minis, 0);
  assert.equal(charge((p, ball) => { wall(p, 2, 50).miniBalls = [{}]; p.setBallMassive(ball.id, false); }).park.unported.minis, 0);
});

// ── between two ticks ───────────────────────────────────────────────────────

test("between two ticks a ball is stepped from where it was by the push that moved it: at 0 where it was, at 1 where it is", () => {
  const park = new Ballpark();
  const ball = spaceBall(park, { maxVelocity: 200 });
  park.gotoDirection(1, 10, 20, 30);
  for (let tick = 0; tick < 4; tick += 1) {
    const was = { p: { ...ball.newPos }, v: { ...ball.newVel } };
    park.evolve();
    // The whole tick is the park's own step, to the last digit; none of it is where the ball was.
    assert.deepEqual(park.between(ball, 1), { p: ball.newPos, v: ball.newVel });
    assert.deepEqual(park.between(ball, 0), was);
    // Part of the tick is the same step taken for that long, not a straight line between the two.
    const half = park.between(ball, 0.5);
    assert.deepEqual(half, park.integrate(was.p, was.v, ball.lastG, ball.mass * ball.agility, park.friction, ball.timeFactor, 0.5));
    const straight = scale({ x: was.p.x + ball.newPos.x, y: was.p.y + ball.newPos.y, z: was.p.z + ball.newPos.z }, 0.5);
    assert.ok(distance(half.p, straight) > 1e-3 && distance(half.p, straight) < distance(was.p, ball.newPos), `tick ${tick}: ${distance(half.p, straight)} m from the straight line's middle`);
  }
});

test("between two ticks a ball lining up for a warp is stepped like any other: its warp has not begun", () => {
  const park = new Ballpark();
  const ball = spaceBall(park, { maxVelocity: 200 });
  park.warpTo(1, 40 * AU, 0, 0, 15000, 3000);
  for (let tick = 0; tick < 3; tick += 1) {
    const was = { p: { ...ball.newPos }, v: { ...ball.newVel } };
    park.evolve();
    assert.ok(ball.mode === MODE.WARP && !isWarping(ball), `tick ${tick}: lining up`);
    assert.deepEqual(park.between(ball, 1), { p: ball.newPos, v: ball.newVel });
    assert.deepEqual(park.between(ball, 0), was);
  }
});

test("between two ticks a ball that was pushed off something is stepped with that push too", () => {
  const park = new Ballpark();
  const ball = spaceBall(park, { id: 1, vx: 8 });
  wall(park, 2, 9);
  const was = { p: { ...ball.newPos }, v: { ...ball.newVel } };
  park.evolve();
  assert.ok(ball.lastC.x < 0, "the ball ran into the wall");
  assert.deepEqual(park.between(ball, 1), { p: ball.newPos, v: ball.newVel });
  assert.deepEqual(park.between(ball, 0), was);
  // Without the wall's push the same step ends somewhere else.
  assert.notDeepEqual(park.integrate(was.p, was.v, ball.lastG, ball.mass * ball.agility, park.friction, ball.timeFactor, 1.0).p, ball.newPos);
});

test("between two ticks a ball in warp is placed by the warp's clock, a tick ahead: at 0 where it is, at 1 where the next tick puts it", () => {
  const park = new Ballpark();
  const ball = readyToWarp(park, { far: 40 * AU });
  park.evolve(); // enters warp
  const posted = [];
  park.onPost = (name) => posted.push(name);
  let checked = 0;
  let speeds = 0;
  for (let tick = 0; tick < 30 && isWarping(ball); tick += 1) {
    park.evolve();
    if (!isWarping(ball)) break;
    // To the last digit but one: the heading is worked out from where the ball was, and far out a double holds a place to under a millimetre.
    const now = park.between(ball, 0);
    assert.ok(distance(now.p, ball.newPos) < 1e-2, `tick ${tick}: ${distance(now.p, ball.newPos)} m`);
    const ahead = park.between(ball, 1);
    const half = park.between(ball, 0.5);
    // The speed is the warp's at that moment, along the line.
    assert.ok(ahead.v.x > 0 && ahead.v.y === 0 && ahead.v.z === 0, `tick ${tick}: ${ahead.v.x} m/s`);
    if (Math.abs(ahead.v.x - now.v.x) > 1e-6 * now.v.x) speeds += 1;
    // Half way through the tick it is between the two, on the line, by the warp's curve and not by halves.
    assert.ok(half.p.x > ball.newPos.x && half.p.x < ahead.p.x && half.p.y === 0 && half.p.z === 0);
    const before = { ...ball.newPos };
    const mode = ball.mode;
    park.evolve();
    if (isWarping(ball)) {
      assert.ok(distance(ahead.p, ball.newPos) < 1e-2 && distance(ahead.p, before) > 1, `tick ${tick}: ${distance(ahead.p, ball.newPos)} m`);
      checked += 1;
    }
    // Looking between ticks changed nothing: the ball was not dropped out of warp by it.
    assert.ok(mode === MODE.WARP && before.x < ball.newPos.x);
  }
  assert.ok(checked >= 5, `${checked} ticks of warp compared`);
  assert.ok(speeds >= 3, `the speed changed within ${speeds} of them`);
});

test("looking between ticks at a warp that is over does not end it", () => {
  const park = new Ballpark();
  const posted = [];
  const ball = readyToWarp(park, { far: 2 * AU });
  park.onPost = (name) => posted.push(name);
  park.evolve();
  for (let tick = 0; tick < 200 && isWarping(ball); tick += 1) {
    const mode = ball.mode;
    const massive = ball.isMassive;
    const said = posted.length;
    // Far past the end of the warp: the place is the end, and nothing else happens.
    const far = park.between(ball, 500);
    assert.deepEqual(far.p, ball.goto);
    assert.deepEqual([ball.mode, ball.isMassive, posted.length], [mode, massive, said]);
    park.evolve();
  }
  assert.equal(ball.mode, MODE.STOP, "the park's own step ended the warp");
});

// ── as the client draws it ───────────────────────────────────────────────────

/** The engine's driver for a bare ballpark: its first step at `from`, then one a second, each handed the clock's reading at the step before. */
function driven(park, from = 5_000_000) {
  park.time = from;
  park.evolve(from);
  return () => {
    park.evolve(park.time);
    park.time += 1000;
    return park.time;
  };
}

test("a ball is drawn a tick behind the park: in the second after a step, from where it was to where the park has it", () => {
  const park = new Ballpark();
  const step = driven(park);
  // The ball arrives after the driver's first step, as every ball of a real park does.
  const ball = spaceBall(park, { maxVelocity: 200 });
  park.gotoDirection(1, 10, 20, 30);
  assert.deepEqual([ball.oldTime, ball.newTime, ball.posUpdateTime, ball.lastTick], [0, 4_999_000, 0, -1]);
  for (let tick = 0; tick < 4; tick += 1) {
    const was = { p: { ...ball.newPos }, v: { ...ball.newVel } };
    const now = step();
    assert.deepEqual([ball.oldTime, ball.newTime], [now - 2000, now - 1000], "each step leaves the reading at the step before, and the one before that");
    // As the step is taken the ball is drawn where it was; a second on, where the park has it.
    assert.deepEqual(park.drawn(ball, now), was);
    assert.deepEqual(park.drawn(ball, now + 250), park.between(ball, 0.25));
    assert.deepEqual(park.drawn(ball, now + 999.5), park.between(ball, 0.9995));
    assert.ok(distance(park.drawn(ball, now + 999.5).p, ball.newPos) < 0.2);
    assert.deepEqual([ball.posUpdateTime, ball.lastTick], [now + 999.5 - 2000, park.currentTime]);
  }
});

test("a ball no step has been timed for is drawn where the park has it: a fixed one, and one that has only just arrived", () => {
  const park = new Ballpark();
  const step = driven(park);
  step();
  park.addBall({ id: 9, x: 700, y: 0, z: 0, radius: 50 });
  const fixed = park.ball(9);
  park.addBall({ id: 2, x: 5, y: 6, z: 7, vx: 3, vy: 0, vz: 0, isFree: true });
  const fresh = park.ball(2);
  assert.deepEqual([fresh.oldTime, fresh.newTime, fixed.oldTime, fixed.newTime], [0, 0, 0, 0]);
  // Neither has a speed to say until a step has been timed for it.
  assert.deepEqual(park.drawn(fresh, park.time + 300), { p: { x: 5, y: 6, z: 7 }, v: vec() });
  assert.deepEqual(park.drawn(fixed, park.time + 300), { p: { x: 700, y: 0, z: 0 }, v: vec() });
  // The drawing is its own copy, kept with when it was made; moved by hand, the ball is drawn at its new place next time.
  assert.deepEqual([fixed.posUpdateTime, fixed.lastPos === fixed.newPos], [park.time + 300 - 2000, false]);
  park.setBallPosition(9, 800, 0, 0);
  assert.deepEqual(park.drawn(fixed, park.time + 300).p, { x: 700, y: 0, z: 0 }, "the same reading: the same drawing");
  assert.deepEqual(park.drawn(fixed, park.time + 400).p, { x: 800, y: 0, z: 0 });
  park.setBallPosition(9, 700, 0, 0);
  const now = step();
  assert.deepEqual([fresh.oldTime, fresh.newTime, fixed.oldTime, fixed.newTime], [now - 2000, now - 1000, 0, 0]);
  assert.deepEqual(park.drawn(fresh, now).p, { x: 5, y: 6, z: 7 });
  assert.ok(park.drawn(fresh, now + 500).p.x > 5 && park.drawn(fresh, now + 500).p.x < fresh.newPos.x);
  assert.deepEqual(park.drawn(fixed, now + 500).p, { x: 700, y: 0, z: 0 });
});

test("a ball made free is given a time a tick back, so its first drawing does not snap", () => {
  const park = new Ballpark();
  const step = driven(park);
  park.addBall({ id: 2, x: 5, y: 6, z: 7 });
  park.setBallFree(2, true);
  assert.equal(park.ball(2).newTime, park.time - 1000);
  // Freed already, nothing changes; fixed again and freed later, the time is that moment's.
  step();
  park.setBallFree(2, true);
  assert.equal(park.ball(2).newTime, park.time - 1000);
  park.setBallFree(2, false);
  step();
  step();
  park.setBallFree(2, true);
  assert.equal(park.ball(2).newTime, park.time - 1000);
});

test("asked again for the same reading, or for an earlier one, the last drawing is given", () => {
  const park = new Ballpark();
  const step = driven(park);
  const ball = spaceBall(park, { maxVelocity: 200 });
  park.gotoDirection(1, 10, 20, 30);
  const now = step();
  const first = park.drawn(ball, now + 400);
  assert.equal(park.drawn(ball, now + 400).p, first.p, "the same answer, not another like it");
  assert.equal(park.drawn(ball, now + 100).p, first.p);
  assert.notDeepEqual(park.drawn(ball, now + 600).p, first.p);
});

test("in warp a ball is drawn by the warp's clock, and its heading is taken from where it was last drawn", () => {
  const park = new Ballpark();
  const step = driven(park);
  // A warp along a line five thousand kilometres off the x axis, so that a heading taken from anywhere else would show.
  const ball = spaceBall(park, { y: 5e6, maxVelocity: 200 });
  park.warpTo(1, 40 * AU, 5e6, 0, 15000, 3000);
  ball.newVel = vec(160, 0, 0);
  step(); // enters warp
  step();
  let now = step();
  assert.ok(isWarping(ball));
  // Never drawn before: the first drawing is aimed from where the ball was.
  const at = park.drawn(ball, now + 500);
  assert.deepEqual(at, park.between(ball, 0.5, { p: ball.oldPos, v: ball.oldVel }));
  assert.ok(at.p.x > ball.newPos.x && at.v.x > 0 && at.p.y === 5e6 && at.v.y === 0, JSON.stringify(at));
  // Drawn off the warp's line once (a rebuilt park, a correction), the next drawing is aimed from there.
  now = step();
  const last = { p: { x: ball.lastPos.x, y: 5e9, z: 0 }, v: ball.lastVel };
  ball.lastPos = last.p;
  const turned = park.drawn(ball, now + 500);
  assert.ok(turned.v.y < 0, "aimed back down at the destination from above the line");
  assert.deepEqual(turned, park.between(ball, 0.5, last));
  // And what was drawn is kept for the next.
  assert.deepEqual([ball.lastPos, ball.lastVel, ball.posUpdateTime], [turned.p, turned.v, now + 500 - 2000]);
});

test("the park's times moved: the drawing moves with them, and a step taken without the clock leaves them alone", () => {
  const make = () => {
    const park = new Ballpark();
    const step = driven(park);
    const ball = spaceBall(park, { maxVelocity: 200 });
    park.gotoDirection(1, 10, 20, 30);
    park.addBall({ id: 9, x: 700, y: 0, z: 0 });
    return { park, step, ball };
  };
  const [a, b] = [make(), make()];
  const now = a.step();
  b.step();
  b.park.drawn(b.ball, now + 100);
  b.park.adjustTimes(400);
  assert.deepEqual([b.park.time, b.ball.oldTime, b.ball.newTime, b.ball.posUpdateTime], [now + 400, now - 2000 + 400, now - 1000 + 400, now + 100 - 2000 + 400]);
  // A ball no step has been timed for keeps its noughts; what was last drawn of it is moved all the same.
  assert.deepEqual([b.park.ball(9).oldTime, b.park.ball(9).newTime, b.park.ball(9).posUpdateTime], [0, 0, 400]);
  assert.deepEqual(b.park.drawn(b.ball, now + 700), a.park.drawn(a.ball, now + 300));
  // A step to catch up or go back is taken without the clock: the times stay, and the drawing runs on between new places.
  const times = [a.ball.oldTime, a.ball.newTime];
  a.park.evolve();
  assert.deepEqual([a.ball.oldTime, a.ball.newTime], times);
  assert.deepEqual(a.park.drawn(a.ball, now + 500), a.park.between(a.ball, 0.5));
});

test("a ball that was there at the driver's very first step is drawn off its path for two ticks, as the engine has it", () => {
  // The first step is handed the clock's reading itself, not the reading a step earlier; the next is handed the same one again.
  const park = new Ballpark();
  // Added free, as a state adds a ball: no time is put on it until a step is.
  const ball = park.addBall({ id: 1, isFree: true, mass: 13000000.0, maxVelocity: 200, radius: 2, speedFraction: 0.95 });
  park.setBallAgility(1, 0.9);
  park.gotoDirection(1, 10, 20, 30);
  assert.deepEqual([ball.oldTime, ball.newTime], [0, 0]);
  const step = driven(park, 5_000_000);
  assert.deepEqual([ball.oldTime, ball.newTime], [4_999_000, 5_000_000]);
  // A tick late: at the step it is drawn a second before where it was.
  assert.deepEqual(park.drawn(ball, 5_000_000), park.between(ball, -1));
  step();
  assert.deepEqual([ball.oldTime, ball.newTime], [5_000_000, 5_000_000]);
  // Two equal times: nothing to draw between, so where the park has it.
  assert.deepEqual(park.drawn(ball, 5_001_500).p, ball.newPos);
  const now = step();
  assert.deepEqual([ball.oldTime, ball.newTime], [now - 2000, now - 1000]);
  assert.deepEqual(park.drawn(ball, now + 500), park.between(ball, 0.5));
});

// ── missiles (test_missile.py, test_movement_controls.py TestMissileFollow) ─

/** TestMissile.setUp: a target 1000 km out, a launcher, a big ball in the way at 2 km, and the missile. */
function missileRange() {
  const park = new Ballpark();
  const dst = spaceBall(park, { id: 1, x: 1e6 });
  const owner = spaceBall(park, { id: 2 });
  const collider = spaceBall(park, { id: 3, x: 2e3 });
  park.setBallRadius(collider.id, 1.9e3);
  const missile = spaceBall(park, { id: 4 });
  park.setMaxSpeed(missile.id, 300);
  park.setBallAgility(missile.id, 0.01);
  park.setBallMass(missile.id, 1e4);
  return { park, dst, owner, collider, missile };
}

/** unittest's assertAlmostEqual: equal once rounded to `places` decimals. */
const almost = (actual, expected, places = 7) => assert.ok(Math.round((actual - expected) * 10 ** places) === 0, `${actual} is not ${expected} to ${places} places`);

function evolveTimes(park, ticks) {
  for (let tick = 0; tick < ticks; tick += 1) park.evolve();
}

test("CCP test_not_aimed_not_massive_from_stationary: launched backwards at 150 m/s, then after the target, through the ball in the way", () => {
  const { park, dst, owner, collider, missile } = missileRange();
  park.launchMissile(missile.id, dst.id, owner.id, 0, 0);
  almost(missile.newVel.x, 0.0);
  almost(missile.newVel.y, 0.0);
  almost(missile.newVel.z, -150);
  // The launcher's facing is not ported: its unturned nose, and counted.
  assert.equal(park.unported.orientation, 1);
  evolveTimes(park, 20);
  almost(missile.newVel.x, missile.maxVelocity * missile.speedFraction, 2);
  assert.ok(Math.abs(missile.newVel.y) <= 0.5 && Math.abs(missile.newVel.z) <= 0.5);
  assert.deepEqual(collider.newPos, vec(2e3, 0, 0));
});

test("CCP test_not_aimed_not_massive_from_moving: launched along the launcher's velocity with 150 m/s on top", () => {
  const { park, dst, owner, collider, missile } = missileRange();
  park.setBallVelocity(owner.id, 0, 0, 10);
  park.launchMissile(missile.id, dst.id, owner.id, 0, 0);
  park.setBallVelocity(owner.id, 0, 0, 0);
  almost(missile.newVel.x, 0.0);
  almost(missile.newVel.y, 0.0);
  almost(missile.newVel.z, 160);
  assert.equal(park.unported.orientation, 0);
  evolveTimes(park, 20);
  almost(missile.newVel.x, missile.maxVelocity * missile.speedFraction, 4);
  almost(missile.newVel.y, 0.0, 0);
  almost(missile.newVel.z, 0.0, 0);
  assert.deepEqual(collider.newPos, vec(2e3, 0, 0));
});

for (const massive of [0, 1]) {
  test(`CCP test_aimed_${massive ? "" : "not_"}massive: an aimed missile leaves at 1 m/s straight at the target and flies through what is in the way`, () => {
    const { park, dst, owner, collider, missile } = missileRange();
    park.launchMissile(missile.id, dst.id, owner.id, 1, massive);
    if (!massive) {
      almost(missile.newVel.x, 1.0);
      almost(missile.newVel.y, 0.0);
      almost(missile.newVel.z, 0.0);
    }
    evolveTimes(park, 20);
    almost(missile.newVel.x, missile.maxVelocity * missile.speedFraction, 4);
    almost(missile.newVel.y, 0.0, 4);
    almost(missile.newVel.z, 0.0, 4);
    assert.deepEqual(collider.newPos, vec(2e3, 0, 0));
    assert.ok(missile.newPos.x > collider.newPos.x);
  });
}

test("CCP TestMissileFollow: ids, a range of minus both radii, the mode, and no following a dead ball", () => {
  const park = new Ballpark();
  const [src, dst, owner] = [1, 2, 3].map((id) => park.addBall({ id }));
  park.setBallRadius(src.id, 1.0);
  park.setBallRadius(dst.id, 2.0);
  park.missileFollow(src.id, dst.id, owner.id);
  assert.deepEqual([src.followId, src.ownerId, src.followRange, src.mode, src.speedFraction], [dst.id, owner.id, -3.0, MODE.MISSILE, 1.0]);
  assert.ok(dst.followers.has(src.id));
  // test_stop_missile
  park.stop(src.id);
  assert.deepEqual([src.mode, src.followId, src.followRange, dst.followers.has(src.id)], [MODE.STOP, 0, 0, false]);
  // test_can_not_follow_moribund_ball
  park.removeBall(dst.id);
  park.missileFollow(src.id, dst.id, owner.id);
  assert.notEqual(src.followId, dst.id);
});

test("a missile flies straight on its launch tick, then leads its target and closes on it", () => {
  const park = new Ballpark();
  const target = spaceBall(park, { id: 1, x: 5e3, maxVelocity: 100 });
  park.setBallRadius(target.id, 50); // a frigate, more or less
  park.gotoDirection(target.id, 0, 1, 0);
  park.setBallVelocity(target.id, 0, 95, 0);
  const owner = spaceBall(park, { id: 2 });
  // Light and nimble, as TestMissile makes its missile.
  const missile = spaceBall(park, { id: 3, maxVelocity: 3000, mass: 1e4 });
  park.setBallAgility(missile.id, 0.01);
  park.launchMissile(missile.id, target.id, owner.id, 1, 1);
  assert.equal(missile.effectStamp, park.currentTime);
  assert.deepEqual(missile.goto, scale(vec(1, 0, 0), 1.0e16));
  park.evolve();
  // The launch tick: at the point far down the launch line, as a GOTO does.
  assert.deepEqual(missile.goto, scale(vec(1, 0, 0), 1.0e16));
  // After it: where the target will be once the missile could get there. Its range is minus both radii, so
  // none of the line between them is added: the point is the target's, led by its velocity.
  const [from, at, going] = [missile.newPos, target.newPos, target.newVel];
  park.evolve();
  const [dx, dy, dz] = [from.x - at.x, from.y - at.y, from.z - at.z];
  const cT = Math.sqrt(dx * dx + dy * dy + dz * dz) / missile.maxVelocity;
  assert.equal(missile.followRange + missile.radius + target.radius, 0);
  assert.deepEqual(missile.goto, vec(at.x + going.x * cT, at.y + going.y * cT, at.z + going.z * cT));
  assert.ok(missile.goto.y > at.y, "it aims ahead of the target, the way it is going");
  // It reaches the target: the tick it does, the two touch, and the target is among what it met.
  let hit = false;
  for (let tick = 0; tick < 10 && !hit; tick += 1) {
    park.evolve();
    hit = missile.collisions.includes(target.id);
  }
  assert.ok(hit, "it reaches the target");
  // The target gone, it flies on the way it was going, colliding with nothing.
  park.removeBall(target.id);
  assert.deepEqual([missile.mode, missile.isMassive], [MODE.GOTO, false]);
});

test("a missile meets only what it is aimed at, a defender missile what any ball meets, missiles too", () => {
  // A target far down x, and a bystander and a second missile on the way, all of them still.
  const flight = (ownerSign) => {
    const park = new Ballpark();
    const target = spaceBall(park, { id: 1, x: 1e5 });
    const owner = spaceBall(park, { id: 2 });
    const bystander = spaceBall(park, { id: 3, x: 1e3 });
    const other = spaceBall(park, { id: 4, x: 2e3 });
    park.missileFollow(other.id, target.id, 9);
    park.setSpeedFraction(other.id, 0);
    const missile = spaceBall(park, { id: 5, maxVelocity: 1000 });
    park.launchMissile(missile.id, target.id, ownerSign * owner.id, 1, 1);
    const met = new Set();
    for (let tick = 0; tick < 12; tick += 1) {
      park.evolve();
      for (const id of missile.collisions) met.add(id);
    }
    // Nothing it passed through has been touched by it.
    assert.ok(!owner.collisions.includes(missile.id) && !bystander.collisions.includes(missile.id) && !other.collisions.includes(missile.id));
    assert.equal(park.unported.minis, 0);
    return [...met].sort();
  };
  // A missile meets nothing on the way. A defender (owner id negative) meets the bystander and the other missile,
  // and its own launcher too: Gradient compares the neighbour's id with the owner id as signed, so it never matches.
  assert.deepEqual(flight(1), []);
  assert.deepEqual(flight(-1), [2, 3, 4]);
});

test("LaunchMissile is refused at a negative target, and does nothing for a launcher not in the park", () => {
  const park = new Ballpark();
  const missile = spaceBall(park, { id: 4, x: 7 });
  assert.throws(() => park.launchMissile(4, -1, 2, 1, 1), /Can not launch missile on a negative ballID/);
  park.launchMissile(4, 1, 2, 1, 1);
  assert.deepEqual([missile.mode, missile.newPos], [MODE.STOP, vec(7, 0, 0)]);
});

test("a missile read in from a state is stepped like any other ball, and the park's clock goes on", () => {
  const park = new Ballpark();
  park.readState(blobOf([
    record({ id: 1, position: vec(1e6, 0, 0), flags: FLAG.FREE | FLAG.MASSIVE }),
    record({ id: 2, mode: MODE.MISSILE, maxVelocity: 3000, followId: 1, followRange: -20, ownerId: 3, effectStamp: 400, goto: vec(1e16, 0, 0) }),
  ]));
  const missile = park.ball(2);
  assert.equal(missile.followPtr, park.ball(1));
  const time = park.currentTime;
  evolveTimes(park, 5);
  assert.equal(park.currentTime, time + 5);
  assert.ok(missile.newPos.x > 0 && missile.newVel.x > 0);
});
