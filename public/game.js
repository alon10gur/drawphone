const socket = io();

let currentScreen = 'lobby';
let roomCode = null;
let playerName = '';
let isDrawing = false;
let currentTool = 'pen';
let currentColor = '#000000';
let brushSize = 3;
let drawingHistory = [];
let currentRound = 0;
let totalRounds = 0;
let drawingSubmitted = false;
let cameraStream = null;
let currentReferenceImageIndex = 0;
let currentStrokes = [];
let shapeStartX = 0;
let shapeStartY = 0;
let tempCanvas = null;
let tempCtx = null;
let isHost = false;
let isSpectator = false;

const screens = {
  lobby: document.getElementById('lobby-screen'),
  upload: document.getElementById('upload-screen'),
  drawing: document.getElementById('drawing-screen'),
  waiting: document.getElementById('waiting-screen'),
  spectator: document.getElementById('spectator-screen'),
  reveal: document.getElementById('reveal-screen'),
};

const canvas = document.getElementById('drawing-canvas');
const ctx = canvas.getContext('2d');

ctx.fillStyle = 'white';
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

tempCanvas = document.createElement('canvas');
tempCanvas.width = canvas.width;
tempCanvas.height = canvas.height;
tempCtx = tempCanvas.getContext('2d');

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let soundEnabled = true;

function playTick() {
  if (!soundEnabled) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 800;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.05);
}

function playSubmit() {
  if (!soundEnabled) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 600;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.15);
}

function playReveal() {
  if (!soundEnabled) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 400;
  osc.type = 'triangle';
  gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.3);
}

function showScreen(screenName) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[screenName].classList.add('active');
  currentScreen = screenName;
}

document.getElementById('player-name').addEventListener('input', (e) => {
  playerName = e.target.value.trim();
});

document.getElementById('create-room-btn').addEventListener('click', () => {
  if (!playerName) {
    alert('Please enter your name first!');
    return;
  }
  socket.emit('create-room', playerName, (response) => {
    if (response.success) {
      roomCode = response.code;
      updateRoomInfo();
    }
  });
});

document.getElementById('join-room-btn').addEventListener('click', () => {
  if (!playerName) {
    alert('Please enter your name first!');
    return;
  }
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code) {
    alert('Please enter a room code!');
    return;
  }
  socket.emit('join-room', code, playerName, (response) => {
    if (response.success) {
      roomCode = code;
      isSpectator = response.isSpectator || false;
      updateRoomInfo();
      if (isSpectator) {
        showScreen('spectator');
        document.getElementById('spectator-subtitle').textContent = `Game in progress - Phase: ${response.phase}`;
        socket.emit('spectator-sync', roomCode);
      }
    } else {
      alert(response.error);
    }
  });
});

document.getElementById('copy-code-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    const btn = document.getElementById('copy-code-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy'), 2000);
  });
});

document.getElementById('start-game-btn').addEventListener('click', () => {
  const duration = parseInt(document.getElementById('timer-select').value);
  socket.emit('set-timer', roomCode, duration);
  setTimeout(() => {
    socket.emit('start-game', roomCode);
  }, 100);
});

