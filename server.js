// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// serve static
app.use('/', express.static('public'));

const TICK_RATE = 20; // server ticks per second
const MAP_TILES = 200; // medium map (200x200 tiles)
const TILE_SIZE = 32;
const MAP_PX = MAP_TILES * TILE_SIZE;
const MAX_PLAYERS = 20;

function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

// Procedural world objects (houses, trees, rocks) generated on server and shared
const world = { tiles: MAP_TILES, tileSize: TILE_SIZE, houses: [], trees: [], rocks: [] };
(function generateWorld(){
  for(let i=0;i<48;i++){
    const hx = randInt(4, MAP_TILES-6);
    const hy = randInt(4, MAP_TILES-6);
    world.houses.push({ x: hx, y: hy, w: randInt(2,4), h: randInt(2,3), color: randChoice(['#b3542c','#7b4b2b','#9b7a4b']) });
  }
  for(let i=0;i<900;i++){
    world.trees.push({ x: Math.random()*(MAP_TILES-4)+2, y: Math.random()*(MAP_TILES-4)+2, s: Math.random()*0.7+0.4 });
  }
  for(let i=0;i<240;i++){
    world.rocks.push({ x: Math.random()*(MAP_TILES-4)+2, y: Math.random()*(MAP_TILES-4)+2, s: Math.random()*0.5+0.4 });
  }
})();

// players storage
const players = {}; // socketId -> player object
let socketCount = 0;

const CLASSES = {
  ninja: { maxHp: 3, weapon: 'dash', cooldown: 0.8, damage: 2 },
  mage:  { maxHp: 5, weapon: 'bolt', cooldown: 0.5, damage: 2 },
  warrior:{ maxHp:8, weapon: 'sword', cooldown: 0.6, damage: 3 },
  archer:{ maxHp:5, weapon: 'arrow', cooldown: 0.6, damage: 2 }
};

// helper
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function tileToPx(t){ return t * TILE_SIZE; }
function pxToTile(p){ return Math.floor(p / TILE_SIZE); }

// basic rectangle overlap
function rectsOverlap(a,b){ return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h); }

// generate spawn position avoiding colliders
function findSpawn(){
  for(let tries=0; tries<200; tries++){
    const x = Math.floor(Math.random()*(MAP_PX-200))+100;
    const y = Math.floor(Math.random()*(MAP_PX-200))+100;
    const box = { x, y, w: 22, h: 28 };
    let bad = false;
    for(const h of world.houses){
      const hx = tileToPx(h.x) - TILE_SIZE*0.5;
      const hy = tileToPx(h.y) - TILE_SIZE*0.6;
      const hw = h.w*TILE_SIZE + TILE_SIZE;
      const hh = h.h*TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(box, {x: hx, y: hy, w: hw, h: hh})){ bad=true; break; }
    }
    if(!bad) return { x, y };
  }
  // fallback
  return { x: MAP_PX/2 + Math.random()*200-100, y: MAP_PX/2 + Math.random()*200-100 };
}

// create player object for server
function createPlayer(id, chosenClass){
  const spawn = findSpawn();
  const cls = CLASSES[chosenClass] || CLASSES.warrior;
  return {
    id,
    name: chosenClass || 'warrior',
    classType: chosenClass || 'warrior',
    x: spawn.x,
    y: spawn.y,
    w: 22, h: 28,
    vx: 0, vy: 0,
    facing: 'down',
    speed: 150,
    hp: cls.maxHp,
    maxHp: cls.maxHp,
    cooldown: 0,
    xp: 0,
    level: 1,
    weapon: cls.weapon,
    attackCooldownBase: cls.cooldown,
    damage: cls.damage,
    lastInputSeq: 0,
    lastSeen: Date.now()
  };
}

