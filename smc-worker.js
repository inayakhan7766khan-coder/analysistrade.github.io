self.onmessage = function(e) {
    const { type, data } = e.data;

    if (type === 'PROCESS_CANDLES') {
        try {
            const candles = data.candles;
            if (!candles || candles.length < 10) return; 

            const smcData = analyzeSMC(candles);
            self.postMessage({ type: 'SMC_RESULT', data: smcData });
        } catch (error) {
            self.postMessage({ type: 'ERROR', error: error.message });
        }
    }
};

function analyzeSMC(candles) {
    const swings = detectSwings(candles, 5);
    const fvgs = detectFVG(candles);
    const orderBlocks = detectOrderBlocks(candles, swings);
    const signals = detectSignals(candles, swings, fvgs, orderBlocks);

    return { swings, fvgs, orderBlocks, signals };
}

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

function detectFVG(candles) {
    const fvgs = [];
    for (let i = 2; i < candles.length; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1]; 
        const c3 = candles[i];

        if (c3.low > c1.high) {
            fvgs.push({ type: 'bullish', top: c3.low, bottom: c1.high, index: i });
        } else if (c3.high < c1.low) {
            fvgs.push({ type: 'bearish', top: c1.low, bottom: c3.high, index: i });
        }
    }
    return fvgs;
}

function detectOrderBlocks(candles, swings) {
    const obs = [];
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].close > candles[i].open) { 
            const prev = candles[i - 1];
            if (prev.close < prev.open) { 
                const brokeSwing = swings.some(s => s.type === 'high' && s.index < i && candles[i].high > s.price);
                if (brokeSwing) {
                    obs.push({ type: 'bullish', top: prev.high, bottom: prev.low, index: i - 1 });
                }
            }
        }
    }
    return obs;
}

function detectSignals(candles, swings, fvgs, obs) {
    const signals = [];
    const last = candles[candles.length - 1];

    const recentSwingHigh = swings.filter(s => s.type === 'high').pop();
    const recentSwingLow = swings.filter(s => s.type === 'low').pop();

    if (recentSwingHigh && last.high > recentSwingHigh.price && last.close < recentSwingHigh.price) {
        const hasFVG = fvgs.some(f => f.type === 'bearish' && f.index >= candles.length - 5);
        if (hasFVG) {
            signals.push({
                type: 'SHORT',
                reason: `Liquidity Sweep at ${recentSwingHigh.price.toFixed(2)} + Bearish FVG`,
                entry: last.close,
                sl: last.high + (last.high * 0.001),
                tp: recentSwingLow ? recentSwingLow.price : last.close - (last.high - last.low) * 2
            });
        }
    }

    if (recentSwingLow && last.low < recentSwingLow.price && last.close > recentSwingLow.price) {
        const hasFVG = fvgs.some(f => f.type === 'bullish' && f.index >= candles.length - 5);
        if (hasFVG) {
            signals.push({
                type: 'LONG',
                reason: `Liquidity Sweep at ${recentSwingLow.price.toFixed(2)} + Bullish FVG`,
                entry: last.close,
                sl: last.low - (last.low * 0.001),
                tp: recentSwingHigh ? recentSwingHigh.price : last.close + (last.high - last.low) * 2
            });
        }
    }

    return signals;
}
