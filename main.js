/**
 * Main Application Logic
 * Handles UI, Canvas Rendering (with DPR & Off-screen optimizations), 
 * AbortController lifecycle, and Web Worker communication.
 */

// --- DOM Elements ---
const canvas = document.getElementById('chartCanvas');
const ctx = canvas.getContext('2d', { alpha: false }); // alpha: false boosts performance
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const debugLog = document.getElementById('debugLog');
const statusEl = document.getElementById('connectionStatus');
const overlay = document.getElementById('chartOverlay');

// --- State Management ---
let candleData = []; // Buffer for OHLC data
let smcResults = null;
let isRunning = false;
let animationFrameId = null;
let mockIntervalId = null;

// --- AbortController for Clean Lifecycle Management ---
let abortController = null;

// --- Web Worker Setup ---
const smcWorker = new Worker('smc-worker.js');

smcWorker.onmessage = function(e) {
    if (e.data.type === 'SMC_RESULT') {
        smcResults = e.data.data;
        
        // Log new signals
        if (smcResults.signals.length > 0) {
            const latestSignal = smcResults.signals[smcResults.signals.length - 1];
            addLogEntry(`🚀 ${latestSignal.type} SIGNAL: ${latestSignal.reason} | Entry: ${latestSignal.entry.toFixed(2)} | SL: ${latestSignal.sl.toFixed(2)} | TP: ${latestSignal.tp.toFixed(2)}`, latestSignal.type === 'LONG' ? 'signal-long' : 'signal-short');
        }
        
        // Trigger re-render
        requestRender();
    } else if (e.data.type === 'ABORTED') {
        addLogEntry('⏹ SMC Calculation aborted cleanly.', 'info');
    }
};

// --- 1. High-Performance Canvas Setup (DPR & Off-screen) ---
const dpr = window.devicePixelRatio || 1;
let canvasWidth, canvasHeight;

// Off-screen canvas for pre-rendering identical candle shapes (Massive performance boost)
const offscreenCanvas = document.createElement('canvas');
const offCtx = offscreenCanvas.getContext('2d', { alpha: false });

function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvasWidth = rect.width;
    canvasHeight = rect.height;

    // Set actual size in memory (scaled to account for extra pixel density)
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;

    // Normalize coordinate system to use css pixels
    ctx.scale(dpr, dpr);

    // Setup offscreen canvas (Fixed size for a single candle)
    offscreenCanvas.width = 20 * dpr;
    offscreenCanvas.height = 40 * dpr;
    offCtx.scale(dpr, dpr);
}
window.addEventListener('resize', () => { resizeCanvas(); requestRender(); });
resizeCanvas();

// --- 2. Rendering Logic (Batching & Math.floor optimization) ---
function drawCandle(x, y, width, height, isBullish) {
    // Pre-render candles on offscreen canvas to avoid repeated path calculations
    offCtx.clearRect(0, 0, 20, 40);
    offCtx.fillStyle = isBullish ? '#00c853' : '#ff1744';
    
    // Math.floor prevents sub-pixel anti-aliasing blur
    const drawY = Math.floor((40 - height) / 2);
    const drawH = Math.floor(height);
    const drawW = Math.floor(width);
    
    offCtx.fillRect(Math.floor((20 - drawW) / 2), drawY, drawW, drawH);
    
    // Draw wick
    offCtx.fillRect(Math.floor(10 - 1), 0, 2, 40);

    // Draw to main canvas using drawImage (Hardware accelerated batching)
    ctx.drawImage(offscreenCanvas, Math.floor(x - 10), Math.floor(y - 20));
}

