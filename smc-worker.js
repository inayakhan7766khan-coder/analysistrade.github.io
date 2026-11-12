self.onmessage = function(e) {
    if (e.data.type === 'ANALYZE') {
        try {
            const { htfData, ltfData, config } = e.data.data;
            
            const htfAnalysis = analyzeHTF(htfData, config.swingLengthHTF);
            const ltfAnalysis = analyzeLTF(ltfData, htfAnalysis, config.swingLengthLTF);
            const amd = detectAMDCycle();
            const signalResult = generateSignal(htfAnalysis, ltfAnalysis);
            signalResult.amd = amd;

            self.postMessage({ 
                type: 'SMC_RESULT', 
                data: { htfAnalysis, ltfAnalysis, signalResult } 
            });
        } catch (error) {
            console.error("Worker Error:", error);
        }
    }
};

function detectSwingHighsLows(data, swingLength) {
    const swings = [];
    if (data.length < swingLength * 2) return swings;
    
    for (let i = swingLength; i < data.length - swingLength; i++) {
        let isHigh = true, isLow = true;
        for (let j = 1; j <= swingLength; j++) {
            if (data[i].high <= data[i - j].high || data[i].high <= data[i + j].high) isHigh = false;
            if (data[i].low >= data[i - j].low || data[i].low >= data[i + j].low) isLow = false;
        }
        if (isHigh) swings.push({ index: i, time: data[i].time, level: data[i].high, type: 'Swing_High' });
        if (isLow) swings.push({ index: i, time: data[i].time, level: data[i].low, type: 'Swing_Low' });
    }
    return swings;
}

function detectOrderBlocks(data, swings) {
    const obs = [];
    for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1], curr = data[i];
        if (prev.close < prev.open && curr.close > curr.open) {
            if ((curr.close - curr.open) > (prev.open - prev.close) * 0.5) 
                obs.push({ index: i - 1, time: prev.time, top: prev.open, bottom: prev.close, type: 'Bullish OB', mitigated: false });
        }
        if (prev.close > prev.open && curr.close < curr.open) {
            if ((curr.open - curr.close) > (prev.close - prev.open) * 0.5) 
                obs.push({ index: i - 1, time: prev.time, top: prev.close, bottom: prev.open, type: 'Bearish OB', mitigated: false });
        }
    }
    obs.forEach(ob => {
        for (let i = ob.index + 2; i < data.length; i++) {
            if (ob.type === 'Bullish OB' && data[i].low < ob.bottom) { ob.mitigated = true; break; }
            if (ob.type === 'Bearish OB' && data[i].high > ob.top) { ob.mitigated = true; break; }
        }
    });
    return obs.filter(ob => !ob.mitigated);
}

function detectFVG(data) {
    const fvgs = [];
    for (let i = 2; i < data.length; i++) {
        const c1 = data[i - 2], c2 = data[i - 1], c3 = data[i];
        if (c3.low > c1.high) fvgs.push({ index: i - 1, time: c2.time, top: c3.low, bottom: c1.high, type: 'Bullish FVG', mitigated: false });
        if (c3.high < c1.low) fvgs.push({ index: i - 1, time: c2.time, top: c1.low, bottom: c3.high, type: 'Bearish FVG', mitigated: false });
    }
    fvgs.forEach(fvg => {
        for (let i = fvg.index + 2; i < data.length; i++) {
            if (fvg.type === 'Bullish FVG' && data[i].low < fvg.bottom) { fvg.mitigated = true; break; }
            if (fvg.type === 'Bearish FVG' && data[i].high > fvg.top) { fvg.mitigated = true; break; }
        }
    });
    return fvgs.filter(f => !f.mitigated);
}

