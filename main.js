// --- DOM Elements ---
const canvas = document.getElementById('chartCanvas'); // (Not used in this lightweight-charts version)
const debugLog = document.getElementById('debugLog');
const statusEl = document.getElementById('connectionStatus');
const livePriceEl = document.getElementById('currentPrice');
const activeTfLabel = document.getElementById('activeTfLabel');

// --- State Management ---
let CONFIG = {
    symbol: 'XAUUSD',
    htfInterval: '1h',
    ltfInterval: '5m',
    swingLengthHTF: 10,
    swingLengthLTF: 5
};

let state = {
    htfData: [],
    ltfData: [],
    currentHTFCandle: null,
    currentLTFCandle: null,
    htfAnalysis: null,
    ltfAnalysis: null,
    chart: null,
    candleSeries: null,
    priceLines: [],
    overlays: { ob: true, fvg: true, liquidity: true, swings: true },
    ws: null,
    lastScanTime: 0
};

const TF_MS = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000
};

// --- Web Worker Setup ---
const smcWorker = new Worker('smc-worker.js');

smcWorker.onmessage = function(e) {
    if (e.data.type === 'SMC_RESULT') {
        state.htfAnalysis = e.data.data.htfAnalysis;
        state.ltfAnalysis = e.data.data.ltfAnalysis;
        const signalResult = e.data.data.signalResult;
        
        updateUI(signalResult);
        drawOverlays();
        
        document.getElementById('lastScan').textContent = `Last scan: ${new Date().toLocaleTimeString()}`;
        if (signalResult.signal) addToHistory(signalResult);
    }
};

// --- Chart Initialization (Lightweight Charts) ---
function initChart() {
    const container = document.getElementById('mainChart');
    
    state.chart = LightweightCharts.createChart(container, {
        width: container.clientWidth, height: 500,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9aa0a6', fontSize: 11 },
        grid: { vertLines: { color: 'rgba(30, 42, 58, 0.5)' }, horzLines: { color: 'rgba(30, 42, 58, 0.5)' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: 'rgba(41, 121, 255, 0.3)', width: 1, style: 2 }, horzLine: { color: 'rgba(41, 121, 255, 0.3)', width: 1, style: 2 } },
        rightPriceScale: { borderColor: 'rgba(30, 42, 58, 0.8)', scaleMargins: { top: 0.1, bottom: 0.2 } },
        timeScale: { borderColor: 'rgba(30, 42, 58, 0.8)', timeVisible: true, secondsVisible: false }
    });

    state.candleSeries = state.chart.addCandlestickSeries({
        upColor: '#00e676', downColor: '#ff1744', borderUpColor: '#00e676', borderDownColor: '#ff1744', wickUpColor: '#00e676', wickDownColor: '#ff1744'
    });

    window.addEventListener('resize', () => { state.chart.applyOptions({ width: container.clientWidth }); });
}

// --- WebSocket Real Live Data ---
function initWebSocket() {
    if (state.ws) state.ws.close();
    
    state.ws = new WebSocket('wss://socket.bayse.markets/ws/v1/realtime');

    state.ws.onopen = () => {
        document.getElementById('botStatus').textContent = 'Live Connected';
        document.getElementById('statusContainer').className = 'flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 border border-green-500/20';
        document.getElementById('statusDot').className = 'pulse-dot bg-green-400';
        
        state.ws.send(JSON.stringify({
            type: "subscribe", channel: "asset_prices", symbols: ["XAUUSD"]
        }));

        document.getElementById('chartLoading').style.opacity = '0';
        setTimeout(() => { document.getElementById('chartLoading').style.display = 'none'; }, 500);
    };

    state.ws.onmessage = (event) => {
        try {
            const lines = event.data.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                const msg = JSON.parse(line);
                if (msg.type === 'asset_price' && msg.data.symbol === 'XAUUSD') {
                    handleTick(msg.data.price, Date.now());
                }
            }
        } catch (err) {
            console.error("WS Parse Error:", err);
        }
    };

    state.ws.onclose = () => {
        document.getElementById('botStatus').textContent = 'Disconnected';
        document.getElementById('statusContainer').className = 'flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/20';
        document.getElementById('statusDot').className = 'pulse-dot bg-red-400';
        setTimeout(initWebSocket, 5000);
    };
}

