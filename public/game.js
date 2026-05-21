const socket = io();

let currentScreen = 'lobby-screen';
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

const screens = {
  lobby: document.getElementById('lobby-screen'),
  upload: document.getElementById('upload-screen'),
  drawing: document.getElementById('drawing-screen'),
  waiting: document.getElementById('waiting-screen'),
  reveal: document.getElementById('reveal-screen'),
};

const canvas = document.getElementById('drawing-canvas');
const ctx = canvas.getContext('2d');

ctx.fillStyle = 'white';
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

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
      updateRoomInfo();
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
  socket.emit('start-game', roomCode);
});

function updateRoomInfo() {
  document.getElementById('room-info').classList.remove('hidden');
  document.getElementById('room-code').textContent = roomCode;
}

socket.on('players-update', (players) => {
  const list = document.getElementById('players-list');
  list.innerHTML = players
    .map((p) => `<li class="${p.isHost ? 'host' : ''}">${p.name}</li>`)
    .join('');

  const host = players.find((p) => p.isHost && p.id === socket.id);
  if (host) {
    document.getElementById('start-game-btn').classList.remove('hidden');
  }
});

socket.on('host-changed', (newHostId) => {
  if (newHostId === socket.id) {
    document.getElementById('start-game-btn').classList.remove('hidden');
  }
});

socket.on('game-started', (data) => {
  showScreen('upload');
  resetUpload();
});

function resetUpload() {
  document.getElementById('upload-preview').classList.add('hidden');
  document.getElementById('upload-placeholder').classList.remove('hidden');
  document.getElementById('submit-image-btn').classList.add('hidden');
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

  document.getElementById('round-display').textContent = `Round ${data.round}/${data.totalRounds}`;
  document.getElementById('drawing-player').textContent = `Recreate this image`;
  document.getElementById('reference-image').src = data.referenceImage;
  document.getElementById('timer-display').textContent = data.timeLeft;

  clearCanvas();
  drawingHistory = [];
  saveCanvasState();

  showScreen('drawing');
  document.getElementById('submit-drawing-btn').classList.remove('hidden');
  document.getElementById('next-round-btn').classList.add('hidden');
});

socket.on('round-info', (data) => {
  document.getElementById('round-display').textContent = `Round ${data.round}/${data.totalRounds}`;
  document.getElementById('timer-display').textContent = data.timeLeft;
});

socket.on('timer-update', (timeLeft) => {
  const timerEl = document.getElementById('timer-display');
  timerEl.textContent = timeLeft;

  const timerContainer = timerEl.parentElement;
  timerContainer.classList.remove('warning', 'danger');

  if (timeLeft <= 10) {
    timerContainer.classList.add('danger');
  } else if (timeLeft <= 30) {
    timerContainer.classList.add('warning');
  }
});

socket.on('drawing-submitted', () => {
  drawingSubmitted = true;
  document.getElementById('submit-drawing-btn').classList.add('hidden');
  showScreen('waiting');
  document.getElementById('waiting-message').textContent = 'Drawing submitted! Waiting for others...';
});

let lastX = 0;
let lastY = 0;

canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

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

  lastX = x;
  lastY = y;
  isDrawing = true;
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!isDrawing || currentTool === 'fill') return;
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

  lastX = x;
  lastY = y;
});

canvas.addEventListener('touchend', () => {
  if (isDrawing) {
    isDrawing = false;
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

  isDrawing = true;
  lastX = x;
  lastY = y;
}

function draw(e) {
  if (!isDrawing || currentTool === 'fill') return;

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

  lastX = x;
  lastY = y;
}

function stopDrawing() {
  if (isDrawing) {
    isDrawing = false;
    saveCanvasState();
  }
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
  const stack = [[startX, startY]];
  const visited = new Set();

  function matchesTarget(idx) {
    return (
      Math.abs(data[idx] - targetR) <= tolerance &&
      Math.abs(data[idx + 1] - targetG) <= tolerance &&
      Math.abs(data[idx + 2] - targetB) <= tolerance
    );
  }

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const idx = (y * width + x) * 4;
    const key = `${x},${y}`;

    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (visited.has(key)) continue;
    if (!matchesTarget(idx)) continue;

    visited.add(key);
    data[idx] = fillR;
    data[idx + 1] = fillG;
    data[idx + 2] = fillB;
    data[idx + 3] = 255;

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
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
  canvas.style.cursor = 'crosshair';
});

document.getElementById('eraser-btn').addEventListener('click', () => {
  currentTool = 'eraser';
  document.getElementById('eraser-btn').classList.add('active');
  document.getElementById('pen-btn').classList.remove('active');
  document.getElementById('fill-btn').classList.remove('active');
  canvas.style.cursor = 'crosshair';
});

document.getElementById('fill-btn').addEventListener('click', () => {
  currentTool = 'fill';
  document.getElementById('fill-btn').classList.add('active');
  document.getElementById('pen-btn').classList.remove('active');
  document.getElementById('eraser-btn').classList.remove('active');
  canvas.style.cursor = 'cell';
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
    const drawingData = canvas.toDataURL('image/jpeg', 0.8);
    socket.emit('submit-drawing', roomCode, drawingData);
  }
});

document.getElementById('next-round-btn').addEventListener('click', () => {
  socket.emit('next-round', roomCode);
});

socket.on('phase-change', (data) => {
  if (data.phase === 'reveal') {
    showScreen('reveal');
    loadRevealData();
  }
});

function loadRevealData() {
  socket.emit('get-reveal-data', roomCode, (data) => {
    if (!data) return;

    const gallery = document.getElementById('reveal-gallery');
    gallery.innerHTML = '';

    data.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'reveal-card';

      let recreationsHtml = '';
      if (item.recreations && item.recreations.length > 0) {
        recreationsHtml = item.recreations
          .map(
            (r) => `
          <div class="reveal-image">
            <h4>By ${r.playerName}</h4>
            <img src="${r.data}" alt="Recreation">
          </div>
        `
          )
          .join('');
      } else {
        recreationsHtml = '<div class="reveal-image"><div class="placeholder">No recreations</div></div>';
      }

      card.innerHTML = `
        <h3>Round ${index + 1}</h3>
        <div class="reveal-images">
          <div class="reveal-image">
            <h4>Original</h4>
            <img src="${item.original}" alt="Original">
          </div>
          ${recreationsHtml}
        </div>
      `;

      gallery.appendChild(card);
    });
  });
}

document.getElementById('play-again-btn').addEventListener('click', () => {
  socket.emit('play-again', roomCode);
});

socket.on('back-to-lobby', () => {
  showScreen('lobby');
  document.getElementById('room-info').classList.remove('hidden');
  document.getElementById('room-code').textContent = roomCode;
  resetUpload();
});
