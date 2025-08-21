// Frontend simulation (p5.js)
let yellowBlink = false;
let yellowBlinkTimer = 0;
let yellowBlinkState = false;

let cars = [];
let lights = [];
const roadWidth = 100;
const laneWidth = roadWidth / 2;
let API_URL = 'http://127.0.0.1:8000';
let timeToNextChange = 0;
let currentIntersection = 'main';

let totalCarsPassed = 0;
let totalWaitTime = 0;
let carsExited = 0;

function simulateScenario(type) {
  if (type === 'normal') {
    spawnCars({ north: 5, south: 4, east: 8, west: 6 });
  } else if (type === 'rush') {
    spawnCars({ north: 3, south: 3, east: 20, west: 18 });
  } else if (type === 'accident') {
    spawnCars({ north: 15, south: 2, east: 0, west: 2 });
  }
}

function setup() {
  const canvas = createCanvas(600, 600);
  canvas.parent('canvas-container');
  frameRate(60);
  lights.push(new TrafficLight(width / 2 - laneWidth / 2, height / 2 - roadWidth, 'green', 'vertical'));
  lights.push(new TrafficLight(width / 2 + laneWidth / 2, height / 2 + roadWidth, 'green', 'vertical'));
  lights.push(new TrafficLight(width / 2 - roadWidth, height / 2 + laneWidth / 2, 'red', 'horizontal'));
  lights.push(new TrafficLight(width / 2 + roadWidth, height / 2 - laneWidth / 2, 'red', 'horizontal'));
  const form = select('#traffic-form');
  form.elt.addEventListener('submit', (e) => { e.preventDefault(); updateAndSpawn(); });
  setInterval(getLightState, 1000);
}

function switchIntersection() {
  currentIntersection = select('#intersection-select').value();
  cars = [];
  getLightState();
}

function draw() {
  background(240);
  drawIntersection();
  yellowBlink = lights.some(l => l.color === 'yellow');
  if (yellowBlink) {
    if (millis() - yellowBlinkTimer > 400) {
      yellowBlinkState = !yellowBlinkState;
      yellowBlinkTimer = millis();
    }
  } else {
    yellowBlinkState = false;
  }
  for (let i = cars.length - 1; i >= 0; i--) {
    cars[i].update();
    cars[i].draw();
    if (cars[i].isOffscreen()) {
      if (cars[i].exitedAt === undefined) {
        cars[i].exitedAt = millis();
        totalCarsPassed++;
        if (cars[i].spawnedAt !== undefined) {
          totalWaitTime += (cars[i].exitedAt - cars[i].spawnedAt) / 1000.0;
          carsExited++;
        }
      }
      cars.splice(i, 1);
    }
  }
  for (const light of lights) light.draw();
  displayStats();
  updateStatsPanel();
  displayTimers();
}

