// public/scripts.js (client)
const socket = io();
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const TILE = 32;
let world = null;
let myId = null;
let players = {}; // id -> {x,y,hp,classType,level}
let projectiles = [];
let mapPx = 0;

// input state
let inputSeq = 0;
const input = { mx:0, my:0, facing:'down', attack:false };

// HUD elements
const hudClass = document.getElementById('hud-class');
const hudHp = document.getElementById('hud-hp');
const hudXp = document.getElementById('hud-xp');
const hudInfo = document.getElementById('hud-info');

// class buttons
document.querySelectorAll('#classbar button').forEach(b=>{
  b.addEventListener('click', ()=>{
    const cls = b.getAttribute('data-class');
    // send spawn immediately with chosen class
    socket.emit('spawn', { classType: cls });
    hudInfo.textContent = 'Spawned as ' + cls;
  });
});

// canvas focus
canvas.addEventListener('click', ()=> canvas.focus());
canvas.focus();

// connect and receive world
socket.on('world', (data) => {
  world = data.world;
  mapPx = data.mapPx;
  hudInfo.textContent = 'Connected to world';
});

// init: server returns own id and known players
socket.on('init', (data) => {
  myId = data.id;
  players = data.players || {};
  players[myId] = data.player;
  updateHud();
  hudInfo.textContent = 'Ready — choose class or click spawn button';
});

// player joined/left
socket.on('playerJoined', (p) => {
  players[p.id] = p;
});
socket.on('playerLeft', (id) => {
  delete players[id];
});

// periodic snapshot from server
socket.on('snapshot', (snap) => {
  // replace or create players entries
  for(const id in snap.players){
    const s = snap.players[id];
    players[id] = players[id] || {};
    players[id].x = s.x; players[id].y = s.y; players[id].hp = s.hp; players[id].maxHp = s.maxHp;
    players[id].classType = s.classType; players[id].xp = s.xp; players[id].level = s.level;
    players[id].facing = s.facing;
  }
  projectiles = snap.projectiles || [];
  updateHud();
});

// hit / died / respawn events
socket.on('hit', (d) => {
  // brief flash or info
  hudInfo.textContent = `Hit: -${d.dmg}`;
  setTimeout(()=> hudInfo.textContent = '', 600);
});
socket.on('died', (d)=> {
  hudInfo.textContent = 'You died!';
  setTimeout(()=> hudInfo.textContent = '', 1200);
});
socket.on('playerRespawn', (data)=>{
  if(players[data.id]){ players[data.id].x = data.x; players[data.id].y = data.y; players[data.id].hp = data.hp; }
});

// input handling
const keys = {};
window.addEventListener('keydown', e=>{
  keys[e.code] = true;
  if(e.code === 'Space') { e.preventDefault(); input.attack = true; }
});
window.addEventListener('keyup', e=>{ keys[e.code] = false; });

// send input to server at ~20 Hz
setInterval(()=>{
  if(!myId) return;
  let mx=0,my=0;
  if(keys['KeyW']){ my -= 1; input.facing = 'up'; }
  if(keys['KeyS']){ my += 1; input.facing = 'down'; }
  if(keys['KeyA']){ mx -= 1; input.facing = 'left'; }
  if(keys['KeyD']){ mx += 1; input.facing = 'right'; }
  if(mx !==0 && my !==0){ mx *= 0.7071; my *= 0.7071; }
  input.mx = mx; input.my = my;
  inputSeq++;
  socket.emit('input', { seq: inputSeq, mx, my, facing: input.facing, attack: input.attack });
  input.attack = false;
}, 1000/20);

