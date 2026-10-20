// Original Scrim behaviour. Pretrained neural OCR is provided by Tesseract.js.
// Source pixels, recognised text and exports live only in this page's memory.
'use strict';

const $ = id => document.getElementById(id);
const LIMIT_BYTES = 8 * 1024 * 1024;
const LIMIT_PIXELS = 4_000_000;
const LIMIT_DIMENSION = 4000;
const OCR_PADDING = 6;
const state = {
  base: null, width: 0, height: 0, phase: 'empty', revision: 0,
  regions: [], nextRegion: 1, scanned: false, acknowledged: false,
  operation: null, loading: false, job: 0, loadRequest: 0,
  workerHolder: null, drawing: null, exportedURL: null,
  timings: {scanMs: null, exportMs: null},
  exportCheck: {status: 'idle', patternCount: null, types: [], revision: null},
};
const canvas = $('canvas');
const context = canvas.getContext('2d', {alpha: false});
const busy = () => Boolean(state.operation || state.loading);
const current = job => state.job === job;
const element = (tag, className, text) => {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
};
const tell = text => { $('status').textContent = text; };
const error = text => { $('error').textContent = text || ''; $('error').hidden = !text; };

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
Object.defineProperty(window, 'scrimProof', {
  configurable: false, writable: false,
  value: () => frozen({
    phase: state.phase, revision: state.revision,
    dimensions: {width: state.width, height: state.height},
    regions: state.regions.map(region => ({id: region.id, type: region.type,
      bbox: {...region.bbox}, selection: region.selection, origin: region.origin})),
    timings: {...state.timings},
    exportCheck: {...state.exportCheck, types: [...state.exportCheck.types]},
    reviewAcknowledged: state.acknowledged,
    readyDownload: Boolean(state.exportedURL && state.exportCheck.status === 'passed' && state.exportCheck.revision === state.revision && state.acknowledged && !busy()),
    busy: busy(),
  }),
});

