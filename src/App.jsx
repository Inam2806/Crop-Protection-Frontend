import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.scss';

// In Create React App, src/setupProxy.js forwards /api to FastAPI.
// Meta access tokens and API secrets must remain on the backend/proxy, never in browser code.
const API = '/api';
// A live preview runs continuously; inference runs at a controlled rate.
// All presets keep only ONE inference request in flight at a time.
const SCAN_PRESETS = {
  // Sampling delays are AFTER each completed request; only one runs at a time.
  fast: { intervalMs: 180, maxSide: 1280, quality: 0.73, description: 'Responsive boxes; target a few detections per second' },
  balanced: { intervalMs: 450, maxSide: 960, quality: 0.72, description: 'Lower load for monitoring' },
  eco: { intervalMs: 1000, maxSide: 640, quality: 0.68, description: 'Conserve CPU and bandwidth' },
};
const DEFAULT_CROPS = [
  'wheat', 'rice', 'maize', 'sugarcane', 'cotton',
  'pulses', 'vegetables', 'fruits_orchard', 'groundnut', 'sunflower',
];
const COLORS = {
  elephant: '#ed7d66', bird: '#e6b54a', cow: '#af895c', sheep: '#d8bdb2',
  horse: '#b99a7a', bear: '#dba172', dog: '#75a7eb', cat: '#b59ae8',
  boar: '#e6a45a', monkey: '#bb8c6d', deer: '#7abda5', nilgai: '#91a1d5',
  buffalo: '#ae8d6b', goat: '#b6c68b', peacock: '#6bbed7',
  leopard: '#d1b36a', tiger: '#ef9b53', zebra: '#c7cbd0', giraffe: '#d5b375',
};
const nice = (value = '') => String(value).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const validCoordinate = (n, limit) => Number.isFinite(n) && Math.abs(n) <= limit;
const snapshotPath = (path) =>
  typeof path === 'string' && /^\/static\/detections\/[A-Za-z0-9_.-]+\.jpg$/.test(path)
    ? `${API}${path}` : null;

