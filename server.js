const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use('/', express.static('public'));

const TICK_RATE = 20;
const MAP_TILES = 200;
const TILE_SIZE = 32;
const MAP_PX = MAP_TILES * TILE_SIZE;
const MAX_PLAYERS = 50;

// helper functions
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function rectsOverlap(a,b){ return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h); }
function facingToAngle(f){ if(f==='up') return -Math.PI/2; if(f==='down') return Math.PI/2; if(f==='left') return Math.PI; return 0; }
function normAngle(a){ while(a <= -Math.PI) a += Math.PI*2; while(a > Math.PI) a -= Math.PI*2; return a; }
function tileToPx(t){ return t * TILE_SIZE; }

// --- world ---
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

// --- classes ---
const CLASSES = {
  ninja:    { maxHp:3,  weapon:'dash', cooldown:0.9, damage:2, ultiCooldown: 15 },
  mage:     { maxHp:5,  weapon:'bolt', cooldown:0.6, damage:2, ultiCooldown: 20 },
  warrior:  { maxHp:8,  weapon:'sword', cooldown:0.7, damage:3, ultiCooldown: 18 },
  archer:   { maxHp:5,  weapon:'arrow', cooldown:0.6, damage:2, ultiCooldown: 20 },
  paladin:  { maxHp:9,  weapon:'smite', cooldown:1.2, damage:3, ultiCooldown: 25 },
  rogue:    { maxHp:4,  weapon:'stab',  cooldown:0.5, damage:2.5, ultiCooldown: 15 },
  cleric:   { maxHp:6,  weapon:'heal',  cooldown:2.0, damage:0, ultiCooldown: 30 },
  berserker:{ maxHp:10, weapon:'rage',  cooldown:1.0, damage:4, ultiCooldown: 20 },
  dragon:   { maxHp:12, weapon:'fire',  cooldown:1.2, damage:5, ultiCooldown: 40 }
};

// --- server state ---
const players = {}; 
const serverProjectiles = [];
const MAX_PROJECTILES = 400;

// --- spawn ---
function findSpawn(){
  for(let tries=0; tries<300; tries++){
    const x = Math.floor(Math.random()*(MAP_PX-200))+100;
    const y = Math.floor(Math.random()*(MAP_PX-200))+100;
    const box = { x, y, w: 22, h: 28 };
    let blocked = false;
    for(const h of world.houses){
      const hx = tileToPx(h.x)-TILE_SIZE*0.5; const hy = tileToPx(h.y)-TILE_SIZE*0.6;
      const hw = h.w*TILE_SIZE + TILE_SIZE; const hh = h.h*TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(box, {x:hx,y:hy,w:hw,h:hh})){ blocked=true; break; }
    }
    if(!blocked) return { x, y };
  }
  return { x: MAP_PX/2 + Math.random()*200-100, y: MAP_PX/2 + Math.random()*200-100 };
}

function createPlayer(id, clsName, name){
  const spawn = findSpawn();
  const cls = CLASSES[clsName] || CLASSES.warrior;
  return {
    id, name: name || clsName || 'player',
    classType: clsName, x: spawn.x, y: spawn.y, w:22, h:28,
    vx:0, vy:0, facing:'down', speed:150,
    hp: cls.maxHp, maxHp: cls.maxHp, cooldown:0, ulti:0,
    weapon: cls.weapon, attackCooldownBase: cls.cooldown, damage: cls.damage,
    xp:0, level:1, ultiCooldown: cls.ultiCooldown,
    lastSeen: Date.now()
  };
}