function updateRoomInfo() {
  document.getElementById('room-info').classList.remove('hidden');
  document.getElementById('room-code').textContent = roomCode;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

socket.on('players-update', (players, spectators = []) => {
  const list = document.getElementById('players-list');
  list.innerHTML = players
    .map((p) => `<li class="${p.isHost ? 'host' : ''}">${escapeHtml(p.name)}</li>`)
    .join('');

  document.getElementById('player-count').textContent = players.length;
  document.getElementById('player-count-badge').classList.remove('hidden');

  const host = players.find((p) => p.isHost && p.id === socket.id);
  isHost = !!host;
  if (host) {
    document.getElementById('start-game-btn').classList.remove('hidden');
    document.getElementById('timer-select').disabled = false;
  } else {
    document.getElementById('start-game-btn').classList.add('hidden');
    document.getElementById('timer-select').disabled = true;
  }

  if (currentScreen === 'spectator') {
    document.getElementById('spectator-player-count').textContent = `${players.length} players`;
    document.getElementById('spectator-count-badge').textContent = `${spectators.length} watching`;
  }

  if (currentScreen === 'reveal') {
    if (isHost) {
      socket.emit('request-reveal-state', roomCode);
    } else {
      const nextBtn = document.getElementById('reveal-next-btn');
      const nextImageBtn = document.getElementById('reveal-next-image-btn');
      const playAgainBtn = document.getElementById('play-again-btn');
      nextBtn.classList.add('hidden');
      nextImageBtn.classList.add('hidden');
      playAgainBtn.classList.add('hidden');
    }
  }
});

socket.on('host-changed', (newHostId) => {
  isHost = newHostId === socket.id;
  if (isHost) {
    document.getElementById('start-game-btn').classList.remove('hidden');
    document.getElementById('timer-select').disabled = false;
  } else {
    document.getElementById('start-game-btn').classList.add('hidden');
    document.getElementById('timer-select').disabled = true;
  }

  if (currentScreen === 'reveal') {
    if (isHost) {
      socket.emit('request-reveal-state', roomCode);
    } else {
      const nextBtn = document.getElementById('reveal-next-btn');
      const nextImageBtn = document.getElementById('reveal-next-image-btn');
      const playAgainBtn = document.getElementById('play-again-btn');
      nextBtn.classList.add('hidden');
      nextImageBtn.classList.add('hidden');
      playAgainBtn.classList.add('hidden');
    }
  }
});

socket.on('timer-updated', (duration) => {
  document.getElementById('timer-select').value = duration;
});

socket.on('game-started', (data) => {
  if (isSpectator) {
    showScreen('spectator');
    document.getElementById('spectator-title').textContent = 'Spectating';
    document.getElementById('spectator-subtitle').textContent = 'Players uploading images...';
    document.getElementById('spectator-stage').classList.add('hidden');
    document.getElementById('spectator-drawings').innerHTML = '';
    document.getElementById('spectator-progress-text').textContent = '';
    return;
  }
  showScreen('upload');
  resetUpload();
});

function resetUpload() {
  document.getElementById('upload-preview').classList.add('hidden');
  document.getElementById('upload-placeholder').classList.remove('hidden');
  document.getElementById('submit-image-btn').classList.add('hidden');
  document.getElementById('submit-image-btn').disabled = false;
  document.getElementById('upload-status').textContent = '';
  document.getElementById('file-input').value = '';
}

const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('file-input');
const uploadPreview = document.getElementById('upload-preview');
const uploadPlaceholder = document.getElementById('upload-placeholder');

uploadArea.addEventListener('click', (e) => {
  if (e.target.id !== 'camera-btn' && !e.target.closest('#camera-btn')) {
    fileInput.click();
  }
});

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) {
    handleFile(file);
  }
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

function handleFile(file) {
  if (file.size > 5 * 1024 * 1024) {
    alert('File too large! Max 5MB.');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 500;
      let width = img.width;
      let height = img.height;

      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width *= ratio;
        height *= ratio;
      }

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = width;
      tempCanvas.height = height;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.drawImage(img, 0, 0, width, height);

      const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.8);
      showPreview(dataUrl);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function showPreview(dataUrl) {
  uploadPreview.src = dataUrl;
  uploadPreview.classList.remove('hidden');
  uploadPlaceholder.classList.add('hidden');
  document.getElementById('submit-image-btn').classList.remove('hidden');
  uploadPreview.dataset.imageData = dataUrl;
}

document.getElementById('submit-image-btn').addEventListener('click', () => {
  const imageData = uploadPreview.dataset.imageData;
  if (!imageData) return;

  socket.emit('upload-image', roomCode, imageData);
  document.getElementById('upload-status').textContent = 'Image submitted! Waiting for others...';
  document.getElementById('submit-image-btn').disabled = true;
});

socket.on('upload-confirmed', () => {
  document.getElementById('upload-status').textContent = 'Image submitted! Waiting for others...';
});

const cameraModal = document.getElementById('camera-modal');
const cameraVideo = document.getElementById('camera-video');
const cameraCanvas = document.getElementById('camera-canvas');
const cameraCaptureBtn = document.getElementById('camera-capture-btn');
const cameraRetakeBtn = document.getElementById('camera-retake-btn');
const cameraUseBtn = document.getElementById('camera-use-btn');
const cameraCloseBtn = document.getElementById('camera-close-btn');

document.getElementById('camera-btn').addEventListener('click', async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
    cameraModal.classList.remove('hidden');
    cameraCaptureBtn.classList.remove('hidden');
    cameraRetakeBtn.classList.add('hidden');
    cameraUseBtn.classList.add('hidden');
    cameraVideo.classList.remove('hidden');
    cameraCanvas.classList.add('hidden');
  } catch (err) {
    alert('Could not access camera. Please allow camera permissions.');
    console.error(err);
  }
});

