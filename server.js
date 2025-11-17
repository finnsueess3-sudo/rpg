// server.js — Pro multiplayer server (authoritative)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use('/', express.static('public'));

const TICK_RATE = 20; // Hz
const MAP_TILES = 200;
const TILE_SIZE = 32;
const MAP_PX = MAP_TILES * TILE_SIZE;
const MAX_PLAYERS = 50; // server-side cap

function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function tileToPx(t){ return t * TILE_SIZE; }

function rectsOverlap(a,b){ return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h); }
function facingToAngle(f){ if(f==='up') return -Math.PI/2; if(f==='down') return Math.PI/2; if(f==='left') return Math.PI; return 0; }

const world = { tiles: MAP_TILES, tileSize: TILE_SIZE, houses: [], trees: [], rocks: [] };
(function generateWorld(){
  for(let i=0;i<64;i++){
    const hx = randInt(4, MAP_TILES-6);
    const hy = randInt(4, MAP_TILES-6);
    world.houses.push({ x: hx, y: hy, w: randInt(2,4), h: randInt(2,3), color: randChoice(['#b3542c','#7b4b2b','#9b7a4b']) });
  }
  for(let i=0;i<1200;i++){
    world.trees.push({ x: Math.random()*(MAP_TILES-4)+2, y: Math.random()*(MAP_TILES-4)+2, s: Math.random()*0.7+0.4 });
  }
  for(let i=0;i<320;i++){
    world.rocks.push({ x: Math.random()*(MAP_TILES-4)+2, y: Math.random()*(MAP_TILES-4)+2, s: Math.random()*0.5+0.4 });
  }
})();

// 8 classes definition
const CLASSES = {
  ninja:    { maxHp:3,  weapon:'dash',  cooldown:0.9, damage:2 },
  mage:     { maxHp:5,  weapon:'bolt',  cooldown:0.6, damage:2 },
  warrior:  { maxHp:8,  weapon:'sword', cooldown:0.7, damage:3 },
  archer:   { maxHp:5,  weapon:'arrow', cooldown:0.6, damage:2 },
  paladin:  { maxHp:9,  weapon:'smite', cooldown:1.2, damage:3 },
  rogue:    { maxHp:4,  weapon:'stab',  cooldown:0.5, damage:2.5 },
  cleric:   { maxHp:6,  weapon:'heal',  cooldown:2.0, damage:0 },
  berserker:{ maxHp:10, weapon:'rage',  cooldown:1.0, damage:4 }
};

// server state
const players = {}; // socketId -> player
const serverProjectiles = []; // projectiles with id, owner, x,y,vx,vy,life,type,damage
const MAX_PROJECTILES = 400;

// helper spawn
function findSpawn(){
  for(let tries=0; tries<300; tries++){
    const x = Math.floor(Math.random()*(MAP_PX-200))+100;
    const y = Math.floor(Math.random()*(MAP_PX-200))+100;
    const box = { x, y, w: 22, h: 28 };
    let bad = false;
    for(const h of world.houses){
      const hx = tileToPx(h.x) - TILE_SIZE*0.5;
      const hy = tileToPx(h.y) - TILE_SIZE*0.6;
      const hw = h.w*TILE_SIZE + TILE_SIZE; const hh = h.h*TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(box, {x: hx, y: hy, w: hw, h: hh})){ bad = true; break; }
    }
    if(!bad) return { x, y };
  }
  return { x: MAP_PX/2 + Math.random()*200-100, y: MAP_PX/2 + Math.random()*200-100 };
}

function createPlayer(id, clsName, name){
  const spawn = findSpawn();
  const cls = CLASSES[clsName] || CLASSES.warrior;
  return {
    id,
    name: name || clsName || 'player',
    classType: clsName || 'warrior',
    x: spawn.x, y: spawn.y, w:22, h:28,
    vx:0, vy:0, facing:'down', speed:150,
    hp: cls.maxHp, maxHp: cls.maxHp, cooldown:0,
    weapon: cls.weapon, attackCooldownBase: cls.cooldown, damage: cls.damage,
    xp:0, level:1,
    lastSeen: Date.now()
  };
}