function detectBOSCHoCH(data, swings) {
    const structures = [];
    const highs = swings.filter(s => s.type === 'Swing_High');
    const lows = swings.filter(s => s.type === 'Swing_Low');
    
    for (let i = 1; i < highs.length; i++) {
        for (let j = highs[i - 1].index; j <= highs[i].index && j < data.length; j++) {
            if (data[j].close > highs[i - 1].level && j > highs[i - 1].index) {
                structures.push({ index: j, time: data[j].time, level: highs[i - 1].level, type: highs[i].level > highs[i - 1].level ? 'BOS' : 'CHoCH', direction: 1 });
                break;
            }
        }
    }
    for (let i = 1; i < lows.length; i++) {
        for (let j = lows[i - 1].index; j <= lows[i].index && j < data.length; j++) {
            if (data[j].close < lows[i - 1].level && j > lows[i - 1].index) {
                structures.push({ index: j, time: data[j].time, level: lows[i - 1].level, type: lows[i].level < lows[i - 1].level ? 'BOS' : 'CHoCH', direction: -1 });
                break;
            }
        }
    }
    return structures.sort((a, b) => a.index - b.index);
}

function detectLiquidityZones(swings, rangePercent = 0.01) {
    const zones = [];
    const highs = swings.filter(s => s.type === 'Swing_High');
    const lows = swings.filter(s => s.type === 'Swing_Low');
    for (let i = 0; i < highs.length; i++) {
        for (let j = i + 1; j < highs.length; j++) {
            if (Math.abs(highs[i].level - highs[j].level) / highs[i].level < rangePercent) {
                zones.push({ level: (highs[i].level + highs[j].level) / 2, zone_type: 'Sell', time: highs[j].time });
            }
        }
    }
    for (let i = 0; i < lows.length; i++) {
        for (let j = i + 1; j < lows.length; j++) {
            if (Math.abs(lows[i].level - lows[j].level) / lows[i].level < rangePercent) {
                zones.push({ level: (lows[i].level + lows[j].level) / 2, zone_type: 'Buy', time: lows[j].time });
            }
        }
    }
    return zones;
}

function analyzeHTF(data, swingLength) {
    const swings = detectSwingHighsLows(data, swingLength || 10);
    const orderBlocks = detectOrderBlocks(data, swings);
    const fvgs = detectFVG(data);
    const liquidityZones = detectLiquidityZones(swings);
    
    let bias = 'Unknown';
    const recent = swings.slice(-6);
    const rHighs = recent.filter(s => s.type === 'Swing_High');
    const rLows = recent.filter(s => s.type === 'Swing_Low');
    
    if (rHighs.length >= 2 && rLows.length >= 2) {
        const lH = rHighs[rHighs.length - 1].level, pH = rHighs[rHighs.length - 2].level;
        const lL = rLows[rLows.length - 1].level, pL = rLows[rLows.length - 2].level;
        if (lH > pH && lL > pL) bias = 'BULLISH';
        else if (lH < pH && lL < pL) bias = 'BEARISH';
    }

    let equilibrium = null, zone = 'UNKNOWN';
    if (rHighs.length > 0 && rLows.length > 0) {
        const maxH = Math.max(...rHighs.map(h => h.level));
        const minL = Math.min(...rLows.map(l => l.level));
        equilibrium = (maxH + minL) / 2;
        zone = data[data.length - 1].close < equilibrium ? 'DISCOUNT' : 'PREMIUM';
    }
    return { bias, swings, orderBlocks, fvgs, liquidityZones, equilibrium, zone };
}