function renderChart() {
    if (!isRunning || candleData.length === 0) return;

    // Clear canvas
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const visibleCandles = candleData.slice(-60); // Show last 60 candles
    const candleWidth = Math.floor((canvasWidth / 60) * 0.7);
    const spacing = Math.floor(canvasWidth / 60);

    // Find min/max for Y-axis scaling
    let minPrice = Infinity, maxPrice = -Infinity;
    visibleCandles.forEach(c => {
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
    });
    const priceRange = maxPrice - minPrice || 1;
    const scaleY = (canvasHeight - 40) / priceRange; // 20px padding top/bottom

    // Draw Candles
    visibleCandles.forEach((c, i) => {
        const x = Math.floor(i * spacing + spacing / 2);
        const yHigh = Math.floor(20 + (maxPrice - c.high) * scaleY);
        const yLow = Math.floor(20 + (maxPrice - c.low) * scaleY);
        const yOpen = Math.floor(20 + (maxPrice - c.open) * scaleY);
        const yClose = Math.floor(20 + (maxPrice - c.close) * scaleY);

        const isBullish = c.close >= c.open;
        const bodyTop = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(1, Math.abs(yClose - yOpen)); // Min 1px height

        drawCandle(x, (bodyTop + bodyHeight / 2), candleWidth, bodyHeight, isBullish);
    });

    // Draw SMC Overlays (FVGs, OBs) if available
    if (smcResults) {
        ctx.strokeStyle = 'rgba(255, 214, 0, 0.5)'; // Yellow for SMC zones
        ctx.lineWidth = 1;
        // (Simplified overlay drawing for FVGs/OBs based on visible indices)
        smcResults.fvgs.slice(-10).forEach(fvg => {
            // Map fvg.index to visible screen X (simplified for demo)
            const visibleIndex = fvg.index - (candleData.length - 60);
            if (visibleIndex >= 0 && visibleIndex < 60) {
                const x = Math.floor(visibleIndex * spacing);
                const yTop = Math.floor(20 + (maxPrice - fvg.top) * scaleY);
                const yBot = Math.floor(20 + (maxPrice - fvg.bottom) * scaleY);
                ctx.fillStyle = fvg.type === 'bullish' ? 'rgba(0, 200, 83, 0.2)' : 'rgba(255, 23, 68, 0.2)';
                ctx.fillRect(x, yTop, spacing, yBot - yTop);
            }
        });
    }

    animationFrameId = null; // Reset flag
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

// --- 3. Auto-Scan Control & Data Streaming (Mock WebSocket) ---
async function startAutoScan() {
    if (isRunning) return;
    
    // 1. Initialize AbortController
    abortController = new AbortController();
    const signal = abortController.signal;

    isRunning = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    statusEl.textContent = 'Connected (Streaming)';
    statusEl.className = 'status connected';
    overlay.style.display = 'none';
    addLogEntry('▶ Auto-Scan started. Fetching real-time data...', 'info');

    // Generate initial historical data
    candleData = generateMockHistory(100);

    try {
        // Simulate WebSocket real-time data stream
        mockIntervalId = setInterval(() => {
            // Check abort signal to prevent memory leaks/zombie intervals
            if (signal.aborted) {
                clearInterval(mockIntervalId);
                throw new DOMException('Aborted', 'AbortError');
            }

            // Simulate new tick updating the last candle or adding a new one
            const lastCandle = candleData[candleData.length - 1];
            const move = (Math.random() - 0.5) * 2;
            lastCandle.close += move;
            lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
            lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

            // Every 5 ticks, push a new candle
            if (Math.random() > 0.8) {
                const newPrice = lastCandle.close;
                candleData.push({ open: newPrice, high: newPrice, low: newPrice, close: newPrice });
                if (candleData.length > 200) candleData.shift(); // Keep buffer small for performance
            }

            // Send to Web Worker for SMC analysis (Non-blocking)
            smcWorker.postMessage({ 
                type: 'PROCESS_CANDLES', 
                data: { candles: candleData },
                abortSignal: signal 
            });

        }, 200); // 200ms tick rate

    } catch (error) {
        if (error.name === 'AbortError') {
            addLogEntry('⏹ Data stream terminated cleanly via AbortController.', 'info');
        } else {
            console.error('Stream error:', error);

        }
    }
}

function stopAutoScan() {
    if (!isRunning) return;

    // Trigger AbortController to cleanly stop all async operations
    if (abortController) {
        abortController.abort();
        abortController = null;
    }

    isRunning = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status disconnected';
    addLogEntry('⏹ Auto-Scan stopped by user.', 'info');
}

// --- 4. Utility Functions ---
function generateMockHistory(count) {
    const data = [];
    let price = 65000;
    for (let i = 0; i < count; i++) {
        const open = price;
        const close = price + (Math.random() - 0.5) * 50;
        const high = Math.max(open, close) + Math.random() * 20;
        const low = Math.min(open, close) - Math.random() * 20;
        data.push({ open, high, low, close });
        price = close;
    }
    return data;
}

function addLogEntry(message, type = 'info') {
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    div.innerHTML = `<span style="opacity:0.7">[${time}]</span> ${message}`;
    debugLog.appendChild(div);
    debugLog.scrollTop = debugLog.scrollHeight; // Auto-scroll to bottom
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