function forgetExport() {
  if (state.exportedURL) URL.revokeObjectURL(state.exportedURL);
  state.exportedURL = null;
  $('download-link').hidden = true;
  $('download-link').removeAttribute('href');
  $('download-link').setAttribute('aria-disabled', 'true');
  $('export-preview').hidden = true;
  $('export-preview').removeAttribute('src');
}
function changed() {
  state.revision++;
  state.acknowledged = false;
  $('review-confirm').checked = false;
  forgetExport();
  state.exportCheck = {status: 'idle', patternCount: null, types: [], revision: null};
  $('export-result').hidden = !state.base;
  $('export-result').textContent = state.base ? 'Review the whole screenshot before checking an export.' : '';
  $('export-result').dataset.state = 'idle';
}
function updateUI() {
  const locked = busy() || Boolean(state.drawing);
  $('file-input').disabled = locked;
  $('demo-btn').disabled = locked;
  $('scan-btn').disabled = !state.base || locked;
  $('clear-btn').disabled = !state.base && !locked;
  $('add-mask-btn').disabled = !state.base || locked;
  $('review-confirm').disabled = !state.base || !state.scanned || locked;
  $('export-btn').disabled = !state.base || !state.scanned || !state.acknowledged || locked;
  for (const id of ['mask-x', 'mask-y', 'mask-width', 'mask-height']) $(id).disabled = !state.base || locked;
  for (const control of $('review-list').querySelectorAll('input,button')) control.disabled = locked;
  $('empty-state').hidden = Boolean(state.base);
  canvas.hidden = !state.base;
  $('progress').hidden = !state.operation;
  const ready = Boolean(state.exportedURL && state.exportCheck.status === 'passed' && state.exportCheck.revision === state.revision && state.acknowledged && !locked);
  $('download-link').hidden = !ready;
  $('download-link').setAttribute('aria-disabled', String(!ready));
  if (ready) $('download-link').href = state.exportedURL;
  canvas.setAttribute('aria-label', state.base ? `Screenshot, ${state.width} by ${state.height} pixels, with ${state.regions.filter(region => region.selection).length} selected masks. Use the numeric form to add masks with a keyboard.` : 'Screenshot review canvas');
}
function paint() {
  if (!state.base) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  context.drawImage(state.base, 0, 0);
  for (const region of state.regions) {
    const {x, y, width, height} = region.bbox;
    context.fillStyle = '#101820';
    if (region.selection) context.fillRect(x, y, width, height);
    context.strokeStyle = region.origin === 'manual' ? '#c56b16' : '#167078';
    context.lineWidth = 2;
    context.setLineDash(region.selection ? [] : [5, 4]);
    context.strokeRect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2));
  }
  context.setLineDash([]);
  if (state.drawing) {
    const rectangle = normalRectangle(state.drawing.start, state.drawing.end);
    context.fillStyle = '#101820';
    context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    context.strokeStyle = '#ef9d37';
    context.lineWidth = 2;
    context.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
  }
}
function regionName(region, index) {
  return region.origin === 'manual' ? `manual region ${index + 1}` : `${region.type} line ${index + 1}`;
}
function renderRegions() {
  const list = $('review-list');
  list.replaceChildren();
  if (!state.regions.length) {
    const note = element('li', 'review-empty', state.scanned ? 'No supported contact lines were recognised. Inspect the whole screenshot and add any needed masks manually.' : 'Scan the screenshot to suggest email and phone lines, or add a manual mask.');
    list.append(note);
  }
  state.regions.forEach((region, index) => {
    const row = element('li', 'review-item'); row.dataset.regionId = region.id;
    const label = element('label', 'review-toggle');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = region.selection;
    checkbox.setAttribute('aria-label', `Mask ${regionName(region, index)}`);
    const copy = element('span', 'review-copy');
    copy.append(element('strong', '', region.origin === 'manual' ? 'Manual region' : `${region.type === 'email+phone' ? 'Email + phone' : region.type === 'email' ? 'Email' : 'Phone'} line`));
    const box = region.bbox;
    copy.append(element('small', '', `${box.x}, ${box.y} · ${box.width} × ${box.height} px${region.origin === 'ocr' ? ' · neural OCR suggestion' : ' · manually drawn'}`));
    label.append(checkbox, copy);
    checkbox.addEventListener('change', () => {
      if (busy()) { checkbox.checked = region.selection; return; }
      if (region.selection === checkbox.checked) return;
      region.selection = checkbox.checked; changed(); paint(); updateUI();
      tell(`${checkbox.checked ? 'Selected' : 'Deselected'} ${regionName(region, index)}. Review acknowledgement and any previous download were reset.`);
    });
    const remove = element('button', 'remove-region', 'Remove'); remove.type = 'button';
    remove.setAttribute('aria-label', `Remove region ${index + 1}`);
    remove.addEventListener('click', () => {
      if (busy()) return;
      const position = state.regions.findIndex(item => item.id === region.id);
      state.regions.splice(position, 1); changed(); renderRegions(); paint(); updateUI();
      const next = [...list.querySelectorAll('button')][Math.min(position, state.regions.length - 1)];
      (next || $('add-mask-btn')).focus({preventScroll: true});
      tell('Region removed. Review the screenshot again before exporting.');
    });
    row.append(label, remove); list.append(row);
  });
  const suggested = state.regions.filter(region => region.origin === 'ocr').length;
  const manual = state.regions.filter(region => region.origin === 'manual').length;
  $('scan-summary').textContent = state.scanned ? `${suggested} supported ${suggested === 1 ? 'line' : 'lines'} suggested · ${manual} manual ${manual === 1 ? 'region' : 'regions'} · ${state.timings.scanMs === null ? '' : `${(state.timings.scanMs / 1000).toFixed(1)}s local scan`}` : 'English neural OCR. Email and phone suggestions require your review.';
}

