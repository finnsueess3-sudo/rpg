const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

const MAP_SIZE = 3000;
const PLAYERS = {};

io.on("connection", socket => {
  PLAYERS[socket.id] = {
    x: Math.random()*MAP_SIZE,
    y: Math.random()*MAP_SIZE,
    class: null,
    hp: 5,
    mana: 5,
    level: 1,
    xp: 0,
    speed: 150,
    facing: "down",
    abilities: {q:false,e:false,x:false},
    status:{},
  };

  socket.emit("init",{id:socket.id,mapSize:MAP_SIZE,players:PLAYERS});

  socket.on("selectClass",cls=>{
    const p=PLAYERS[socket.id]; p.class=cls;
    const baseStats={
      ninja:{hp:3,speed:180},mage:{hp:5,mana:10},warrior:{hp:8},
      archer:{hp:5},dragon:{hp:10,mana:10},rogue:{hp:4,speed:170},
      paladin:{hp:9},berserker:{hp:7,speed:160},assassin:{hp:3,speed:190}
    };
    Object.assign(p,baseStats[cls]||{});
  });

  socket.on("update",data=>{
    const p=PLAYERS[socket.id]; if(!p) return;
    Object.assign(p,data);
  });

  socket.on("disconnect",()=>delete PLAYERS[socket.id]);
});

setInterval(()=>{ io.emit("playersUpdate",PLAYERS); },50);

http.listen(3000,()=>console.log("Server running on port 3000"));