cameraCloseBtn.addEventListener('click', () => {
  stopCamera();
  cameraModal.classList.add('hidden');
});

cameraCaptureBtn.addEventListener('click', () => {
  cameraCanvas.width = cameraVideo.videoWidth;
  cameraCanvas.height = cameraVideo.videoHeight;
  const cCtx = cameraCanvas.getContext('2d');
  cCtx.drawImage(cameraVideo, 0, 0);

  const dataUrl = cameraCanvas.toDataURL('image/jpeg', 0.8);
  cameraVideo.classList.add('hidden');
  cameraCanvas.classList.remove('hidden');
  cameraCanvas.dataset.imageData = dataUrl;

  cameraCaptureBtn.classList.add('hidden');
  cameraRetakeBtn.classList.remove('hidden');
  cameraUseBtn.classList.remove('hidden');
});

cameraRetakeBtn.addEventListener('click', () => {
  cameraVideo.classList.remove('hidden');
  cameraCanvas.classList.add('hidden');
  cameraCaptureBtn.classList.remove('hidden');
  cameraRetakeBtn.classList.add('hidden');
  cameraUseBtn.classList.add('hidden');
});

cameraUseBtn.addEventListener('click', () => {
  const dataUrl = cameraCanvas.dataset.imageData;
  if (dataUrl) {
    const img = new Image();
    img.onload = () => {
      const maxDim = 500;
      let width = img.width;
      let height = img.height;

      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width *= ratio;
        height *= ratio;
      }

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = width;
      tempCanvas.height = height;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.drawImage(img, 0, 0, width, height);

      showPreview(tempCanvas.toDataURL('image/jpeg', 0.8));
      stopCamera();
      cameraModal.classList.add('hidden');
    };
    img.src = dataUrl;
  }
});

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
}

socket.on('round-start-personal', (data) => {
  currentRound = data.round;
  totalRounds = data.totalRounds;
  drawingSubmitted = false;
  currentReferenceImageIndex = data.referenceImageIndex;
  currentStrokes = [];
  lastStrokeTime = Date.now();

  document.getElementById('round-display').textContent = `Round ${data.round}/${data.totalRounds}`;
  document.getElementById('drawing-player').textContent = `Recreate this image`;
  document.getElementById('reference-image').src = data.referenceImage;
  document.getElementById('timer-display').textContent = data.timeLeft;
  document.getElementById('submission-counter').textContent = `0/${totalRounds} submitted`;

  clearCanvas();
  drawingHistory = [];
  saveCanvasState();

  showScreen('drawing');
  document.getElementById('submit-drawing-btn').classList.remove('hidden');
  document.getElementById('submit-drawing-btn').disabled = false;
});

socket.on('round-info', (data) => {
  document.getElementById('round-display').textContent = `Round ${data.round}/${data.totalRounds}`;
  document.getElementById('timer-display').textContent = data.timeLeft;
  document.getElementById('submission-counter').textContent = `${data.submissionsCount}/${data.totalPlayers} submitted`;
});

socket.on('timer-update', (timeLeft) => {
  const timerEl = document.getElementById('timer-display');
  timerEl.textContent = timeLeft;

  const timerContainer = timerEl.parentElement;
  timerContainer.classList.remove('warning', 'danger');

  if (timeLeft <= 10) {
    timerContainer.classList.add('danger');
    playTick();
  } else if (timeLeft <= 30) {
    timerContainer.classList.add('warning');
    if (timeLeft % 5 === 0) playTick();
  }
});

socket.on('drawing-submitted', (data) => {
  document.getElementById('submission-counter').textContent = `${data.submissionsCount}/${data.totalPlayers} submitted`;

  if (data.playerId === socket.id) {
    drawingSubmitted = true;
    document.getElementById('submit-drawing-btn').classList.add('hidden');
    showScreen('waiting');
    document.getElementById('waiting-message').textContent = 'Drawing submitted! Waiting for others...';
    playSubmit();
  }
});

socket.on('round-ended', () => {
  if (isSpectator) {
    document.getElementById('spectator-title').textContent = 'Round complete!';
    document.getElementById('spectator-subtitle').textContent = 'Moving to reveal phase...';
    return;
  }
  document.getElementById('waiting-message').textContent = 'Round complete!';
  showScreen('waiting');
  document.getElementById('submit-drawing-btn').classList.add('hidden');
});