function bounds(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('The image has invalid dimensions.');
  if (width > LIMIT_DIMENSION || height > LIMIT_DIMENSION || width * height > LIMIT_PIXELS) throw new Error('Image dimensions exceed the limit: 4 million pixels, with each side at most 4000 pixels.');
}
function imageHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) {
    if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12,16)) !== 'IHDR') throw new Error('The PNG header is invalid.');
    const width = view.getUint32(16), height = view.getUint32(20); bounds(width, height);
    return {type: 'image/png', width, height};
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const startsOfFrame = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error('The JPEG header is invalid.');
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('The JPEG header is truncated or invalid.');
      if (startsOfFrame.has(marker)) {
        if (length < 8) throw new Error('The JPEG size header is invalid.');
        const height = view.getUint16(offset + 3), width = view.getUint16(offset + 5); bounds(width, height);
        return {type: 'image/jpeg', width, height};
      }
      offset += length;
    }
    throw new Error('The JPEG has no readable image-size header.');
  }
  throw new Error('Choose a valid PNG or JPEG screenshot. Other file types are not supported.');
}
async function decodeRaster(blob, validateName = true) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('The image file is empty.');
  const byteLimit = validateName ? LIMIT_BYTES : LIMIT_PIXELS * 4 + 1024 * 1024;
  if (blob.size > byteLimit) throw new Error(validateName ? 'The image file exceeds the 8 MB limit.' : 'The encoded PNG is larger than the bounded output limit.');
  if (validateName && !/\.(png|jpe?g)$/i.test(blob.name || '')) throw new Error('Use a PNG (.png) or JPEG (.jpg or .jpeg) file.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = imageHeader(bytes);
  if (blob.type && blob.type !== header.type) throw new Error('The file type does not match its image header.');
  if (validateName && ((/\.png$/i.test(blob.name) && header.type !== 'image/png') || (/\.jpe?g$/i.test(blob.name) && header.type !== 'image/jpeg'))) throw new Error('The filename extension does not match the image type.');
  const url = URL.createObjectURL(blob);
  const image = new Image(); image.decoding = 'async';
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('The image could not be decoded. Your current review has been kept.')); image.src = url; });
    // The browser applies JPEG EXIF orientation; validate the oriented result too.
    const width = image.naturalWidth, height = image.naturalHeight; bounds(width, height);
    if (width * height !== header.width * header.height || !((width === header.width && height === header.height) || (width === header.height && height === header.width))) throw new Error('Decoded dimensions do not match the image header.');
    const raster = document.createElement('canvas'); raster.width = width; raster.height = height;
    const pixels = raster.getContext('2d', {alpha: false});
    pixels.fillStyle = '#ffffff'; pixels.fillRect(0, 0, width, height); pixels.drawImage(image, 0, 0, width, height);
    return raster;
  } finally { image.src = ''; URL.revokeObjectURL(url); }
}
function terminateWorker() {
  const holder = state.workerHolder; state.workerHolder = null;
  if (!holder) return;
  holder.rejectFailure(new Error('OCR operation cancelled.'));
  if (holder.worker) Promise.resolve(holder.worker.terminate()).catch(() => {});
  else if (holder.nativeWorker) holder.nativeWorker.terminate();
  holder.nativeWorker = null;
}
function cancelOperation() {
  state.job++; state.operation = null; terminateWorker(); state.drawing = null;
}
async function loadImage(file, isExample = false) {
  const request = ++state.loadRequest; state.loading = true; error(''); updateUI();
  tell('Opening the image locally…');
  try {
    const raster = await decodeRaster(file);
    if (request !== state.loadRequest) return;
    cancelOperation(); state.base = raster; state.width = raster.width; state.height = raster.height;
    canvas.width = state.width; canvas.height = state.height;
    state.regions = []; state.nextRegion = 1; state.scanned = false; state.phase = 'loaded';
    state.timings = {scanMs: null, exportMs: null}; changed();
    for (const [id, value] of [['mask-x',0],['mask-y',0],['mask-width',Math.min(160,state.width)],['mask-height',Math.min(40,state.height)]]) $(id).value = value;
    $('mask-x').max = state.width - 1; $('mask-y').max = state.height - 1;
    $('mask-width').max = state.width; $('mask-height').max = state.height;
    renderRegions(); paint();
    tell(`${isExample ? 'Fictional example' : 'Screenshot'} loaded: ${state.width} × ${state.height} pixels. Scan for supported contact lines, then review the whole image.`);
  } catch (failure) {
    if (request === state.loadRequest) error(`${failure.message}${state.base && !failure.message.includes('kept') ? ' Your current image and masks have been kept.' : ''}`);
  } finally {
    if (request === state.loadRequest) { state.loading = false; updateUI(); }
  }
}

