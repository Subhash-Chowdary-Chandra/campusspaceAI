import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await fs.readFile(path.join(here, 'campus-data.json'), 'utf8'));
const rooms = data.rooms;
const requests = data.requests;
const weekdayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weeklyHours = new Map(rooms.map(room => [room.room_id, 0]));
for (const item of data.schedule) weeklyHours.set(item.room_id, (weeklyHours.get(item.room_id) || 0) + Number(item.duration_hours || 0));
const classesByRoom = new Map();
const eventsByRoom = new Map();
for (const item of data.schedule) {
  if (!classesByRoom.has(item.room_id)) classesByRoom.set(item.room_id, []);
  classesByRoom.get(item.room_id).push(item);
}
for (const item of data.events) {
  if (!eventsByRoom.has(item.room_id)) eventsByRoom.set(item.room_id, []);
  eventsByRoom.get(item.room_id).push(item);
}

const purposeBonus = (purpose, roomType) => {
  const type = String(roomType).toLowerCase();
  if (purpose === 'Study group' && type === 'study room') return 20;
  if (purpose === 'Class' && type === 'classroom') return 16;
  if (purpose === 'Workshop' && ['seminar', 'lab'].includes(type)) return 18;
  if (purpose === 'Club meeting' && type === 'seminar') return 15;
  if (purpose === 'Project work' && ['study room', 'lab'].includes(type)) return 16;
  return 0;
};

function overlaps(startA, durationA, startB, durationB) {
  return startA < startB + durationB && startB < startA + durationA;
}

function eligible(request, room) {
  if (!(Number(room.capacity) >= Number(request.required_capacity)
    && (!Number(request.projector_required) || Number(room.projector))
    && (!Number(request.computers_required) || Number(room.computers)))) return false;
  const date = new Date(`${request.request_date}T12:00:00Z`);
  const weekday = weekdayShort[date.getUTCDay()];
  const start = Number(request.start_hour);
  const duration = Number(request.duration_hours);
  if ((classesByRoom.get(room.room_id) || []).some(item => item.weekday === weekday && overlaps(start, duration, Number(item.start_hour), Number(item.duration_hours)))) return false;
  if ((eventsByRoom.get(room.room_id) || []).some(item => {
    const eventDate = item.start_time.slice(0, 10);
    const time = item.start_time.slice(11, 16).split(':').map(Number);
    const eventStart = time[0] + time[1] / 60;
    return eventDate === request.request_date && overlaps(start, duration, eventStart, Number(item.duration_hours));
  })) return false;
  return true;
}

const featuresFor = (request, room) => [
  Number(room.capacity) - Number(request.required_capacity),
  weeklyHours.get(room.room_id) || 0,
  purposeBonus(request.purpose, room.room_type)
];

// Synthetic rubric label: a transparent teaching signal until real room-choice
// outcomes exist. This is not a historical preference or booking-success label.
const labelFor = ([capacitySlack, classHours, purposeFit]) =>
  80 - 0.18 * capacitySlack - 0.12 * classHours + purposeFit;

let seed = 42;
function random() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const requestOrder = requests.map((_, i) => i);
for (let i = requestOrder.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [requestOrder[i], requestOrder[j]] = [requestOrder[j], requestOrder[i]];
}
const splitAt = Math.floor(requestOrder.length * 0.8);
const trainRequestIds = new Set(requestOrder.slice(0, splitAt));
const trainRows = [];
const holdoutRows = [];
let usableRequests = 0;
for (let i = 0; i < requests.length; i++) {
  const request = requests[i];
  const targetRows = trainRequestIds.has(i) ? trainRows : holdoutRows;
  let found = false;
  for (const room of rooms) {
    if (!eligible(request, room)) continue;
    found = true;
    const features = featuresFor(request, room);
    targetRows.push({ features, target: labelFor(features) });
  }
  if (found) usableRequests++;
}
if (trainRows.length < 20 || holdoutRows.length < 20) throw new Error('Not enough feasible request-room training pairs.');