// server accepts connections
io.on('connection', socket => {
  if(Object.keys(players).length >= MAX_PLAYERS){
    socket.emit('full');
    socket.disconnect(true);
    return;
  }
  socketCount++;
  console.log('conn', socket.id);

  // send world
  socket.emit('world', { world, mapPx: MAP_PX });

  // create player on 'spawn' event after client chooses class
  socket.on('spawn', (payload) => {
    const cls = payload && payload.classType ? payload.classType : 'warrior';
    const p = createPlayer(socket.id, cls);
    players[socket.id] = p;
    socket.emit('init', { id: socket.id, player: p, players });
    socket.broadcast.emit('playerJoined', p);
  });

  // receive inputs: movement vector, facing, seq
  socket.on('input', (data) => {
    const p = players[socket.id];
    if(!p) return;
    p.lastSeen = Date.now();
    // data: { seq, mx, my, facing }
    p.lastInputSeq = data.seq || p.lastInputSeq;
    p.vx = data.mx * p.speed;
    p.vy = data.my * p.speed;
    p.facing = data.facing || p.facing;
    // attack requests
    if(data.attack){
      // attempt attack if cooldown ready
      if(p.cooldown <= 0){
        handleAttack(p, data.attack); // attackType may depend on class
        p.cooldown = p.attackCooldownBase;
      }
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    socket.broadcast.emit('playerLeft', socket.id);
    console.log('left', socket.id);
  });
});

// attack resolution (server authoritative)
function handleAttack(p, attackPayload){
  const cls = p.classType;
  if(cls === 'ninja'){
    // dash: move player quickly for a short time (instantly adjust pos), check collisions with other players
    const dashDist = 160;
    let dx = 0, dy = 0;
    if(p.facing === 'left') dx = -dashDist;
    if(p.facing === 'right') dx = dashDist;
    if(p.facing === 'up') dy = -dashDist;
    if(p.facing === 'down') dy = dashDist;
    const newX = clamp(p.x + dx, 0, MAP_PX);
    const newY = clamp(p.y + dy, 0, MAP_PX);
    // simple collision with houses: don't apply if collides
    const newBox = { x: newX, y: newY, w: p.w, h: p.h };
    let blocked = false;
    for(const h of world.houses){
      const hx = tileToPx(h.x) - TILE_SIZE*0.5; const hy = tileToPx(h.y) - TILE_SIZE*0.6;
      const hw = h.w*TILE_SIZE + TILE_SIZE; const hh = h.h*TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(newBox, {x: hx, y: hy, w: hw, h: hh})){ blocked = true; break; }
    }
    if(!blocked){
      p.x = newX; p.y = newY;
      // hit any players in small radius from dash endpoint
      for(const id in players){
        if(id === p.id) continue;
        const targ = players[id];
        const dx2 = targ.x - p.x, dy2 = targ.y - p.y;
        const dist2 = Math.hypot(dx2, dy2);
        if(dist2 < 48){
          applyDamage(targ, p.damage, p.id);
        }
      }
    }
  } else if(cls === 'warrior'){
    // short-range arc: hit players in front within range and angle
    const range = 96;
    const arcHalf = Math.PI/3;
    const ang = facingToAngle(p.facing);
    for(const id in players){
      if(id === p.id) continue;
      const targ = players[id];
      const dx = targ.x - p.x, dy = targ.y - p.y;
      const dist = Math.hypot(dx, dy);
      if(dist > range) continue;
      const a = Math.atan2(dy, dx);
      let diff = Math.abs(normAngle(a - ang));
      if(diff <= arcHalf){
        applyDamage(targ, p.damage, p.id);
      }
    }
  } else if(cls === 'mage' || cls === 'archer'){
    // spawn a server-side projectile with simple lifetime
    // store in global projectiles list for tic update
    const speed = cls === 'mage' ? 420 : 520;
    const ang = facingToAngle(p.facing);
    const vx = Math.cos(ang) * speed, vy = Math.sin(ang) * speed;
    const proj = {
      id: 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2,8),
      owner: p.id,
      x: p.x + p.w/2,
      y: p.y + p.h/2,
      vx, vy,
      life: cls === 'mage' ? 2.0 : 3.0,
      damage: p.damage,
      type: cls === 'mage' ? 'bolt' : 'arrow'
    };
    serverProjectiles.push(proj);
  }
}

