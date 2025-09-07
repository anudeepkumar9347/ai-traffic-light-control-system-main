(function() {
  'use strict';

  // ======= Config =======
  const SIDES = ['North','East','South','West'];
  const SIDE_IDX = { North:0, East:1, South:2, West:3 };
  const COLORS = { North:'#4fc3f7', East:'#f06292', South:'#81c784', West:'#ffb74d' };
  const INTERGREEN = 3;   // all-red seconds
  const YELLOW = 3;
  const MIN_GREEN = 5;
  const MAX_GREEN = 45;
  const DEFAULT_CYCLE = 60;

  // ======= Utilities =======
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const nowSec = () => performance.now() / 1000;

  function poisson(lambda) {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    while (p > L) { k++; p *= Math.random(); }
    return k - 1;
  }

  // ======= Canvas and Viewport =======
  class View {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = window.devicePixelRatio || 1;
      this.width = 900; this.height = 700;
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }
    resize() {
      const parent = this.canvas.parentElement || document.body;
      const rect = parent.getBoundingClientRect();
      const aspect = 900/700;
      let w = rect.width - 32; let h = w / aspect;
      if (h > rect.height - 32) { h = rect.height - 32; w = h * aspect; }
      w = Math.max(300, w); h = Math.max(220, h);
      this.width = w; this.height = h; this.dpr = window.devicePixelRatio || 1;
      this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
      this.canvas.width = Math.floor(w * this.dpr); this.canvas.height = Math.floor(h * this.dpr);
      this.ctx.setTransform(1,0,0,1,0,0);
      this.ctx.scale(this.dpr, this.dpr);
    }
    layout() {
      const cx = this.width/2, cy = this.height/2;
      const roadHalf = Math.min(this.width,this.height)*0.1; // half-width of road corridor
      const lane = roadHalf/2;
      const carW = clamp(lane*0.5, 8, 18);
      const carH = clamp(carW*2, 16, 36);
      return { width:this.width, height:this.height, centerX:cx, centerY:cy, roadHalf, lane, carW, carH };
    }
  }

  // ======= Vehicles =======
  class Vehicle {
    constructor(side, x, y, rot, w, h) {
      this.side = side; this.x = x; this.y = y; this.rot = rot;
      this.w = w; this.h = h; this.v = 0; this.vMax = 120; this.acc = 80; // px/s, px/s^2
      this.state = 'queue'; // queue | moving | exiting | done
      this.spawnAt = nowSec();
      this._tween = null; // {fromX,fromY,toX,toY,t, dur}
    }
    update(dt) {
      if (this.state !== 'moving' && this.state !== 'exiting') return;
      // simple accel towards vMax
      if (this.v < this.vMax) this.v = Math.min(this.vMax, this.v + this.acc*dt);
      // clamp per-frame displacement to smooth motion at high dt/timeScale
      const step = this.v * dt;
      const maxStep = 0.6 * this.h; // no more than ~60% car length per frame
      const scale = step > maxStep && step > 0 ? (maxStep / step) : 1;
      const dx = Math.cos(this.rot) * this.v * dt * scale;
      const dy = Math.sin(this.rot) * this.v * dt * scale;
      this.x += dx; this.y += dy;
    }
  }

  // ======= Traffic Model on Frontend (fallback) =======
  function computeLocalSchedule(qlens) {
    const demand = qlens.map(n => Math.max(0, Number(n)||0));
    const total = demand.reduce((a,b)=>a+b,0);
    let baseCycle = DEFAULT_CYCLE;
    if (total <= 10) baseCycle = 60; else if (total <= 40) baseCycle = 80; else if (total <= 80) baseCycle = 100; else baseCycle = 120;
    const mean = total/4; const variance = total>0 ? demand.reduce((s,v)=>s+Math.pow(v-mean,2),0)/4 : 0;
    const cycle = Math.min(150, baseCycle * (1 + (variance/(total+1))*0.2));
    const totalGreen = Math.max(20, cycle - 4*INTERGREEN);
    let greens;
    if (total<=0) greens = [totalGreen/4,totalGreen/4,totalGreen/4,totalGreen/4];
    else {
      const proportions = demand.map(d=>d/(total+1e-9));
      const saturation = 1 - Math.exp(-total/50);
      const adj = proportions.map(p=>p*(0.7+0.3*saturation));
      const sumAdj = adj.reduce((a,b)=>a+b,0)||1;
      greens = adj.map(p => (p/sumAdj)*totalGreen);
    }
    greens = greens.map(g=>clamp(g, MIN_GREEN, MAX_GREEN));
    const sumG = greens.reduce((a,b)=>a+b,0)||1; const scale = (totalGreen/sumG);
    greens = greens.map(g=>g*scale);
    const schedule = greens.map((g,i)=>({ side:SIDES[i], green_duration:parseFloat(g.toFixed(2)), priority_score:parseFloat((demand[i]+demand[i]*demand[i]/100).toFixed(2)), demand_level:demand[i] }));
    // Order by green desc then demand
    schedule.sort((a,b) => b.green_duration - a.green_duration || b.demand_level - a.demand_level);
    let t=0; schedule.forEach(s=>{ s.start_after = parseFloat(t.toFixed(2)); t += s.green_duration + INTERGREEN; });
    return { cycle_time:parseFloat(cycle.toFixed(2)), green_total:parseFloat(greens.reduce((a,b)=>a+b,0).toFixed(2)), schedule };
  }

  // ======= Backend API client =======
  class ApiClient {
    constructor(base='') { this.base = base; }
    async simulate(qlens) {
      // Cancel any previous request to avoid overlap
      if (this._ctrl) {
        try { this._ctrl.abort(); } catch(_) {}
      }
      const ctrl = new AbortController(); this._ctrl = ctrl;
      const to = setTimeout(()=>ctrl.abort(), 2500);
      try {
        const res = await fetch(`${this.base}/simulate`, {
          method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ congestion_data: qlens.map(q=>[q]) }), signal: ctrl.signal
        });
        clearTimeout(to);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        clearTimeout(to);
        throw e;
      }
    }
  }

  // ======= Scheduler =======
  class Scheduler {
    constructor(api, statusEl) {
      this.api = api; this.statusEl = statusEl;
      this.last = null; this.lastFetchAt = 0; this.minInterval = 12; // seconds of sim time
      this._reqSeq = 0; this._backoff = 0; // simple backoff seconds (sim-time based)
    }
    setStatus(txt) { if (this.statusEl) this.statusEl.textContent = txt; }
    static _isFiniteNumber(x){ return typeof x==='number' && Number.isFinite(x); }
    _validateSchedule(payload){
      if (!payload || !Array.isArray(payload.schedule)) return null;
      const seen = new Set();
      const clean = [];
      for (const it of payload.schedule) {
        if (!it || !it.side || !SIDES.includes(it.side)) continue;
        if (seen.has(it.side)) continue; // enforce unique per side
        const g = Number(it.green_duration);
        if (!Scheduler._isFiniteNumber(g) || g < 0) continue;
        clean.push({ ...it, green_duration: clamp(g, MIN_GREEN, MAX_GREEN) });
        seen.add(it.side);
      }
      if (!clean.length) return null;
      return { ...payload, schedule: clean };
    }
    async getSchedule(qlens, simTime) {
      const minInt = this.minInterval + this._backoff;
      if (this.last && (simTime - this.lastFetchAt) < minInt) return this.last;
      const seq = ++this._reqSeq;
      try {
        const resultRaw = await this.api.simulate(qlens);
        if (seq !== this._reqSeq) return this.last; // superseded
        const result = this._validateSchedule(resultRaw);
        if (result) {
          this.last = result; this.lastFetchAt = simTime; this._backoff = 0; this.setStatus('🟢 Connected');
          return this.last;
        }
        throw new Error('bad payload');
      } catch (_) {
        // simple exponential-ish backoff up to 30s
        this._backoff = clamp((this._backoff||0) ? this._backoff*1.5 : 5, 0, 30);
        const local = computeLocalSchedule(qlens);
        this.last = local; this.lastFetchAt = simTime; this.setStatus('🟡 Offline (Local AI)');
        return local;
      }
    }
  }

  // ======= Signals =======
  class Signals {
    constructor() { this.active = null; this.phase = 'allred'; this.phaseT = 0; this.greenRemaining = 0; }
    update(dt, schedule, qlens) {
      if (!schedule || !schedule.schedule || schedule.schedule.length===0) return;
      this.phaseT += dt;
      if (!this.active) {
        // pick highest queue length side
        const s = schedule.schedule.slice().sort((a,b)=> (qlens[SIDE_IDX[b.side]]||0) - (qlens[SIDE_IDX[a.side]]||0))[0] || schedule.schedule[0];
        this.active = s.side; this.greenRemaining = s.green_duration; this.phase = 'green'; this.phaseT = 0;
      }
      if (this.phase === 'green') {
        this.greenRemaining = Math.max(0, this.greenRemaining - dt);
        if (this.greenRemaining <= 0) { this.phase = 'yellow'; this.phaseT = 0; }
      } else if (this.phase === 'yellow') {
        if (this.phaseT >= YELLOW) { this.phase = 'allred'; this.phaseT = 0; }
      } else if (this.phase === 'allred') {
        if (this.phaseT >= INTERGREEN) {
          // next side with vehicles, else next in schedule
          const idx = schedule.schedule.findIndex(s=>s.side===this.active);
          let next = null;
          for (let i=1;i<=schedule.schedule.length;i++){
            const c = schedule.schedule[(idx+i)%schedule.schedule.length];
            if ((qlens[SIDE_IDX[c.side]]||0) > 0) { next = c; break; }
          }
          if (!next) next = schedule.schedule[(idx+1)%schedule.schedule.length];
          this.active = next.side; this.greenRemaining = next.green_duration; this.phase = 'green'; this.phaseT = 0;
        }
      }
    }
  }

  // ======= Traffic System =======
  class TrafficSystem {
    constructor(view) {
      this.view = view;
      this.queues = { North:[], East:[], South:[], West:[] };
      this.approach = { North:[], East:[], South:[], West:[] };
      this.moving = [];
      this.releaseCooldown = { North:0, East:0, South:0, West:0 };
      this.stats = { total:0, processed:0, wait:0 };
      this.spawnAcc = { North:0, East:0, South:0, West:0 }; // per-side accumulators
    }
    _queueTarget(side, idx, layout){
      const spacing = Math.max(35, layout.carH + 15);
      if (side==='North') return { x: layout.centerX - layout.lane, y: layout.centerY - layout.roadHalf - 10 - idx*spacing, rot: Math.PI/2 };
      if (side==='South') return { x: layout.centerX + layout.lane, y: layout.centerY + layout.roadHalf + 10 + idx*spacing, rot: -Math.PI/2 };
      if (side==='East')  return { x: layout.centerX + layout.roadHalf + 10 + idx*spacing, y: layout.centerY + layout.lane, rot: Math.PI };
      // West
      return { x: layout.centerX - layout.roadHalf - 10 - idx*spacing, y: layout.centerY - layout.lane, rot: 0 };
    }
    _spawnPos(side, layout){
      // Spawn off-canvas along inbound lane
      const pad = 60;
      if (side==='North') return { x: layout.centerX - layout.lane, y: -pad, rot: Math.PI/2 };
      if (side==='South') return { x: layout.centerX + layout.lane, y: layout.height + pad, rot: -Math.PI/2 };
      if (side==='East')  return { x: layout.width + pad, y: layout.centerY + layout.lane, rot: Math.PI };
      return { x: -pad, y: layout.centerY - layout.lane, rot: 0 };
    }
    queueSpawn(dt, rates, layout) {
      const spacing = Math.max(35, layout.carH + 15);
      const qStart = layout.roadHalf + Math.max(30, layout.roadHalf*0.4);
      SIDES.forEach((side, idx)=>{
        const rate = rates[idx]||0; const lambda = (rate/60)*dt;
        this.spawnAcc[side] += Math.max(0, lambda);
        let spawned = 0; const MAX_PER_FRAME = 3;
        while (this.spawnAcc[side] >= 1 - 1e-9 && spawned < MAX_PER_FRAME) {
          // Limit total vehicles in system (queue + approach)
          const pendingLen = this.queues[side].length + this.approach[side].length;
          if (pendingLen >= 24) { break; }
          const sp = this._spawnPos(side, layout);
          const v = new Vehicle(side, sp.x, sp.y, sp.rot, layout.carW, layout.carH);
          v.state = 'approach'; v.v = v.vMax * 0.6; // approach at moderate speed
          this.approach[side].push(v); this.stats.total++; spawned++; this.spawnAcc[side] -= 1;
        }
      });
    }
    updateApproach(dt, layout){
      // Move approach vehicles toward their target queue slots; when arrived, move into queues
      for (const side of SIDES) {
        const baseIdx = this.queues[side].length; // current queued count
        // Ensure deterministic order
        const arr = this.approach[side];
        for (let i=0; i<arr.length; i++) {
          const v = arr[i];
          const { x:tx, y:ty, rot } = this._queueTarget(side, baseIdx + i, layout);
          // Desired direction to target
          const dx = tx - v.x, dy = ty - v.y;
          const dist = Math.hypot(dx, dy);
          // Braking near target
          const brakeDist = Math.max(20, v.h*1.2);
          const desiredV = dist > brakeDist ? v.vMax*0.7 : Math.max(0, (dist/brakeDist) * (v.vMax*0.5));
          // Simple accelerate/decelerate towards desiredV
          if (v.v < desiredV) v.v = Math.min(desiredV, v.v + v.acc*dt);
          else v.v = Math.max(desiredV, v.v - (v.acc*1.5)*dt);
          // Move a step towards target without overshoot
          if (dist > 1e-3) {
            const step = Math.min(dist, v.v*dt);
            const ux = dx/dist, uy = dy/dist;
            v.x += ux*step; v.y += uy*step; v.rot = rot;
          }
        }
        // Transfer arrived vehicles into queue
        let j = 0;
        while (j < this.approach[side].length) {
          const v = this.approach[side][j]; 
          const { x:tx, y:ty } = this._queueTarget(side, this.queues[side].length, layout);
          if (Math.hypot(v.x - tx, v.y - ty) <= 2.0) {
            v.state = 'queue'; v.v = 0;
            // snap to exact slot
            v.x = tx; v.y = ty;
            this.queues[side].push(v);
            this.approach[side].splice(j,1);
            // don't increment j; next element shifted into position j
          } else {
            j++;
          }
        }
      }
    }
    release(dt, signals, layout) {
      const side = signals.active; if (!side) return;
      this.releaseCooldown[side] = Math.max(0, this.releaseCooldown[side] - dt);
      if (signals.phase !== 'green') return;
      if (this.releaseCooldown[side] > 0) return;
      if (this.queues[side].length === 0) return;
      // Intersection occupancy gate: avoid releasing into a blocked box
      const occ = this.moving.filter(m=> Math.hypot(m.x - layout.centerX, m.y - layout.centerY) < 120).length;
      if (occ >= 6) { return; }
      const v = this.queues[side].shift();
      v.state = 'moving'; v.v = 0; // start from rest
      this.moving.push(v);
      // re-pack remaining queue positions
      const spacing = Math.max(35, layout.carH + 15);
      const qStart = layout.roadHalf + Math.max(30, layout.roadHalf*0.4);
      this.queues[side].forEach((qv, idx)=>{
        let toX=qv.x, toY=qv.y, rot=qv.rot;
        if (side==='North'){ toX = layout.centerX - layout.lane; toY = layout.centerY - layout.roadHalf - 10 - idx*spacing; rot=Math.PI/2; }
        if (side==='South'){ toX = layout.centerX + layout.lane; toY = layout.centerY + layout.roadHalf + 10 + idx*spacing; rot=-Math.PI/2; }
        if (side==='East'){  toX = layout.centerX + layout.roadHalf + 10 + idx*spacing; toY = layout.centerY + layout.lane; rot=Math.PI; }
        if (side==='West'){  toX = layout.centerX - layout.roadHalf - 10 - idx*spacing; toY = layout.centerY - layout.lane; rot=0; }
        // tween from current to target over ~100ms
        qv._tween = { fromX:qv.x, fromY:qv.y, toX, toY, t:0, dur:0.1 };
        qv.rot = rot;
      });
      const occPenalty = occ >= 4 ? 0.6 : 0;
      this.releaseCooldown[side] = 1.1 + occPenalty; // seconds
    }
    updateVehicles(dt, layout) {
      // Move movers
      for (const v of this.moving) {
        v.update(dt);
      }
      // Cull done ones (outside bounds)
      this.moving = this.moving.filter(v => {
        const off = v.x < -60 || v.x > layout.width+60 || v.y < -60 || v.y > layout.height+60;
        if (off) { this.stats.processed++; this.stats.wait += Math.max(0, nowSec() - v.spawnAt); }
        return !off;
      });
    }
    updateQueuedTweens(dt) {
      // Smoothly interpolate queued vehicles to their new slots
      for (const side of SIDES) {
        for (const qv of this.queues[side]) {
          const tw = qv._tween;
          if (tw) {
            tw.t += dt; const k = Math.min(1, tw.t / Math.max(0.0001, tw.dur));
            const ease = k < 0.5 ? 2*k*k : -1 + (4 - 2*k)*k; // easeInOutQuad
            qv.x = tw.fromX + (tw.toX - tw.fromX) * ease;
            qv.y = tw.fromY + (tw.toY - tw.fromY) * ease;
            if (k >= 1) qv._tween = null;
          }
        }
      }
    }
    queuesLengths() { return SIDES.map(s => this.queues[s].length); }
  }

  // ======= Renderer =======
  class Renderer {
    constructor(view, traffic, signals, scheduleEl) {
      this.view = view; this.traffic = traffic; this.signals = signals; this.scheduleEl = scheduleEl;
      this._lastActive = null;
    }
    draw(L) {
      const { ctx } = this.view;
      // Background
      const g = ctx.createLinearGradient(0,0,0,L.height); g.addColorStop(0,'#1a1a2e'); g.addColorStop(1,'#16213e');
      ctx.fillStyle = g; ctx.fillRect(0,0,L.width,L.height);
      // Roads
      ctx.fillStyle = '#444';
      ctx.fillRect(L.centerX - L.roadHalf, 0, 2*L.roadHalf, L.height);
      ctx.fillRect(0, L.centerY - L.roadHalf, L.width, 2*L.roadHalf);
      // Center markings (gap around intersection)
      ctx.strokeStyle = '#ffeb3b'; ctx.lineWidth = Math.max(2, L.roadHalf/30);
      ctx.setLineDash([20,15]);
      const gap = L.roadHalf + 10;
      ctx.beginPath(); ctx.moveTo(L.centerX, 0); ctx.lineTo(L.centerX, L.centerY-gap); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(L.centerX, L.centerY+gap); ctx.lineTo(L.centerX, L.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, L.centerY); ctx.lineTo(L.centerX-gap, L.centerY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(L.centerX+gap, L.centerY); ctx.lineTo(L.width, L.centerY); ctx.stroke();
      ctx.setLineDash([]);
      // Intersection plate
      ctx.fillStyle = '#555'; ctx.fillRect(L.centerX-L.roadHalf, L.centerY-L.roadHalf, 2*L.roadHalf, 2*L.roadHalf);

      // Traffic lights
      const lights = { North:'red', East:'red', South:'red', West:'red' };
      if (this.signals.active) {
        lights[this.signals.active] = this.signals.phase === 'green' ? 'green' : (this.signals.phase === 'yellow' ? 'yellow':'red');
      }
  this.drawLights(L, lights);

      // Queued vehicles
      // Approach vehicles first (so others draw on top)
      for (const side of SIDES) {
        for (const v of this.traffic.approach[side]) this.drawVehicle(v);
      }
      // Then queued vehicles near stop lines
      for (const side of SIDES) {
        for (const v of this.traffic.queues[side]) this.drawVehicle(v);
      }
      // Moving vehicles last (top layer)
      for (const v of this.traffic.moving) this.drawVehicle(v);
    }
    drawLights(L, lights) {
      const ctx = this.view.ctx; const r = Math.max(10, L.roadHalf/6); const dist = L.roadHalf + 40;
      const pos = {
        North: {x:L.centerX - dist*0.7, y:L.centerY - dist},
        East:  {x:L.centerX + dist, y:L.centerY - dist*0.7},
        South: {x:L.centerX + dist*0.7, y:L.centerY + dist},
        West:  {x:L.centerX - dist, y:L.centerY + dist*0.7}
      };
      for (const s of SIDES) {
        const p = pos[s];
        ctx.fillStyle = '#222'; const box = r*2.5; ctx.fillRect(p.x - box/2, p.y - box/2, box, box);
        const color = lights[s] === 'green' ? '#44ff44' : (lights[s] === 'yellow' ? '#ffff44' : '#ff4444');
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI*2); ctx.fill();
        // label and queue badge
        ctx.fillStyle = '#fff'; ctx.font = `${Math.max(10, L.roadHalf/8)}px sans-serif`; ctx.textAlign='center';
        ctx.fillText(s, p.x, p.y - box/2 - 8);
        const q = this.traffic.queues[s].length; const badge = Math.max(14, L.roadHalf/5);
        ctx.fillStyle = q>10 ? '#ff4444' : '#44aa44'; ctx.beginPath(); ctx.arc(p.x, p.y + box/2 + badge + 4, badge, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `${Math.max(8, L.roadHalf/10)}px sans-serif`; ctx.fillText(String(q), p.x, p.y + box/2 + badge + 8);
      }
      this.view.ctx.textAlign='left';
    }
    drawVehicle(v) {
      const ctx = this.view.ctx; ctx.save(); ctx.translate(v.x, v.y); ctx.rotate(v.rot);
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-v.w/2+2, -v.h/2+2, v.w, v.h);
      // body
      const grd = ctx.createLinearGradient(-v.w/2, -v.h/2, v.w/2, v.h/2);
      grd.addColorStop(0, COLORS[v.side]); grd.addColorStop(1, '#333'); ctx.fillStyle = grd;
      roundRect(ctx, -v.w/2, -v.h/2, v.w, v.h, 2); ctx.fill();
      // outline
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1; roundRect(ctx, -v.w/2, -v.h/2, v.w, v.h, 2); ctx.stroke();
      ctx.restore();
    }
  updateScheduleView(schedule) {
      if (!this.scheduleEl) return;
      this.scheduleEl.innerHTML = '';
      if (!schedule || !schedule.schedule || !schedule.schedule.length) {
        const d = document.createElement('div'); d.className='schedule-item'; d.textContent='No active schedule'; this.scheduleEl.appendChild(d); return;
      }
      for (const item of schedule.schedule) {
        const d = document.createElement('div'); d.className=`schedule-item ${item.side.toLowerCase()}`;
        if (item.side === this.signals.active) d.classList.add('active');
    const liveQ = this.traffic.queues[item.side]?.length ?? 0;
    const g = Number(item.green_duration);
    d.innerHTML = `<strong>${item.side}</strong><br>Green: ${Number.isFinite(g)?g.toFixed(1):'--'}s<br>Queue: ${liveQ}`;
        this.scheduleEl.appendChild(d);
      }
    }
  }

  function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath(); }

  // ======= UI Wiring =======
  class UI {
    constructor(doc){
      this.doc = doc;
      this.start = doc.getElementById('startBtn');
      this.pause = doc.getElementById('pauseBtn');
      this.reset = doc.getElementById('resetBtn');
  this.rushBtn = doc.getElementById('rushBtn');
  this.normalBtn = doc.getElementById('normalBtn');
  this.nightBtn = doc.getElementById('nightBtn');
  this.accidentBtn = doc.getElementById('accidentBtn');
      this.timeScaleSlider = doc.getElementById('timeScaleSlider');
      this.timeScaleValue = doc.getElementById('timeScaleValue');
      this.connectionStatus = doc.getElementById('connectionStatus');
      this.resultDisplay = doc.getElementById('resultDisplay');
      this.scheduleDisplay = doc.getElementById('scheduleDisplay');
      this.fpsEl = doc.getElementById('fpsValue');
      this.activeSide = doc.getElementById('activeSide');
      this.timeRemain = doc.getElementById('timeRemaining');
      this.signalPhase = doc.getElementById('signalPhase');

      this.sliders = ['north','east','south','west'].map(s=>doc.getElementById(s+'Rate'));
      this.sliderVals = ['north','east','south','west'].map(s=>doc.getElementById(s+'Val'));

      this.statsEls = {
        total: doc.getElementById('totalVehicles'),
        processed: doc.getElementById('processedVehicles'),
        moving: doc.getElementById('movingVehicles'),
        wait: doc.getElementById('avgWaitTime'),
        cycle: doc.getElementById('cycleTime'),
        throughput: doc.getElementById('throughput'),
        efficiency: doc.getElementById('efficiency')
      };
    }
    setSliderRates(rates){
      // rates: [N,E,S,W]
      const ids = ['north','east','south','west'];
      ids.forEach((id, i)=>{
        const slider = this.doc.getElementById(id+'Rate');
        const label = this.doc.getElementById(id+'Val');
        if (slider) { slider.value = String(rates[i]); }
        if (label) { label.textContent = String(rates[i]); }
      });
    }
    readRates(){
      const vals = this.sliders.map(el=> el ? Number(el.value) : 0);
      return vals.length===4 ? vals : [25,45,15,35];
    }
    wireControls(onStart, onPause, onReset, onRateChange, onTimeScale){
      const { start, pause, reset, resultDisplay } = this;
      if (start) start.addEventListener('click', ()=>{ resultDisplay && (resultDisplay.textContent='Simulation running...'); onStart(this.readRates()); start.disabled=true; if(pause){ pause.disabled=false; pause.textContent='⏸️ PAUSE'; } if(reset){ reset.disabled=false; } });
      if (pause) pause.addEventListener('click', ()=>{ onPause(); /* Engine will update labels; keep button enabled */ });
      if (reset) reset.addEventListener('click', ()=>{ onReset(); if(start){ start.disabled=false; } if(pause){ pause.disabled=true; pause.textContent='⏸️ PAUSE'; } if(reset){ reset.disabled=true; } this.resultDisplay && (this.resultDisplay.textContent='Ready to start simulation'); });
      this.sliders.forEach((s, i)=> s && s.addEventListener('input', ()=>{ this.sliderVals[i].textContent = s.value; onRateChange(this.readRates()); }));
      if (this.timeScaleSlider && this.timeScaleValue) {
        this.timeScaleValue.textContent = `${this.timeScaleSlider.value}x`;
        this.timeScaleSlider.addEventListener('input', ()=>{ this.timeScaleValue.textContent = `${this.timeScaleSlider.value}x`; onTimeScale(Number(this.timeScaleSlider.value)); });
      }
      // Presets
      const applyRates = (rates, msg)=>{ this.setSliderRates(rates); onRateChange(this.readRates()); if (this.resultDisplay) this.resultDisplay.textContent = msg; };
      if (this.rushBtn) this.rushBtn.addEventListener('click', ()=> applyRates([60,80,50,70], 'Rush hour preset applied'));
      if (this.normalBtn) this.normalBtn.addEventListener('click', ()=> applyRates([25,45,15,35], 'Normal traffic preset applied'));
      if (this.nightBtn) this.nightBtn.addEventListener('click', ()=> applyRates([5,10,5,10], 'Night time preset applied'));
      if (this.accidentBtn) this.accidentBtn.addEventListener('click', ()=> applyRates([10,10,60,10], 'Accident scenario preset applied'));
    }
    updateHUD(signals, traffic, cycleTime, fps, simTime){
      if (this.fpsEl) this.fpsEl.textContent = String(fps);
      if (this.activeSide) this.activeSide.textContent = signals.active || 'None';
      if (this.timeRemain) this.timeRemain.textContent = signals.greenRemaining>0 ? `${signals.greenRemaining.toFixed(1)}s` : '--';
      if (this.signalPhase) this.signalPhase.textContent = signals.phase.charAt(0).toUpperCase()+signals.phase.slice(1);

      // stats
      const totalQueued = SIDES.reduce((s,side)=> s + traffic.queues[side].length, 0);
      const totalActive = totalQueued + traffic.moving.length;
      const throughput = traffic.stats.processed>0 ? (traffic.stats.processed / (simTime/60)) : 0;
      const eff = totalActive>0 ? (traffic.moving.length/totalActive)*100 : 100;
      this.statsEls.total && (this.statsEls.total.textContent = String(traffic.stats.total));
      this.statsEls.processed && (this.statsEls.processed.textContent = String(traffic.stats.processed));
      this.statsEls.wait && (this.statsEls.wait.textContent = traffic.stats.processed>0 ? `${(traffic.stats.wait/traffic.stats.processed).toFixed(1)}s` : '0s');
      this.statsEls.cycle && (this.statsEls.cycle.textContent = `${Math.round(cycleTime||DEFAULT_CYCLE)}s`);
      this.statsEls.moving && (this.statsEls.moving.textContent = String(traffic.moving.length));
      this.statsEls.throughput && (this.statsEls.throughput.textContent = `${throughput.toFixed(1)}/min`);
      this.statsEls.efficiency && (this.statsEls.efficiency.textContent = `${Math.round(eff)}%`);
    }
  }

  // ======= Engine =======
  class Engine {
    constructor(doc) {
      this.doc = doc;
      this.canvas = doc.getElementById('trafficCanvas');
      this.view = new View(this.canvas);
      this.ui = new UI(doc);
      this.api = new ApiClient('');
      this.scheduler = new Scheduler(this.api, this.ui.connectionStatus);
      this.signals = new Signals();
      this.traffic = new TrafficSystem(this.view);
      this.renderer = new Renderer(this.view, this.traffic, this.signals, this.ui.scheduleDisplay);

  this.timeScale = clamp(Number(this.ui.timeScaleSlider?.value)||15, 1, 100);
  this.running = false; this.paused = false;
  this.lastTs = 0; this.fpsCount=0; this.fpsClock=0; this.fps=0;
      this.simTime = 0; // seconds
  this._rafId = null; this._loopBound = this.loop.bind(this); this._schedSeq = 0;

  // Draw initial scene
  const L0 = this.view.layout();
  this.renderer.draw(L0);

      this.ui.wireControls(
        (rates)=>{ this.start(rates); },
        ()=>{ this.togglePause(); },
        ()=>{ this.reset(); },
        (rates)=>{ if (this.running) this.currentRates = rates; },
        (s)=>{ this.timeScale = clamp(s,1,100); }
      );
      // Auto-pause when tab is hidden to avoid dt spikes
      document.addEventListener('visibilitychange', ()=>{
        if (!this.running) return;
        if (document.visibilityState === 'hidden') {
          this.paused = true;
        } else {
          // resume cleanly
          this.paused = false; this.lastTs = performance.now();
        }
      });
    }
    start(rates){
      this.currentRates = rates; this.running = true; this.paused=false; this.lastTs = performance.now();
      if (this._rafId) { try { cancelAnimationFrame(this._rafId); } catch(_){} this._rafId=null; }
      this._rafId = requestAnimationFrame(this._loopBound);
    }
    togglePause(){
      if (!this.running) return;
      this.paused = !this.paused;
      if (this.paused) {
        if (this.ui.pause) this.ui.pause.textContent = '▶️ RESUME';
        if (this.ui.resultDisplay) this.ui.resultDisplay.textContent = 'Simulation paused';
      } else {
        this.lastTs = performance.now();
        if (this.ui.pause) this.ui.pause.textContent = '⏸️ PAUSE';
        if (this.ui.resultDisplay) this.ui.resultDisplay.textContent = 'Simulation running...';
      }
    }
    reset(){
      this.running=false; this.paused=false; this.simTime=0;
      this.signals = new Signals(); this.traffic = new TrafficSystem(this.view); this.renderer = new Renderer(this.view, this.traffic, this.signals, this.ui.scheduleDisplay);
      if (this._rafId){ try{ cancelAnimationFrame(this._rafId);}catch(_){} this._rafId=null; }
      this._pendingSched=null; this._lastSchedAt=0; const L0 = this.view.layout(); this.renderer.draw(L0);
      // Reflect initial UI state
      if (this.ui.start) this.ui.start.disabled = false;
      if (this.ui.pause) { this.ui.pause.disabled = true; this.ui.pause.textContent = '⏸️ PAUSE'; }
      if (this.ui.reset) this.ui.reset.disabled = true;
    }
    async loop(ts){
      if (!this.running) return;
      const realDt = Math.max(0, (ts - this.lastTs)/1000); this.lastTs = ts;
  if (this.paused) { this._rafId = requestAnimationFrame(this._loopBound); return; }
      const simDt = clamp(realDt*this.timeScale, 0, 0.25*this.timeScale); // cap
      this.simTime += simDt;
  // Compute layout once per frame
  const L = this.view.layout();

      // FPS
      this.fpsCount++; this.fpsClock += realDt; if (this.fpsClock >= 0.5) { this.fps = Math.round(this.fpsCount/this.fpsClock); this.fpsCount=0; this.fpsClock=0; }

      // Spawn queues and release
  this.traffic.queueSpawn(simDt, this.currentRates || [25,45,15,35], L);
  // Update approach vehicles towards queue targets
  this.traffic.updateApproach(simDt, L);

      // Schedule update (async)
      const qlens = this.traffic.queuesLengths();
      if (!this._pendingSched || (this.simTime - (this._lastSchedAt||0)) > 15) {
        const seq = ++this._schedSeq;
        this._pendingSched = this.scheduler.getSchedule(qlens, this.simTime).then(s=>{
          if (seq !== this._schedSeq) return; // superseded
          this.currentSchedule = s; this._lastSchedAt=this.simTime; this.renderer.updateScheduleView(s);
        }).catch(()=>{});
      }

      // Signals
      if (this.currentSchedule) this.signals.update(simDt, this.currentSchedule, qlens);

      // Release vehicles on green
  this.traffic.release(simDt, this.signals, L);
  // Tween queued ones to new positions
  this.traffic.updateQueuedTweens(simDt);
      // Update movers
  this.traffic.updateVehicles(simDt, L);

      // Draw
  this.renderer.draw(L);

      // HUD
      this.ui.updateHUD(this.signals, this.traffic, this.currentSchedule?.cycle_time || DEFAULT_CYCLE, this.fps, this.simTime);

  this._rafId = requestAnimationFrame(this._loopBound);
    }
  }

  // ======= Bootstrap =======
  document.addEventListener('DOMContentLoaded', () => {
    const engine = new Engine(document);
  });

})();