let registration = null;
let registrationError = false;
if ('serviceWorker' in navigator && window.isSecureContext) {
  registration = navigator.serviceWorker.register('./sw.js').catch(() => { registrationError = true; return null; });
}
async function withTimeout(promise, milliseconds, message) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timeout); }
}
async function requireModelCache(job) {
  const message = 'The local OCR cache could not start. Use HTTPS or localhost, reload, and retry the scan. Your image remains on this device.';
  if (!registration || registrationError) throw new Error(message);
  const registered = await withTimeout(registration, 20_000, message);
  if (!registered || !current(job)) throw new Error(message);
  await withTimeout(navigator.serviceWorker.ready, 20_000, message);
  if (!current(job)) throw new Error(message);
  if (!navigator.serviceWorker.controller) {
    await withTimeout(new Promise(resolve => {
      const listener = () => { if (navigator.serviceWorker.controller) { navigator.serviceWorker.removeEventListener('controllerchange', listener); resolve(); } };
      navigator.serviceWorker.addEventListener('controllerchange', listener); listener();
    }), 20_000, message);
  }
}
async function workerFor(job) {
  if (state.workerHolder?.worker) return state.workerHolder.worker;
  await requireModelCache(job);
  if (!current(job)) throw new Error('Scan cancelled.');
  if (!window.Tesseract?.createWorker || typeof WebAssembly === 'undefined' || typeof window.Worker !== 'function') throw new Error('This browser cannot load the local neural OCR engine. Try a current browser with WebAssembly enabled.');
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const holder = {worker: null, nativeWorker: null, failure, rejectFailure}; state.workerHolder = holder;
  // Tesseract 7 does not expose its Worker until initialization completes, and
  // its language-load rejection can leave that initialization promise pending.
  // Capture the REAL native Worker during the synchronous library call only,
  // so Clear/error can terminate it even before initialization finishes.
  const NativeWorker = window.Worker;
  let creation;
  try {
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); holder.nativeWorker = this; }
    };
    creation = window.Tesseract.createWorker('eng', 1, {
    workerPath: new URL('./vendor/worker.min.js', document.baseURI).href,
    corePath: new URL('./vendor/core', document.baseURI).href,
    langPath: new URL('./vendor/lang', document.baseURI).href,
    workerBlobURL: false, cacheMethod: 'none', gzip: true,
    logger: message => {
      if (state.workerHolder !== holder || !state.operation) return;
      if (Number.isFinite(message.progress)) $('progress').value = Math.max(0, Math.min(1, message.progress));
      const status = typeof message.status === 'string' ? message.status : 'working';
      tell(`${state.operation === 'export' ? 'Checking the exported pixels' : 'Running local neural OCR'}: ${status}${Number.isFinite(message.progress) ? ` · ${Math.round(message.progress * 100)}%` : ''}`);
    },
      errorHandler: () => {
        rejectFailure(new Error('The local OCR worker or model could not complete its operation.'));
        holder.nativeWorker?.terminate(); holder.nativeWorker = null;
      },
    });
  } finally { window.Worker = NativeWorker; }
  creation.then(worker => {
    if (state.workerHolder !== holder) Promise.resolve(worker.terminate()).catch(() => {});
  }, () => {});
  const worker = await withTimeout(Promise.race([creation, failure]), 60_000, 'The local OCR engine took too long to initialise.');
  if (!current(job) || state.workerHolder !== holder) { await worker.terminate(); throw new Error('Scan cancelled.'); }
  holder.worker = worker;
  return worker;
}
function recognise(worker, image) {
  const operation = worker.recognize(image, {}, {text: true, blocks: true});
  const failure = state.workerHolder?.failure;
  return withTimeout(failure ? Promise.race([operation, failure]) : operation, 120_000, 'The OCR operation exceeded the bounded processing time.');
}
function patternTypes(text) {
  const types = [];
  if (/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/i.test(text)) types.push('email');
  const candidates = text.match(/\+?\d[\d().\s-]{5,}\d/g) || [];
  if (candidates.some(value => {
    const number = value.trim(), count = number.replace(/\D/g, '').length;
    return count >= 7 && count <= 15 && !/^\d{4}[-.]\d{1,2}[-.]\d{1,2}$/.test(number) && !/^\d{1,2}[-.]\d{1,2}[-.]\d{4}$/.test(number);
  })) types.push('phone');
  return types;
}
function clampBox(box, padding = 0) {
  if (!box || ![box.x0,box.y0,box.x1,box.y1].every(Number.isFinite)) return null;
  const x = Math.max(0, Math.floor(box.x0 - padding)), y = Math.max(0, Math.floor(box.y0 - padding));
  const right = Math.min(state.width, Math.ceil(box.x1 + padding)), bottom = Math.min(state.height, Math.ceil(box.y1 + padding));
  return right > x && bottom > y ? {x, y, width: right - x, height: bottom - y} : null;
}
function recognisedLines(data) {
  const results = [], keys = new Set();
  for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) {
    const text = line.text || (line.words || []).map(word => word.text).join(' ');
    const types = patternTypes(text); if (!types.length) continue;
    let box = line.bbox;
    if (!box && line.words?.length) {
      const boxes = line.words.map(word => word.bbox).filter(Boolean);
      if (boxes.length) box = {x0: Math.min(...boxes.map(b=>b.x0)),y0: Math.min(...boxes.map(b=>b.y0)),x1: Math.max(...boxes.map(b=>b.x1)),y1: Math.max(...boxes.map(b=>b.y1))};
    }
    const bbox = clampBox(box, OCR_PADDING); if (!bbox) continue;
    const type = types.join('+'), key = `${type}:${bbox.x}:${bbox.y}:${bbox.width}:${bbox.height}`;
    if (!keys.has(key)) { keys.add(key); results.push({type, bbox}); }
  }
  return results;
}
async function scan() {
  if (!state.base || busy()) return;
  const job = ++state.job, started = performance.now(); state.operation = 'scan'; state.phase = 'scanning';
  error(''); $('progress').value = 0; updateUI(); tell('Loading the local English neural OCR engine…');
  try {
    const worker = await workerFor(job);
    if (!current(job)) return;
    const result = await recognise(worker, state.base);
    if (!current(job)) return;
    const previous = new Map(state.regions.filter(r=>r.origin==='ocr').map(r=>[JSON.stringify([r.type,r.bbox]),r.selection]));
    const suggestions = recognisedLines(result.data);
    state.regions = [...suggestions.map(region => ({id: `r${state.nextRegion++}`, ...region, selection: previous.get(JSON.stringify([region.type,region.bbox])) ?? true, origin: 'ocr'})), ...state.regions.filter(region => region.origin === 'manual')];
    state.timings.scanMs = performance.now() - started; state.scanned = true; state.phase = 'review'; changed();
    renderRegions(); paint();
    tell(`${suggestions.length} supported ${suggestions.length===1?'line':'lines'} suggested. Review every mask and the whole screenshot. OCR can miss text; names, faces, addresses and QR codes need manual review.`);
  } catch (failure) {
    if (current(job)) {
      terminateWorker(); state.phase = state.scanned ? 'review' : 'error';
      error('The local OCR scan could not complete. Check that the model assets finished loading, then retry. Your image and existing masks have been kept.');
      tell('Scan unavailable. No detection result was invented.');
    }
  } finally { if (current(job)) { state.operation = null; updateUI(); } }
}