function analyzeLTF(data, htf, swingLength) {
    const swings = detectSwingHighsLows(data, swingLength || 5);
    const orderBlocks = detectOrderBlocks(data, swings);
    const fvgs = detectFVG(data);
    const bosChoch = detectBOSCHoCH(data, swings);
    const price = data[data.length - 1].close;
    
    let liquiditySweep = false, sweepInfo = null;
    const rLows = swings.filter(s => s.type === 'Swing_Low').slice(-3);
    const rHighs = swings.filter(s => s.type === 'Swing_High').slice(-3);
    
    if (rLows.length > 0 && data[data.length - 1].low < rLows[rLows.length-1].level && price > rLows[rLows.length-1].level) {
        liquiditySweep = true; sweepInfo = `Swept ${rLows[rLows.length-1].level.toFixed(2)}`;
    } else if (rHighs.length > 0 && data[data.length - 1].high > rHighs[rHighs.length-1].level && price < rHighs[rHighs.length-1].level) {
        liquiditySweep = true; sweepInfo = `Swept ${rHighs[rHighs.length-1].level.toFixed(2)}`;
    }

    let ltfStructure = null;
    if (bosChoch.length > 0) {
        const last = bosChoch[bosChoch.length - 1];
        ltfStructure = last.direction === 1 ? (last.type === 'BOS' ? 'BOS_BULLISH' : 'CHOCH_BULLISH') : (last.type === 'BOS' ? 'BOS_BEARISH' : 'CHOCH_BEARISH');
    }

    let priceInHTFPOI = false, poiType = null;
    if (htf.orderBlocks.length > 0) {
        for (const ob of htf.orderBlocks.slice(-3)) {
            if (ob.type === 'Bullish OB' && htf.bias === 'BULLISH' && ob.bottom <= price && price <= ob.top) { priceInHTFPOI = true; poiType = 'HTF Bullish OB'; break; }
            if (ob.type === 'Bearish OB' && htf.bias === 'BEARISH' && ob.bottom <= price && price <= ob.top) { priceInHTFPOI = true; poiType = 'HTF Bearish OB'; break; }
        }
    }
    if (!priceInHTFPOI && htf.fvgs.length > 0) {
        for (const fvg of htf.fvgs.slice(-3)) {
            if (fvg.type === 'Bullish FVG' && htf.bias === 'BULLISH' && fvg.bottom <= price && price <= fvg.top) { priceInHTFPOI = true; poiType = 'HTF Bullish FVG'; break; }
            if (fvg.type === 'Bearish FVG' && htf.bias === 'BEARISH' && fvg.bottom <= price && price <= fvg.top) { priceInHTFPOI = true; poiType = 'HTF Bearish FVG'; break; }
        }
    }
    return { swings, orderBlocks, fvgs, bosChoch, liquiditySweep, sweepInfo, ltfStructure, priceInHTFPOI, poiType, currentPrice: price };
}

function detectAMDCycle() {
    const h = new Date().getUTCHours();
    if (h >= 0 && h < 8) return { phase: 'ACCUMULATION', description: 'Asian Session - Smart money accumulating positions' };
    if (h >= 8 && h < 13) return { phase: 'MANIPULATION', description: 'London Open - Watch for liquidity sweep & manipulation' };
    if (h >= 13 && h < 22) return { phase: 'DISTRIBUTION', description: 'NY Session - Real trend continuation & distribution' };
    return { phase: 'OFF-PEAK', description: 'Low volatility period - reduced trading activity' };
}

function generateSignal(htf, ltf) {
    const conditions = [];
    let met = 0;
    
    const biasClear = htf.bias !== 'Unknown';
    conditions.push({ name: 'HTF Bias Clear', met: biasClear, detail: htf.bias });
    if (biasClear) met++;
    
    let zoneCorrect = (htf.bias === 'BULLISH' && htf.zone === 'DISCOUNT') || (htf.bias === 'BEARISH' && htf.zone === 'PREMIUM');
    conditions.push({ name: 'Premium/Discount Zone', met: zoneCorrect, detail: htf.zone });
    if (zoneCorrect) met++;
    
    conditions.push({ name: 'Price in HTF POI', met: ltf.priceInHTFPOI, detail: ltf.poiType || 'Not in POI' });
    if (ltf.priceInHTFPOI) met++;
    
    conditions.push({ name: 'Liquidity Sweep', met: ltf.liquiditySweep, detail: ltf.sweepInfo || 'No sweep' });
    if (ltf.liquiditySweep) met++;
    
    const structShift = ltf.ltfStructure !== null;
    conditions.push({ name: 'LTF Structure Shift', met: structShift, detail: ltf.ltfStructure || 'No shift' });
    if (structShift) met++;

    let signal = null, signalType = null;
    if (met === 5) {
        if (htf.bias === 'BULLISH' && ltf.ltfStructure?.includes('BULLISH')) { signalType = 'BUY'; signal = { type: 'STRONG BUY', emoji: '🟢' }; }
        else if (htf.bias === 'BEARISH' && ltf.ltfStructure?.includes('BEARISH')) { signalType = 'SELL'; signal = { type: 'STRONG SELL', emoji: '🔴' }; }
    }
    return { conditions, conditionsMet: met, signal, signalType };
}
