const canvas = document.getElementById('chartCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const debugLog = document.getElementById('debugLog');
const statusEl = document.getElementById('connectionStatus');
const overlay = document.getElementById('chartOverlay');
const overlayText = document.getElementById('overlayText');
const loadingSpinner = document.getElementById('loadingSpinner');

let candleData = []; 
let smcResults = null;
let isRunning = false;
let mockIntervalId = null;
let abortController = null;
let lastSignalTime = 0; // Prevent log spamming

// Web Worker Setup
const smcWorker = new Worker('smc-worker.js');

smcWorker.onmessage = function(e) {
    if (e.data.type === 'SMC_RESULT') {
        smcResults = e.data.data;
        
        // Only log new signals if at least 2 seconds have passed
        const now = Date.now();
        if (smcResults.signals.length > 0 && (now - lastSignalTime > 2000)) {
            const latestSignal = smcResults.signals[smcResults.signals.length - 1];
            addLogEntry(`🚀 ${latestSignal.type} SIGNAL: ${latestSignal.reason} | Entry: ${latestSignal.entry.toFixed(2)}`, latestSignal.type === 'LONG' ? 'signal-long' : 'signal-short');
            lastSignalTime = now;
        }
        requestRender();
    }
};

// High-Performance Canvas
const dpr = window.devicePixelRatio || 1;
let canvasWidth, canvasHeight;

const offscreenCanvas = document.createElement('canvas');
const offCtx = offscreenCanvas.getContext('2d', { alpha: false });

function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvasWidth = rect.width;
    canvasHeight = rect.height;
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    ctx.scale(dpr, dpr);
    offscreenCanvas.width = 20 * dpr;
    offscreenCanvas.height = 40 * dpr;
    offCtx.scale(dpr, dpr);
}
window.addEventListener('resize', () => { resizeCanvas(); requestRender(); });
resizeCanvas();

function drawCandle(x, y, width, height, isBullish) {
    offCtx.clearRect(0, 0, 20, 40);
    offCtx.fillStyle = isBullish ? '#00e676' : '#ff1744';
    const drawY = Math.floor((40 - height) / 2);
    const drawH = Math.floor(height);
    const drawW = Math.floor(width);
    offCtx.fillRect(Math.floor((20 - drawW) / 2), drawY, drawW, drawH);
    offCtx.fillRect(9, 0, 2, 40);
    ctx.drawImage(offscreenCanvas, Math.floor(x - 10), Math.floor(y - 20));
}

function renderChart() {
    if (!isRunning || candleData.length === 0) return;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw Grid Lines (Advanced Look)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i < canvasWidth; i += 50) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvasHeight); ctx.stroke();
    }
    for (let i = 0; i < canvasHeight; i += 50) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvasWidth, i); ctx.stroke();
    }

    const visibleCandles = candleData.slice(-60);
    const candleWidth = Math.floor((canvasWidth / 60) * 0.7);
    const spacing = Math.floor(canvasWidth / 60);

    let minPrice = Infinity, maxPrice = -Infinity;
    visibleCandles.forEach(c => {
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
    });
    const priceRange = maxPrice - minPrice || 1;
    const scaleY = (canvasHeight - 40) / priceRange;

    visibleCandles.forEach((c, i) => {
        const x = Math.floor(i * spacing + spacing / 2);
        const yHigh = Math.floor(20 + (maxPrice - c.high) * scaleY);
        const yLow = Math.floor(20 + (maxPrice - c.low) * scaleY);
        const yOpen = Math.floor(20 + (maxPrice - c.open) * scaleY);
        const yClose = Math.floor(20 + (maxPrice - c.close) * scaleY);

        const isBullish = c.close >= c.open;
        const bodyTop = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(1, Math.abs(yClose - yOpen)); 

        drawCandle(x, (bodyTop + bodyHeight / 2), candleWidth, bodyHeight, isBullish);
    });

    if (smcResults) {
        smcResults.fvgs.slice(-10).forEach(fvg => {
            const visibleIndex = fvg.index - (candleData.length - 60);
            if (visibleIndex >= 0 && visibleIndex < 60) {
                const x = Math.floor(visibleIndex * spacing);
                const yTop = Math.floor(20 + (maxPrice - fvg.top) * scaleY);
                const yBot = Math.floor(20 + (maxPrice - fvg.bottom) * scaleY);
                ctx.fillStyle = fvg.type === 'bullish' ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 23, 68, 0.15)';
                ctx.fillRect(x, yTop, spacing, yBot - yTop);
            }
        });
    }
}

let renderRequested = false;
function requestRender() {
    if (!renderRequested) {
        renderRequested = true;
        requestAnimationFrame(() => {
            renderChart();
            renderRequested = false;
        });
    }
}

async function startAutoScan() {
    if (isRunning) return;
    
    // Show loading spinner
    loadingSpinner.style.display = 'block';
    overlayText.textContent = 'Connecting to Data Stream...';
    overlay.style.opacity = '1';

    // Simulate delay for connection
    setTimeout(() => {
        abortController = new AbortController();
        const signal = abortController.signal;

        isRunning = true;
        btnStart.disabled = true;
        btnStop.disabled = false;
        statusEl.innerHTML = '<span class="dot"></span> Live Connected';
        statusEl.className = 'status connected';
        overlay.style.opacity = '0';
        addLogEntry('▶ Auto-Scan started. Fetching real-time data...', 'info');

        candleData = generateMockHistory(100);

        // FIXED: Abort logic inside setInterval
        mockIntervalId = setInterval(() => {
            if (signal.aborted) {
                clearInterval(mockIntervalId);
                return; // Exit cleanly without throwing error
            }

            const lastCandle = candleData[candleData.length - 1];
            const move = (Math.random() - 0.5) * 15;
            lastCandle.close += move;
            lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
            lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

            if (Math.random() > 0.85) {
                const newPrice = lastCandle.close;
                candleData.push({ open: newPrice, high: newPrice, low: newPrice, close: newPrice });
                if (candleData.length > 200) candleData.shift(); 
            }

            smcWorker.postMessage({ type: 'PROCESS_CANDLES', data: { candles: candleData } });
            requestRender();

        }, 200); 

    }, 800); // 800ms fake loading time
}

function stopAutoScan() {
    if (!isRunning) return;

    if (abortController) {
        abortController.abort();
        abortController = null;
    }

    clearInterval(mockIntervalId);
    isRunning = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    statusEl.innerHTML = '<span class="dot"></span> Disconnected';
    statusEl.className = 'status disconnected';
    addLogEntry('⏹ Auto-Scan stopped by user.', 'info');
}

function generateMockHistory(count) {
    const data = [];
    let price = 65000;
    for (let i = 0; i < count; i++) {
        const open = price;
        const close = price + (Math.random() - 0.5) * 100;
        const high = Math.max(open, close) + Math.random() * 30;
        const low = Math.min(open, close) - Math.random() * 30;
        data.push({ open, high, low, close });
        price = close;
    }
    return data;
}

function addLogEntry(message, type = 'info') {
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    div.innerHTML = `<span style="opacity:0.5; font-size:0.75rem; margin-bottom:2px; display:block;">[${time}]</span> ${message}`;
    debugLog.appendChild(div);
    debugLog.scrollTop = debugLog.scrollHeight;
}

btnStart.addEventListener('click', startAutoScan);
btnStop.addEventListener('click', stopAutoScan);
document.getElementById('btnClearLog').addEventListener('click', () => {
    debugLog.innerHTML = '';
    addLogEntry('Log cleared.', 'info');
});

resizeCanvas();