// --- connection ---
io.on('connection', socket => {
  if(Object.keys(players).length >= MAX_PLAYERS){
    socket.emit('full'); socket.disconnect(true); return;
  }

  socket.emit('world', { world, mapPx: MAP_PX });

  socket.on('spawn', payload => {
    if(players[socket.id]) return;
    const p = createPlayer(socket.id, payload.classType, payload.name);
    players[socket.id] = p;
    socket.emit('init', { id: socket.id, player: p, players });
    socket.broadcast.emit('playerJoined', p);
  });

  socket.on('input', data => {
    const p = players[socket.id];
    if(!p) return;
    p.lastSeen = Date.now();
    p.vx = clamp(data.mx||0,-1,1) * p.speed;
    p.vy = clamp(data.my||0,-1,1) * p.speed;
    if(data.facing) p.facing = data.facing;
    if(data.attack && p.cooldown<=0){
      handleAttackServer(p, data.attack);
      p.cooldown = p.attackCooldownBase;
    }
    if(data.ulti && p.ulti<=0){
      handleUltServer(p);
      p.ulti = p.ultiCooldown;
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// --- attack ---
function handleAttackServer(p){
  const cls = p.classType;
  if(cls==='ninja'){ ninjaAttack(p); }
  else if(cls==='warrior'){ warriorAttack(p); }
  else if(cls==='mage'){ mageAttack(p); }
  else if(cls==='archer'){ archerAttack(p); }
  else if(cls==='paladin'){ paladinAttack(p); }
  else if(cls==='rogue'){ rogueAttack(p); }
  else if(cls==='cleric'){ clericAttack(p); }
  else if(cls==='berserker'){ berserkerAttack(p); }
  else if(cls==='dragon'){ dragonAttack(p); }
}

// --- ult ---
function handleUltServer(p){
  // simple example ult effects per class
  const cls = p.classType;
  io.emit('ultTriggered', {id: p.id, classType: cls});
  if(cls==='ninja'){ /* aoe poison */ }
  else if(cls==='mage'){ /* lightning beam */ }
  else if(cls==='warrior'){ /* whirlwind */ }
  else if(cls==='archer'){ /* raining arrows */ }
  else if(cls==='paladin'){ /* shield boost + melee bash */ }
  else if(cls==='rogue'){ /* invis + speed */ }
  else if(cls==='cleric'){ /* mass heal */ }
  else if(cls==='berserker'){ /* rage hit */ }
  else if(cls==='dragon'){ /* transform + fire beam */ }
}

// --- simplified class attacks ---
function ninjaAttack(p){ dealNearby(p, 48, p.damage); }
function warriorAttack(p){ dealArc(p, 96, Math.PI/3, p.damage); }
function mageAttack(p){ spawnProjectile(p,'bolt', facingToAngle(p.facing), 420+p.level*20, p.damage); }
function archerAttack(p){ spawnProjectile(p,'arrow', facingToAngle(p.facing), 520+p.level*10, p.damage); }
function paladinAttack(p){ spawnProjectile(p,'smite', facingToAngle(p.facing), 380+p.level*12, p.damage); }
function rogueAttack(p){ stabClosest(p, 80, p.damage); }
function clericAttack(p){ p.hp=Math.min(p.maxHp,p.hp+2); }
function berserkerAttack(p){ dealNearby(p,80+p.level*3,p.damage); p.hp=Math.max(1,p.hp-1); }
function dragonAttack(p){ spawnProjectile(p,'fire', facingToAngle(p.facing), 500, p.damage); }

// --- damage helpers ---
function dealNearby(p, radius, dmg){
  for(const id in players){
    if(id===p.id) continue;
    const t=players[id];
    const dist=Math.hypot(t.x-p.x,t.y-p.y);
    if(dist<radius) applyDamage(t,dmg,p.id);
  }
}
function dealArc(p, radius, halfAngle, dmg){
  const ang=facingToAngle(p.facing);
  for(const id in players){
    if(id===p.id) continue;
    const t=players[id];
    const dx=t.x-p.x, dy=t.y-p.y; const dist=Math.hypot(dx,dy);
    if(dist>radius) continue;
    const a=Math.atan2(dy,dx);
    if(Math.abs(normAngle(a-ang))<=halfAngle) applyDamage(t,dmg,p.id);
  }
}
function stabClosest(p, range, dmg){
  let best=null, bestDist=1e9;
  const ang=facingToAngle(p.facing);
  for(const id in players){
    if(id===p.id) continue;
    const t=players[id];
    const dx=t.x-p.x, dy=t.y-p.y; const dist=Math.hypot(dx,dy);
    if(dist<bestDist && Math.abs(normAngle(Math.atan2(dy,dx)-ang))<0.6){ best=t; bestDist=dist; }
  }
  if(best && bestDist<range) applyDamage(best,dmg,p.id);
}

// --- projectiles ---
function spawnProjectile(owner,type,angle,speed,dmg){
  if(serverProjectiles.length>MAX_PROJECTILES) return;
  serverProjectiles.push({ id:'proj_'+uuidv4().slice(0,8), owner: owner.id, x: owner.x+owner.w/2, y: owner.y+owner.h/2, vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed, life: type==='bolt'?2:3, damage:dmg, type });
}

// --- apply damage ---
function applyDamage(target,dmg,fromId){
  if(!target) return;
  target.hp-=dmg;
  io.to(target.id).emit('hit',{dmg,from:fromId});
  if(target.hp<=0){
    const killer=players[fromId];
    if(killer){ killer.xp=(killer.xp||0)+10; const prev=killer.level||1; killer.level=Math.floor(killer.xp/20)+1; if(killer.level>prev){ killer.maxHp+=1; killer.hp=Math.min(killer.maxHp,killer.hp+2); killer.damage=(killer.damage||1)+0.5; } }
    const deadId=target.id;
    setTimeout(()=>{
      const sp=findSpawn();
      target.x=sp.x; target.y=sp.y; target.hp=target.maxHp;
      io.emit('playerRespawn',{id:deadId,x:target.x,y:target.y,hp:target.hp});
    },1200);
  } else { io.emit('playerHitFlash',{id:target.id}); }
}

// --- server tick ---
setInterval(()=>{
  const dt=1/TICK_RATE;
  for(const id in players){
    const p=players[id];
    const nx=clamp(p.x+p.vx*dt,0,MAP_PX);
    const ny=clamp(p.y+p.vy*dt,0,MAP_PX);
    const box={x:nx,y:ny,w:p.w,h:p.h};
    let blocked=false;
    for(const h of world.houses){
      const hx=tileToPx(h.x)-TILE_SIZE*0.5; const hy=tileToPx(h.y)-TILE_SIZE*0.6;
      const hw=h.w*TILE_SIZE+TILE_SIZE; const hh=h.h*TILE_SIZE+TILE_SIZE*0.6;
      if(rectsOverlap(box,{x:hx,y:hy,w:hw,h:hh})){ blocked=true; break; }
    }
    if(!blocked){ p.x=nx; p.y=ny; }
    if(p.cooldown>0) p.cooldown=Math.max(0,p.cooldown-dt);
    if(p.ulti>0) p.ulti=Math.max(0,p.ulti-dt);
  }

  for(let i=serverProjectiles.length-1;i>=0;i--){
    const pr=serverProjectiles[i];
    pr.x+=pr.vx*dt; pr.y+=pr.vy*dt; pr.life-=dt;
    if(pr.x<0||pr.y<0||pr.x>MAP_PX||pr.y>MAP_PX||pr.life<=0){ serverProjectiles.splice(i,1); continue; }
    for(const id in players){
      if(id===pr.owner) continue;
      const t=players[id];
      const box={x:t.x,y:t.y,w:t.w,h:t.h};
      if(pr.x>=box.x && pr.x<=box.x+box.w && pr.y>=box.y && pr.y<=box.y+box.h){ applyDamage(t,pr.damage,pr.owner); serverProjectiles.splice(i,1); break; }
    }
  }

  const snap={t:Date.now(),players:{},projectiles:[]};
  for(const id in players){
    const p=players[id];
    snap.players[id]={x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,classType:p.classType,xp:p.xp,level:p.level,facing:p.facing};
  }
  for(const pr of serverProjectiles) snap.projectiles.push({id:pr.id,x:pr.x,y:pr.y,type:pr.type});
  io.emit('snapshot',snap);

},1000/TICK_RATE);

// --- cleanup ---
setInterval(()=>{
  const now=Date.now();
  for(const id in players){
    if(now-players[id].lastSeen>1000*30){ delete players[id]; io.emit('playerLeft',id); }
  }
},5000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Server listening on',PORT));