socket.on('spectator-phase', (data) => {
  showScreen('spectator');

  if (data.phase === 'upload') {
    document.getElementById('spectator-title').textContent = 'Spectating';
    document.getElementById('spectator-subtitle').textContent = `Players uploading images (${data.imagesUploaded}/${data.totalPlayers})`;
    document.getElementById('spectator-stage').classList.add('hidden');
    document.getElementById('spectator-drawings').innerHTML = '';
    document.getElementById('spectator-progress-text').textContent = '';
  } else if (data.phase === 'drawing') {
    document.getElementById('spectator-title').textContent = `Spectating - Round ${data.round}/${data.totalRounds}`;
    document.getElementById('spectator-subtitle').textContent = `${data.submissionsCount}/${data.totalPlayers} submitted`;
    document.getElementById('spectator-stage').classList.remove('hidden');
    document.getElementById('spectator-ref-img').src = data.referenceImage;
    document.getElementById('spectator-drawings').innerHTML = '';
    document.getElementById('spectator-progress-text').textContent = `Round ${data.round} of ${data.totalRounds}`;
  }
});

socket.on('spectator-drawing', (data) => {
  const container = document.getElementById('spectator-drawings');
  const card = document.createElement('div');
  card.className = 'spectator-drawing-card';
  card.innerHTML = `
    <h4>${escapeHtml(data.playerName)}</h4>
    <img src="${data.drawing}" alt="${escapeHtml(data.playerName)}'s drawing">
  `;
  container.appendChild(card);

  if (data.submissionsCount !== undefined) {
    document.getElementById('spectator-subtitle').textContent = `${data.submissionsCount}/${data.totalPlayers} submitted`;
  }
});

socket.on('spectator-timer', (data) => {
  if (currentScreen === 'spectator') {
    document.getElementById('spectator-subtitle').textContent = `${data.submissionsCount}/${data.totalPlayers} submitted - ${data.timeLeft}s left`;
  }
});

let lastX = 0;
let lastY = 0;
let lastStrokeTime = 0;

canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', (e) => stopDrawing(e));

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (touch.clientX - rect.left) * scaleX;
  const y = (touch.clientY - rect.top) * scaleY;

  if (currentTool === 'fill') {
    floodFill(Math.floor(x), Math.floor(y), currentColor);
    saveCanvasState();
    return;
  }

  if (currentTool === 'line' || currentTool === 'rect' || currentTool === 'circle') {
    shapeStartX = x;
    shapeStartY = y;
    lastX = x;
    lastY = y;
    tempCtx.drawImage(canvas, 0, 0);
    isDrawing = true;
    return;
  }

  lastX = x;
  lastY = y;
  isDrawing = true;
  lastStrokeTime = Date.now();
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!isDrawing || currentTool === 'fill') return;

  if (currentTool === 'line' || currentTool === 'rect' || currentTool === 'circle') {
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (touch.clientX - rect.left) * scaleX;
    const y = (touch.clientY - rect.top) * scaleY;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);
    drawShape(shapeStartX, shapeStartY, x, y);
    return;
  }

  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (touch.clientX - rect.left) * scaleX;
  const y = (touch.clientY - rect.top) * scaleY;

  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.strokeStyle = currentTool === 'eraser' ? '#ffffff' : currentColor;
  ctx.lineWidth = currentTool === 'eraser' ? brushSize * 2 : brushSize;
  ctx.stroke();

  currentStrokes.push({
    x1: lastX,
    y1: lastY,
    x2: x,
    y2: y,
    color: currentTool === 'eraser' ? '#ffffff' : currentColor,
    size: currentTool === 'eraser' ? brushSize * 2 : brushSize,
    time: Date.now() - lastStrokeTime,
  });

  lastX = x;
  lastY = y;
});

canvas.addEventListener('touchend', (e) => {
  if (isDrawing) {
    isDrawing = false;
    if (currentTool === 'line' || currentTool === 'rect' || currentTool === 'circle') {
      const touch = e.changedTouches[0];
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (touch.clientX - rect.left) * scaleX;
      const y = (touch.clientY - rect.top) * scaleY;

      currentStrokes.push({
        x1: shapeStartX,
        y1: shapeStartY,
        x2: x,
        y2: y,
        color: currentColor,
        size: brushSize,
        time: Date.now() - lastStrokeTime,
        shape: currentTool,
      });
    }
    saveCanvasState();
  }
});

