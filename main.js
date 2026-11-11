// --- DOM Elements ---
const canvas = document.getElementById('chartCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const debugLog = document.getElementById('debugLog');
const statusEl = document.getElementById('connectionStatus');
const overlay = document.getElementById('chartOverlay');
const overlayText = document.getElementById('overlayText');
const loadingSpinner = document.getElementById('loadingSpinner');
const livePriceEl = document.getElementById('livePrice');
const activeTfLabel = document.getElementById('activeTfLabel');

// --- State ---
let candleData = []; 
let smcResults = null;
let isRunning = false;
let ws = null; // WebSocket reference
let lastSignalTime = 0; 
let currentTimeframe = '1m';
let currentCandle = null;
let candleTimer = null;

// --- Web Worker Setup ---
const smcWorker = new Worker('smc-worker.js');

// --- Timeframe Selector ---
document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentTimeframe = e.target.getAttribute('data-tf');
        activeTfLabel.textContent = currentTimeframe;
        addLogEntry(`Timeframe switched to ${currentTimeframe}.`, 'info');
        
        // Reset current candle timer when timeframe changes
        if (isRunning) {
            clearInterval(candleTimer);
            startCandleTimer();
        }
    });
});

// --- Web Worker Message Handler ---
smcWorker.onmessage = function(e) {
    if (e.data.type === 'SMC_RESULT') {
        smcResults = e.data.data;
        
        const now = Date.now();
        // Log signals with a cooldown to prevent spam
        if (smcResults.signals.length > 0 && (now - lastSignalTime > 4000)) {
            const latestSignal = smcResults.signals[smcResults.signals.length - 1];
            
            const logMsg = `
                <div class="signal-badge">${currentTimeframe}</div><br>
                <strong>${latestSignal.type} SIGNAL</strong><br>
                Entry: ${latestSignal.entry.toFixed(2)}<br>
                <span style="font-size:0.75rem; opacity:0.8">SL: ${latestSignal.sl.toFixed(2)} | TP: ${latestSignal.tp.toFixed(2)}</span>
            `;
            
            addLogEntry(logMsg, latestSignal.type === 'LONG' ? 'signal-long' : 'signal-short');
            lastSignalTime = now;
        }
        requestRender();
    }
};

// --- Canvas Setup (DPR & Offscreen) ---
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
    offCtx.fillStyle = isBullish ? '#00ff88' : '#ff3366';
    const drawY = Math.floor((40 - height) / 2);
    const drawH = Math.floor(height);
    const drawW = Math.floor(width);
    offCtx.fillRect(Math.floor((20 - drawW) / 2), drawY, drawW, drawH);
    offCtx.fillRect(9, 0, 2, 40);
    ctx.drawImage(offscreenCanvas, Math.floor(x - 10), Math.floor(y - 20));
}

