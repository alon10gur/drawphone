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
const disconnectedPlayers = new Map();
const RECONNECT_WINDOW = 120000;

function generateRoomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  return name.replace(/[<>"'&]/g, '').substring(0, 20) || 'Player';
}

function createRoom(hostId, hostName) {
  const code = generateRoomCode();
  const sanitizedName = sanitizeName(hostName);
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
    scores: new Map(),
    votes: new Map(),
    votePhase: false,
    voteCounts: new Map(),
    emojiReactions: [],
  });
  rooms.get(code).players.set(hostId, { id: hostId, name: sanitizedName, isHost: true });
  return code;
}

function joinRoom(code, playerId, playerName) {
  const room = rooms.get(code);
  if (!room) return { success: false, error: 'Room not found' };
  if (room.players.has(playerId)) return { success: false, error: 'Already in room' };
  if (room.spectators.has(playerId)) return { success: false, error: 'Already spectating' };
  if (room.phase === 'lobby') {
    if (room.players.size >= 8) return { success: false, error: 'Room is full' };
    const sanitizedName = sanitizeName(playerName);
    room.players.set(playerId, { id: playerId, name: sanitizedName, isHost: false });
    return { success: true, playerCount: room.players.size, isSpectator: false };
  }
  const sanitizedName = sanitizeName(playerName);
  room.spectators.set(playerId, { id: playerId, name: sanitizedName });
  return { success: true, playerCount: room.players.size, isSpectator: true, phase: room.phase };
}