// handle connections
io.on('connection', socket => {
  // limit
  if(Object.keys(players).length >= MAX_PLAYERS){
    socket.emit('full'); socket.disconnect(true); return;
  }

  // send world immediately
  socket.emit('world', { world, mapPx: MAP_PX });

  // spawn event must include classType and optional name
  socket.on('spawn', payload => {
    if(players[socket.id]) return; // already spawned
    const cls = payload && payload.classType ? payload.classType : 'warrior';
    if(!CLASSES[cls]) cls = 'warrior';
    const p = createPlayer(socket.id, cls, payload && payload.name);
    players[socket.id] = p;
    // inform this client
    socket.emit('init', { id: socket.id, player: p, players });
    // broadcast join
    socket.broadcast.emit('playerJoined', p);
  });

  // input from client
  socket.on('input', data => {
    const p = players[socket.id];
    if(!p) return;
    p.lastSeen = Date.now();
    // apply basic anti-cheat: clamp mx,my within [-1,1]
    const mx = clamp(data.mx || 0, -1, 1);
    const my = clamp(data.my || 0, -1, 1);
    p.vx = mx * p.speed;
    p.vy = my * p.speed;
    if(data.facing) p.facing = data.facing;
    if(data.attack){
      if(p.cooldown <= 0){
        handleAttackServer(p, data.attack);
        p.cooldown = p.attackCooldownBase;
      }
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// attack resolution: server authoritative, supports upgrades by level
function handleAttackServer(p, attackPayload){
  // attackPayload is currently unused; class determines behavior
  const cls = p.classType;

  // Level-based behavior:
  // Ninja: level1 dash, level>=2 also katana (melee on attack), level>=3 katana stronger
  // Mage: level1 bolt projectile, level>=3 beam (short continuous damage)
  // Warrior: sword arc with damage scaling
  // Archer: arrow projectile, level>=2 multi-shot
  // Paladin: smite (projectile) + level2 shield bash (melee)
  // Rogue: stab (higher crit chance at level2)
  // Cleric: heal ally (not implemented as no allies), or small heal self
  // Berserker: rage hit that does more damage per level

  if(cls === 'ninja'){
    // dash: teleport-ish small move if not blocked
    const dashDist = 140 + (p.level-1)*10;
    let dx=0, dy=0;
    if(p.facing==='left') dx=-dashDist;
    if(p.facing==='right') dx=dashDist;
    if(p.facing==='up') dy=-dashDist;
    if(p.facing==='down') dy=dashDist;
    const nx = clamp(p.x + dx, 0, MAP_PX);
    const ny = clamp(p.y + dy, 0, MAP_PX);
    const box = { x: nx, y: ny, w: p.w, h: p.h };
    // check house collision
    let blocked=false;
    for(const h of world.houses){
      const hx = tileToPx(h.x)-TILE_SIZE*0.5; const hy = tileToPx(h.y)-TILE_SIZE*0.6;
      const hw = h.w*TILE_SIZE + TILE_SIZE; const hh = h.h*TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(box, {x:hx,y:hy,w:hw,h:hh})){ blocked=true; break; }
    }
    if(!blocked){ p.x = nx; p.y = ny; }
    // damage anyone nearby at end
    for(const id in players){
      if(id === p.id) continue;
      const t = players[id];
      const dist = Math.hypot(t.x - p.x, t.y - p.y);
      if(dist < 48 + (p.level*2)){
        applyDamage(t, p.damage + Math.floor(p.level/2), p.id);
      }
    }
    // additional melee at level >=2: katana sweep around
    if(p.level >= 2){
      const arcRange = 96 + p.level*6;
      const arcHalf = Math.PI/2;
      const ang = facingToAngle(p.facing);
      for(const id in players){
        if(id===p.id) continue;
        const t = players[id];
        const dx2 = t.x - p.x, dy2 = t.y - p.y; const dist = Math.hypot(dx2, dy2);
        if(dist > arcRange) continue;
        const a = Math.atan2(dy2, dx2); const diff = Math.abs(normAngle(a - ang));
        if(diff <= arcHalf){
          // katana damage scales with level
          applyDamage(t, p.damage + 1 + Math.floor(p.level/2), p.id);
        }
      }
    }
  } else if(cls === 'warrior'){
    // sword arc
    const range = 96 + p.level*4;
    const arcHalf = Math.PI/3;
    const ang = facingToAngle(p.facing);
    for(const id in players){
      if(id===p.id) continue;
      const t = players[id];
      const dx = t.x - p.x, dy = t.y - p.y; const dist = Math.hypot(dx, dy);
      if(dist > range) continue;
      const a = Math.atan2(dy, dx);
      if(Math.abs(normAngle(a - ang)) <= arcHalf){
        applyDamage(t, p.damage + Math.floor((p.level-1)/1.5), p.id);
      }
    }
  } else if(cls === 'mage'){
    if(p.level >= 3){
      // short beam: damage all in a short cone multiple times -> approximate by instant damage to anyone in line up to range
      const range = 220 + (p.level-3)*30;
      const ang = facingToAngle(p.facing);
      for(const id in players){
        if(id===p.id) continue;
        const t = players[id];
        const dx = t.x - p.x, dy = t.y - p.y; const dist = Math.hypot(dx, dy);
        if(dist > range) continue;
        const a = Math.atan2(dy, dx);
        if(Math.abs(normAngle(a - ang)) < 0.2){
          applyDamage(t, p.damage + 1 + Math.floor((p.level-1)/2), p.id);
        }
      }
    } else {
      // bolt projectile
      spawnProjectile(p, 'bolt', facingToAngle(p.facing), 420 + p.level*20, p.damage + Math.floor(p.level/2));
    }
  } else if(cls === 'archer'){
    // arrow; level2 multi-shot
    spawnProjectile(p, 'arrow', facingToAngle(p.facing), 520 + p.level*10, p.damage + Math.floor(p.level/2));
    if(p.level >= 2){
      // small spread
      spawnProjectile(p, 'arrow', facingToAngle(p.facing) + 0.12, 520 + p.level*10, p.damage + Math.floor(p.level/2));
      spawnProjectile(p, 'arrow', facingToAngle(p.facing) - 0.12, 520 + p.level*10, p.damage + Math.floor(p.level/2));
    }
  } else if(cls === 'paladin'){
    // smite: medium-range projectile, level2 shield bash melee
    spawnProjectile(p, 'smite', facingToAngle(p.facing), 380 + p.level*12, p.damage + Math.floor(p.level/2));
    if(p.level >= 2){
      // shield bash melee close
      for(const id in players){
        if(id===p.id) continue;
        const t = players[id];
        if(Math.hypot(t.x - p.x, t.y - p.y) < 60){
          applyDamage(t, p.damage + 1, p.id);
        }
      }
    }
  } else if(cls === 'rogue'){
    // stab: high crit chance at levels
    let dmg = p.damage + Math.floor(p.level/2);
    if(p.level >= 2 && Math.random() < 0.25) dmg *= 2; // crit
    // stab hits single closest player in front within short range
    let best = null, bestDist = 1e9;
    const ang = facingToAngle(p.facing);
    for(const id in players){
      if(id===p.id) continue;
      const t = players[id];
      const dx = t.x - p.x, dy = t.y - p.y; const dist = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx); if(Math.abs(normAngle(a - ang)) > 0.6) continue;
      if(dist < bestDist){ bestDist = dist; best = t; }
    }
    if(best && bestDist < 80) applyDamage(best, dmg, p.id);
  } else if(cls === 'cleric'){
    // heal self for small amount if any heal available
    const heal = 2 + Math.floor(p.level/2);
    p.hp = Math.min(p.maxHp, p.hp + heal);
    // cooldown already applied
  } else if(cls === 'berserker'){
    // rage hit: larger damage, self HP penalty at high levels
    for(const id in players){
      if(id===p.id) continue;
      const t = players[id];
      if(Math.hypot(t.x - p.x, t.y - p.y) < 80 + p.level*3){
        applyDamage(t, p.damage + Math.floor(p.level), p.id);
        // small recoil to self
        p.hp = Math.max(1, p.hp - 1);
      }
    }
  }
}

function spawnProjectile(owner, type, angle, speed, dmg){
  if(serverProjectiles.length > MAX_PROJECTILES) return;
  const pr = {
    id: 'proj_' + uuidv4().slice(0,8),
    owner: owner.id,
    x: owner.x + owner.w/2,
    y: owner.y + owner.h/2,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: type === 'bolt' ? 2.0 : 3.0,
    damage: dmg,
    type
  };
  serverProjectiles.push(pr);
}

// apply damage, xp and respawn logic
function applyDamage(target, dmg, fromId){
  if(!target) return;
  target.hp -= dmg;
  io.to(target.id).emit('hit', { dmg, from: fromId });
  if(target.hp <= 0){
    // award xp to killer
    const killer = players[fromId];
    if(killer){
      killer.xp = (killer.xp || 0) + 10;
      const prevLevel = killer.level || 1;
      killer.level = Math.floor(killer.xp / 20) + 1;
      if(killer.level > prevLevel){
        // level up: increase stats moderately
        killer.maxHp += 1;
        killer.hp = Math.min(killer.maxHp, killer.hp + 2);
        killer.damage = (killer.damage || 1) + 0.5;
      }
    }
    // notify and respawn target after delay
    io.to(target.id).emit('died', { by: fromId });
    const deadId = target.id;
    setTimeout(()=>{
      const sp = findSpawn();
      target.x = sp.x; target.y = sp.y;
      target.hp = target.maxHp;
      // broadcast respawn
      io.emit('playerRespawn', { id: deadId, x: target.x, y: target.y, hp: target.hp });
    }, 1200);
  } else {
    // minor server notify to all to show hit effect on target
    io.emit('playerHitFlash', { id: target.id });
  }
}

// norm angle utility
function normAngle(a){ while(a <= -Math.PI) a += Math.PI*2; while(a > Math.PI) a -= Math.PI*2; return a; }

// server tick loop
setInterval(()=> {
  const dt = 1 / TICK_RATE;
  // integrate players movement with simple house collision
  for(const id in players){
    const p = players[id];
    // integrate
    const nx = clamp(p.x + p.vx * dt, 0, MAP_PX);
    const ny = clamp(p.y + p.vy * dt, 0, MAP_PX);
    const box = { x: nx, y: ny, w: p.w, h: p.h };
    let blocked=false;
    for(const h of world.houses){
      const hx = tileToPx(h.x)-TILE_SIZE*0.5; const hy = tileToPx(h.y)-TILE_SIZE*0.6;
      const hw = h.w*TILE_SIZE + TILE_SIZE; const hh = h.h*TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(box, {x:hx,y:hy,w:hw,h:hh})){ blocked=true; break; }
    }
    if(!blocked){ p.x = nx; p.y = ny; }
    if(p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - dt);
  }

  // projectiles movement and collision vs players
  for(let i = serverProjectiles.length - 1; i >= 0; i--){
    const pr = serverProjectiles[i];
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.life -= dt;
    // remove if out of bounds
    if(pr.x < 0 || pr.y < 0 || pr.x > MAP_PX || pr.y > MAP_PX || pr.life <= 0){
      serverProjectiles.splice(i,1);
      continue;
    }
    // collision with players (not owner)
    for(const id in players){
      if(id === pr.owner) continue;
      const t = players[id];
      const box = { x: t.x, y: t.y, w: t.w, h: t.h };
      if(pr.x >= box.x && pr.x <= box.x + box.w && pr.y >= box.y && pr.y <= box.y + box.h){
        applyDamage(t, pr.damage, pr.owner);
        serverProjectiles.splice(i,1);
        break;
      }
    }
  }

  // snapshot prepare
  const snap = { t: Date.now(), players: {}, projectiles: [] };
  for(const id in players){
    const p = players[id];
    snap.players[id] = { x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, classType: p.classType, xp: p.xp, level: p.level, facing: p.facing };
  }
  for(const pr of serverProjectiles){
    snap.projectiles.push({ id: pr.id, x: pr.x, y: pr.y, type: pr.type });
  }

  io.emit('snapshot', snap);

}, 1000 / TICK_RATE);

// cleanup stale players
setInterval(()=>{
  const now = Date.now();
  for(const id in players){
    if(now - players[id].lastSeen > 1000 * 30){
      delete players[id];
      io.emit('playerLeft', id);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Server listening on', PORT));