// rendering loop (~60fps)
function render(){
  requestAnimationFrame(render);
  if(!world) return;
  // clear
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // compute camera centered on my player
  const me = players[myId];
  let camx = 0, camy = 0;
  if(me){
    camx = me.x + (me.w||22)/2 - canvas.width/2;
    camy = me.y + (me.h||28)/2 - canvas.height/2;
    camx = clamp(camx, 0, mapPx - canvas.width);
    camy = clamp(camy, 0, mapPx - canvas.height);
  } else {
    camx = 0; camy = 0;
  }

  // background
  const g = ctx.createLinearGradient(0,0,0,canvas.height);
  g.addColorStop(0,'#9ad08c'); g.addColorStop(1,'#6ea564');
  ctx.fillStyle = g; ctx.fillRect(0,0,canvas.width,canvas.height);

  // decorative flowers
  const startX = Math.floor(camx / TILE) - 2;
  const startY = Math.floor(camy / TILE) - 2;
  const endX = startX + Math.ceil(canvas.width / TILE) + 6;
  const endY = startY + Math.ceil(canvas.height / TILE) + 6;
  for(let gy = startY; gy < endY; gy++){
    for(let gx = startX; gx < endX; gx++){
      const seed = (gx*374761393 + gy*668265263) & 0xffffffff;
      const rnd = ((seed>>>0)%100)/100;
      if(rnd < 0.03){
        const px = gx * TILE - camx + TILE*0.4;
        const py = gy * TILE - camy + TILE*0.6;
        ctx.fillStyle = '#fff7b2'; ctx.beginPath(); ctx.arc(px, py, 1.4, 0, Math.PI*2); ctx.fill();
      }
    }
  }

  // draw houses
  if(world && world.houses){
    world.houses.forEach(h => {
      const hx = h.x * TILE - TILE*0.5 - camx;
      const hy = h.y * TILE - TILE*0.9 - camy;
      const hw = h.w * TILE + TILE;
      const hh = h.h * TILE + TILE*0.6;
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(hx + hw/2, hy + hh + 6, hw*0.45, 8, 0, 0, Math.PI*2); ctx.fill();
      // body
      ctx.fillStyle = h.color; ctx.fillRect(hx, hy, hw, hh);
      // roof
      ctx.beginPath(); ctx.moveTo(hx - 6, hy + 6); ctx.lineTo(hx + hw/2, hy - hh*0.35); ctx.lineTo(hx + hw + 6, hy + 6); ctx.closePath();
      ctx.fillStyle = '#6b2318'; ctx.fill();
    });
  }

  // draw trees & rocks
  if(world && world.trees){
    world.trees.forEach(t => {
      const tx = t.x * TILE - camx;
      const ty = t.y * TILE - camy;
      ctx.fillStyle = '#5b3b2a'; ctx.fillRect(tx - 4, ty + 6, 8, 14 * t.s);
      ctx.beginPath(); ctx.fillStyle = '#1f6a2f'; ctx.ellipse(tx, ty, 16*t.s, 18*t.s, 0, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = '#2b8b3c'; ctx.ellipse(tx - 10*t.s, ty + 6, 10*t.s, 12*t.s, 0, 0, Math.PI*2); ctx.fill();
    });
    world.rocks.forEach(r => {
      const rx = r.x * TILE - camx;
      const ry = r.y * TILE - camy;
      ctx.beginPath(); ctx.fillStyle = '#8b8b8b'; ctx.ellipse(rx, ry, 8*r.s, 6*r.s, 0, 0, Math.PI*2); ctx.fill();
    });
  }

  // draw projectiles
  projectiles.forEach(pr => {
    const sx = pr.x - camx, sy = pr.y - camy;
    if(pr.type === 'bolt'){
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = '#cfe9ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - 10, sy - 10); ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.fillStyle = '#6b4a2e';
      ctx.beginPath(); ctx.ellipse(sx, sy, 5, 2, 0, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }
  });

  // draw players (including me)
  for(const id in players){
    const p = players[id];
    const sx = p.x - camx, sy = p.y - camy;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(sx + 11, sy + (p.h||28) - 2, 11*0.6, 6, 0, 0, Math.PI*2); ctx.fill();
    // body
    ctx.fillStyle = '#ffd07a'; ctx.fillRect(sx, sy, p.w || 22, p.h || 28);
    ctx.fillStyle = '#2b6b5a'; ctx.fillRect(sx - 2, sy + 6, (p.w||22)+4, (p.h||28)-8);
    // head
    ctx.fillStyle = '#ffe7b5'; ctx.fillRect(sx + 4, sy - 8, 12, 12);
    // small name & hp bar
    ctx.fillStyle = '#fff'; ctx.font = '11px Inter,system-ui';
    ctx.fillText((p.classType||'player') + ' [' + (p.level||1) + ']', sx, sy - 12);
    // hp bar
    ctx.fillStyle = '#333'; ctx.fillRect(sx, sy - 6, (p.w||22), 4);
    ctx.fillStyle = '#f44'; ctx.fillRect(sx, sy - 6, ((p.hp||1)/(p.maxHp||1))*(p.w||22), 4);
  }
}

// keep projectiles synced clientside from snapshots
socket.on('snapshot', (snap) => {
  projectiles = snap.projectiles || [];
  // players updated in on snapshot handler earlier
});

// utility
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

// HUD update
function updateHud(){
  const me = players[myId];
  hudClass.textContent = 'Klasse: ' + (me ? me.classType : '-');
  hudHp.textContent = 'HP: ' + (me ? (me.hp + '/' + me.maxHp) : '-');
  hudXp.textContent = 'Level: ' + (me ? (me.level || 1) + ' | XP: ' + (me.xp || 0) : '-');
}

// animate
render();
