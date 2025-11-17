// public/game.js — client (interpolation + prediction + minimap + animations)
const socket = io();
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const miniCanvas = document.getElementById('minimap');
const miniCtx = miniCanvas.getContext('2d');

const TILE = 32;
let world = null;
let mapPx = 0;
let myId = null;
let players = {}; // id -> {x,y,w,h,hp,maxHp,classType,level,xp,facing,prev,next}
let projectiles = [];
let lastSnapshot = null;

// HUD elements
const hudClass = document.getElementById('hud-class');
const hudHp = document.getElementById('hud-hp');
const hudXp = document.getElementById('hud-xp');
const hudInfo = document.getElementById('hud-info');

// spawn via classbar
document.querySelectorAll('#classbar button').forEach(b=> {
  b.addEventListener('click', ()=>{
    const cls = b.getAttribute('data-class');
    socket.emit('spawn', { classType: cls });
    hudInfo.textContent = 'Spawned as ' + cls + ' — click the canvas to focus';
  });
});

// focus canvas
canvas.addEventListener('click', ()=> canvas.focus());
canvas.focus();

// input
const inputState = { mx:0, my:0, facing:'down', attack:false };
const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true; if(e.code === 'Space'){ e.preventDefault(); inputState.attack = true; }});
window.addEventListener('keyup', e => { keys[e.code] = false; });

// receive world
socket.on('world', (data) => { world = data.world; mapPx = data.mapPx; hudInfo.textContent = 'World ready'; });

// init — after spawn
socket.on('init', (data) => {
  myId = data.id;
  // build players map from data.players
  players = {};
  for(const id in data.players){
    const p = data.players[id];
    players[id] = {
      x: p.x, y: p.y, w: p.w || 22, h: p.h || 28,
      hp: p.hp, maxHp: p.maxHp, classType: p.classType, xp: p.xp || 0, level: p.level || 1,
      facing: p.facing || 'down',
      prev: { x: p.x, y: p.y, t: performance.now() - 120 },
      next: { x: p.x, y: p.y, t: performance.now() }
    };
  }
  hudInfo.textContent = 'Spawned — control with WASD, Space to attack';
});

// player join/left
socket.on('playerJoined', p => {
  players[p.id] = {
    x: p.x, y: p.y, w: p.w || 22, h: p.h || 28,
    hp: p.hp, maxHp: p.maxHp, classType: p.classType, xp: p.xp || 0, level: p.level || 1,
    facing: p.facing || 'down',
    prev: { x: p.x, y: p.y, t: performance.now() - 120 },
    next: { x: p.x, y: p.y, t: performance.now() }
  };
});
socket.on('playerLeft', id => { delete players[id]; });

// snapshots
socket.on('snapshot', snap => {
  lastSnapshot = snap;
  const now = performance.now();
  for(const id in snap.players){
    const s = snap.players[id];
    if(!players[id]){
      players[id] = {
        x: s.x, y: s.y, w:22, h:28, hp: s.hp, maxHp: s.maxHp, classType: s.classType, xp: s.xp||0, level: s.level||1,
        facing: s.facing||'down', prev:{x:s.x,y:s.y,t:now-120}, next:{x:s.x,y:s.y,t:now}
      };
      continue;
    }
    const p = players[id];
    p.prev.x = p.next.x; p.prev.y = p.next.y; p.prev.t = p.next.t;
    p.next.x = s.x; p.next.y = s.y; p.next.t = now;
    p.hp = s.hp; p.maxHp = s.maxHp; p.classType = s.classType; p.xp = s.xp; p.level = s.level; p.facing = s.facing;
  }
  projectiles = snap.projectiles || [];
  updateHud();
});

// hit/died/respawn
socket.on('hit', d => { hudInfo.textContent = `Hit -${d.dmg}`; setTimeout(()=> hudInfo.textContent='',500); });
socket.on('died', d => { hudInfo.textContent = 'You died!'; setTimeout(()=> hudInfo.textContent='',1200); });
socket.on('playerRespawn', data => {
  if(players[data.id]){ players[data.id].x=data.x; players[data.id].y=data.y; players[data.id].hp=data.hp; }
});