// --- Candle Aggregation ---
function handleTick(price, time) {
    const now = Date.now();
    livePriceEl.textContent = price.toFixed(2);
    
    // LTF Candle
    const ltfMs = TF_MS[CONFIG.ltfInterval];
    const ltfBucket = Math.floor(time / ltfMs) * ltfMs;
    
    if (!state.currentLTFCandle || state.currentLTFCandle.time < ltfBucket / 1000) {
        if (state.currentLTFCandle) {
            state.ltfData.push(state.currentLTFCandle);
            if (state.ltfData.length > 300) state.ltfData.shift();
        }
        state.currentLTFCandle = { time: ltfBucket / 1000, open: price, high: price, low: price, close: price, volume: 100 };
    } else {
        state.currentLTFCandle.high = Math.max(state.currentLTFCandle.high, price);
        state.currentLTFCandle.low = Math.min(state.currentLTFCandle.low, price);
        state.currentLTFCandle.close = price;
    }

    // HTF Candle
    const htfBucket = Math.floor(time / (60 * 60 * 1000)) * (60 * 60 * 1000);
    if (!state.currentHTFCandle || state.currentHTFCandle.time < htfBucket / 1000) {
        if (state.currentHTFCandle) {
            state.htfData.push(state.currentHTFCandle);
            if (state.htfData.length > 100) state.htfData.shift();
        }
        state.currentHTFCandle = { time: htfBucket / 1000, open: price, high: price, low: price, close: price, volume: 0 };
    } else {
        state.currentHTFCandle.high = Math.max(state.currentHTFCandle.high, price);
        state.currentHTFCandle.low = Math.min(state.currentHTFCandle.low, price);
        state.currentHTFCandle.close = price;
    }

    // Update Chart
    if (state.candleSeries && state.currentLTFCandle) {
        state.candleSeries.update(state.currentLTFCandle);
    }

    // Send to Worker for Analysis (Throttled)
    if (!state.lastScanTime || now - state.lastScanTime > 2000) {
        runAnalysis();
        state.lastScanTime = now;
    }
}

// --- Trigger Analysis ---
function runAnalysis() {
    if (state.ltfData.length < 5 || state.htfData.length < 3) return;

    smcWorker.postMessage({
        type: 'ANALYZE',
        data: {
            htfData: [...state.htfData, state.currentHTFCandle].filter(Boolean),
            ltfData: [...state.ltfData, state.currentLTFCandle].filter(Boolean),
            config: CONFIG
        }
    });
}