function startDrawing(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  if (currentTool === 'fill') {
    floodFill(Math.floor(x), Math.floor(y), currentColor);
    saveCanvasState();
    return;
  }

  if (currentTool === 'line' || currentTool === 'rect' || currentTool === 'circle') {
    shapeStartX = x;
    shapeStartY = y;
    lastX = x;
    lastY = y;
    tempCtx.drawImage(canvas, 0, 0);
    isDrawing = true;
    return;
  }

  isDrawing = true;
  lastX = x;
  lastY = y;
  lastStrokeTime = Date.now();
}

function draw(e) {
  if (!isDrawing || currentTool === 'fill') return;

  if (currentTool === 'line' || currentTool === 'rect' || currentTool === 'circle') {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);
    drawShape(shapeStartX, shapeStartY, x, y);
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.strokeStyle = currentTool === 'eraser' ? '#ffffff' : currentColor;
  ctx.lineWidth = currentTool === 'eraser' ? brushSize * 2 : brushSize;
  ctx.stroke();

  currentStrokes.push({
    x1: lastX,
    y1: lastY,
    x2: x,
    y2: y,
    color: currentTool === 'eraser' ? '#ffffff' : currentColor,
    size: currentTool === 'eraser' ? brushSize * 2 : brushSize,
    time: Date.now() - lastStrokeTime,
  });

  lastX = x;
  lastY = y;
}

function stopDrawing(e) {
  if (!isDrawing) return;
  isDrawing = false;

  if (currentTool === 'line' || currentTool === 'rect' || currentTool === 'circle') {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e && e.type !== 'mouseout' ? e.clientX : lastX;
    const clientY = e && e.type !== 'mouseout' ? e.clientY : lastY;
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;

    currentStrokes.push({
      x1: shapeStartX,
      y1: shapeStartY,
      x2: x,
      y2: y,
      color: currentColor,
      size: brushSize,
      time: Date.now() - lastStrokeTime,
      shape: currentTool,
    });

    saveCanvasState();
    return;
  }

  saveCanvasState();
}

function drawShape(x1, y1, x2, y2) {
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = brushSize;
  ctx.beginPath();

  if (currentTool === 'line') {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  } else if (currentTool === 'rect') {
    ctx.rect(x1, y1, x2 - x1, y2 - y1);
  } else if (currentTool === 'circle') {
    const radius = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    ctx.arc(x1, y1, radius, 0, Math.PI * 2);
  }

  ctx.stroke();
}

function floodFill(startX, startY, fillColor) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const width = canvas.width;
  const height = canvas.height;

  const targetIdx = (startY * width + startX) * 4;
  const targetR = data[targetIdx];
  const targetG = data[targetIdx + 1];
  const targetB = data[targetIdx + 2];

  const fillHex = fillColor.replace('#', '');
  const fillR = parseInt(fillHex.substring(0, 2), 16);
  const fillG = parseInt(fillHex.substring(2, 4), 16);
  const fillB = parseInt(fillHex.substring(4, 6), 16);

  if (targetR === fillR && targetG === fillG && targetB === fillB) return;

  const tolerance = 32;
  const visited = new Uint8Array(width * height);
  const stack = [startX + startY * width];

  function matchesTarget(idx) {
    return (
      Math.abs(data[idx] - targetR) <= tolerance &&
      Math.abs(data[idx + 1] - targetG) <= tolerance &&
      Math.abs(data[idx + 2] - targetB) <= tolerance
    );
  }

  let iterations = 0;
  const maxIterations = width * height;

  while (stack.length > 0 && iterations < maxIterations) {
    iterations++;
    const pos = stack.pop();
    const x = pos % width;
    const y = (pos - x) / width;
    const idx = pos * 4;

    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (visited[pos]) continue;
    if (!matchesTarget(idx)) continue;

    visited[pos] = 1;
    data[idx] = fillR;
    data[idx + 1] = fillG;
    data[idx + 2] = fillB;
    data[idx + 3] = 255;

    stack.push(pos + 1, pos - 1, pos + width, pos - width);
  }

  ctx.putImageData(imageData, 0, 0);
}

function saveCanvasState() {
  if (drawingHistory.length > 20) {
    drawingHistory.shift();
  }
  drawingHistory.push(canvas.toDataURL());
}