// input send @20Hz
let seq = 0;
setInterval(()=> {
  if(!myId) return;
  let mx=0,my=0;
  if(keys['KeyW']){ my -= 1; inputState.facing = 'up'; }
  if(keys['KeyS']){ my += 1; inputState.facing = 'down'; }
  if(keys['KeyA']){ mx -= 1; inputState.facing = 'left'; }
  if(keys['KeyD']){ mx += 1; inputState.facing = 'right'; }
  if(mx !== 0 && my !== 0){ mx *= 0.7071; my *= 0.7071; }
  seq++;
  socket.emit('input', { seq, mx, my, facing: inputState.facing, attack: inputState.attack });
  inputState.attack = false;
}, 1000/20);

// interpolation/prediction
const INTERP_MS = 120; // delay
function lerp(a,b,t){ return a + (b-a) * t; }

// render loop ~60fps
function renderLoop(){
  requestAnimationFrame(renderLoop);
  if(!world) return;

  // determine camera (center on predicted local player)
  const me = players[myId];
  let camx=0, camy=0;
  if(me){
    const now = performance.now();
    let predX = me.next.x, predY = me.next.y;
    // simple local extrapolation small amount (we don't keep local inputs history; server authoritative)
    predX = lerp(me.prev.x, me.next.x, 0.9);
    predY = lerp(me.prev.y, me.next.y, 0.9);
    camx = predX + (me.w||22)/2 - canvas.width/2;
    camy = predY + (me.h||28)/2 - canvas.height/2;
    camx = clamp(camx, 0, mapPx - canvas.width);
    camy = clamp(camy, 0, mapPx - canvas.height);
  }

  // background
  const g = ctx.createLinearGradient(0,0,0,canvas.height);
  g.addColorStop(0,'#9ad08c'); g.addColorStop(1,'#6ea564');
  ctx.fillStyle = g; ctx.fillRect(0,0,canvas.width,canvas.height);

  // draw world objects
  drawHouses(camx, camy);
  drawTreesRocks(camx, camy);

  // draw projectiles
  projectiles.forEach(pr => {
    const sx = pr.x - camx, sy = pr.y - camy;
    if(pr.type === 'bolt' || pr.type === 'smite'){ ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.strokeStyle='#cfe9ff'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(sx - 8, sy - 8); ctx.stroke(); ctx.restore(); }
    else { ctx.fillStyle='#6b4a2e'; ctx.beginPath(); ctx.ellipse(sx, sy, 5, 2, 0,0,Math.PI*2); ctx.fill(); }
  });

  // draw players via interpolation
  const renderTime = performance.now() - INTERP_MS;
  for(const id in players){
    const p = players[id];
    let drawX = p.x, drawY = p.y;
    if(p.prev && p.next && p.next.t > p.prev.t){
      const a = p.prev.t, b = p.next.t;
      const alpha = clamp((renderTime - a) / Math.max(1, b - a), 0, 1);
      drawX = lerp(p.prev.x, p.next.x, alpha);
      drawY = lerp(p.prev.y, p.next.y, alpha);
    } else {
      drawX = p.x; drawY = p.y;
    }

    // local prediction small
    if(id === myId && p.next){ drawX = lerp(p.prev.x, p.next.x, 0.95); drawY = lerp(p.prev.y, p.next.y, 0.95); }

    drawPlayer(drawX - camx, drawY - camy, p);
  }

  // minimap render
  drawMinimap(camx, camy);

  // HUD
  updateHud();
}

function drawHouses(camx, camy){
  if(!world) return;
  world.houses.forEach(h => {
    const hx = h.x * TILE - TILE*0.5 - camx;
    const hy = h.y * TILE - TILE*0.9 - camy;
    const hw = h.w * TILE + TILE; const hh = h.h * TILE + TILE*0.6;
    // shadow
    ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(hx + hw/2, hy + hh + 6, hw*0.45, 8, 0,0,Math.PI*2); ctx.fill();
    // body
    ctx.fillStyle = h.color; ctx.fillRect(hx, hy, hw, hh);
    // roof
    ctx.beginPath(); ctx.moveTo(hx - 6, hy + 6); ctx.lineTo(hx + hw/2, hy - hh*0.35); ctx.lineTo(hx + hw + 6, hy + 6); ctx.closePath(); ctx.fillStyle='#6b2318'; ctx.fill();
  });
}