function renderChart() {
    if (!isRunning || candleData.length === 0) return;

    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let i = 0; i < canvasWidth; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvasHeight); ctx.stroke(); }
    for (let i = 0; i < canvasHeight; i += 40) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvasWidth, i); ctx.stroke(); }

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
        const yOpen = Math.floor(20 + (maxPrice - c.open) * scaleY);
        const yClose = Math.floor(20 + (maxPrice - c.close) * scaleY);

        const isBullish = c.close >= c.open;
        const bodyTop = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(1, Math.abs(yClose - yOpen)); 

        drawCandle(x, (bodyTop + bodyHeight / 2), candleWidth, bodyHeight, isBullish);
    });

    // Current Price Line
    const lastCandle = candleData[candleData.length - 1];
    const yLast = Math.floor(20 + (maxPrice - lastCandle.close) * scaleY);
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.5)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(0, yLast); ctx.lineTo(canvasWidth, yLast); ctx.stroke();
    ctx.setLineDash([]);

    // FVG Overlays
    if (smcResults) {
        smcResults.fvgs.slice(-5).forEach(fvg => {
            const visibleIndex = fvg.index - (candleData.length - 60);
            if (visibleIndex >= 0 && visibleIndex < 60) {
                const x = Math.floor(visibleIndex * spacing);
                const yTop = Math.floor(20 + (maxPrice - fvg.top) * scaleY);
                const yBot = Math.floor(20 + (maxPrice - fvg.bottom) * scaleY);
                ctx.fillStyle = fvg.type === 'bullish' ? 'rgba(0, 255, 136, 0.1)' : 'rgba(255, 51, 102, 0.1)';
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

// --- LIVE DATA INTEGRATION (Bayse Markets WebSocket) ---
function startAutoScan() {
    if (isRunning) return;
    
    loadingSpinner.style.display = 'block';
    overlayText.textContent = 'CONNECTING TO LIVE GOLD FEED...';
    overlay.style.opacity = '1';

    // Initialize empty candle data
    candleData = [];
    currentCandle = null;

    // 1. Connect to Bayse Markets WebSocket (No API Key Required)
    ws = new WebSocket('wss://socket.bayse.markets/ws/v1/realtime');

    ws.onopen = () => {
        loadingSpinner.style.display = 'none';
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        
        isRunning = true;
        btnStart.disabled = true;
        btnStop.disabled = false;
        statusEl.innerHTML = '<span class="dot"></span> LIVE GOLD';
        statusEl.className = 'status connected';
        addLogEntry('Connected to live XAU/USD feed. Streaming...', 'info');

        // Subscribe to Gold (XAUUSD)
        ws.send(JSON.stringify({
            type: "subscribe",
            channel: "asset_prices",
            symbols: ["XAUUSD"]
        }));

        // Start building candles
        startCandleTimer();
    };

    ws.onmessage = (event) => {
        try {
            // Handle possible multiple JSON lines
            const lines = event.data.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                const msg = JSON.parse(line);
                
                if (msg.type === 'asset_price' && msg.data.symbol === 'XAUUSD') {
                    const price = msg.data.price;
                    
                    // Update Ticker
                    livePriceEl.textContent = price.toFixed(2);
                    
                    // Build/Update Current Candle
                    if (!currentCandle) {
                        currentCandle = { open: price, high: price, low: price, close: price };
                    } else {
                        currentCandle.close = price;
                        currentCandle.high = Math.max(currentCandle.high, price);
                        currentCandle.low = Math.min(currentCandle.low, price);
                    }

                    // Send to Worker for SMC Analysis
                    smcWorker.postMessage({ 
                        type: 'PROCESS_CANDLES', 
                        data: { candles: [...candleData, currentCandle] } 
                    });
                    
                    requestRender();
                }
            }
        } catch (err) {
            console.error("WS Parse Error:", err);
        }
    };

    ws.onerror = (err) => {
        console.error("WS Error:", err);
        addLogEntry('Connection error. Please check your internet.', 'info');
        stopAutoScan();
    };

    ws.onclose = () => {
        addLogEntry('Live feed disconnected.', 'info');
        stopAutoScan();
    };
}

function startCandleTimer() {
    // Determine candle duration based on timeframe
    let ms = 60000; // 1m default
    if (currentTimeframe === '5m') ms = 300000;
    else if (currentTimeframe === '15m') ms = 900000;
    else if (currentTimeframe === '1H') ms = 3600000;

    candleTimer = setInterval(() => {
        if (currentCandle) {
            candleData.push(currentCandle);
            if (candleData.length > 200) candleData.shift();
            currentCandle = null; // Start a new candle
            addLogEntry(`New ${currentTimeframe} candle formed.`, 'info');
        }
    }, ms);
}

function stopAutoScan() {
    if (!isRunning && !ws) return;

    if (ws) {
        ws.close();
        ws = null;
    }
    clearInterval(candleTimer);
    
    isRunning = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    statusEl.innerHTML = '<span class="dot"></span> OFF';
    statusEl.className = 'status disconnected';
    addLogEntry('Auto-Scan halted.', 'info');
}

// --- Utility Functions ---
function addLogEntry(message, type = 'info') {
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    div.innerHTML = `<span class="time">[${time}]</span> ${message}`;
    debugLog.appendChild(div);
    debugLog.scrollTop = debugLog.scrollHeight;
}

// --- Event Listeners ---
btnStart.addEventListener('click', startAutoScan);
btnStop.addEventListener('click', stopAutoScan);
document.getElementById('btnClearLog').addEventListener('click', () => {
    debugLog.innerHTML = '';
    addLogEntry('Log cleared.', 'info');
});

// Initial render
resizeCanvas();