async function requestJson(path, options = {}) {
  const endpoint = `${API}${path}`;
  const result = await fetch(endpoint, options);
  const contentType = result.headers.get('content-type') || '';
  const response = contentType.includes('application/json')
    ? await result.json().catch(() => null)
    : null;

  if (result.status === 404) {
    throw new Error(
      `HTTP 404 at ${endpoint}. First verify http://localhost:8000/health, then configure src/setupProxy.js ` +
      'for Create React App (or vite.config.js for Vite), then restart the frontend.'
    );
  }
  if (!result.ok) {
    const detail = response?.detail || response?.error || `HTTP ${result.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  // CRA can otherwise return index.html with HTTP 200 for unknown paths.
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(
      `${endpoint} returned non-JSON content instead of the FastAPI response. ` +
      'Check the React proxy and backend URL.'
    );
  }
  return response;
}

function ScoreBadge({ detection }) {
  const score = detection.priority_score ?? detection.risk_score;
  if (score == null) return <span className="score-badge unknown">Priority unknown</span>;
  return (
    <span className="score-badge provisional"
      title="Heuristic index, not a probability of crop loss">
      Priority {Number(score).toFixed(2)} · {detection.harm_status === 'reviewed_evidence' ? 'evidence reviewed' : 'unvalidated'}
    </span>
  );
}

function AlertDisplay({ alert, config, snapshot, camera }) {
  const status = alert?.status || (config?.enabled ? 'waiting' : 'disabled');
  const labels = {
    accepted_by_meta: 'Meta accepted the request (delivery not confirmed)',
    partially_accepted: 'Some recipients accepted; others failed',
    failed: 'Alert request failed',
    not_configured: 'Meta Cloud API configuration incomplete',
    cooldown: 'Alert held by per-camera cooldown',
    observing: 'Tracking animal presence; waiting for the 10-second harm-matrix rule',
    queued: 'Animal remained visible for over 10 seconds; submitting WhatsApp notification',
    below_harm_threshold: 'No visible animal meets both the harm-score and confidence gates',
    in_progress: 'Previous alert is still being submitted',
    no_animals: 'No animals in this frame',
    below_threshold: 'No animal met the alert confidence threshold',
    upload_disabled: 'Upload alerts disabled on the backend',
    disabled: 'Alerts switched off on the backend',
    waiting: 'Waiting for a detection',
  };
  const image = snapshotPath(snapshot || alert?.snapshot);
  const problems = alert?.errors?.length ? alert.errors : config?.setup_issues;
  return (
    <section className="alert-panel glass" aria-live="polite">
      <div className="panel-heading">
        <h3>📱 Meta WhatsApp notifications</h3>
        <span className={`alert-state state-${status}`}>{nice(status)}</span>
      </div>
      <p className="panel-desc">{labels[status] || status}.</p>
      <div className="alert-facts">
        <div><small>Camera</small><strong>{camera?.id || '—'} · {camera?.name || '—'}</strong></div>
        <div><small>Channel</small><strong>{config?.channel?.toUpperCase() || 'Not enabled'}</strong></div>
        <div><small>Eligible in frame</small><strong>{alert?.qualifying_count ?? '—'}</strong></div>
        <div><small>Accepted requests</small><strong>{alert?.accepted_count ?? 0}</strong></div>
      </div>
      {config?.enabled && (
        <p className="fine-print">Minimum confidence: {config.min_confidence ?? '—'} · Cooldown: {config.cooldown_sec ?? '—'}s · Meta image upload: {config.media_upload_ready ? 'configured' : 'not configured'} · Mode: {config.mode || '—'}</p>
      )}
      {!!problems?.length && <div className="alert-problems">{problems.map((reason, i) => <p key={i}>{reason}</p>)}</div>}
      {image && (
        <a className="snapshot-link" href={image} target="_blank" rel="noreferrer">
          <img src={image} alt="Annotated animal detections with bounding boxes" loading="lazy" />
          <span>Open saved annotated image ↗</span>
        </a>
      )}
      {alert?.message_statuses?.length > 0 && <p className="fine-print">Meta accepted IDs: {alert.message_statuses.filter((s) => s.id).length}. Check delivery through WhatsApp webhooks.</p>}
      <p className="fine-print">Session mode sends a photo caption and location pin. Template mode sends the approved body and optional image header; the map is a link.</p>
    </section>
  );
}

export default function App() {
  const [running, setRunning] = useState(false);
  const [sourceMode, setSourceMode] = useState('camera');
  const [busy, setBusy] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState(null);
  const [modelInfo, setModelInfo] = useState(null);
  const [alertConfig, setAlertConfig] = useState(null);
  const [lastResponse, setLastResponse] = useState(null);
  const [detections, setDetections] = useState([]);
  const [imageInfo, setImageInfo] = useState({ width: 640, height: 480 });
  const [requestRate, setRequestRate] = useState(null);
  const [scanSpeed, setScanSpeed] = useState('fast');
  const [recentAlert, setRecentAlert] = useState(null);
  const [framesProcessed, setFramesProcessed] = useState(0);
  const [sightings, setSightings] = useState({}); // per-frame occurrences, NOT unique animals
  const [cameraId, setCameraId] = useState('CAM-01');
  const [cameraName, setCameraName] = useState('North field');
  const [cameras, setCameras] = useState([]);
  const [deviceId, setDeviceId] = useState('');
  const [crop, setCrop] = useState('');
  const [crops, setCrops] = useState(DEFAULT_CROPS);
  const [cropBusy, setCropBusy] = useState(false);
  const [harmCoverage, setHarmCoverage] = useState(null);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locationName, setLocationName] = useState('');
  const [farmLocation, setFarmLocation] = useState(null);
  const [locationBusy, setLocationBusy] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [uploadPreview, setUploadPreview] = useState(null);
  const [resizeCount, setResizeCount] = useState(0);

  const videoRef = useRef(null);
  const imageRef = useRef(null);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const runRef = useRef(false);
  const controllerRef = useRef(null);
  const nextFrameRef = useRef(null);
  const inFlightGenerationRef = useRef(null);
  const generationRef = useRef(0);
  const scanSpeedRef = useRef('fast');
  const sessionIdRef = useRef('default');
  const pendingAlertRef = useRef(null);
  const cameraRef = useRef({ id: 'CAM-01', name: 'North field' });
  const locationRef = useRef(null);
  const lastResultAtRef = useRef(0);
  const lastSoundAtRef = useRef(0);
  const soundRef = useRef(false);
  const uploadPreviewRef = useRef(null);

  useEffect(() => { cameraRef.current = { id: cameraId, name: cameraName }; }, [cameraId, cameraName]);
  useEffect(() => { locationRef.current = farmLocation; }, [farmLocation]);
  useEffect(() => { soundRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => {
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => setResizeCount((x) => x + 1)) : null;
    if (stageRef.current && ro) ro.observe(stageRef.current);
    const resize = () => setResizeCount((x) => x + 1);
    window.addEventListener('resize', resize);
    return () => { ro?.disconnect(); window.removeEventListener('resize', resize); };
  }, []);

  // Notifications are now submitted AFTER detection responses return. Fetch
  // the latest result separately to distinguish API acceptance from delivery.
  useEffect(() => {
    if (!running) return undefined;
    let active = true;
    let polling = false;
    const timer = setInterval(async () => {
      if (!pendingAlertRef.current || polling) return;
      polling = true;
      try {
        const reply = await requestJson(`/alert-status?camera_id=${encodeURIComponent(cameraRef.current.id)}`);
        if (active && reply.alert?.request_id === pendingAlertRef.current) {
          setRecentAlert(reply.alert);
          if (reply.alert.status !== 'queued') pendingAlertRef.current = null;
        }
      } catch { /* no disruption of live detection if status polling fails */ }
      finally { polling = false; }
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [running]);

  const loadCoverage = useCallback(async (selectedCrop) => {
    if (!selectedCrop) { setHarmCoverage(null); return; }
    try { setHarmCoverage(await requestJson(`/harm-matrix?crop=${encodeURIComponent(selectedCrop)}`)); }
    catch { setHarmCoverage(null); }
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      requestJson('/health'), requestJson('/model-info'), requestJson('/alert-config'), requestJson('/farm-crop'),
      requestJson('/farm-location'),
    ]).then(([h, m, a, c, l]) => {
      if (!alive) return;
      if (h.status === 'fulfilled') setHealth(h.value);
      if (m.status === 'fulfilled') setModelInfo(m.value);
      else setError('Backend unreachable through /api. Check the React proxy and FastAPI.');
      if (a.status === 'fulfilled') setAlertConfig(a.value);
      if (c.status === 'fulfilled') {
        if (Array.isArray(c.value.available_crops)) setCrops(c.value.available_crops);
        if (c.value.crop) { setCrop(c.value.crop); loadCoverage(c.value.crop); }
      }
      if (l.status === 'fulfilled' && l.value.success && l.value.location) {
        const stored = l.value.location;
        setFarmLocation(stored);
        locationRef.current = stored;
        setLatitude(String(stored.latitude));
        setLongitude(String(stored.longitude));
        setLocationName(stored.name || '');
        setNotice('Previously saved farm location loaded. Verify it if the camera has moved.');
      }
    });
    return () => { alive = false; };
  }, [loadCoverage]);

  useEffect(() => () => {
    runRef.current = false;
    generationRef.current += 1;
    controllerRef.current?.abort();
    if (nextFrameRef.current != null) clearTimeout(nextFrameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (uploadPreviewRef.current) URL.revokeObjectURL(uploadPreviewRef.current);
  }, []);

  const stopCamera = () => {
    generationRef.current += 1;
    runRef.current = false;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (nextFrameRef.current != null) clearTimeout(nextFrameRef.current);
    nextFrameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setRunning(false);
    setRequestRate(null);
    setDetections([]);
  };

  const validateCamera = () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(cameraId.trim())) {
      setError('Camera ID must be 1–48 letters, numbers, hyphens or underscores.');
      return false;
    }
    if (!cameraName.trim()) { setError('Enter a camera name or field position.'); return false; }
    cameraRef.current = { id: cameraId.trim(), name: cameraName.trim() };
    return true;
  };

  const sendFile = async (file, filename, source, signal) => {
    const form = new FormData();
    form.append('file', file, filename);
    form.append('source', source);
    form.append('camera_id', cameraRef.current.id.trim());
    form.append('camera_name', cameraRef.current.name.trim());
    form.append('session_id', sessionIdRef.current);
    const loc = locationRef.current;
    if (loc) {
      form.append('latitude', String(loc.latitude));
      form.append('longitude', String(loc.longitude));
    }
    return requestJson('/detect', { method: 'POST', body: form, signal });
  };

  const processResult = (data, source) => {
    const found = Array.isArray(data.detections) ? data.detections : [];
    setDetections(found);
    setLastResponse(data);
    if (source === 'camera' && data.alert?.status === 'queued') {
      pendingAlertRef.current = data.request_id;
      setRecentAlert(data.alert);
    }
    setImageInfo(data.image_info || { width: 640, height: 480 });
    setFramesProcessed((count) => count + 1);
    setSightings((previous) => {
      const next = { ...previous };
      for (const detection of found) {
        const label = detection.class || detection.label || 'unknown';
        next[label] = (next[label] || 0) + 1;
      }
      return next;
    });
    if (data.farm_crop) setCrop(data.farm_crop);
    if (data.partial) setNotice('Partial detection: one or more models failed or were unavailable.');
    if (source === 'camera') {
      const now = performance.now();
      if (lastResultAtRef.current) {
        const elapsed = now - lastResultAtRef.current;
        if (elapsed > 0) setRequestRate(Number((1000 / elapsed).toFixed(1)));
      }
      lastResultAtRef.current = now;
    }
    if (found.length && soundRef.current && Date.now() - lastSoundAtRef.current > 5000) {
      try {
        const sound = new Audio('/engyclick-police-siren-sound-effect-317645.mp3');
        sound.volume = 0.35;
        sound.play().catch(() => {}); // optional, user-provided sound file
      } catch { /* optional feature */ }
      lastSoundAtRef.current = Date.now();
    }
  };

  // Timer-based sampling: we never start a second request before the first finishes.
  // This keeps the video preview smooth without overloading FastAPI/YOLO/Meta.
  const scheduleNextFrame = (generation, delayMs) => {
    if (!runRef.current || generation !== generationRef.current) return;
    if (nextFrameRef.current != null) clearTimeout(nextFrameRef.current);
    nextFrameRef.current = setTimeout(() => {
      nextFrameRef.current = null;
      void runFrame(generation);
    }, delayMs);
  };

  const runFrame = async (generation) => {
    if (!runRef.current || generation !== generationRef.current || inFlightGenerationRef.current === generation) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      scheduleNextFrame(generation, 150);
      return;
    }
    inFlightGenerationRef.current = generation;
    let controller = null;
    let failed = false;
    try {
      const { maxSide, quality } = SCAN_PRESETS[scanSpeedRef.current];
      const originalWidth = video.videoWidth || 640;
      const originalHeight = video.videoHeight || 480;
      const scale = Math.min(1, maxSide / Math.max(originalWidth, originalHeight));
      canvas.width = Math.max(1, Math.round(originalWidth * scale));
      canvas.height = Math.max(1, Math.round(originalHeight * scale));
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Camera canvas context unavailable');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob || !runRef.current || generation !== generationRef.current) return;
      controller = new AbortController();
      controllerRef.current = controller;
      const data = await sendFile(blob, 'camera-frame.jpg', 'camera', controller.signal);
      if (runRef.current && generation === generationRef.current) { processResult(data, 'camera'); setError(''); }
    } catch (exc) {
      if (runRef.current && generation === generationRef.current && exc.name !== 'AbortError') {
        failed = true;
        setError(`Detection request failed: ${exc.message}`);
      }
    } finally {
      if (inFlightGenerationRef.current === generation) inFlightGenerationRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
      if (runRef.current && generation === generationRef.current) {
        // Back off on errors to avoid hammering an offline backend or invalid API key.
        const interval = SCAN_PRESETS[scanSpeedRef.current].intervalMs;
        scheduleNextFrame(generation, failed ? Math.max(3000, interval) : interval);
      }
    }
  };

  const startCamera = async () => {
    if (!validateCamera()) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access requires localhost or HTTPS and a supported browser.');
      return;
    }
    stopCamera();
    const generation = generationRef.current;
    setSourceMode('camera');
    // A restart is a new continuous observation session, not 10 seconds
    // carried over from the previous stream.
    sessionIdRef.current = `s${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    pendingAlertRef.current = null;
    setRecentAlert(null);
    setError(''); setNotice(''); setDetections([]); setLastResponse(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (generation !== generationRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      if (!videoRef.current) throw new Error('Camera preview is not ready');
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      if (generation !== generationRef.current) return;
      const available = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      setCameras(available.filter((x) => x.kind === 'videoinput'));
      lastResultAtRef.current = 0;
      runRef.current = true;
      setRunning(true);
      scheduleNextFrame(generation, 0);
    } catch (exc) {
      stopCamera();
      setError(`Cannot start camera: ${exc.message}. Check permissions/device selection.`);
    }
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose an image file.'); return; }
    if (!validateCamera()) return;
    stopCamera();
    const generation = generationRef.current;
    setSourceMode('upload'); setBusy(true); setDetections([]);
    setError(''); setNotice(''); setLastResponse(null);
    if (uploadPreviewRef.current) URL.revokeObjectURL(uploadPreviewRef.current);
    const url = URL.createObjectURL(file);
    uploadPreviewRef.current = url;
    setUploadPreview(url);
    try {
      const data = await sendFile(file, file.name, 'upload');
      if (generation === generationRef.current) processResult(data, 'upload');
    } catch (exc) { if (generation === generationRef.current) setError(`Upload detection failed: ${exc.message}`); }
    finally { setBusy(false); }
  };

  const changeCrop = async (event) => {
    const value = event.target.value;
    if (!value) return;
    setCropBusy(true); setError('');
    try {
      const form = new FormData(); form.append('crop', value);
      const data = await requestJson('/farm-crop', { method: 'POST', body: form });
      setCrop(data.crop); await loadCoverage(data.crop);
      setNotice(`${nice(data.crop)} selected. Harm priorities remain unvalidated where marked provisional.`);
    } catch (exc) { setError(`Unable to save crop: ${exc.message}`); }
    finally { setCropBusy(false); }
  };

  const saveLocation = async () => {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!latitude.trim() || !longitude.trim() || !validCoordinate(lat, 90) || !validCoordinate(lon, 180)) {
      setError('Enter valid latitude (-90 to 90) and longitude (-180 to 180).');
      return;
    }
    setLocationBusy(true); setError('');
    try {
      const form = new FormData();
      form.append('latitude', String(lat)); form.append('longitude', String(lon));
      if (locationName.trim()) form.append('locationName', locationName.trim());
      const data = await requestJson('/farm-location', { method: 'POST', body: form });
      locationRef.current = data.location;
      setFarmLocation(data.location);
      setNotice('Location saved. Coordinates will be included in future camera alerts.');
    } catch (exc) { setError(`Unable to save location: ${exc.message}`); }
    finally { setLocationBusy(false); }
  };

  const useGPS = () => {
    if (!navigator.geolocation) { setError('Device location unavailable; enter coordinates manually.'); return; }
    setLocationBusy(true); setError('');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLatitude(coords.latitude.toFixed(6));
        setLongitude(coords.longitude.toFixed(6));
        setLocationBusy(false);
        setNotice('Device coordinates filled in. Check them, then click Save farm location.');
      },
      (exc) => { setLocationBusy(false); setError(`Location permission/error: ${exc.message}`); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 120000 },
    );
  };

  // Only send coordinates that were explicitly saved, never unsaved text fields.
  const camera = lastResponse?.camera || { id: cameraId, name: cameraName };
  const counts = lastResponse?.animal_counts || {};
  const totalThisFrame = lastResponse?.count ?? detections.length;
  const sessionSightings = Object.values(sightings).reduce((a, b) => a + b, 0);
  const activeImage = sourceMode === 'upload' ? uploadPreview : null;
  const alert = recentAlert || lastResponse?.alert || null;
  const tracking = lastResponse?.tracking || null;
  const lastSnapshot = lastResponse?.snapshot || null;
  const selectedLocation = lastResponse?.location_used || farmLocation;
  const mapLink = selectedLocation
    ? `https://www.google.com/maps?q=${selectedLocation.latitude},${selectedLocation.longitude}` : null;

  // Both video and uploaded image use object-fit: contain in the same viewport.
  // Convert the backend's original-image box coordinates to displayed pixels.
  const boxStyle = (box) => {
    if (!Array.isArray(box) || box.length !== 4) return null;
    const stageW = stageRef.current?.clientWidth || 0;
    const stageH = stageRef.current?.clientHeight || 0;
    const sourceW = Number(imageInfo.width);
    const sourceH = Number(imageInfo.height);
    if (!stageW || !stageH || !sourceW || !sourceH) return null;
    const scale = Math.min(stageW / sourceW, stageH / sourceH);
    const left = (stageW - sourceW * scale) / 2;
    const top = (stageH - sourceH * scale) / 2;
    return {
      left: `${left + box[0] * scale}px`, top: `${top + box[1] * scale}px`,
      width: `${Math.max(0, (box[2] - box[0]) * scale)}px`,
      height: `${Math.max(0, (box[3] - box[1]) * scale)}px`,
    };
  };
  void resizeCount; // a resize triggers a render and recalculation

  return (
    <div className="app-container">
      <div className="app-background" />
      <header className="app-header">
        <div className="logo-container"><div className="logo-icon">🌾</div><div>
          <h1>Crop Protection System</h1>
          <p>AI animal detection · Crop monitoring · Camera alerts</p>
        </div></div>
        <div className="header-badge">
          <span className="badge">COCO + YOLO-World</span>
          <span className="badge">{modelInfo?.num_animal_classes ?? '—'} active classes</span>
          <span className="badge">{health?.status === 'ok' ? 'API healthy' : health ? 'API degraded' : 'Connecting'}</span>
        </div>
      </header>

      <main className="main-content">
        <section className="control-card glass">
          <div className="control-header">
            <div className="status-indicator">
              <span className={`status-dot ${running ? 'active' : 'inactive'}`}><span className="pulse-ring" /></span>
              <div className="status-text"><span className="status-label">Camera monitoring</span>
                <strong className={`status-value ${running ? 'active' : 'inactive'}`}>{running ? 'ONLINE' : 'OFFLINE'}</strong>
              </div>
            </div>
            <div className="fps-display"><span className="fps-value">{requestRate ?? '—'}</span>
              <span className="fps-label">completed req/s</span></div>
          </div>

          <div className="model-info-display">
            <span className="model-badge">Models: {modelInfo?.sources?.map((s) => s.key).join(' + ') || 'Not loaded'}</span>
            <span className="model-badge">Alert service: {alertConfig?.enabled ? (alertConfig.ready ? 'Ready' : 'Setup needed') : 'Off'}</span>
            <span className="model-badge">Photos: {alertConfig?.media_upload_ready ? 'Direct Meta upload ready' : 'Meta not configured'}</span>
          </div>

          <div className="control-grid">
            <div className="field-group">
              <label htmlFor="camera-id">Camera ID</label>
              <input id="camera-id" className="location-input" maxLength={48} value={cameraId}
                disabled={running || busy} onChange={(e) => setCameraId(e.target.value)} placeholder="CAM-01" />
            </div>
            <div className="field-group">
              <label htmlFor="camera-name">Camera name / field position</label>
              <input id="camera-name" className="location-input" maxLength={70} value={cameraName}
                disabled={running || busy} onChange={(e) => setCameraName(e.target.value)} placeholder="East gate" />
            </div>
            <div className="field-group">
              <label htmlFor="camera-device">Camera device</label>
              <select id="camera-device" className="crop-select" value={deviceId}
                disabled={running || busy} onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">System default camera</option>
                {cameras.map((device, i) => <option key={device.deviceId || i} value={device.deviceId}>{device.label || `Camera ${i + 1}`}</option>)}
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="scan-speed">Detection speed</label>
              <select id="scan-speed" className="crop-select" value={scanSpeed}
                onChange={(e) => { setScanSpeed(e.target.value); scanSpeedRef.current = e.target.value; }}>
                <option value="fast">Fast — 180 ms between scans</option>
                <option value="balanced">Balanced — 450 ms between scans</option>
                <option value="eco">Eco — 1 s between scans</option>
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="crop-select">Protected crop</label>
              <select id="crop-select" className="crop-select" value={crop} disabled={cropBusy}
                onChange={changeCrop}>
                <option value="">Choose a crop</option>
                {crops.map((value) => <option value={value} key={value}>{nice(value)}</option>)}
              </select>
            </div>
          </div>

          <div className="button-group">
            <button className={`btn btn-toggle ${running ? 'active' : 'inactive'}`}
              onClick={running ? stopCamera : startCamera} disabled={busy}>
              {running ? '⏹ Stop camera' : '▶ Start camera'}
            </button>
            <label className={`btn btn-upload ${busy ? 'is-disabled' : ''}`}>
              📷 Upload image
              <input type="file" accept="image/*" disabled={busy} onChange={handleFile} hidden />
            </label>
            <button className={`btn btn-info ${showInfo ? 'active' : ''}`} onClick={() => setShowInfo((v) => !v)}>
              ℹ️ {showInfo ? 'Hide details' : 'Info'}
            </button>
            <label className="sound-switch"><input type="checkbox" checked={soundEnabled}
              onChange={(e) => setSoundEnabled(e.target.checked)} /> Sound on animal sighting</label>
          </div>
          <p className="fine-print">Scan mode: {SCAN_PRESETS[scanSpeed].description}. Live camera detection uses short intervals, stable box IDs and a separate WhatsApp send queue. Harm alert: score &gt; {alertConfig?.temporal_rule?.harm_score_gt ?? 0.6}, confidence &ge; {alertConfig?.min_confidence ?? 0.55}, present for &gt; {alertConfig?.temporal_rule?.observed_seconds_gt ?? 10} seconds. These are provisional scores, not validated danger probabilities.</p>
          <p className="fine-print">Camera ID determines which camera is named in WhatsApp, and cooldown is maintained separately for each ID. Upload alerts require server opt-in.</p>
        </section>

        <section className="location-panel glass">
          <div className="panel-heading"><h3>📍 Farm location</h3>
            <span className="panel-subtitle">Explicitly save the coordinates to include a map link in alerts</span></div>
          <div className="location-grid">
            <div className="field-group"><label htmlFor="farm-lat">Latitude</label>
              <input className="location-input" id="farm-lat" inputMode="decimal" value={latitude}
                onChange={(e) => setLatitude(e.target.value)} placeholder="e.g. 12.914142" /></div>
            <div className="field-group"><label htmlFor="farm-lon">Longitude</label>
              <input className="location-input" id="farm-lon" inputMode="decimal" value={longitude}
                onChange={(e) => setLongitude(e.target.value)} placeholder="e.g. 74.856034" /></div>
            <div className="field-group"><label htmlFor="location-name">Field name (optional)</label>
              <input className="location-input" id="location-name" value={locationName}
                onChange={(e) => setLocationName(e.target.value)} placeholder="North field" /></div>
          </div>
          <div className="button-group compact">
            <button className="btn" onClick={useGPS} disabled={locationBusy}>📍 Use device coordinates</button>
            <button className="btn btn-location active" onClick={saveLocation} disabled={locationBusy}>
              {locationBusy ? 'Saving…' : 'Save farm location'}</button>
          </div>
          {farmLocation && <div className="location-status">Saved: {farmLocation.name || 'Farm location'} · {farmLocation.latitude.toFixed(6)}, {farmLocation.longitude.toFixed(6)}
            <a href={`https://www.google.com/maps?q=${farmLocation.latitude},${farmLocation.longitude}`} target="_blank" rel="noreferrer">View map ↗</a>
          </div>}
        </section>

        {error && <div className="error-banner" role="alert">
          <div className="error-message">⚠️ {error}
            {(/404|non-JSON|proxy/i.test(error)) && (
              <div className="api-route-help">
                Check the FastAPI server at <a href="http://localhost:8000/health" target="_blank" rel="noreferrer">http://localhost:8000/health</a>.
                It should show FastAPI JSON, not a React page.
              </div>
            )}
          </div>
          <button className="error-close" onClick={() => setError('')} aria-label="Dismiss error">✕</button>
        </div>}
        {notice && <div className="notice-banner" role="status">{notice}
          <button className="error-close" onClick={() => setNotice('')} aria-label="Dismiss notice">✕</button></div>}

        <div className="camera-toolbar">
          <strong>{sourceMode === 'upload' ? 'Uploaded image' : 'Live camera'}</strong>
          <span>Camera: {cameraId} · {cameraName}</span>
          {busy && <span>Analyzing image…</span>}
        </div>
        <section className={`camera-view-container ${running ? 'camera-on' : ''}`} ref={stageRef} aria-label="Animal detection image and boxes">
          <video ref={videoRef} className={`camera-video ${running ? '' : 'is-hidden'}`} playsInline autoPlay muted />
          {sourceMode === 'upload' && activeImage && <img ref={imageRef} className="camera-image" src={activeImage} alt="Uploaded field for animal detection" />}
          {!running && !(sourceMode === 'upload' && activeImage) && (
            <div className="camera-feed-inactive"><div className="inactive-icon">📷</div><h3>Camera offline</h3>
              <p>Start a camera or upload a field image to analyze animals.</p></div>
          )}
          <canvas ref={canvasRef} className="hidden-canvas" />
          <div className="detection-overlay" aria-hidden="true">
            {detections.map((d, i) => {
              const style = boxStyle(d.box);
              if (!style) return null;
              const label = d.class || d.label || 'animal';
              const color = COLORS[label] || '#7abda5';
              return <div className="bounding-box" key={d.track_id != null ? `track-${d.track_id}` : `${label}-${i}`}
                style={{ ...style, borderColor: d.harm_gate_qualified ? '#f4bb4f' : color }}
                title={d.track_id != null ? `Track #${d.track_id}: observed ${d.visible_seconds || 0}s` : label}>
                <div className="bounding-label" style={{ background: color }}>
                  <span className="label-class">{nice(label)}</span>
                  <span className="label-confidence">{Math.round(Number(d.confidence || 0) * 100)}%{d.track_id != null ? ` · #${d.track_id} · ${Number(d.visible_seconds || 0).toFixed(1)}s` : ''}</span>
                </div>
              </div>;
            })}
          </div>
          <div className="camera-overlay-info">
            <span className="overlay-badge">{running ? '● LIVE' : sourceMode === 'upload' ? '● UPLOAD' : '○ OFFLINE'}</span>
            <span className="overlay-badge">Animals this frame: {totalThisFrame}</span>
            {crop && <span className="overlay-badge">🌾 {nice(crop)}</span>}
            {tracking && <span className="overlay-badge">Harm &gt; {tracking.harm_threshold.toFixed(2)} · {tracking.dwell_seconds}s dwell</span>}
            {tracking?.next_alert_in_seconds != null &&
              <span className="overlay-badge">Alert in ~{tracking.next_alert_in_seconds.toFixed(1)}s</span>}
          </div>
        </section>

        <div className="summary-grid">
          <div className="summary-card glass"><span>Animals this frame</span><strong>{totalThisFrame}</strong><small>Current result</small></div>
          <div className="summary-card glass"><span>Processed images/frames</span><strong>{framesProcessed}</strong><small>Session total</small></div>
          <div className="summary-card glass"><span>Detection occurrences</span><strong>{sessionSightings}</strong><small>Across frames, not unique animals</small></div>
        </div>

        <section className="stats-panel glass">
          <div className="panel-heading"><h3>🐾 Animals detected in latest frame</h3>
            <span className="panel-subtitle">Counts are detections in one image, not tracking IDs</span></div>
          {Object.keys(counts).length ? <div className="count-chips">
            {Object.entries(counts).map(([label, number]) => <span className="stats-class" key={label}>
              <i style={{ background: COLORS[label] || '#7abda5' }} /> {nice(label)} <strong>{number}</strong>
            </span>)}
          </div> : <p className="empty-state">No animals in the latest result.</p>}
          {!!detections.length && <div className="detection-table">
            {detections.map((d, i) => <div className="detection-row" key={i}>
              <strong>{nice(d.class || d.label)}</strong>
              <span>{Math.round(Number(d.confidence || 0) * 100)}% detection confidence</span>
              <ScoreBadge detection={d} />
            </div>)}
          </div>}
          {harmCoverage && <p className="fine-print">Crop harm table: {harmCoverage.coverage?.reviewed_evidence_pairs ?? 0} evidence-reviewed entries. Unvalidated indices are not probabilities.</p>}
          {lastResponse?.partial && <p className="caution-text">One or more detection models were unavailable for this result.</p>}
        </section>

        <AlertDisplay alert={alert} config={alertConfig} snapshot={lastSnapshot} camera={camera} />
        {selectedLocation && mapLink && <div className="location-summary glass">
          <span>📍 Alert location: {selectedLocation.name || 'Farm'} ({selectedLocation.latitude}, {selectedLocation.longitude})</span>
          <a href={mapLink} target="_blank" rel="noreferrer">Open Google Maps ↗</a>
        </div>}

        {showInfo && <section className="info-panel glass">
          <div className="info-header"><h3>About the system</h3>
            <button className="info-close" onClick={() => setShowInfo(false)} aria-label="Close information">✕</button></div>
          <div className="info-grid">
            <div className="info-card"><h4>Animal detection</h4><p>COCO YOLO and YOLO-World outputs are merged. Up to 19 classes are configured, depending on models successfully loaded.</p></div>
            <div className="info-card"><h4>Crop priority</h4><p>Experimental confidence × harm index is unvalidated. Missing values stay unknown. Alerts do not represent predicted damage probabilities.</p></div>
            <div className="info-card"><h4>Meta WhatsApp alerts</h4><p>The backend uploads annotated images directly to Meta and reports accepted message IDs. Delivery must be checked using Meta webhooks. Session mode needs an open 24-hour service window; unattended alerts require an approved template.</p></div>
            <div className="info-card"><h4>Location privacy</h4><p>Only coordinates you explicitly save are sent from this frontend. No default Delhi or IP-based fallback is used.</p></div>
          </div>
        </section>}
      </main>
    </div>
  );
}
