const SERVER_URL = "http://127.0.0.1:8783";

const urlInput = document.getElementById("url");
const startInput = document.getElementById("start");
const endInput = document.getElementById("end");
const filenameInput = document.getElementById("filename");
const qualitySelect = document.getElementById("quality");
const statusEl = document.getElementById("status");
const videoTitleEl = document.getElementById("videoTitle");
const serverDot = document.getElementById("serverDot");
const cropButton = document.getElementById("crop");
const cancelButton = document.getElementById("cancelJob");
const saveAsButton = document.getElementById("saveAs");
const progressTrack = document.getElementById("progressTrack");
const progressFill = document.getElementById("progressFill");
const tabStrip = document.getElementById("tabStrip");
const newTabBtn = document.getElementById("newTabBtn");
const stopAllBtn = document.getElementById("stopAllBtn");

const ACTIVE_STATUSES = new Set(["starting", "downloading", "cancelling"]);

// Each job is fully independent client-side state (its own URL/times/quality
// and its own server jobId + poll loop), so running several at once never
// cross-contaminates their progress or inputs.
let jobs = [];
let activeLocalId = null;
let jobCounter = 0;

function makeLocalId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function createJob(prefill) {
  jobCounter += 1;
  const job = {
    localId: makeLocalId(),
    label: `Job ${jobCounter}`,
    jobId: null,
    url: (prefill && prefill.url) || "",
    videoTitle: (prefill && prefill.title) || "",
    start: "",
    end: (prefill && prefill.duration) || "",
    filename: "",
    quality: "best",
    status: "idle",
    progress: 0,
    stage: "",
    error: null,
    outputPath: null
  };
  jobs.push(job);
  return job;
}

function getActiveJob() {
  return jobs.find((j) => j.localId === activeLocalId) || null;
}

function saveFormIntoActiveJob() {
  const job = getActiveJob();
  if (!job) return;
  job.url = urlInput.value.trim();
  job.start = startInput.value;
  job.end = endInput.value;
  job.filename = filenameInput.value.trim();
  job.quality = qualitySelect.value;
}

function selectJob(localId) {
  saveFormIntoActiveJob();
  activeLocalId = localId;
  renderTabs();
  loadJobIntoForm();
}

function statusDotClass(status) {
  if (status === "downloading" || status === "starting" || status === "cancelling") return "downloading";
  if (status === "done") return "done";
  if (status === "error") return "error";
  if (status === "cancelled") return "cancelled";
  return "";
}

function renderTabs() {
  tabStrip.innerHTML = "";
  for (const job of jobs) {
    const tab = document.createElement("div");
    tab.className = "tab" + (job.localId === activeLocalId ? " active" : "");

    const dot = document.createElement("span");
    dot.className = "status-dot " + statusDotClass(job.status);
    tab.appendChild(dot);

    const displayName = job.filename || job.label;
    const label = document.createElement("span");
    label.textContent =
      job.status === "downloading" && job.progress
        ? `${displayName} (${job.progress.toFixed(0)}%)`
        : displayName;
    tab.appendChild(label);

    const close = document.createElement("span");
    close.className = "close-x";
    close.textContent = "×";
    close.title = "Close tab";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeJob(job.localId);
    });
    tab.appendChild(close);

    tab.addEventListener("click", () => selectJob(job.localId));
    tabStrip.appendChild(tab);
  }
  stopAllBtn.disabled = !jobs.some((j) => ACTIVE_STATUSES.has(j.status));
}

function loadJobIntoForm() {
  const job = getActiveJob();
  if (!job) return;

  urlInput.value = job.url;
  videoTitleEl.textContent = job.videoTitle || "";
  startInput.value = job.start;
  endInput.value = job.end;
  filenameInput.value = job.filename;
  qualitySelect.value = job.quality;

  const isActive = ACTIVE_STATUSES.has(job.status);
  cropButton.disabled = isActive;
  cropButton.style.display = isActive ? "none" : "block";
  cancelButton.style.display = isActive ? "block" : "none";
  saveAsButton.style.display = job.status === "done" ? "block" : "none";

  if (job.status === "idle") {
    setProgress(null);
    setStatus("");
  } else if (job.status === "error") {
    setProgress(null);
    setStatus(`Error:\n${job.error}`);
  } else if (job.status === "cancelled") {
    setProgress(null);
    setStatus("Job cancelled.");
  } else if (job.status === "done") {
    setProgress(100);
    setStatus(`Done! Saved to:\n${job.outputPath}`);
  } else {
    setProgress(job.progress);
    const percent = job.progress ? ` (${job.progress.toFixed(0)}%)` : "";
    setStatus(`${job.stage || "Working..."}${percent}\nThis can take a while for long or high-quality clips.`);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(percent) {
  if (percent === null) {
    progressTrack.classList.remove("visible");
    return;
  }
  progressTrack.classList.add("visible");
  progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "";
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseTime(value) {
  value = (value || "").trim();
  if (!value) return NaN;
  if (value.includes(":")) {
    // Accepts hh:mm:ss, mm:ss, or a bare seconds value.
    const parts = value.split(":").map(Number);
    if (parts.length > 3 || parts.some((p) => Number.isNaN(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  return Number(value);
}

async function checkServerHealth() {
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    serverDot.className = res.ok ? "dot ok" : "dot down";
  } catch {
    serverDot.className = "dot down";
  }
}

async function getActiveTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("youtube.com/watch")) {
    return null;
  }
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "GET_VIDEO_INFO" }, (response) => {
      resolve(chrome.runtime.lastError ? null : response || null);
    });
  });
}