// damage
function applyDamage(target, dmg, fromId){
  if(!target) return;
  target.hp -= dmg;
  // notify target client
  io.to(target.id).emit('hit', { dmg, from: fromId });
  // death
  if(target.hp <= 0){
    // award xp to killer
    const killer = players[fromId];
    if(killer){
      killer.xp = (killer.xp || 0) + 10;
      // level up at thresholds: every 20 xp
      const lvlBefore = killer.level || 1;
      killer.level = Math.floor((killer.xp / 20)) + 1;
      if(killer.level > lvlBefore){
        killer.maxHp += 1;
        killer.hp = Math.min(killer.maxHp, killer.hp + 2);
        killer.damage += 0.5;
      }
    }
    // respawn target after short delay
    const deadId = target.id;
    io.to(deadId).emit('died', { by: fromId });
    // schedule respawn
    setTimeout(()=>{
      const spawn = findSpawn();
      target.x = spawn.x; target.y = spawn.y;
      target.hp = target.maxHp;
      // inform all clients about respawn
      io.emit('playerRespawn', { id: deadId, x: target.x, y: target.y, hp: target.hp });
    }, 1200);
  }
}

// simple projectiles list + server update loop
const serverProjectiles = [];

function facingToAngle(f){
  if(f === 'up') return -Math.PI/2;
  if(f === 'down') return Math.PI/2;
  if(f === 'left') return Math.PI;
  return 0;
}
function normAngle(a){
  while(a <= -Math.PI) a += Math.PI*2;
  while(a > Math.PI) a -= Math.PI*2;
  return a;
}

// server tick: update movement, projectiles, broadcast
setInterval(()=>{
  // update players positions based on vx/vy and simple collision vs houses
  const dt = 1 / TICK_RATE;
  for(const id in players){
    const p = players[id];
    // simple integration
    const nx = clamp(p.x + p.vx * dt, 0, MAP_PX);
    const ny = clamp(p.y + p.vy * dt, 0, MAP_PX);
    const box = { x: nx, y: ny, w: p.w, h: p.h };
    let blocked = false;
    for(const h of world.houses){
      const hx = tileToPx(h.x) - TILE_SIZE*0.5;
      const hy = tileToPx(h.y) - TILE_SIZE*0.6;
      const hw = h.w*TILE_SIZE + TILE_SIZE; const hh = h.h*TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(box, {x: hx, y: hy, w: hw, h: hh})){ blocked = true; break; }
    }
    if(!blocked){
      p.x = nx; p.y = ny;
    }
    // cooldown tick
    if(p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - dt);
  }

  // projectiles
  for(let i = serverProjectiles.length-1; i >= 0; i--){
    const pr = serverProjectiles[i];
    pr.x += pr.vx * (1 / TICK_RATE);
    pr.y += pr.vy * (1 / TICK_RATE);
    pr.life -= (1 / TICK_RATE);
    // check collisions with players (not owner)
    for(const id in players){
      if(id === pr.owner) continue;
      const t = players[id];
      const box = { x: t.x, y: t.y, w: t.w, h: t.h };
      if(pr.x >= box.x && pr.x <= box.x + box.w && pr.y >= box.y && pr.y <= box.y + box.h){
        applyDamage(t, pr.damage, pr.owner);
        // remove projectile
        serverProjectiles.splice(i,1);
        break;
      }
    }
    if(pr.life <= 0){
      // remove
      const idx = serverProjectiles.indexOf(pr);
      if(idx >= 0) serverProjectiles.splice(idx,1);
    }
  }

  // prepare snapshot (sparse)
  const snapshot = { t: Date.now(), players: {}, projectiles: [] };
  for(const id in players){
    const p = players[id];
    snapshot.players[id] = { x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, classType: p.classType, xp: p.xp || 0, level: p.level || 1, facing: p.facing };
  }
  for(const pr of serverProjectiles){
    snapshot.projectiles.push({ id: pr.id, x: pr.x, y: pr.y, type: pr.type });
  }

  // broadcast
  io.emit('snapshot', snapshot);
}, 1000 / TICK_RATE);

// small cleanup: disconnect stale players
setInterval(()=>{
  const now = Date.now();
  for(const id in players){
    if(now - players[id].lastSeen > 1000 * 30){ // 30s timeout
      delete players[id];
      io.emit('playerLeft', id);
    }
  }
}, 5000);

// start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port', PORT));