// --- UI Updates ---
function updateUI(res) {
    if (!state.htfAnalysis || !state.ltfAnalysis) return;
    const htf = state.htfAnalysis, ltf = state.ltfAnalysis;

    document.getElementById('currentPrice').textContent = ltf.currentPrice.toFixed(2);
    
    if (state.ltfData.length > 0) {
        const highs = state.ltfData.map(d => d.high), lows = state.ltfData.map(d => d.low);
        document.getElementById('dayHigh').textContent = Math.max(...highs).toFixed(2);
        document.getElementById('dayLow').textContent = Math.min(...lows).toFixed(2);
    }

    document.getElementById('htfBias').innerHTML = htf.bias === 'BULLISH' ? '<span class="text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full text-xs">▲ BULLISH</span>' 
        : htf.bias === 'BEARISH' ? '<span class="text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full text-xs">▼ BEARISH</span>' 
        : '<span class="text-gray-400 bg-gray-500/10 px-2 py-0.5 rounded-full text-xs">— UNKNOWN</span>';
    
    document.getElementById('htfZone').innerHTML = htf.zone === 'DISCOUNT' ? '<span class="text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full text-xs">DISCOUNT</span>' 
        : htf.zone === 'PREMIUM' ? '<span class="text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full text-xs">PREMIUM</span>' 
        : '<span class="text-gray-400">---</span>';

    document.getElementById('equilibrium').textContent = htf.equilibrium ? htf.equilibrium.toFixed(2) : '---.--';
    document.getElementById('obCount').textContent = htf.orderBlocks.length;
    document.getElementById('fvgCount').textContent = htf.fvgs.length;

    // AMD
    document.querySelectorAll('.amd-phase').forEach(el => { el.classList.remove('active'); el.style.borderColor = 'rgba(75, 85, 99, 0.5)'; el.style.background = 'rgba(31, 41, 55, 0.5)'; });
    const activeAmd = document.querySelector(`[data-phase="${res.amd.phase}"]`);
    if (activeAmd) { activeAmd.classList.add('active'); activeAmd.style.borderColor = 'rgba(255, 215, 0, 0.5)'; activeAmd.style.background = 'rgba(255, 215, 0, 0.05)'; }
    document.getElementById('amdDescription').textContent = res.amd.description;

    // LTF
    document.getElementById('ltfStructure').innerHTML = ltf.ltfStructure 
        ? `<span class="${ltf.ltfStructure.includes('BULLISH') ? 'text-green-400' : 'text-red-400'} text-xs font-semibold px-2 py-0.5 rounded-full ${ltf.ltfStructure.includes('BULLISH') ? 'bg-green-500/10' : 'bg-red-500/10'}">${ltf.ltfStructure}</span>` 
        : '<span class="text-gray-400 text-xs">No shift</span>';
    
    document.getElementById('liquiditySweep').innerHTML = ltf.liquiditySweep ? `<span class="text-yellow-400 text-xs">⚡ ${ltf.sweepInfo}</span>` : '<span class="text-gray-500 text-xs">No sweep</span>';
    document.getElementById('inHTFPOI').innerHTML = ltf.priceInHTFPOI ? '<span class="text-green-400 text-xs">✅ Yes</span>' : '<span class="text-red-400 text-xs">❌ No</span>';
    document.getElementById('poiType').textContent = ltf.poiType || '---';

    // Conditions
    document.getElementById('conditionsList').innerHTML = res.conditions.map((c, i) => `
        <div class="condition-item ${c.met ? 'met' : 'unmet'} rounded-lg p-3 flex items-center gap-3 animate-slide-in" style="animation-delay: ${i * 0.1}s">
            <i class="${c.met ? 'ri-checkbox-circle-fill text-green-400' : 'ri-close-circle-fill text-red-400'}"></i>
            <span class="text-xs text-gray-300 flex-1">${c.name}</span>
            <span class="text-xs mono ${c.met ? 'text-green-400' : 'text-gray-500'}">${c.detail}</span>
        </div>
    `).join('');

    // Strength
    const strength = (res.conditionsMet / 5) * 100;
    document.getElementById('progressCircle').style.strokeDashoffset = 314 - (strength / 100) * 314;
    document.getElementById('strengthValue').textContent = `${Math.round(strength)}%`;
    document.getElementById('conditionsMet').textContent = `${res.conditionsMet}/5`;
    
    const confEl = document.getElementById('confidence');
    if (strength >= 80) { confEl.textContent = 'High'; confEl.className = 'text-lg font-bold mono text-green-400'; }
    else if (strength >= 50) { confEl.textContent = 'Medium'; confEl.className = 'text-lg font-bold mono text-yellow-400'; }
    else { confEl.textContent = 'Low'; confEl.className = 'text-lg font-bold mono text-red-400'; }

    // Signal Output
    const sigMsg = document.getElementById('signalMessage');
    const sigCard = document.getElementById('signalCard');
    
    if (res.signal) {
        const isBuy = res.signalType === 'BUY';
        sigCard.className = `glass-card p-5 animate-fade-in-up signal-card ${isBuy ? 'glow-green' : 'glow-red'}`;
        
        let targets = '', sl = '';
        if (isBuy) {
            targets = Math.max(...htf.swings.filter(s => s.type === 'Swing_High').slice(-3).map(s => s.level)).toFixed(2);
            sl = Math.min(...ltf.swings.filter(s => s.type === 'Swing_Low').slice(-3).map(s => s.level)).toFixed(2);
        } else {
            targets = Math.min(...htf.swings.filter(s => s.type === 'Swing_Low').slice(-3).map(s => s.level)).toFixed(2);
            sl = Math.max(...ltf.swings.filter(s => s.type === 'Swing_High').slice(-3).map(s => s.level)).toFixed(2);
        }

        document.getElementById('targetLevel').textContent = targets || '---.--';
        document.getElementById('entryLevel').textContent = ltf.currentPrice.toFixed(2);
        document.getElementById('slLevel').textContent = sl || '---.--';
        
        if (targets && sl) {
            const risk = Math.abs(ltf.currentPrice - parseFloat(sl)), reward = Math.abs(parseFloat(targets) - ltf.currentPrice);
            document.getElementById('rrRatio').textContent = `1:${risk > 0 ? (reward / risk).toFixed(1) : '--'}`;
        }

        sigMsg.innerHTML = `
            <div class="text-center">
                <div class="text-3xl mb-2">${res.signal.emoji}</div>
                <div class="text-lg font-bold ${isBuy ? 'text-green-400' : 'text-red-400'} mb-2">${res.signal.type}</div>
                <div class="grid grid-cols-3 gap-3 mt-4">
                    <div class="p-2 rounded-lg bg-blue-500/10"><div class="text-[10px] text-gray-500">Entry</div><div class="mono text-sm text-blue-400">${ltf.currentPrice.toFixed(2)}</div></div>
                    <div class="p-2 rounded-lg bg-green-500/10"><div class="text-[10px] text-gray-500">Target</div><div class="mono text-sm text-green-400">${targets || '---'}</div></div>
                    <div class="p-2 rounded-lg bg-red-500/10"><div class="text-[10px] text-gray-500">SL</div><div class="mono text-sm text-red-400">${sl || '---'}</div></div>
                </div>
            </div>`;
    } else {
        sigCard.className = 'glass-card p-5 animate-fade-in-up signal-card';
        sigMsg.innerHTML = `<div class="text-center"><div class="text-2xl mb-2">🔍</div><div class="text-sm text-gray-400">SCANNING... ${res.conditionsMet}/5 conditions met</div><div class="text-xs text-gray-600 mt-2">${res.conditions.filter(c => !c.met)[0]?.name || 'Analyzing...'}</div></div>`;
    }

    // Swings
    document.getElementById('swingPointsList').innerHTML = ltf.swings.slice(-6).reverse().map(s => `
        <div class="flex items-center justify-between p-2 rounded-lg ${s.type === 'Swing_High' ? 'bg-red-500/5' : 'bg-green-500/5'}">
            <div class="flex items-center gap-2"><i class="${s.type === 'Swing_High' ? 'ri-arrow-down-s-line text-red-400' : 'ri-arrow-up-s-line text-green-400'}"></i><span class="text-xs text-gray-400">${s.type === 'Swing_High' ? 'High' : 'Low'}</span></div>
            <span class="mono text-xs ${s.type === 'Swing_High' ? 'text-red-400' : 'text-green-400'}">${s.level.toFixed(2)}</span>
        </div>
    `).join('');
}