function clearCanvas() {
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

document.getElementById('pen-btn').addEventListener('click', () => {
  currentTool = 'pen';
  document.getElementById('pen-btn').classList.add('active');
  document.getElementById('eraser-btn').classList.remove('active');
  document.getElementById('fill-btn').classList.remove('active');
  document.getElementById('line-btn').classList.remove('active');
  document.getElementById('rect-btn').classList.remove('active');
  document.getElementById('circle-btn').classList.remove('active');
  canvas.style.cursor = 'crosshair';
});

document.getElementById('eraser-btn').addEventListener('click', () => {
  currentTool = 'eraser';
  document.getElementById('eraser-btn').classList.add('active');
  document.getElementById('pen-btn').classList.remove('active');
  document.getElementById('fill-btn').classList.remove('active');
  document.getElementById('line-btn').classList.remove('active');
  document.getElementById('rect-btn').classList.remove('active');
  document.getElementById('circle-btn').classList.remove('active');
  canvas.style.cursor = 'crosshair';
});

document.getElementById('fill-btn').addEventListener('click', () => {
  currentTool = 'fill';
  document.getElementById('fill-btn').classList.add('active');
  document.getElementById('pen-btn').classList.remove('active');
  document.getElementById('eraser-btn').classList.remove('active');
  document.getElementById('line-btn').classList.remove('active');
  document.getElementById('rect-btn').classList.remove('active');
  document.getElementById('circle-btn').classList.remove('active');
  canvas.style.cursor = 'cell';
});

document.getElementById('line-btn').addEventListener('click', () => {
  currentTool = 'line';
  document.getElementById('line-btn').classList.add('active');
  document.getElementById('pen-btn').classList.remove('active');
  document.getElementById('eraser-btn').classList.remove('active');
  document.getElementById('fill-btn').classList.remove('active');
  document.getElementById('rect-btn').classList.remove('active');
  document.getElementById('circle-btn').classList.remove('active');
  canvas.style.cursor = 'crosshair';
});

document.getElementById('rect-btn').addEventListener('click', () => {
  currentTool = 'rect';
  document.getElementById('rect-btn').classList.add('active');
  document.getElementById('pen-btn').classList.remove('active');
  document.getElementById('eraser-btn').classList.remove('active');
  document.getElementById('fill-btn').classList.remove('active');
  document.getElementById('line-btn').classList.remove('active');
  document.getElementById('circle-btn').classList.remove('active');
  canvas.style.cursor = 'crosshair';
});

document.getElementById('circle-btn').addEventListener('click', () => {
  currentTool = 'circle';
  document.getElementById('circle-btn').classList.add('active');
  document.getElementById('pen-btn').classList.remove('active');
  document.getElementById('eraser-btn').classList.remove('active');
  document.getElementById('fill-btn').classList.remove('active');
  document.getElementById('line-btn').classList.remove('active');
  document.getElementById('rect-btn').classList.remove('active');
  canvas.style.cursor = 'crosshair';
});

document.getElementById('color-picker').addEventListener('input', (e) => {
  currentColor = e.target.value;
});

document.querySelectorAll('.color-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentColor = btn.dataset.color;
    document.getElementById('color-picker').value = currentColor;
  });
});

document.getElementById('brush-size').addEventListener('input', (e) => {
  brushSize = parseInt(e.target.value);
  document.getElementById('brush-size-display').textContent = brushSize;
});

document.getElementById('clear-btn').addEventListener('click', () => {
  clearCanvas();
  saveCanvasState();
});

document.getElementById('undo-btn').addEventListener('click', () => {
  if (drawingHistory.length > 1) {
    drawingHistory.pop();
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = drawingHistory[drawingHistory.length - 1];
  }
});

document.getElementById('submit-drawing-btn').addEventListener('click', () => {
  if (!drawingSubmitted) {
    drawingSubmitted = true;
    document.getElementById('submit-drawing-btn').disabled = true;
    const drawingData = canvas.toDataURL('image/jpeg', 0.8);
    socket.emit('submit-drawing', roomCode, drawingData, currentReferenceImageIndex, currentStrokes);
  }
});

document.getElementById('sound-toggle-btn').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  document.getElementById('sound-on-icon').classList.toggle('hidden', !soundEnabled);
  document.getElementById('sound-off-icon').classList.toggle('hidden', soundEnabled);
});

socket.on('phase-change', (data) => {
  if (data.phase === 'reveal') {
    showScreen('reveal');
  }
});