function leaveRoom(playerId) {
  for (const [code, room] of rooms) {
    if (room.players.has(playerId)) {
      const player = room.players.get(playerId);
      room.players.delete(playerId);
      if (room.players.size === 0) {
        if (room.timer) clearInterval(room.timer);
        rooms.delete(code);
        for (const [pid, info] of disconnectedPlayers) {
          if (info.roomCode === code) disconnectedPlayers.delete(pid);
        }
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

function clearRoomTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('reconnect-attempt', (playerId, callback) => {
    const info = disconnectedPlayers.get(playerId);
    if (!info) return callback({ success: false, error: 'No reconnect session' });
    if (Date.now() - info.timestamp > RECONNECT_WINDOW) {
      disconnectedPlayers.delete(playerId);
      return callback({ success: false, error: 'Reconnect window expired' });
    }
    const room = rooms.get(info.roomCode);
    if (!room) {
      disconnectedPlayers.delete(playerId);
      return callback({ success: false, error: 'Room no longer exists' });
    }
    socket.join(info.roomCode);
    room.players.set(socket.id, { id: socket.id, name: info.name, isHost: info.isHost });
    disconnectedPlayers.delete(playerId);
    io.to(info.roomCode).emit('players-update', Array.from(room.players.values()), Array.from(room.spectators.values()));
    callback({
      success: true,
      code: info.roomCode,
      isSpectator: false,
      phase: room.phase,
      state: buildReconnectState(room, socket.id),
    });
  });

  socket.on('create-room', (name, callback) => {
    const code = createRoom(socket.id, name);
    socket.join(code);
    const room = rooms.get(code);
    io.to(code).emit('players-update', Array.from(room.players.values()), Array.from(room.spectators.values()));
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
    } else if (room.phase === 'voting') {
      socket.emit('phase-change', { phase: 'voting' });
      socket.emit('voting-state', buildVotingState(room, socket.id));
    } else if (room.phase === 'results') {
      socket.emit('phase-change', { phase: 'results' });
      socket.emit('results-state', buildResultsState(room));
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

  socket.on('start-game', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (!room) return callback && callback({ success: false, error: 'Room not found' });
    if (room.phase !== 'lobby') return callback && callback({ success: false, error: 'Game already started' });
    const host = room.players.get(socket.id);
    if (!host || !host.isHost) return callback && callback({ success: false, error: 'Not host' });
    if (room.players.size < 2) return callback && callback({ success: false, error: 'Need at least 2 players' });

    room.phase = 'upload';
    room.images = [];
    room.drawingsByImage = [];
    room.strokesByImage = [];
    room.currentRound = 0;
    room.totalRounds = room.players.size;
    room.submissionsCount = 0;
    room.scores = new Map();
    room.votes = new Map();
    room.votePhase = false;
    room.voteCounts = new Map();
    room.emojiReactions = [];
    room.players.forEach((p) => room.scores.set(p.id, 0));

    io.to(roomCode).emit('game-started', {
      phase: 'upload',
      playerCount: room.players.size,
      roundDuration: room.roundDuration,
    });
    io.to(roomCode).emit('players-update', Array.from(room.players.values()), Array.from(room.spectators.values()));
    if (callback) callback({ success: true });
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
      clearRoomTimer(room);
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

    clearRoomTimer(room);

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
        clearRoomTimer(room);
        room.currentRound++;
        startDrawingRound(roomCode);
      }
    }, 1000);
  }

  socket.on('submit-drawing', (roomCode, drawingData, imageIndex, strokes) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;

    if (typeof imageIndex !== 'number' || imageIndex < 0 || imageIndex >= room.images.length) return;

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
      clearRoomTimer(room);
      room.currentRound++;
      startDrawingRound(roomCode);
    }
  });

  const strokeRateLimits = new Map();
  socket.on('submit-stroke', (roomCode, imageIndex, stroke) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'drawing') return;

    const now = Date.now();
    const lastStroke = strokeRateLimits.get(socket.id) || 0;
    if (now - lastStroke < 16) return;
    strokeRateLimits.set(socket.id, now);

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

  socket.on('vote-drawing', (roomCode, imageIndex, drawingPlayerId, points) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'voting') return;

    const voter = room.players.get(socket.id);
    if (!voter) return;

    const voteKey = `${imageIndex}-${drawingPlayerId}`;
    if (!room.votes.has(voteKey)) {
      room.votes.set(voteKey, new Set());
    }
    const voters = room.votes.get(voteKey);
    if (voters.has(socket.id)) return;

    const drawingPlayer = room.players.get(drawingPlayerId);
    if (!drawingPlayer) return;
    if (drawingPlayerId === socket.id) return;

    voters.add(socket.id);

    const currentScore = room.scores.get(drawingPlayerId) || 0;
    room.scores.set(drawingPlayerId, currentScore + points);

    io.to(roomCode).emit('vote-recorded', {
      imageIndex,
      drawingPlayerId,
      voterId: socket.id,
      points,
      totalScore: room.scores.get(drawingPlayerId),
    });

    const allVoted = checkAllVotesDone(room);
    if (allVoted) {
      room.phase = 'results';
      io.to(roomCode).emit('phase-change', { phase: 'results' });
      io.to(roomCode).emit('results-state', buildResultsState(room));
    }
  });

  socket.on('emoji-reaction', (roomCode, emoji) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.phase !== 'reveal' && room.phase !== 'voting' && room.phase !== 'results') return;

    const player = room.players.get(socket.id) || room.spectators.get(socket.id);
    if (!player) return;

    const reaction = {
      emoji,
      playerId: socket.id,
      playerName: player.name,
      timestamp: Date.now(),
    };
    room.emojiReactions.push(reaction);
    io.to(roomCode).emit('emoji-reaction', reaction);

    setTimeout(() => {
      room.emojiReactions = room.emojiReactions.filter((r) => r.timestamp > Date.now() - 5000);
    }, 5000);
  });

  socket.on('get-reveal-data', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (!room) return callback(null);

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
    if (!currentImage) return;
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
    if (!currentImage) return;
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
    room.emojiReactions = [];

    if (room.revealImageIndex >= room.images.length) {
      startVotingPhase(roomCode);
    } else {
      sendRevealState(roomCode);
    }
  });

  function startVotingPhase(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.phase = 'voting';
    room.votePhase = true;
    room.votes = new Map();
    room.emojiReactions = [];

    const votingState = buildVotingState(room);
    io.to(roomCode).emit('phase-change', { phase: 'voting' });
    io.to(roomCode).emit('voting-state', votingState);
  }

  function buildVotingState(room, excludeSocketId = null) {
    const images = room.images;
    const voteItems = [];

    images.forEach((img, imageIndex) => {
      const imageDrawings = room.drawingsByImage[imageIndex] || [];
      imageDrawings.forEach((d) => {
        if (d.playerId === excludeSocketId) return;
        voteItems.push({
          imageIndex,
          originalPlayer: room.players.get(img.playerId)?.name || 'Unknown',
          originalImage: img.data,
          drawingPlayerId: d.playerId,
          drawingPlayerName: room.players.get(d.playerId)?.name || 'Unknown',
          drawing: d.data,
        });
      });
    });

    return {
      voteItems,
      scores: Object.fromEntries(room.scores),
    };
  }

  function checkAllVotesDone(room) {
    const images = room.images;
    const players = Array.from(room.players.values());

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const imageDrawings = room.drawingsByImage[i] || [];
      for (const d of imageDrawings) {
        if (d.playerId === img.playerId) continue;
        const voteKey = `${i}-${d.playerId}`;
        const voters = room.votes.get(voteKey) || new Set();
        const eligibleVoters = players.filter((p) => p.id !== d.playerId);
        if (voters.size < eligibleVoters.length) return false;
      }
    }
    return true;
  }

  function buildResultsState(room) {
    const sorted = Array.from(room.scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([playerId, score]) => ({
        playerId,
        playerName: room.players.get(playerId)?.name || 'Unknown',
        score,
      }));

    return {
      rankings: sorted,
      scores: Object.fromEntries(room.scores),
    };
  }

  socket.on('play-again', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    clearRoomTimer(room);
    room.phase = 'lobby';
    room.images = [];
    room.drawingsByImage = [];
    room.strokesByImage = [];
    room.currentRound = 0;
    room.totalRounds = 0;
    room.submissionsCount = 0;
    room.revealImageIndex = 0;
    room.revealDrawingIndex = 0;
    room.scores = new Map();
    room.votes = new Map();
    room.votePhase = false;
    room.voteCounts = new Map();
    room.emojiReactions = [];
    room.players.forEach((p) => room.scores.set(p.id, 0));

    io.to(roomCode).emit('back-to-lobby');
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);

    const room = findPlayerRoom(socket.id);
    if (room) {
      const player = room.players.get(socket.id);
      if (player) {
        disconnectedPlayers.set(socket.id, {
          name: player.name,
          isHost: player.isHost,
          roomCode: room.code,
          timestamp: Date.now(),
        });
      }
    }

    const result = leaveRoom(socket.id);
    if (result.roomDeleted) return;

    const roomCode = result.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.phase === 'upload') {
      room.totalRounds = room.players.size;
      if (room.images.length >= room.players.size) {
        room.phase = 'drawing';
        room.currentRound = 0;
        startDrawingRound(roomCode);
      }
    }

    if (room.phase === 'drawing') {
      const shift = room.currentRound + 1;
      const images = room.images;
      const playerImages = [];
      const allPlayers = Array.from(room.players.values());
      allPlayers.forEach((p, idx) => {
        const imageIndex = (idx + shift) % images.length;
        playerImages.push({ playerId: p.id, imageIndex });
      });

      const disconnectedImageIndex = playerImages.find((p) => p.playerId === socket.id)?.imageIndex;
      const alreadySubmitted = disconnectedImageIndex !== undefined && room.drawingsByImage[disconnectedImageIndex]?.some(
        (d) => d.playerId === socket.id
      );

      if (!alreadySubmitted) {
        room.submissionsCount++;
        io.to(roomCode).emit('drawing-submitted', {
          playerId: socket.id,
          submissionsCount: room.submissionsCount,
          totalPlayers: room.players.size,
        });
        if (room.submissionsCount >= room.players.size) {
          clearRoomTimer(room);
          room.currentRound++;
          startDrawingRound(roomCode);
        }
      }

      room.totalRounds = room.players.size;
      io.to(roomCode).emit('round-info', {
        round: room.currentRound + 1,
        totalRounds: room.totalRounds,
        timeLeft: room.timeLeft,
        submissionsCount: room.submissionsCount,
        totalPlayers: room.players.size,
      });
    }

    if (room.phase === 'voting') {
      const allVoted = checkAllVotesDone(room);
      if (allVoted) {
        room.phase = 'results';
        io.to(roomCode).emit('phase-change', { phase: 'results' });
        io.to(roomCode).emit('results-state', buildResultsState(room));
      }
    }

    io.to(roomCode).emit('players-update', Array.from(room.players.values()), Array.from(room.spectators.values()));
    if (result.newHostId) {
      io.to(roomCode).emit('host-changed', result.newHostId);
    }
  });
});

function findPlayerRoom(playerId) {
  for (const room of rooms.values()) {
    if (room.players.has(playerId)) return room;
  }
  return null;
}

function buildReconnectState(room, playerId) {
  const state = { phase: room.phase };

  if (room.phase === 'upload') {
    state.imagesUploaded = room.images.length;
    state.totalPlayers = room.players.size;
  } else if (room.phase === 'drawing') {
    const players = Array.from(room.players.values());
    const shift = room.currentRound + 1;
    const playerIndex = players.findIndex((p) => p.id === playerId);
    const imageIndex = playerIndex >= 0 ? (playerIndex + shift) % room.images.length : 0;
    const referenceImage = room.images[imageIndex];

    state.round = room.currentRound + 1;
    state.totalRounds = room.totalRounds;
    state.referenceImage = referenceImage?.data;
    state.referenceImageIndex = imageIndex;
    state.timeLeft = room.timeLeft;
    state.submissionsCount = room.submissionsCount;
    state.totalPlayers = room.players.size;
  } else if (room.phase === 'reveal') {
    state.revealImageIndex = room.revealImageIndex;
    state.revealDrawingIndex = room.revealDrawingIndex;
  }

  return state;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
