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
  const sanitizedName = hostName.replace(/[<>"'&]/g, '').substring(0, 20) || 'Player';
  rooms.set(code, {
    code,
    players: new Map(),
    spectators: new Map(),
    images: [],
    drawingsByImage: [],
    strokesByImage: [],
    phase: 'lobby',
    currentRound: 0,
    totalRounds: 0,
    timer: null,
    timeLeft: 0,
    roundDuration: 90,
    submissionsCount: 0,
    revealImageIndex: 0,
    revealDrawingIndex: 0,
  });
  rooms.get(code).players.set(hostId, { id: hostId, name: sanitizedName, isHost: true });
  return code;
}

function joinRoom(code, playerId, playerName) {
  const room = rooms.get(code);
  if (!room) return { success: false, error: 'Room not found' };
  if (room.phase === 'lobby') {
    if (room.players.size >= 8) return { success: false, error: 'Room is full' };
    const sanitizedName = playerName.replace(/[<>"'&]/g, '').substring(0, 20) || 'Player';
    room.players.set(playerId, { id: playerId, name: sanitizedName, isHost: false });
    return { success: true, playerCount: room.players.size, isSpectator: false };
  }
  const sanitizedName = playerName.replace(/[<>"'&]/g, '').substring(0, 20) || 'Player';
  room.spectators.set(playerId, { id: playerId, name: sanitizedName });
  return { success: true, playerCount: room.players.size, isSpectator: true, phase: room.phase };
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
        return { newHostId: newHost.id, roomCode: code };
      }
      return { roomCode: code };
    }
    if (room.spectators.has(playerId)) {
      room.spectators.delete(playerId);
      return { roomCode: code };
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
      io.to(code).emit('players-update', Array.from(room.players.values()), Array.from(room.spectators.values()));
      if (result.isSpectator) {
        callback({ success: true, code, isSpectator: true, phase: result.phase });
      } else {
        callback({ success: true, code, isSpectator: false });
      }
    } else {
      callback(result);
    }
  });

  socket.on('spectator-sync', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.phase === 'upload') {
      socket.emit('spectator-phase', { phase: 'upload', imagesUploaded: room.images.length, totalPlayers: room.players.size });
    } else if (room.phase === 'drawing') {
      const players = Array.from(room.players.values());
      const images = room.images;
      const shift = room.currentRound + 1;
      const playerIndex = players.findIndex((p) => p.id === socket.id);
      if (playerIndex >= 0) return;

      const currentImage = images[(shift - 1) % images.length];

      socket.emit('spectator-phase', {
        phase: 'drawing',
        round: room.currentRound + 1,
        totalRounds: room.players.size,
        referenceImage: currentImage.data,
        timeLeft: room.timeLeft,
        submissionsCount: room.submissionsCount,
        totalPlayers: room.players.size,
      });
    } else if (room.phase === 'reveal') {
      sendRevealStateToSocket(roomCode, socket);
    }
  });

  socket.on('set-timer', (roomCode, duration) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'lobby') return;
    const host = room.players.get(socket.id);
    if (!host || !host.isHost) return;
    room.roundDuration = Math.min(300, Math.max(60, duration));
    io.to(roomCode).emit('timer-updated', room.roundDuration);
  });

  socket.on('start-game', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.phase !== 'lobby') return;
    const host = room.players.get(socket.id);
    if (!host || !host.isHost) return;

    room.phase = 'upload';
    room.images = [];
    room.drawingsByImage = [];
    room.strokesByImage = [];
    room.currentRound = 0;
    room.totalRounds = room.players.size;
    room.submissionsCount = 0;

    io.to(roomCode).emit('game-started', {
      phase: 'upload',
      playerCount: room.players.size,
      roundDuration: room.roundDuration,
    });
    io.to(roomCode).emit('players-update', Array.from(room.players.values()), Array.from(room.spectators.values()));
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

    if (room.players.size === 0) {
      rooms.delete(roomCode);
      return;
    }

    if (room.currentRound >= room.players.size) {
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

    room.timeLeft = room.roundDuration;
    room.submissionsCount = 0;

    players.forEach((player) => {
      const playerIndex = players.indexOf(player);
      const imageIndex = (playerIndex + shift) % images.length;

      if (!room.drawingsByImage[imageIndex]) {
        room.drawingsByImage[imageIndex] = [];
      }
      if (!room.strokesByImage[imageIndex]) {
        room.strokesByImage[imageIndex] = [];
      }
    });

    players.forEach((player) => {
      const playerIndex = players.indexOf(player);
      const imageIndex = (playerIndex + shift) % images.length;
      const referenceImage = images[imageIndex];

      io.to(player.id).emit('round-start-personal', {
        round: room.currentRound + 1,
        totalRounds: room.totalRounds,
        referenceImage: referenceImage.data,
        referencePlayerId: referenceImage.playerId,
        referenceImageIndex: imageIndex,
        timeLeft: room.timeLeft,
      });
    });

    io.to(roomCode).emit('round-info', {
      round: room.currentRound + 1,
      totalRounds: room.totalRounds,
      timeLeft: room.timeLeft,
      submissionsCount: 0,
      totalPlayers: players.length,
    });

    room.timer = setInterval(() => {
      room.timeLeft--;
      io.to(roomCode).emit('timer-update', room.timeLeft);
      io.to(roomCode).emit('spectator-timer', {
        timeLeft: room.timeLeft,
        submissionsCount: room.submissionsCount,
        totalPlayers: room.players.size,
      });

      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        room.currentRound++;
        startDrawingRound(roomCode);
      }
    }, 1000);
  }

  socket.on('submit-drawing', (roomCode, drawingData, imageIndex, strokes) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;

    const alreadySubmitted = room.drawingsByImage[imageIndex]?.some(
      (d) => d.playerId === socket.id
    );
    if (alreadySubmitted) return;

    if (!room.drawingsByImage[imageIndex]) {
      room.drawingsByImage[imageIndex] = [];
    }
    if (!room.strokesByImage[imageIndex]) {
      room.strokesByImage[imageIndex] = [];
    }

    room.drawingsByImage[imageIndex].push({
      playerId: socket.id,
      data: drawingData,
    });
    room.strokesByImage[imageIndex].push({
      playerId: socket.id,
      strokes: strokes || [],
    });

    room.submissionsCount++;
    io.to(roomCode).emit('drawing-submitted', {
      playerId: socket.id,
      submissionsCount: room.submissionsCount,
      totalPlayers: room.players.size,
    });

    const submittingPlayer = room.players.get(socket.id);
    io.to(roomCode).emit('spectator-drawing', {
      playerId: socket.id,
      playerName: submittingPlayer ? submittingPlayer.name : 'Unknown',
      drawing: drawingData,
      submissionsCount: room.submissionsCount,
      totalPlayers: room.players.size,
    });

    if (room.submissionsCount >= room.players.size) {
      if (room.timer) clearInterval(room.timer);
      room.currentRound++;
      startDrawingRound(roomCode);
    }
  });

  socket.on('submit-stroke', (roomCode, imageIndex, stroke) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;

    if (!room.strokesByImage[imageIndex]) {
      room.strokesByImage[imageIndex] = [];
    }

    let playerStrokes = room.strokesByImage[imageIndex].find(
      (s) => s.playerId === socket.id
    );
    if (!playerStrokes) {
      playerStrokes = { playerId: socket.id, strokes: [] };
      room.strokesByImage[imageIndex].push(playerStrokes);
    }
    playerStrokes.strokes.push(stroke);
  });

  socket.on('get-reveal-data', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (!room) return callback(null);

    const players = Array.from(room.players.values());
    const images = room.images;

    const revealData = images.map((img, imageIndex) => {
      const originalPlayer = room.players.get(img.playerId);
      const imageDrawings = room.drawingsByImage[imageIndex] || [];
      const imageStrokes = room.strokesByImage[imageIndex] || [];
      const recreations = imageDrawings.map((d, idx) => ({
        playerId: d.playerId,
        playerName: room.players.get(d.playerId)?.name || 'Unknown',
        data: d.data,
        strokes: imageStrokes[idx]?.strokes || [],
      }));

      return {
        original: img.data,
        originalPlayer: originalPlayer ? originalPlayer.name : 'Unknown',
        recreations,
      };
    });

    callback(revealData);
  });

  function sendRevealStateToSocket(roomCode, targetSocket) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const currentImage = room.images[room.revealImageIndex];
    const originalPlayer = room.players.get(currentImage.playerId);
    const imageDrawings = room.drawingsByImage[room.revealImageIndex] || [];
    const imageStrokes = room.strokesByImage[room.revealImageIndex] || [];
    const revealedDrawings = imageDrawings.slice(0, room.revealDrawingIndex);
    const revealedStrokes = imageStrokes.slice(0, room.revealDrawingIndex);
    const totalDrawings = imageDrawings.length;

    targetSocket.emit('phase-change', { phase: 'reveal' });
    targetSocket.emit('reveal-state', {
      currentImageIndex: room.revealImageIndex,
      totalImages: room.images.length,
      original: currentImage.data,
      originalPlayer: originalPlayer ? originalPlayer.name : 'Unknown',
      revealedDrawings: revealedDrawings.map((d, idx) => ({
        playerId: d.playerId,
        playerName: room.players.get(d.playerId)?.name || 'Unknown',
        data: d.data,
        strokes: revealedStrokes[idx]?.strokes || [],
      })),
      totalDrawings,
      allRevealed: room.revealDrawingIndex >= totalDrawings,
      isLastImage: room.revealImageIndex >= room.images.length - 1,
    });
  }

  function sendRevealState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const currentImage = room.images[room.revealImageIndex];
    const originalPlayer = room.players.get(currentImage.playerId);
    const imageDrawings = room.drawingsByImage[room.revealImageIndex] || [];
    const imageStrokes = room.strokesByImage[room.revealImageIndex] || [];
    const revealedDrawings = imageDrawings.slice(0, room.revealDrawingIndex);
    const revealedStrokes = imageStrokes.slice(0, room.revealDrawingIndex);
    const totalDrawings = imageDrawings.length;

    io.to(roomCode).emit('phase-change', { phase: 'reveal' });
    io.to(roomCode).emit('reveal-state', {
      currentImageIndex: room.revealImageIndex,
      totalImages: room.images.length,
      original: currentImage.data,
      originalPlayer: originalPlayer ? originalPlayer.name : 'Unknown',
      revealedDrawings: revealedDrawings.map((d, idx) => ({
        playerId: d.playerId,
        playerName: room.players.get(d.playerId)?.name || 'Unknown',
        data: d.data,
        strokes: revealedStrokes[idx]?.strokes || [],
      })),
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

    const imageDrawings = room.drawingsByImage[room.revealImageIndex] || [];
    if (room.revealDrawingIndex >= imageDrawings.length) return;

    room.revealDrawingIndex++;
    sendRevealState(roomCode);
  });

  socket.on('request-reveal-state', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal') return;
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
    room.drawingsByImage = [];
    room.strokesByImage = [];
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

    const roomCode = result.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.phase === 'drawing') {
      const alreadySubmitted = room.drawingsByImage.some((drawings) =>
        drawings && drawings.some((d) => d.playerId === socket.id)
      );
      if (!alreadySubmitted) {
        room.totalRounds = room.players.size;
        room.submissionsCount++;
        io.to(roomCode).emit('drawing-submitted', {
          playerId: socket.id,
          submissionsCount: room.submissionsCount,
          totalPlayers: room.players.size,
        });
        if (room.submissionsCount >= room.players.size) {
          if (room.timer) clearInterval(room.timer);
          room.currentRound++;
          startDrawingRound(roomCode);
        }
      }
    }

    io.to(roomCode).emit('players-update', Array.from(room.players.values()), Array.from(room.spectators.values()));
    if (result.newHostId) {
      io.to(roomCode).emit('host-changed', result.newHostId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
