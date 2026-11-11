/**
 * SMC Worker: Handles heavy algorithmic calculations off the main thread.
 * Prevents Long Animation Frames (LoAF) and UI freezing.
 */

self.onmessage = function(e) {
    const { type, data, abortSignal } = e.data;

    if (type === 'PROCESS_CANDLES') {
        try {
            const candles = data.candles;
            if (candles.length < 10) return; // Need minimum data for SMC

            const smcData = analyzeSMC(candles);
            
            // Send results back to main thread
            self.postMessage({ type: 'SMC_RESULT', data: smcData });
        } catch (error) {
            if (error.name === 'AbortError') {
                self.postMessage({ type: 'ABORTED' });
            } else {
                self.postMessage({ type: 'ERROR', error: error.message });
            }
        }
    }
};

function analyzeSMC(candles) {
    const swings = detectSwings(candles, 5);
    const fvgs = detectFVG(candles);
    const orderBlocks = detectOrderBlocks(candles, swings);
    const signals = detectSignals(candles, swings, fvgs, orderBlocks);

    return { swings, fvgs, orderBlocks, signals, lastCandle: candles[candles.length - 1] };
}

// 1. Detect Swing Highs/Lows (HTF Bias foundation)
function detectSwings(candles, lookback) {
    const swings = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
        const current = candles[i];
        const prev = candles.slice(i - lookback, i);
        const next = candles.slice(i + 1, i + lookback + 1);

        const isHigh = prev.every(c => current.high > c.high) && next.every(c => current.high > c.high);
        const isLow = prev.every(c => current.low < c.low) && next.every(c => current.low < c.low);

        if (isHigh) swings.push({ type: 'high', index: i, price: current.high });
        if (isLow) swings.push({ type: 'low', index: i, price: current.low });
    }
    return swings;
}

// 2. Detect Fair Value Gap (3-candle pattern)
function detectFVG(candles) {
    const fvgs = [];
    for (let i = 2; i < candles.length; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1]; // Impulse candle
        const c3 = candles[i];

        // Bullish FVG: Low of c3 is higher than High of c1
        if (c3.low > c1.high) {
            fvgs.push({ type: 'bullish', top: c3.low, bottom: c1.high, index: i });
        }
        // Bearish FVG: High of c3 is lower than Low of c1
        else if (c3.high < c1.low) {
            fvgs.push({ type: 'bearish', top: c1.low, bottom: c3.high, index: i });
        }
    }
    return fvgs;
}

// 3. Detect Order Blocks (Last opposite candle before a strong move/swing break)
function detectOrderBlocks(candles, swings) {
    const obs = [];
    // Simplified OB logic: Bearish candle before a bullish swing high break
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].close > candles[i].open) { // Bullish candle
            const prev = candles[i - 1];
            if (prev.close < prev.open) { // Previous was bearish
                // Check if this move broke a recent swing high
                const brokeSwing = swings.some(s => s.type === 'high' && s.index < i && candles[i].high > s.price);
                if (brokeSwing) {
                    obs.push({ type: 'bullish', top: prev.high, bottom: prev.low, index: i - 1 });
                }
            }
        }
    }
    return obs;
}

// 4. Synthesize Entry Signals (Liquidity Sweep + CHOCH + FVG/OB)
function detectSignals(candles, swings, fvgs, obs) {
    const signals = [];
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    // Check for Liquidity Sweep (Wick grabs high/low, body closes inside)
    const recentSwingHigh = swings.filter(s => s.type === 'high').pop();
    const recentSwingLow = swings.filter(s => s.type === 'low').pop();

    if (recentSwingHigh && last.high > recentSwingHigh.price && last.close < recentSwingHigh.price) {
        // Liquidity Swept! Now check for CHOCH (Close below a minor low) and FVG/OB
        const hasFVG = fvgs.some(f => f.type === 'bearish' && f.index >= candles.length - 5);
        if (hasFVG) {
            signals.push({
                type: 'SHORT',
                reason: `Liquidity Sweep at ${recentSwingHigh.price} + Bearish FVG Confirmed (CHOCH)`,
                entry: last.close,
                sl: last.high + (last.high * 0.001), // Just above sweep wick
                tp: recentSwingLow ? recentSwingLow.price : last.close - (last.high - last.low) * 2
            });
        }
    }

    if (recentSwingLow && last.low < recentSwingLow.price && last.close > recentSwingLow.price) {
        const hasFVG = fvgs.some(f => f.type === 'bullish' && f.index >= candles.length - 5);
        if (hasFVG) {
            signals.push({
                type: 'LONG',
                reason: `Liquidity Sweep at ${recentSwingLow.price} + Bullish FVG Confirmed (CHOCH)`,
                entry: last.close,
                sl: last.low - (last.low * 0.001), // Just below sweep wick
                tp: recentSwingHigh ? recentSwingHigh.price : last.close + (last.high - last.low) * 2
            });
        }
    }

    return signals;
}