function normalize(rows) {
  const means = [0, 1, 2].map(j => rows.reduce((sum, row) => sum + row.features[j], 0) / rows.length);
  const scales = [0, 1, 2].map(j => {
    const variance = rows.reduce((sum, row) => sum + (row.features[j] - means[j]) ** 2, 0) / rows.length;
    return Math.sqrt(variance) || 1;
  });
  return { means, scales };
}

function solve(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-10) throw new Error(`Singular fitting matrix at column ${col}.`);
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}

function fit(rows, regularization = 0.001) {
  const { means, scales } = normalize(rows);
  const width = 4;
  const gram = Array.from({ length: width }, () => Array(width).fill(0));
  const rhs = Array(width).fill(0);
  for (const row of rows) {
    const x = [1, ...row.features.map((value, j) => (value - means[j]) / scales[j])];
    for (let a = 0; a < width; a++) {
      rhs[a] += x[a] * row.target;
      for (let b = 0; b < width; b++) gram[a][b] += x[a] * x[b];
    }
  }
  for (let j = 1; j < width; j++) gram[j][j] += regularization;
  const coefficients = solve(gram, rhs);
  return { intercept: coefficients[0], coefficients: coefficients.slice(1), means, scales };
}

function predict(model, features) {
  let score = model.intercept;
  for (let j = 0; j < features.length; j++) score += model.coefficients[j] * ((features[j] - model.means[j]) / model.scales[j]);
  return score;
}

function metrics(rows, predictions) {
  const actual = rows.map(row => row.target);
  const mean = actual.reduce((sum, value) => sum + value, 0) / actual.length;
  const mae = actual.reduce((sum, value, i) => sum + Math.abs(value - predictions[i]), 0) / actual.length;
  const rmse = Math.sqrt(actual.reduce((sum, value, i) => sum + (value - predictions[i]) ** 2, 0) / actual.length);
  const total = actual.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const residual = actual.reduce((sum, value, i) => sum + (value - predictions[i]) ** 2, 0);
  return { mae: Number(mae.toFixed(5)), rmse: Number(rmse.toFixed(5)), r2: Number((1 - residual / total).toFixed(5)) };
}

const validationFit = fit(trainRows);
const holdoutMetrics = metrics(holdoutRows, holdoutRows.map(row => predict(validationFit, row.features)));
const baselineMean = trainRows.reduce((sum, row) => sum + row.target, 0) / trainRows.length;
const baselineMetrics = metrics(holdoutRows, holdoutRows.map(() => baselineMean));
const fullRows = [...trainRows, ...holdoutRows];
const finalModel = fit(fullRows);
const artifact = {
  name: 'CampusSpace Room Fit Ranker',
  algorithm: 'Ridge Regression, fitted from scratch by a JavaScript normal-equation solver',
  target: 'synthetic_rubric_fit_score',
  featureNames: ['capacitySlackSeats', 'weeklyClassHours', 'purposeFitBonus'],
  intercept: finalModel.intercept,
  coefficients: finalModel.coefficients,
  means: finalModel.means,
  scales: finalModel.scales,
  labelDefinition: '80 - 0.18 × excess seats - 0.12 × weekly class hours + purpose-fit bonus; hard capacity and equipment constraints are filtered before ranking.',
  dataNote: 'Training pairs are generated from the supplied synthetic room, schedule and request data. The target is a product rubric, not a real assigned-room or user-preference label.',
  training: {
    seed: 42,
    requestSplit: '80/20 deterministic split by request row; holdout requests are excluded from fitting.',
    requestsInSource: requests.length,
    requestsWithFeasibleRooms: usableRequests,
    trainingPairs: trainRows.length,
    holdoutPairs: holdoutRows.length,
    regularization: 0.001,
    holdoutMetrics,
    trainingMeanBaseline: baselineMetrics
  }
};
await fs.writeFile(path.join(here, 'room-ranker.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  model: artifact.name,
  algorithm: artifact.algorithm,
  requests: requests.length,
  feasibleRequests: usableRequests,
  trainingPairs: trainRows.length,
  holdoutPairs: holdoutRows.length,
  holdoutMetrics,
  trainingMeanBaseline: baselineMetrics,
  output: 'room-ranker.json'
}, null, 2));
