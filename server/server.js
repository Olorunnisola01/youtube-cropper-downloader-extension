const express = require("express");
const cors = require("cors");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 8783;
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "YouTubeCropper", "downloads");

// Fallback paths in case a tool's install location isn't on the PATH the
// server process actually inherited (e.g. when auto-started at login with a
// stale environment snapshot from before the tool was installed).
const YTDLP_FALLBACK = path.join(
  os.homedir(),
  "AppData", "Roaming", "Python", "Python314", "Scripts", "yt-dlp.exe"
);

const FFMPEG_FALLBACKS = [
  "C:\\tools\\ffmpeg_extracted\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe",
  path.join(
    os.homedir(),
    "AppData", "Local", "Microsoft", "WinGet", "Packages",
    "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "ffmpeg-8.1.2-full_build", "bin", "ffmpeg.exe"
  )
];

// Deno lets yt-dlp run YouTube's player JS to solve signature/format
// extraction. Without it, yt-dlp falls back to a slower degraded extraction
// path — pointing at it directly avoids depending on PATH (which can be
// stale for a process auto-started before Deno was installed).
const DENO_FALLBACK = path.join(
  os.homedir(),
  "AppData", "Local", "Microsoft", "WinGet", "Packages",
  "DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "deno.exe"
);

let ytDlpCmd = "yt-dlp";
let ffmpegCmd = "ffmpeg";
let denoPath = null;

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// In-memory job tracker. Each job runs fully independently (its own yt-dlp
// process), so multiple crops can proceed in parallel without interfering
// with each other. The side panel polls /status/:jobId per job and can
// cancel any job individually or all at once.
const jobs = new Map();

function checkTool(cmd, versionFlag) {
  return new Promise((resolve) => {
    execFile(cmd, [versionFlag], (err) => resolve(!err));
  });
}

async function resolveYtDlp() {
  if (await checkTool("yt-dlp", "--version")) {
    return "yt-dlp";
  }
  if (fs.existsSync(YTDLP_FALLBACK) && (await checkTool(YTDLP_FALLBACK, "--version"))) {
    return YTDLP_FALLBACK;
  }
  return null;
}

async function resolveFfmpeg() {
  // ffmpeg uses a single-dash "-version" flag, not "--version".
  if (await checkTool("ffmpeg", "-version")) {
    return "ffmpeg";
  }
  for (const candidate of FFMPEG_FALLBACKS) {
    if (fs.existsSync(candidate) && (await checkTool(candidate, "-version"))) {
      return candidate;
    }
  }
  return null;
}

async function resolveDeno() {
  if (await checkTool("deno", "--version")) {
    return "deno"; // on PATH; yt-dlp can find it there without a hint
  }
  if (fs.existsSync(DENO_FALLBACK) && (await checkTool(DENO_FALLBACK, "--version"))) {
    return DENO_FALLBACK;
  }
  return null; // yt-dlp will fall back to its slower degraded extraction path
}

function formatForQuality(quality) {
  if (quality === "best") {
    return "bestvideo+bestaudio/best";
  }
  const height = Number(quality);
  return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 120);
}

function buildOutputPath(jobId, requestedName) {
  const base = requestedName ? sanitizeFilename(requestedName) : "";
  let outputName = base ? `${base}.mp4` : `clip_${jobId}.mp4`;
  let outputPath = path.join(OUTPUT_DIR, outputName);

  // Avoid clobbering an existing file if the user's chosen name collides
  // with a previous clip.
  if (base && fs.existsSync(outputPath)) {
    outputName = `${base}_${jobId}.mp4`;
    outputPath = path.join(OUTPUT_DIR, outputName);
  }

  return outputPath;
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

function cleanupPartialFiles(outputPath) {
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath);
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(base)) {
      fs.unlink(path.join(dir, f), () => {});
    }
  }
}

const ACTIVE_STATUSES = new Set(["starting", "downloading"]);