function drawOverlays() {
    if (!state.candleSeries) return;
    state.priceLines.forEach(line => state.candleSeries.removePriceLine(line));
    state.priceLines = [];

    if (state.overlays.ob && state.htfAnalysis) {
        state.htfAnalysis.orderBlocks.slice(-2).forEach(ob => {
            const color = ob.type === 'Bullish OB' ? '#00e676' : '#ff1744';
            state.priceLines.push(state.candleSeries.createPriceLine({ price: ob.top, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: ob.type }));
            state.priceLines.push(state.candleSeries.createPriceLine({ price: ob.bottom, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: '' }));
        });
    }
    if (state.overlays.fvg && state.htfAnalysis) {
        state.htfAnalysis.fvgs.slice(-2).forEach(fvg => {
            const color = fvg.type === 'Bullish FVG' ? '#2979ff' : '#ff9100';
            state.priceLines.push(state.candleSeries.createPriceLine({ price: fvg.top, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: fvg.type }));
            state.priceLines.push(state.candleSeries.createPriceLine({ price: fvg.bottom, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: false, title: '' }));
        });
    }
    if (state.overlays.liquidity && state.htfAnalysis) {
        state.htfAnalysis.liquidityZones.slice(-3).forEach(lz => {
            state.priceLines.push(state.candleSeries.createPriceLine({ price: lz.level, color: lz.zone_type === 'Buy' ? '#00e5ff' : '#e040fb', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: `${lz.zone_type} Liq` }));
        });
    }
    if (state.htfAnalysis && state.htfAnalysis.equilibrium) {
        state.priceLines.push(state.candleSeries.createPriceLine({ price: state.htfAnalysis.equilibrium, color: '#ffffff', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: 'EQ' }));
    }
}