socket.on('reveal-state', (data) => {
  if (isSpectator) {
    showScreen('spectator');
    document.getElementById('spectator-title').textContent = `Reveal - Image ${data.currentImageIndex + 1}/${data.totalImages}`;
    document.getElementById('spectator-subtitle').textContent = data.allRevealed ? 'All drawings revealed!' : 'Watch the drawings unfold';
    document.getElementById('spectator-stage').classList.remove('hidden');
    document.getElementById('spectator-ref-img').src = data.original;
    document.getElementById('spectator-progress-text').textContent = `Image ${data.currentImageIndex + 1} of ${data.totalImages}`;

    const container = document.getElementById('spectator-drawings');
    container.innerHTML = '';
    data.revealedDrawings.forEach((d) => {
      const card = document.createElement('div');
      card.className = 'spectator-drawing-card';
      card.innerHTML = `
        <h4>${escapeHtml(d.playerName)}</h4>
        <img src="${d.data}" alt="${escapeHtml(d.playerName)}'s drawing">
      `;
      container.appendChild(card);
    });
    return;
  }

  showScreen('reveal');

  const title = document.getElementById('reveal-title');
  const subtitle = document.getElementById('reveal-subtitle');
  const originalImg = document.getElementById('reveal-original-img');
  const drawingsContainer = document.getElementById('reveal-drawings');
  const progressText = document.getElementById('reveal-progress-text');
  const nextBtn = document.getElementById('reveal-next-btn');
  const nextImageBtn = document.getElementById('reveal-next-image-btn');
  const playAgainBtn = document.getElementById('play-again-btn');

  title.textContent = `Image ${data.currentImageIndex + 1}/${data.totalImages}`;
  subtitle.textContent = data.allRevealed ? 'All drawings revealed!' : 'Click to reveal the next drawing';
  originalImg.src = data.original;
  progressText.textContent = `Image ${data.currentImageIndex + 1} of ${data.totalImages}`;

  drawingsContainer.innerHTML = '';
  data.revealedDrawings.forEach((d) => {
    const card = document.createElement('div');
    card.className = 'reveal-drawing-card';
    card.innerHTML = `
      <h4>${escapeHtml(d.playerName)}</h4>
      <img src="${d.data}" alt="${escapeHtml(d.playerName)}'s drawing">
      ${d.strokes && d.strokes.length > 0 ? '<button class="btn btn-small timelapse-btn" data-player-id="' + escapeHtml(d.playerId) + '" data-stroke-count="' + d.strokes.length + '">Timelapse</button>' : ''}
    `;
    drawingsContainer.appendChild(card);
  });

  document.querySelectorAll('.timelapse-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const playerId = btn.dataset.playerId;
      const drawing = data.revealedDrawings.find((d) => d.playerId === playerId);
      if (drawing && drawing.strokes.length > 0) {
        showTimelapse(drawing.strokes, drawing.playerName);
      }
    });
  });

  nextBtn.classList.add('hidden');
  nextImageBtn.classList.add('hidden');
  playAgainBtn.classList.add('hidden');

  if (!data.allRevealed) {
    if (isHost) nextBtn.classList.remove('hidden');
  } else if (!data.isLastImage) {
    if (isHost) nextImageBtn.classList.remove('hidden');
  } else {
    if (isHost) {
      playAgainBtn.classList.remove('hidden');
    }
  }

  playReveal();
});

socket.on('reveal-complete', () => {
  if (isSpectator) {
    document.getElementById('spectator-title').textContent = 'All images revealed!';
    document.getElementById('spectator-subtitle').textContent = 'Game complete!';
    return;
  }

  const subtitle = document.getElementById('reveal-subtitle');
  const nextBtn = document.getElementById('reveal-next-btn');
  const nextImageBtn = document.getElementById('reveal-next-image-btn');
  const playAgainBtn = document.getElementById('play-again-btn');
  subtitle.textContent = 'All images revealed!';
  nextBtn.classList.add('hidden');
  nextImageBtn.classList.add('hidden');
  if (isHost) {
    playAgainBtn.classList.remove('hidden');
  }
});

document.getElementById('reveal-next-btn').addEventListener('click', () => {
  socket.emit('reveal-next-drawing', roomCode);
});

document.getElementById('reveal-next-image-btn').addEventListener('click', () => {
  socket.emit('reveal-next-image', roomCode);
});

document.getElementById('play-again-btn').addEventListener('click', () => {
  socket.emit('play-again', roomCode);
});

