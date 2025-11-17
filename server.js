const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

const MAP_SIZE = 2000;
const PLAYERS = {};

io.on("connection", socket => {
  console.log("Player connected:", socket.id);
  PLAYERS[socket.id] = {
    x: Math.random() * MAP_SIZE,
    y: Math.random() * MAP_SIZE,
    class: null,
    hp: 10,
    mana: 5,
    level: 1,
    xp: 0,
    speed: 150,
    facing: "down",
    abilities: { q: false, e: false, x: false },
    status: {}
  };

  socket.emit("init", { id: socket.id, mapSize: MAP_SIZE, players: PLAYERS });

  socket.on("selectClass", cls => {
    const p = PLAYERS[socket.id];
    p.class = cls;
    switch(cls){
      case "ninja": p.hp=3; p.speed=180; break;
      case "mage": p.hp=5; p.mana=10; break;
      case "warrior": p.hp=8; break;
      case "archer": p.hp=5; break;
      case "dragon": p.hp=10; p.mana=10; break;
      case "rogue": p.hp=4; p.speed=170; break;
    }
  });

  socket.on("update", data => {
    const p = PLAYERS[socket.id];
    if(!p) return;
    Object.assign(p, data);
  });

  socket.on("disconnect", () => {
    delete PLAYERS[socket.id];
  });
});

setInterval(() => {
  io.emit("playersUpdate", PLAYERS);
}, 50);

http.listen(3000, () => console.log("Server running on port 3000"));