async function updateAndSpawn() {
  const north = parseInt(select('#north').value(), 10);
  const south = parseInt(select('#south').value(), 10);
  const east = parseInt(select('#east').value(), 10);
  const west = parseInt(select('#west').value(), 10);
  const data = { north, south, east, west };
  try {
    await fetch(`${API_URL}/traffic?intersection=${currentIntersection}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
  } catch (e) { console.error('Error sending traffic data:', e); }
  spawnCars(data);
}

async function getLightState() {
  try {
    const response = await fetch(`${API_URL}/state?intersection=${currentIntersection}`);
    const data = await response.json();
    timeToNextChange = data.time_to_next_change;
    for (const light of lights) {
      if (light.orientation === 'vertical') light.color = data.lights.vertical;
      else light.color = data.lights.horizontal;
    }
  } catch (e) { console.error('Error fetching light state:', e); }
}

function drawIntersection() {
  fill(100); noStroke();
  rect(width / 2 - roadWidth, 0, roadWidth * 2, height);
  rect(0, height / 2 - roadWidth, width, roadWidth * 2);
  stroke(255, 255, 0); strokeWeight(2);
  line(width / 2, 0, width / 2, height / 2 - roadWidth);
  line(width / 2, height / 2 + roadWidth, width / 2, height);
  line(0, height / 2, width / 2 - roadWidth, height / 2);
  line(width / 2 + roadWidth, height / 2, width, height / 2);
}

function spawnCars(data) {
  for (let i = 0; i < data.north; i++) { let c = new Car(width / 2 - laneWidth / 2, -20 - i * 40, 'north'); c.spawnedAt = millis(); cars.push(c); }
  for (let i = 0; i < data.south; i++) { let c = new Car(width / 2 + laneWidth / 2, height + 20 + i * 40, 'south'); c.spawnedAt = millis(); cars.push(c); }
  for (let i = 0; i < data.east; i++) { let c = new Car(width + 20 + i * 40, height / 2 - laneWidth / 2, 'east'); c.spawnedAt = millis(); cars.push(c); }
  for (let i = 0; i < data.west; i++) { let c = new Car(-20 - i * 40, height / 2 + laneWidth / 2, 'west'); c.spawnedAt = millis(); cars.push(c); }
  updateStatsPanel();
}

function updateStatsPanel() {
  let avgWait = carsExited > 0 ? (totalWaitTime / carsExited).toFixed(2) : '0.00';
  let html = `<b>Total Cars Passed:</b> ${totalCarsPassed}<br>`;
  html += `<b>Average Wait Time (s):</b> ${avgWait}<br>`;
  html += `<b>Cars Currently in Intersection:</b> ${cars.length}`;
  let statsDiv = document.getElementById('stats-content');
  if (statsDiv) statsDiv.innerHTML = html;
}

function displayStats() {
  fill(0); noStroke(); textSize(16); textAlign(LEFT, TOP);
  let waitingNorth = cars.filter(c => c.direction === 'north' && c.isWaiting()).length;
  let waitingSouth = cars.filter(c => c.direction === 'south' && c.isWaiting()).length;
  let waitingEast = cars.filter(c => c.direction === 'east' && c.isWaiting()).length;
  let waitingWest = cars.filter(c => c.direction === 'west' && c.isWaiting()).length;
  text(`Waiting N: ${waitingNorth}`, 10, 10);
  text(`Waiting S: ${waitingSouth}`, 10, 30);
  text(`Waiting E: ${waitingEast}`, 10, 50);
  text(`Waiting W: ${waitingWest}`, 10, 70);
}

function displayTimers() {
  for (const light of lights) {
    if (light.color === 'green') {
      fill(0); noStroke(); textSize(16); textAlign(CENTER, CENTER);
      text(timeToNextChange, light.x, light.y - 40);
    }
  }
}

class TrafficLight {
  constructor(x, y, color, orientation) { this.x = x; this.y = y; this.color = color; this.orientation = orientation; }
  draw() {
    fill(50); stroke(0); strokeWeight(2); rectMode(CENTER);
    if (this.orientation === 'vertical') rect(this.x, this.y, 30, 90, 5); else rect(this.x, this.y, 90, 30, 5);
    rectMode(CORNER);
    const redOn = color(255, 0, 0), redOff = color(100, 0, 0);
    const yellowOn = color(255, 255, 0), yellowOff = color(100, 100, 0);
    const greenOn = color(0, 255, 0), greenOff = color(0, 100, 0);
    noStroke();
    if (this.orientation === 'vertical') {
      fill(this.color === 'red' ? redOn : redOff); ellipse(this.x, this.y - 30, 20, 20);
      fill(this.color === 'yellow' ? yellowOn : yellowOff); ellipse(this.x, this.y, 20, 20);
      fill(this.color === 'green' ? greenOn : greenOff); ellipse(this.x, this.y + 30, 20, 20);
    } else {
      fill(this.color === 'red' ? redOn : redOff); ellipse(this.x - 30, this.y, 20, 20);
      fill(this.color === 'yellow' ? yellowOn : yellowOff); ellipse(this.x, this.y, 20, 20);
      fill(this.color === 'green' ? greenOn : greenOff); ellipse(this.x + 30, this.y, 20, 20);
    }
  }
}

class Car {
  constructor(x, y, direction) {
    this.x = x; this.y = y; this.direction = direction; this.speed = 1; this.color = color(random(255), random(255), random(255));
    this.width = 20; this.height = 30; this.stopped = false;
  }
  update() {
    this.stopped = false; let light = this.getRelevantLight(); let stopPosition = this.getStopPosition();
    if (light && light.color !== 'green') { if (this.isApproaching(stopPosition)) this.stopped = true; }
    for (const other of cars) {
      if (other !== this && this.direction === other.direction) {
        if (this.isBehind(other) && this.distanceTo(other) < 40) { this.stopped = true; break; }
      }
    }
    if (!this.stopped) {
      switch (this.direction) {
        case 'north': this.y += this.speed; break;
        case 'south': this.y -= this.speed; break;
        case 'east': this.x -= this.speed; break;
        case 'west': this.x += this.speed; break;
      }
    }
  }
  draw() {
    fill(this.color); stroke(0); strokeWeight(1); rectMode(CENTER);
    if (this.direction === 'north' || this.direction === 'south') rect(this.x, this.y, this.width, this.height); else rect(this.x, this.y, this.height, this.width);
    rectMode(CORNER);
  }
  isOffscreen() { return (this.x < -50 || this.x > width + 50 || this.y < -50 || this.y > height + 50); }
  getRelevantLight() { return (this.direction === 'north' || this.direction === 'south') ? lights.find(l => l.orientation === 'vertical') : lights.find(l => l.orientation === 'horizontal'); }
  getStopPosition() {
    switch (this.direction) {
      case 'north': return height / 2 - roadWidth - this.height;
      case 'south': return height / 2 + roadWidth + this.height;
      case 'east': return width / 2 + roadWidth + this.height;
      case 'west': return width / 2 - roadWidth - this.height;
    }
  }
  isApproaching(stopPosition) {
    switch (this.direction) {
      case 'north': return this.y > stopPosition && this.y < stopPosition + 50;
      case 'south': return this.y < stopPosition && this.y > stopPosition - 50;
      case 'east': return this.x < stopPosition && this.x > stopPosition - 50;
      case 'west': return this.x > stopPosition && this.x < stopPosition + 50;
    }
  }
  isWaiting() { return this.stopped; }
  distanceTo(other) { return dist(this.x, this.y, other.x, other.y); }
  isBehind(other) {
    switch (this.direction) {
      case 'north': return this.y < other.y;
      case 'south': return this.y > other.y;
      case 'east': return this.x > other.x;
      case 'west': return this.x < other.x;
    }
  }
}

function applyApiUrl() {
  const v = document.getElementById('api-url').value.trim();
  if (v) { API_URL = v; pingBackend(); }
}

async function pingBackend() {
  const el = document.getElementById('backend-indicator');
  try {
    const res = await fetch(`${API_URL}/health`);
    if (res.ok) el.textContent = 'Online'; else el.textContent = 'Unreachable';
  } catch { el.textContent = 'Unreachable'; }
}

// Call on load after initial script setup
window.addEventListener('load', pingBackend);

// Optional: expose a quick reset
async function resetIntersection() {
  try { await fetch(`${API_URL}/reset?intersection=${currentIntersection}`, { method: 'POST' }); } catch {}
}