socket.on('back-to-lobby', () => {
  isSpectator = false;
  showScreen('lobby');
  document.getElementById('room-info').classList.remove('hidden');
  document.getElementById('room-code').textContent = roomCode;
  document.getElementById('player-count-badge').classList.add('hidden');
  document.getElementById('spectator-stage').classList.add('hidden');
  document.getElementById('spectator-drawings').innerHTML = '';
  document.getElementById('spectator-progress-text').textContent = '';
  drawingSubmitted = false;
  currentStrokes = [];
  drawingHistory = [];
  currentRound = 0;
  totalRounds = 0;
  resetUpload();
});

const timelapseModal = document.getElementById('timelapse-modal');
const timelapseCanvas = document.getElementById('timelapse-canvas');
const timelapseCtx = timelapseCanvas.getContext('2d');
const timelapsePlayBtn = document.getElementById('timelapse-play-btn');
const timelapsePauseBtn = document.getElementById('timelapse-pause-btn');
const timelapseSpeed = document.getElementById('timelapse-speed');
const timelapseSpeedDisplay = document.getElementById('timelapse-speed-display');
const timelapseCloseBtn = document.getElementById('timelapse-close-btn');
let timelapseInterval = null;
let timelapseStrokes = [];

timelapseSpeed.addEventListener('input', () => {
  timelapseSpeedDisplay.textContent = timelapseSpeed.value + 'x';
});

timelapseCloseBtn.addEventListener('click', () => {
  stopTimelapse();
  timelapseModal.classList.add('hidden');
});

timelapsePlayBtn.addEventListener('click', () => {
  timelapsePlayBtn.classList.add('hidden');
  timelapsePauseBtn.classList.remove('hidden');
  playTimelapse();
});

timelapsePauseBtn.addEventListener('click', () => {
  stopTimelapse();
  timelapsePauseBtn.classList.add('hidden');
  timelapsePlayBtn.classList.remove('hidden');
});

function showTimelapse(strokes, playerName) {
  timelapseStrokes = strokes.map((s) => ({
    ...s,
    x1: (s.x1 / 600) * 400,
    y1: (s.y1 / 500) * 400,
    x2: (s.x2 / 600) * 400,
    y2: (s.y2 / 500) * 400,
  }));
  document.getElementById('timelapse-title').textContent = `Timelapse - ${playerName}`;
  timelapseCtx.fillStyle = 'white';
  timelapseCtx.fillRect(0, 0, timelapseCanvas.width, timelapseCanvas.height);
  timelapseModal.classList.remove('hidden');
  timelapsePlayBtn.classList.remove('hidden');
  timelapsePauseBtn.classList.add('hidden');
  stopTimelapse();
}

function playTimelapse() {
  stopTimelapse();
  const speed = parseInt(timelapseSpeed.value);
  let strokeIndex = 0;

  function drawNextStroke() {
    if (strokeIndex >= timelapseStrokes.length) {
      timelapsePauseBtn.classList.add('hidden');
      timelapsePlayBtn.classList.remove('hidden');
      return;
    }

    const stroke = timelapseStrokes[strokeIndex];
    timelapseCtx.strokeStyle = stroke.color;
    timelapseCtx.lineWidth = stroke.size;
    timelapseCtx.lineCap = 'round';
    timelapseCtx.lineJoin = 'round';
    timelapseCtx.beginPath();

    if (stroke.shape === 'line') {
      timelapseCtx.moveTo(stroke.x1, stroke.y1);
      timelapseCtx.lineTo(stroke.x2, stroke.y2);
    } else if (stroke.shape === 'rect') {
      timelapseCtx.rect(stroke.x1, stroke.y1, stroke.x2 - stroke.x1, stroke.y2 - stroke.y1);
    } else if (stroke.shape === 'circle') {
      const radius = Math.sqrt(Math.pow(stroke.x2 - stroke.x1, 2) + Math.pow(stroke.y2 - stroke.y1, 2));
      timelapseCtx.arc(stroke.x1, stroke.y1, radius, 0, Math.PI * 2);
    } else {
      timelapseCtx.moveTo(stroke.x1, stroke.y1);
      timelapseCtx.lineTo(stroke.x2, stroke.y2);
    }

    timelapseCtx.stroke();

    strokeIndex++;

    const delay = strokeIndex < timelapseStrokes.length ? timelapseStrokes[strokeIndex].time / speed : 0;
    timelapseInterval = setTimeout(drawNextStroke, Math.max(10, delay));
  }

  drawNextStroke();
}

function stopTimelapse() {
  if (timelapseInterval) {
    clearTimeout(timelapseInterval);
    timelapseInterval = null;
  }
}
