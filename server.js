const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { randomUUID } = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DOWNLOAD_DIR = path.join(ROOT, "youtube downloads");
const CACHE_DIR = path.join(ROOT, ".cache", "yt-dlp");
const LOCAL_YTDLP = path.join(ROOT, ".venv", "bin", "yt-dlp");
const LOCAL_PYTHON = path.join(ROOT, ".venv", "bin", "python");
const PREMIERE_SUFFIX = " - Premiere Ready";

const jobs = new Map();
const hiddenLogPatterns = [
  /^Deprecated Feature: Support for Python version 3\.9 has been deprecated/
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function hasCommand(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore"
  });
  return result.status === 0;
}

function commandPath(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function getYtDlpPath() {
  if (fs.existsSync(LOCAL_YTDLP)) return LOCAL_YTDLP;
  return commandPath("yt-dlp");
}

function getFfmpegPath() {
  const systemFfmpeg = commandPath("ffmpeg");
  if (systemFfmpeg) return systemFfmpeg;
  if (!fs.existsSync(LOCAL_PYTHON)) return null;

  const result = spawnSync(
    LOCAL_PYTHON,
    ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],
    { encoding: "utf8" }
  );

  return result.status === 0 ? result.stdout.trim() : null;
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function isValidYoutubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host);
  } catch {
    return false;
  }
}

function qualityLabel(height) {
  if (height === "best") return "Best available";
  if (height === "2160") return "4K / 2160p";
  return `${height}p`;
}