function drawTreesRocks(camx, camy){
  if(!world) return;
  world.trees.forEach(t => {
    const tx = t.x * TILE - camx; const ty = t.y * TILE - camy;
    ctx.fillStyle = '#5b3b2a'; ctx.fillRect(tx - 4, ty + 6, 8, 14 * t.s);
    ctx.beginPath(); ctx.fillStyle = '#1f6a2f'; ctx.ellipse(tx, ty, 16*t.s, 18*t.s, 0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = '#2b8b3c'; ctx.ellipse(tx - 10*t.s, ty + 6, 10*t.s, 12*t.s, 0,0,Math.PI*2); ctx.fill();
  });
  world.rocks.forEach(r => {
    const rx = r.x * TILE - camx; const ry = r.y * TILE - camy;
    ctx.beginPath(); ctx.fillStyle = '#8b8b8b'; ctx.ellipse(rx, ry, 8*r.s, 6*r.s, 0,0,Math.PI*2); ctx.fill();
  });
}

function drawPlayer(sx, sy, p){
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(sx + 11, sy + (p.h||28) - 2, 11*0.6, 6, 0,0,Math.PI*2); ctx.fill();

  // body (more detailed)
  ctx.fillStyle = '#ffd07a'; ctx.fillRect(sx, sy, p.w || 22, p.h || 28);
  ctx.fillStyle = '#2b6b5a'; ctx.fillRect(sx - 2, sy + 6, (p.w||22)+4, (p.h||28)-8);
  // head
  ctx.fillStyle = '#ffe7b5'; ctx.fillRect(sx + 4, sy - 8, 12, 12);

  // name & level
  ctx.fillStyle = '#fff'; ctx.font = '11px Inter,system-ui';
  ctx.fillText((p.classType||'') + ' [' + (p.level||1) + ']', sx, sy - 12);

  // hp bar
  ctx.fillStyle = '#333'; ctx.fillRect(sx, sy - 6, (p.w||22), 4);
  ctx.fillStyle = '#f44'; ctx.fillRect(sx, sy - 6, ((p.hp||1)/(p.maxHp||1))*(p.w||22), 4);

  // level-based visual effects
  if(p.level >= 2 && p.classType === 'ninja'){
    // small katana glint indicator
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx + (p.w||22) - 2, sy + 6); ctx.lineTo(sx + (p.w||22) + 12, sy + 6); ctx.stroke();
  }
  if(p.level >= 3 && p.classType === 'mage'){
    // mage aura
    ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = '#aee6ff'; ctx.beginPath(); ctx.ellipse(sx + (p.w||22)/2, sy + (p.h||28)/2, (p.w||22)*1.4, (p.h||28)*1.2, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();
  }
}

// minimap: shows players as dots (you = bright)
function drawMinimap(camx, camy){
  const W = miniCanvas.width, H = miniCanvas.height;
  miniCtx.clearRect(0,0,W,H);
  // background
  miniCtx.fillStyle = '#0b1b10'; miniCtx.fillRect(0,0,W,H);
  // draw world bounds outline
  miniCtx.strokeStyle = '#274'; miniCtx.strokeRect(2,2,W-4,H-4);
  // map scale
  const scaleX = W / mapPx, scaleY = H / mapPx;
  // draw houses as tiny blocks
  if(world){
    world.houses.forEach(h => {
      const hx = tileToPx(h.x) - TILE_SIZE*0.5, hy = tileToPx(h.y) - TILE_SIZE*0.9;
      miniCtx.fillStyle = '#7b4'; miniCtx.fillRect(hx*scaleX, hy*scaleY, 6, 6);
    });
  }
  // players
  for(const id in players){
    const p = players[id];
    const dx = (p.x / mapPx) * W;
    const dy = (p.y / mapPx) * H;
    if(id === myId){
      miniCtx.fillStyle = '#2cf'; miniCtx.beginPath(); miniCtx.arc(dx, dy, 4, 0, Math.PI*2); miniCtx.fill();
    } else {
      miniCtx.fillStyle = '#f55'; miniCtx.beginPath(); miniCtx.arc(dx, dy, 3, 0, Math.PI*2); miniCtx.fill();
    }
  }
}

// HUD update
function updateHud(){
  const me = players[myId];
  hudClass.textContent = 'Klasse: ' + (me ? me.classType : '-');
  hudHp.textContent = 'HP: ' + (me ? (me.hp + '/' + me.maxHp) : '-');
  hudXp.textContent = 'Level / XP: ' + (me ? (me.level || 1) + ' / ' + (me.xp || 0) : '-');
  // info text left unchanged
}

// utils
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

// start render
requestAnimationFrame(renderLoop);
