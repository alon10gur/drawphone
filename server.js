const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

const rooms = new Map();

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function createRoom(hostId, hostName) {
  const code = generateRoomCode();
  rooms.set(code, {
    code,
    players: new Map(),
    images: [],
    drawings: [],
    phase: 'lobby',
    currentRound: 0,
    totalRounds: 0,
    timer: null,
    timeLeft: 0,
    submissionsCount: 0,
    revealImageIndex: 0,
    revealDrawingIndex: 0,
  });
  rooms.get(code).players.set(hostId, { id: hostId, name: hostName, isHost: true });
  return code;
}

function joinRoom(code, playerId, playerName) {
  const room = rooms.get(code);
  if (!room) return { success: false, error: 'Room not found' };
  if (room.phase !== 'lobby') return { success: false, error: 'Game already started' };
  if (room.players.size >= 8) return { success: false, error: 'Room is full' };
  room.players.set(playerId, { id: playerId, name: playerName, isHost: false });
  return { success: true, playerCount: room.players.size };
}

function leaveRoom(playerId) {
  for (const [code, room] of rooms) {
    if (room.players.has(playerId)) {
      const player = room.players.get(playerId);
      room.players.delete(playerId);
      if (room.players.size === 0) {
        rooms.delete(code);
        return { roomDeleted: true };
      }
      if (player.isHost && room.players.size > 0) {
        const newHost = room.players.values().next().value;
        newHost.isHost = true;
        return { newHostId: newHost.id };
      }
      return {};
    }
  }
  return {};
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('create-room', (name, callback) => {
    const code = createRoom(socket.id, name);
    socket.join(code);
    callback({ success: true, code });
  });

  socket.on('join-room', (code, name, callback) => {
    const result = joinRoom(code, socket.id, name);
    if (result.success) {
      socket.join(code);
      const room = rooms.get(code);
      io.to(code).emit('players-update', Array.from(room.players.values()));
      callback({ success: true, code });
    } else {
      callback(result);
    }
  });

  socket.on('start-game', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const host = room.players.get(socket.id);
    if (!host || !host.isHost) return;

    room.phase = 'upload';
    room.images = [];
    room.drawings = [];
    room.currentRound = 0;
    room.totalRounds = room.players.size;
    room.submissionsCount = 0;

    io.to(roomCode).emit('game-started', {
      phase: 'upload',
      playerCount: room.players.size,
    });
  });

  socket.on('upload-image', (roomCode, imageData) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'upload') return;

    const existing = room.images.find((img) => img.playerId === socket.id);
    if (existing) {
      existing.data = imageData;
    } else {
      room.images.push({ playerId: socket.id, data: imageData });
    }

    socket.emit('upload-confirmed');

    if (room.images.length === room.players.size) {
      room.phase = 'drawing';
      room.currentRound = 0;
      startDrawingRound(roomCode);
    }
  });

  function startDrawingRound(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.currentRound >= room.totalRounds) {
      room.phase = 'reveal';
      room.revealImageIndex = 0;
      room.revealDrawingIndex = 0;
      io.to(roomCode).emit('round-ended');
      sendRevealState(roomCode);
      return;
    }

    const players = Array.from(room.players.values());
    const images = room.images;
    const shift = room.currentRound + 1;

    room.timeLeft = 90;
    room.submissionsCount = 0;
    room.drawings[room.currentRound] = [];

    players.forEach((player) => {
      const playerIndex = players.indexOf(player);
      const imageIndex = (playerIndex + shift) % images.length;
      const referenceImage = images[imageIndex];

      io.to(player.id).emit('round-start-personal', {
        round: room.currentRound + 1,
        totalRounds: room.totalRounds,
        referenceImage: referenceImage.data,
        referencePlayerId: referenceImage.playerId,
        timeLeft: room.timeLeft,
      });
    });

    io.to(roomCode).emit('round-info', {
      round: room.currentRound + 1,
      totalRounds: room.totalRounds,
      timeLeft: room.timeLeft,
    });

    room.timer = setInterval(() => {
      room.timeLeft--;
      io.to(roomCode).emit('timer-update', room.timeLeft);

      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        room.currentRound++;
        startDrawingRound(roomCode);
      }
    }, 1000);
  }

  socket.on('submit-drawing', (roomCode, drawingData) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;

    if (!room.drawings[room.currentRound]) {
      room.drawings[room.currentRound] = [];
    }

    const existingIdx = room.drawings[room.currentRound].findIndex(
      (d) => d.playerId === socket.id
    );
    if (existingIdx >= 0) {
      room.drawings[room.currentRound][existingIdx].data = drawingData;
    } else {
      room.drawings[room.currentRound].push({
        playerId: socket.id,
        data: drawingData,
      });
    }

    room.submissionsCount++;
    io.to(roomCode).emit('drawing-submitted', { playerId: socket.id });

    if (room.submissionsCount >= room.players.size) {
      if (room.timer) clearInterval(room.timer);
      room.currentRound++;
      startDrawingRound(roomCode);
    }
  });

  socket.on('next-round', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;
    const host = room.players.get(socket.id);
    if (!host || !host.isHost) return;

    if (room.timer) clearInterval(room.timer);
    room.currentRound++;
    startDrawingRound(roomCode);
  });

  socket.on('get-reveal-data', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (!room) return callback(null);

    const players = Array.from(room.players.values());
    const images = room.images;

    const revealData = images.map((img, imageIndex) => {
      const originalPlayer = room.players.get(img.playerId);
      const roundDrawings = room.drawings[imageIndex] || [];
      const recreations = roundDrawings.map((d) => ({
        playerId: d.playerId,
        playerName: room.players.get(d.playerId)?.name || 'Unknown',
        data: d.data,
      }));

      return {
        original: img.data,
        originalPlayer: originalPlayer ? originalPlayer.name : 'Unknown',
        recreations,
      };
    });

    callback(revealData);
  });

  function sendRevealState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const currentImage = room.images[room.revealImageIndex];
    const originalPlayer = room.players.get(currentImage.playerId);
    const roundDrawings = room.drawings[room.revealImageIndex] || [];
    const revealedDrawings = roundDrawings.slice(0, room.revealDrawingIndex);
    const totalDrawings = roundDrawings.length;

    io.to(roomCode).emit('phase-change', { phase: 'reveal' });
    io.to(roomCode).emit('reveal-state', {
      currentImageIndex: room.revealImageIndex,
      totalImages: room.images.length,
      original: currentImage.data,
      originalPlayer: originalPlayer ? originalPlayer.name : 'Unknown',
      revealedDrawings,
      totalDrawings,
      allRevealed: room.revealDrawingIndex >= totalDrawings,
      isLastImage: room.revealImageIndex >= room.images.length - 1,
    });
  }

  socket.on('reveal-next-drawing', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal') return;
    const host = room.players.get(socket.id);
    if (!host || !host.isHost) return;

    room.revealDrawingIndex++;
    sendRevealState(roomCode);
  });

  socket.on('reveal-next-image', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal') return;
    const host = room.players.get(socket.id);
    if (!host || !host.isHost) return;

    room.revealImageIndex++;
    room.revealDrawingIndex = 0;

    if (room.revealImageIndex >= room.images.length) {
      io.to(roomCode).emit('reveal-complete');
    } else {
      sendRevealState(roomCode);
    }
  });

  socket.on('play-again', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.phase = 'lobby';
    room.images = [];
    room.drawings = [];
    room.currentRound = 0;
    room.submissionsCount = 0;
    room.revealImageIndex = 0;
    room.revealDrawingIndex = 0;
    if (room.timer) clearInterval(room.timer);

    io.to(roomCode).emit('back-to-lobby');
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const result = leaveRoom(socket.id);
    if (result.roomDeleted) return;

    for (const [code, room] of rooms) {
      if (room.players.size > 0) {
        io.to(code).emit('players-update', Array.from(room.players.values()));
        if (result.newHostId) {
          io.to(code).emit('host-changed', result.newHostId);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
