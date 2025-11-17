const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const mini = document.getElementById('minimap');
const miniCtx = mini.getContext('2d');

let world, mapPx;
let playerId, players={}, projectiles=[];
let me=null;

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const keyState = {};
document.addEventListener('keydown', e=>keyState[e.key.toLowerCase()]=true);
document.addEventListener('keyup', e=>keyState[e.key.toLowerCase()]=false);

document.getElementById('spawnBtn').onclick=()=>{
  const cls = document.getElementById('classSelect').value;
  const name = document.getElementById('playerName').value || cls;
  socket.emit('spawn',{classType:cls,name});
};

socket.on('world', data => { world = data.world; mapPx = data.mapPx; });
socket.on('init', data => { playerId=data.id; players=data.players; me=data.player; });
socket.on('snapshot', snap => {
  for(const id in snap.players){
    if(!players[id]) players[id]={};
    Object.assign(players[id], snap.players[id]);
    if(id===playerId) me=players[id];
  }
  projectiles = snap.projectiles;
});
socket.on('playerJoined', p => { players[p.id]=p; });
socket.on('playerLeft', id => { delete players[id]; });

function sendInput(){
  if(!me) return;
  const mx = (keyState['w']?-1:0)+(keyState['s']?1:0);
  const my = (keyState['a']?-1:0)+(keyState['d']?1:0);
  socket.emit('input',{mx:my,my:mx,facing:'down',attack:keyState[' '], ulti:keyState['x']});
}

setInterval(sendInput,50);

// --- render ---
function draw(){
  if(!world || !me) return;
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const camX = me.x - canvas.width/2;
  const camY = me.y - canvas.height/2;

  // draw houses
  world.houses.forEach(h=>{
    ctx.fillStyle=h.color;
    ctx.fillRect(h.x*32-camX,h.y*32-camY,h.w*32,h.h*32);
  });

  // draw players
  for(const id in players){
    const p = players[id];
    ctx.fillStyle=id===playerId?'cyan':'red';
    ctx.fillRect(p.x-camX,p.y-camY,p.w,p.h);
    // basic attack animation
    ctx.fillStyle='yellow';
    if(p.cooldown>0) ctx.fillRect(p.x-camX-4,p.y-camY-4,p.w+8,p.h+8);
  }

  // draw projectiles
  projectiles.forEach(pr=>{
    ctx.fillStyle='orange';
    ctx.beginPath(); ctx.arc(pr.x-camX,pr.y-camY,6,0,Math.PI*2); ctx.fill();
  });

  drawMinimap();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// --- minimap ---
function drawMinimap(){
  miniCtx.clearRect(0,0,mini.width,mini.height);
  const scale = mini.width / mapPx;
  // draw all players
  for(const id in players){
    const p = players[id];
    miniCtx.fillStyle=id===playerId?'cyan':'red';
    miniCtx.fillRect(p.x*scale,p.y*scale,4,4);
  }
  // draw me
  miniCtx.fillStyle='lime';
  miniCtx.fillRect(me.x*scale-2,me.y*scale-2,4,4);
}