function addManual(rectangle) {
  if (!state.base || busy()) return false;
  const bbox = clampBox({x0: rectangle.x, y0: rectangle.y, x1: rectangle.x + rectangle.width, y1: rectangle.y + rectangle.height});
  if (!bbox || bbox.width < 2 || bbox.height < 2) { error('A mask must cover at least 2 × 2 pixels inside the image.'); return false; }
  state.regions.push({id: `r${state.nextRegion++}`, type: 'manual', bbox, selection: true, origin: 'manual'});
  changed(); error(''); renderRegions(); paint(); updateUI();
  tell('Opaque manual mask added. Inspect the whole image and acknowledge the updated review.');
  return true;
}
function point(event) {
  const rectangle = canvas.getBoundingClientRect();
  return {x: Math.max(0,Math.min(state.width,(event.clientX-rectangle.left)*state.width/rectangle.width)), y: Math.max(0,Math.min(state.height,(event.clientY-rectangle.top)*state.height/rectangle.height))};
}
function normalRectangle(a, b) {
  const x = Math.floor(Math.min(a.x,b.x)), y = Math.floor(Math.min(a.y,b.y));
  return {x,y,width:Math.ceil(Math.max(a.x,b.x))-x,height:Math.ceil(Math.max(a.y,b.y))-y};
}
canvas.addEventListener('pointerdown', event => {
  if (!state.base || busy() || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault(); error(''); const start = point(event);
  state.drawing = {pointer: event.pointerId,start,end:start};
  try { canvas.setPointerCapture(event.pointerId); } catch {}
  updateUI();
});
canvas.addEventListener('pointermove', event => {
  if (!state.drawing || state.drawing.pointer !== event.pointerId) return;
  event.preventDefault(); state.drawing.end = point(event); paint();
});
canvas.addEventListener('pointerup', event => {
  if (!state.drawing || state.drawing.pointer !== event.pointerId) return;
  const rectangle = normalRectangle(state.drawing.start, point(event)); state.drawing = null;
  try { canvas.releasePointerCapture(event.pointerId); } catch {}
  addManual(rectangle); paint(); updateUI();
});
canvas.addEventListener('pointercancel', () => { state.drawing = null; paint(); updateUI(); });
$('manual-form').addEventListener('submit', event => {
  event.preventDefault(); if (!state.base || busy()) return;
  const values = ['mask-x','mask-y','mask-width','mask-height'].map(id=>$(id).value.trim());
  const numbers = values.map(Number);
  if (values.some(value=>!value) || numbers.some(value=>!Number.isSafeInteger(value)) || numbers[2]<2 || numbers[3]<2) { error('Enter whole-pixel coordinates and a width and height of at least 2 pixels.'); return; }
  addManual({x:numbers[0],y:numbers[1],width:numbers[2],height:numbers[3]});
});
$('review-confirm').addEventListener('change', () => {
  if (busy() || !state.scanned) { $('review-confirm').checked = state.acknowledged; return; }
  state.acknowledged = $('review-confirm').checked;
  if (!state.acknowledged) forgetExport();
  updateUI(); tell(state.acknowledged ? 'Review acknowledged. The next step encodes a PNG and checks those output pixels with neural OCR.' : 'Review acknowledgement removed. A new acknowledgement is required before export.');
});
async function pngBlob(output) {
  return new Promise((resolve,reject)=>{ output.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG encoding failed.')), 'image/png'); });
}
async function exportAndCheck() {
  if (!state.base || busy() || !state.scanned || !state.acknowledged) return;
  const job = ++state.job, revision = state.revision, started = performance.now(); state.operation = 'export'; state.phase = 'checking';
  forgetExport(); state.exportCheck = {status:'pending',patternCount:null,types:[],revision};
  $('export-result').textContent = 'Encoding a new PNG, then scanning the decoded output pixels…'; $('export-result').dataset.state = 'pending';
  error(''); $('progress').value = 0; updateUI();
  try {
    const output = document.createElement('canvas'); output.width = state.width; output.height = state.height;
    const pixels = output.getContext('2d',{alpha:false}); pixels.fillStyle='#ffffff'; pixels.fillRect(0,0,state.width,state.height); pixels.drawImage(state.base,0,0);
    pixels.fillStyle='#101820';
    for(const region of state.regions.filter(region=>region.selection)) {const box=region.bbox;pixels.fillRect(box.x,box.y,box.width,box.height);}
    const blob = await pngBlob(output);
    if(!current(job)||revision!==state.revision)return;
    const decoded = await decodeRaster(blob,false);
    const worker = await workerFor(job);
    if(!current(job)||revision!==state.revision)return;
    const result = await recognise(worker, decoded);
    if(!current(job)||revision!==state.revision)return;
    const lines = recognisedLines(result.data), types = [...new Set(lines.flatMap(line=>line.type.split('+')))];
    // Also count recognised supported patterns whose region output is missing.
    const textTypes = patternTypes(result.data.text || '');
    for(const type of textTypes)if(!types.includes(type))types.push(type);
    const count = Math.max(lines.length,textTypes.length ? 1 : 0);
    state.timings.exportMs = performance.now()-started;
    state.exportCheck = {status:count?'patterns-remain':'passed',patternCount:count,types,revision};
    state.exportedURL = URL.createObjectURL(blob); $('export-preview').src=state.exportedURL; $('export-preview').hidden=false;
    if(count) {
      state.phase='review'; state.acknowledged=false; $('review-confirm').checked=false;
      $('export-result').textContent=`Export check recognised ${count} supported ${count===1?'line':'lines'} (${types.join(', ')}). Download withheld. Return to the masks, then review and retry.`;
      $('export-result').dataset.state='warning'; tell('Supported contact patterns remain in the exported pixels. Review the masks before trying again.');
    } else {
      state.phase='export-ready'; $('download-link').download='scrim-redacted.png';
      $('export-result').textContent='Export check completed: no supported email or phone pattern was recognised in the output. This is not a privacy guarantee; inspect the preview before downloading.';
      $('export-result').dataset.state='passed'; tell('Checked PNG ready. OCR can miss the same text twice; your visual review remains essential.');
    }
  } catch (failure) {
    if(current(job)) {
      terminateWorker(); state.phase='review'; state.exportCheck={status:'failed',patternCount:null,types:[],revision};
      forgetExport(); $('export-result').textContent='The export check could not complete. Download withheld. Your image and masks remain available; retry the check.'; $('export-result').dataset.state='error';
      error('The PNG or local OCR check failed. No ready download was produced. Retry after checking the model assets.');
    }
  } finally {if(current(job)){state.operation=null;updateUI();}}
}

$('file-input').addEventListener('change',()=>{const file=$('file-input').files[0];if(file)loadImage(file);});
$('demo-btn').addEventListener('click',async()=>{
  if(busy())return;
  const request = ++state.loadRequest;
  state.loading = true; error(''); updateUI(); tell('Loading the fictional example…');
  try {
    const source=new URL($('demo-btn').dataset.src || 'fixtures/help.png',document.baseURI);
    if(source.origin!==location.origin)throw new Error('The example must be hosted on this origin.');
    const response=await fetch(source);if(!response.ok)throw new Error('The fictional example could not be loaded.');
    const blob=await response.blob();
    if (request !== state.loadRequest) return;
    await loadImage(new File([blob],'scrim-fictional-example.png',{type:'image/png'}),true);
  }catch(failure){if(request === state.loadRequest)error(failure.message);}
  finally {if(request === state.loadRequest){state.loading=false;updateUI();}}
});
$('scan-btn').addEventListener('click',scan);
$('export-btn').addEventListener('click',exportAndCheck);
$('download-link').addEventListener('click',event=>{
  if(!window.scrimProof().readyDownload){event.preventDefault();error('The export is not ready. Review and complete a new export check.');}
});
$('clear-btn').addEventListener('click',()=>{
  state.loadRequest++; state.loading=false; cancelOperation(); state.base=null; state.width=0; state.height=0; state.regions=[]; state.nextRegion=1; state.scanned=false; state.phase='empty';
  state.timings={scanMs:null,exportMs:null}; changed(); $('file-input').value=''; error(''); renderRegions(); paint(); updateUI(); tell('Image, recognised regions and export cleared from this page. Any running scan was cancelled.');
});
window.addEventListener('pagehide',()=>{terminateWorker();forgetExport();});
renderRegions(); updateUI();