async function refreshFromActiveTab() {
  const info = await getActiveTabInfo();
  const job = getActiveJob();
  // Only auto-fill a job that hasn't been started yet, so we never clobber
  // a running or finished job's inputs by switching YouTube tabs.
  if (!job || job.status !== "idle" || !info) return;

  job.url = info.url;
  job.videoTitle = info.title || "";
  const formattedDuration = formatTime(info.duration);
  if (formattedDuration && !job.end) {
    job.end = formattedDuration;
  }
  loadJobIntoForm();
}

document.getElementById("useCurrent").addEventListener("click", async () => {
  const info = await getActiveTabInfo();
  if (info) {
    startInput.value = formatTime(info.currentTime);
    saveFormIntoActiveJob();
  }
});

newTabBtn.addEventListener("click", async () => {
  const info = await getActiveTabInfo();
  const job = createJob(
    info ? { url: info.url, title: info.title, duration: formatTime(info.duration) } : null
  );
  selectJob(job.localId);
});

cropButton.addEventListener("click", async () => {
  saveFormIntoActiveJob();
  const job = getActiveJob();
  if (!job) return;

  const start = parseTime(job.start);
  const end = parseTime(job.end);

  if (!job.url) {
    setStatus("Enter or detect a YouTube URL first.");
    return;
  }
  if (Number.isNaN(start) || Number.isNaN(end)) {
    setStatus("Enter valid Start/End times (seconds, mm:ss, or hh:mm:ss).");
    return;
  }
  if (end <= start) {
    setStatus("End time must be after start time.");
    return;
  }

  job.status = "starting";
  job.progress = 0;
  job.error = null;
  renderTabs();
  loadJobIntoForm();
  setStatus("Sending job to local cropper server...");

  let res;
  try {
    res = await fetch(`${SERVER_URL}/crop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: job.url, start, end, quality: job.quality, filename: job.filename })
    });
  } catch (err) {
    job.status = "error";
    job.error =
      `Could not reach the local cropper server.\n` +
      `Make sure it is running (node server.js in the YouTubeCropper/server folder).\n\n` +
      `Error: ${err.message}`;
    renderTabs();
    loadJobIntoForm();
    return;
  }

  if (!res.ok) {
    const text = await res.text();
    job.status = "error";
    job.error = text || `Server responded with status ${res.status}`;
    renderTabs();
    loadJobIntoForm();
    return;
  }

  const { jobId } = await res.json();
  job.jobId = jobId;
  renderTabs();
  loadJobIntoForm();
  pollJob(job.localId);
});

cancelButton.addEventListener("click", async () => {
  const job = getActiveJob();
  if (!job || !job.jobId) return;
  try {
    await fetch(`${SERVER_URL}/cancel/${job.jobId}`, { method: "POST" });
  } catch {
    // Server may already be gone; the poll loop will surface a connection error.
  }
});

stopAllBtn.addEventListener("click", async () => {
  try {
    await fetch(`${SERVER_URL}/cancel-all`, { method: "POST" });
  } catch (err) {
    setStatus(`Could not reach the server to stop jobs.\nError: ${err.message}`);
  }
});

saveAsButton.addEventListener("click", () => {
  const job = getActiveJob();
  if (!job || !job.jobId || job.status !== "done") return;
  const base = job.filename || job.videoTitle || "clip";
  const suggestedName = base.replace(/[\\/:*?"<>|]/g, "_") + ".mp4";
  chrome.downloads.download({
    url: `${SERVER_URL}/file/${job.jobId}`,
    filename: suggestedName,
    saveAs: true
  });
});

function closeJob(localId) {
  const job = jobs.find((j) => j.localId === localId);
  if (!job) return;

  if (ACTIVE_STATUSES.has(job.status) && job.jobId) {
    fetch(`${SERVER_URL}/cancel/${job.jobId}`, { method: "POST" }).catch(() => {});
  }

  jobs = jobs.filter((j) => j.localId !== localId);

  if (jobs.length === 0) {
    const newJob = createJob(null);
    activeLocalId = newJob.localId;
  } else if (activeLocalId === localId) {
    activeLocalId = jobs[jobs.length - 1].localId;
  }

  renderTabs();
  loadJobIntoForm();
}

function pollJob(localId) {
  const poll = async () => {
    const job = jobs.find((j) => j.localId === localId);
    if (!job || !job.jobId) return; // tab closed or reset

    let res;
    try {
      res = await fetch(`${SERVER_URL}/status/${job.jobId}`);
    } catch (err) {
      job.status = "error";
      job.error = `Lost connection to the local server while downloading.\nError: ${err.message}`;
      renderTabs();
      if (activeLocalId === localId) loadJobIntoForm();
      return;
    }

    if (!res.ok) {
      job.status = "error";
      job.error = `Server lost track of this job (status ${res.status}).`;
      renderTabs();
      if (activeLocalId === localId) loadJobIntoForm();
      return;
    }

    const serverJob = await res.json();
    job.status = serverJob.status;
    job.progress = serverJob.progress || 0;
    job.stage = serverJob.stage;
    job.error = serverJob.error;
    job.outputPath = serverJob.outputPath;

    renderTabs();
    if (activeLocalId === localId) loadJobIntoForm();

    if (ACTIVE_STATUSES.has(job.status)) {
      setTimeout(poll, 1200);
    }
  };

  poll();
}

chrome.tabs.onActivated.addListener(refreshFromActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") refreshFromActiveTab();
});

(async function init() {
  const info = await getActiveTabInfo();
  const job = createJob(
    info ? { url: info.url, title: info.title, duration: formatTime(info.duration) } : null
  );
  activeLocalId = job.localId;
  renderTabs();
  loadJobIntoForm();
  checkServerHealth();
  setInterval(checkServerHealth, 5000);
})();