function parseTime(value) {
  const parts = String(value || "").trim().split(":").map(part => Number(part));
  if (!parts.length || parts.some(part => Number.isNaN(part) || part < 0)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function timeLabel(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
  return `${String(minutes).padStart(2, "0")}:${rest}`;
}

function clipFromPayload(payload) {
  if (!payload.clipEnabled) return null;

  const start = parseTime(payload.startTime);
  const end = parseTime(payload.endTime);

  if (start === null || end === null) throw new Error("Enter valid clip times, like 00:00 and 00:20.");
  if (end <= start) throw new Error("Clip end time must be after the start time.");

  return { start, end };
}

function clipSlug(clip) {
  if (!clip) return "";
  return ` [clip ${timeLabel(clip.start).replace(/:/g, "-")}-${timeLabel(clip.end).replace(/:/g, "-")}]`;
}

function buildYtDlpArgs({ url, type, quality, clip }) {
  const output = path.join(DOWNLOAD_DIR, `%(title).180B [%(id)s]${clipSlug(clip)}.%(ext)s`);
  const ffmpegPath = getFfmpegPath();
  const ffmpegArgs = ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : [];
  const clipArgs = clip
    ? ["--download-sections", `*${timeLabel(clip.start)}-${timeLabel(clip.end)}`, "--force-keyframes-at-cuts"]
    : [];
  const commonArgs = [
    "--no-playlist",
    "--cache-dir",
    CACHE_DIR,
    "--extractor-args",
    "youtube:player_client=android_vr",
    "--force-ipv4",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    ...clipArgs
  ];

  if (type === "mp3") {
    return [
      ...ffmpegArgs,
      ...commonArgs,
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-o",
      output,
      url
    ];
  }

  const format =
    quality === "best"
      ? "bv*+ba/b"
      : `bv*[height=${quality}]+ba/b[height=${quality}]`;

  return [
    ...ffmpegArgs,
    ...commonArgs,
    "-f",
    format,
    "--merge-output-format",
    "mp4",
    "--print",
    "after_move:filepath",
    "-o",
    output,
    url
  ];
}

function appendJobLog(job, lines) {
  job.log.push(...lines);
  job.log = job.log.slice(-80);
}

function getMediaInfo(filePath) {
  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath || !filePath || !fs.existsSync(filePath)) return null;

  const result = spawnSync(ffmpegPath, ["-hide_banner", "-i", filePath], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const videoLine = output.split(/\r?\n/).find(line => line.includes("Video:"));
  const audioLine = output.split(/\r?\n/).find(line => line.includes("Audio:"));
  const dimensions = videoLine ? videoLine.match(/,\s*(\d{3,5})x(\d{3,5})[\s,\[]/) : null;
  const codec = videoLine ? videoLine.match(/Video:\s*([^,\s]+)/) : null;

  return {
    width: dimensions ? Number(dimensions[1]) : null,
    height: dimensions ? Number(dimensions[2]) : null,
    videoCodec: codec ? codec[1] : null,
    videoLine,
    audioLine
  };
}

function premiereReadyPath(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${PREMIERE_SUFFIX}.mp4`);
}

function convertToPremiereMp4(job, inputPath) {
  return new Promise(resolve => {
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath || !inputPath || !fs.existsSync(inputPath)) {
      appendJobLog(job, ["Could not find the downloaded MP4 for Premiere conversion."]);
      resolve(false);
      return;
    }

    const inputInfo = getMediaInfo(inputPath);
    const outputPath = premiereReadyPath(inputPath);
    const tempOutputPath = `${outputPath}.part.mp4`;

    try {
      fs.rmSync(tempOutputPath, { force: true });
    } catch {}

    appendJobLog(job, [
      `Source verified: ${inputInfo?.width || "?"}x${inputInfo?.height || "?"} ${inputInfo?.videoCodec || "video"}`,
      "Converting to Premiere-ready H.264 + AAC MP4..."
    ]);

    const child = spawn(
      ffmpegPath,
      [
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "avc1",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        tempOutputPath
      ],
      { cwd: ROOT }
    );

    child.stderr.on("data", chunk => {
      const lines = chunk
        .toString()
        .split(/\r?\n/)
        .filter(line => /frame=|time=|bitrate=|speed=|video:|muxing overhead/.test(line))
        .slice(-3);
      if (lines.length) appendJobLog(job, lines);
    });

    child.on("error", error => {
      appendJobLog(job, [`Premiere conversion failed: ${error.message}`]);
      resolve(false);
    });

    child.on("close", code => {
      if (code === 0) {
        const outputInfo = getMediaInfo(tempOutputPath);
        if (
          inputInfo?.width &&
          inputInfo?.height &&
          (outputInfo?.width !== inputInfo.width || outputInfo?.height !== inputInfo.height)
        ) {
          appendJobLog(job, [
            `Premiere conversion changed resolution to ${outputInfo?.width || "?"}x${outputInfo?.height || "?"}. Keeping the source file instead.`
          ]);
          try {
            fs.rmSync(tempOutputPath, { force: true });
          } catch {}
          resolve(false);
          return;
        }

        fs.renameSync(tempOutputPath, outputPath);
        appendJobLog(job, [
          `Premiere-ready verified: ${outputInfo?.width || "?"}x${outputInfo?.height || "?"} H.264 + AAC`,
          `Premiere-ready file saved: ${outputPath}`
        ]);
        resolve(true);
      } else {
        try {
          fs.rmSync(tempOutputPath, { force: true });
        } catch {}
        appendJobLog(job, [`Premiere conversion failed with exit code ${code}.`]);
        resolve(false);
      }
    });
  });
}

function safeFormats(formats = []) {
  const mp4Heights = new Set();
  let hasAudio = false;

  for (const format of formats) {
    if (format.vcodec && format.vcodec !== "none" && format.height) mp4Heights.add(format.height);
    if (format.acodec && format.acodec !== "none") hasAudio = true;
  }

  return {
    mp3: hasAudio,
    mp4: [...mp4Heights].sort((a, b) => b - a).map(height => ({
      height,
      label: qualityLabel(String(height))
    }))
  };
}

function startDownload(payload) {
  const ytdlpPath = getYtDlpPath();
  if (!ytdlpPath) {
    throw new Error("yt-dlp is not installed. Install it first, then try again.");
  }

  const type = payload.type === "mp3" ? "mp3" : "mp4";
  const quality = String(payload.quality || "best");
  const clip = clipFromPayload(payload);
  const allowedQualities = new Set(["best", "2160", "1440", "1080", "720", "480", "360"]);

  if (!isValidYoutubeUrl(payload.url)) throw new Error("Enter a valid YouTube URL.");
  if (type === "mp4" && !allowedQualities.has(quality)) throw new Error("Pick a valid MP4 resolution.");
  if (type === "mp3" && !getFfmpegPath()) {
    throw new Error("ffmpeg is required for MP3 downloads. Install it first, then try again.");
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const id = randomUUID();
  const job = {
    id,
    type,
    quality,
    status: "running",
    log: [
      `Starting ${type.toUpperCase()} download${type === "mp4" ? ` at ${qualityLabel(quality)}` : ""}...`,
      ...(clip ? [`Clip range: ${timeLabel(clip.start)} - ${timeLabel(clip.end)}`] : [])
    ],
    createdAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    filePath: null,
    premiereFilePath: null
  };
  jobs.set(id, job);

  const child = spawn(ytdlpPath, buildYtDlpArgs({ url: payload.url, type, quality, clip }), {
    cwd: ROOT
  });

  const appendLog = chunk => {
    const lines = chunk
      .toString()
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !hiddenLogPatterns.some(pattern => pattern.test(line)));
    for (const line of lines) {
      if (type === "mp4" && path.isAbsolute(line.trim()) && line.trim().endsWith(".mp4")) {
        job.filePath = line.trim();
      }
    }
    appendJobLog(job, lines.slice(-20));
  };

  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  child.on("error", error => {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.log.push(error.message);
  });
  child.on("close", async code => {
    job.exitCode = code;
    if (code === 0 && type === "mp4") {
      job.status = "converting";
      const converted = await convertToPremiereMp4(job, job.filePath);
      job.premiereFilePath = converted ? premiereReadyPath(job.filePath) : null;
      job.status = converted ? "complete" : "failed";
      job.finishedAt = new Date().toISOString();
      appendJobLog(
        job,
        converted
          ? ["Done. Use the Premiere-ready MP4 for editing."]
          : ["Download finished, but the Premiere conversion failed."]
      );
      return;
    }

    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? "complete" : "failed";
    appendJobLog(job, [code === 0 ? `Saved to ${DOWNLOAD_DIR}` : `Download failed with exit code ${code}.`]);
  });

  return job;
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/status" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      tools: {
        ytdlp: Boolean(getYtDlpPath()),
        ffmpeg: Boolean(getFfmpegPath())
      },
      downloadDir: DOWNLOAD_DIR
    });
  }

  if (pathname === "/api/metadata" && req.method === "POST") {
    const ytdlpPath = getYtDlpPath();
    if (!ytdlpPath) {
      return sendJson(res, 412, { error: "yt-dlp is not installed." });
    }

    const body = await readBody(req);
    if (!isValidYoutubeUrl(body.url)) {
      return sendJson(res, 400, { error: "Enter a valid YouTube URL." });
    }

    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const result = spawnSync(
      ytdlpPath,
      [
        "--no-playlist",
        "--cache-dir",
        CACHE_DIR,
        "--extractor-args",
        "youtube:player_client=android_vr",
        "--force-ipv4",
        "--dump-single-json",
        body.url
      ],
      {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024
      }
    );

    if (result.status !== 0) {
      return sendJson(res, 500, { error: result.stderr.trim() || "Could not read video info." });
    }

    const info = JSON.parse(result.stdout);
    return sendJson(res, 200, {
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail,
      formats: safeFormats(info.formats)
    });
  }

  if (pathname === "/api/download" && req.method === "POST") {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, { job: startDownload(body) });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Job not found." });
    return sendJson(res, 200, { job });
  }

  sendJson(res, 404, { error: "Not found." });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store, max-age=0"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`YouTube downloader running at http://${HOST}:${PORT}`);
});