function runJob(jobId, { url, start, end, quality, filename }) {
  const job = jobs.get(jobId);
  const outputPath = buildOutputPath(jobId, filename);
  job.outputPath = outputPath;

  // --download-sections fetches only the requested time range instead of the
  // whole video. YouTube serves these as single continuous byte-range URLs,
  // so yt-dlp extracts the range via ffmpeg over one HTTP connection — true
  // multi-connection (aria2c/IDM-style) splitting isn't available here since
  // that requires downloading the whole track, which we deliberately avoid.
  // -reconnect flags mean a dropped connection resumes instead of restarting
  // the whole clip from scratch.
  const ytDlpArgs = [
    "--no-plugin-dirs",
    "--newline",
    "-f", formatForQuality(quality || "best"),
    "--merge-output-format", "mp4",
    "--download-sections", `*${start}-${end}`,
    "--force-keyframes-at-cuts",
    "--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5"
  ];

  if (denoPath) {
    ytDlpArgs.push("--js-runtimes", `deno:${denoPath}`);
  }

  ytDlpArgs.push("-o", outputPath, url);

  console.log(`[${jobId}] Running yt-dlp:`, ytDlpCmd, ytDlpArgs.join(" "));
  job.status = "downloading";
  job.stage = "Downloading clip from YouTube...";

  const ytDlp = spawn(ytDlpCmd, ytDlpArgs);
  job.pid = ytDlp.pid;
  job.process = ytDlp;
  let log = "";

  const handleOutput = (chunk) => {
    const text = chunk.toString();
    log += text;
    const match = text.match(/\[download\]\s+([\d.]+)%/);
    if (match) {
      job.progress = Number(match[1]);
    }
    if (/\[Merger\]|Merging formats/.test(text)) {
      job.stage = "Merging video and audio...";
    }
    if (/\[VideoRemuxer\]|\[ffmpeg\]/.test(text)) {
      job.stage = "Finalizing clip...";
    }
  };

  ytDlp.stdout.on("data", handleOutput);
  ytDlp.stderr.on("data", handleOutput);

  ytDlp.on("close", (code) => {
    job.process = null;

    if (job.status === "cancelling") {
      job.status = "cancelled";
      job.stage = "Cancelled";
      cleanupPartialFiles(outputPath);
      return;
    }

    if (code !== 0 || !fs.existsSync(outputPath)) {
      job.status = "error";
      job.error = `yt-dlp failed:\n${log.slice(-4000)}`;
      cleanupPartialFiles(outputPath);
      return;
    }

    job.status = "done";
    job.progress = 100;
    job.stage = "Done";
  });
}

app.post("/crop", async (req, res) => {
  const { url, start, end, quality, filename } = req.body || {};

  if (!url || typeof start !== "number" || typeof end !== "number" || end <= start) {
    return res.status(400).send("Invalid request: url, start, end are required and end must be > start.");
  }

  const resolvedYtDlp = await resolveYtDlp();
  const resolvedFfmpeg = await resolveFfmpeg();
  if (!resolvedYtDlp || !resolvedFfmpeg) {
    return res.status(500).send(
      `Missing required tool(s): ${!resolvedYtDlp ? "yt-dlp " : ""}${!resolvedFfmpeg ? "ffmpeg" : ""}. ` +
      `Install them and make sure they are on your PATH (see README.md).`
    );
  }
  ytDlpCmd = resolvedYtDlp;
  ffmpegCmd = resolvedFfmpeg;
  denoPath = await resolveDeno(); // optional — null just means slower extraction

  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  jobs.set(jobId, {
    status: "starting",
    progress: 0,
    stage: "Starting...",
    outputPath: null,
    error: null,
    pid: null,
    process: null
  });

  res.json({ jobId });

  runJob(jobId, { url, start, end, quality, filename });
});

app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Unknown job id" });
  }
  const { process: _proc, ...safeJob } = job;
  res.json(safeJob);
});

app.post("/cancel/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Unknown job id" });
  }
  if (!ACTIVE_STATUSES.has(job.status)) {
    return res.json({ ok: true, message: "Job was not active." });
  }
  job.status = "cancelling";
  job.stage = "Cancelling...";
  if (job.pid) {
    await killProcessTree(job.pid);
  }
  res.json({ ok: true });
});

app.post("/cancel-all", async (req, res) => {
  const cancelled = [];
  for (const [jobId, job] of jobs.entries()) {
    if (ACTIVE_STATUSES.has(job.status)) {
      job.status = "cancelling";
      job.stage = "Cancelling...";
      if (job.pid) {
        await killProcessTree(job.pid);
      }
      cancelled.push(jobId);
    }
  }
  res.json({ ok: true, cancelled });
});

app.get("/file/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done" || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).send("File not available.");
  }
  res.download(job.outputPath);
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`YouTube Cropper server listening on http://127.0.0.1:${PORT}`);
  console.log(`Downloads will be saved to: ${OUTPUT_DIR}`);
});