function addToHistory(res) {
    const hist = document.getElementById('scanHistory');
    if (hist.querySelector('p')) hist.innerHTML = '';
    
    const div = document.createElement('div');
    div.className = 'p-2 rounded-lg bg-gray-800/30 border border-gray-700/30 animate-slide-in';
    div.innerHTML = `
        <div class="flex items-center justify-between">
            <span class="text-xs text-gray-500">${new Date().toLocaleTimeString()}</span>
            <span class="text-xs mono ${res.signalType === 'BUY' ? 'text-green-400' : 'text-red-400'}">${res.signal.type}</span>
        </div>
        <div class="flex items-center justify-between mt-1">
            <span class="text-[10px] text-gray-600">Bias: ${state.htfAnalysis.bias}</span>
            <span class="text-[10px] text-gray-600">${res.conditionsMet}/5 met</span>
        </div>`;
    hist.insertBefore(div, hist.firstChild);
    while (hist.children.length > 5) hist.removeChild(hist.lastChild);
}

// --- Controls & Events ---
function changeTimeframe(tf) {
    document.querySelectorAll('.tf-btn').forEach(btn => btn.className = 'tf-btn px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:bg-gray-700/50 transition-all');
    document.querySelector(`[data-tf="${tf}"]`).className = 'tf-btn px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30 transition-all';
    
    CONFIG.ltfInterval = tf;
    state.ltfData = []; 
    state.currentLTFCandle = null;
    state.candleSeries.setData([]);
    
    if (state.ws) state.ws.close();
    initWebSocket();
}

function toggleOB() { state.overlays.ob = !state.overlays.ob; document.getElementById('obToggle').style.opacity = state.overlays.ob ? '1' : '0.4'; drawOverlays(); }
function toggleFVG() { state.overlays.fvg = !state.overlays.fvg; document.getElementById('fvgToggle').style.opacity = state.overlays.fvg ? '1' : '0.4'; drawOverlays(); }
function toggleLiquidity() { state.overlays.liquidity = !state.overlays.liquidity; document.getElementById('liqToggle').style.opacity = state.overlays.liquidity ? '1' : '0.4'; drawOverlays(); }
function toggleSwings() { state.overlays.swings = !state.overlays.swings; document.getElementById('swingToggle').style.opacity = state.overlays.swings ? '1' : '0.4'; }

function toggleSettings() { document.getElementById('settingsModal').classList.toggle('hidden'); }
function applySettings() {
    CONFIG.swingLengthHTF = parseInt(document.getElementById('settingsSwingHTF').value);
    CONFIG.swingLengthLTF = parseInt(document.getElementById('settingsSwingLTF').value);
    toggleSettings();
    runAnalysis();
}

function updateClock() {
    const now = new Date();
    document.getElementById('currentTime').textContent = now.toLocaleTimeString();
    document.getElementById('currentDate').textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Start
document.addEventListener('DOMContentLoaded', () => {
    updateClock();
    setInterval(updateClock, 1000);
    initChart();
    initWebSocket();
});
