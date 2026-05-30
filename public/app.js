const form = document.querySelector("#downloadForm");
const urlInput = document.querySelector("#url");
const typeInput = document.querySelector("#type");
const qualityField = document.querySelector("#qualityField");
const qualityInput = document.querySelector("#quality");
const infoButton = document.querySelector("#infoButton");
const toolStatus = document.querySelector("#toolStatus");
const downloadLink = document.querySelector("#downloadLink");
const videoCard = document.querySelector("#videoCard");
const log = document.querySelector("#log");
const clipEnabled = document.querySelector("#clipEnabled");
const clipControls = document.querySelector("#clipControls");
const startTimeInput = document.querySelector("#startTime");
const endTimeInput = document.querySelector("#endTime");
const startRange = document.querySelector("#startRange");
const endRange = document.querySelector("#endRange");
const rangeFill = document.querySelector("#rangeFill");
const clipHint = document.querySelector("#clipHint");
const rangeWrap = document.querySelector(".range-wrap");
const hoverMarker = document.querySelector("#hoverMarker");

let activeTimer = null;
let videoDuration = 120;

function setLog(lines) {
  const text = Array.isArray(lines) ? lines.join("\n") : lines;
  log.textContent = text;
  log.classList.toggle("hidden", !text.trim());
  log.scrollTop = log.scrollHeight;
}

function setNotice(message, level = "muted") {
  toolStatus.className = `notice ${level}`;
  toolStatus.textContent = message;
}

function setDownloadLink(url) {
  downloadLink.classList.toggle("hidden", !url);
  if (url) {
    downloadLink.href = url;
    downloadLink.textContent = "Download file";
  } else {
    downloadLink.removeAttribute("href");
  }
}

function durationLabel(seconds) {
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function parseTime(value) {
  const parts = String(value).trim().split(":").map(part => Number(part));
  if (parts.some(part => Number.isNaN(part) || part < 0)) return null;
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

function clampClip(start, end) {
  const max = Math.max(1, videoDuration);
  const safeStart = Math.min(Math.max(0, Math.round(start)), max - 1);
  const safeEnd = Math.min(Math.max(safeStart + 1, Math.round(end)), max);
  return [safeStart, safeEnd];
}

function setClipDuration(duration) {
  videoDuration = Math.max(1, Math.round(duration || 120));
  startRange.max = String(videoDuration);
  endRange.max = String(videoDuration);

  const [start, end] = clampClip(Number(startRange.value), Number(endRange.value));
  startRange.value = String(start);
  endRange.value = String(end);
  updateClipUi({ fromRange: true });
}

function updateClipUi({ fromRange = false } = {}) {
  let start = fromRange ? Number(startRange.value) : parseTime(startTimeInput.value);
  let end = fromRange ? Number(endRange.value) : parseTime(endTimeInput.value);

  if (start === null) start = Number(startRange.value);
  if (end === null) end = Number(endRange.value);

  [start, end] = clampClip(start, end);
  startRange.value = String(start);
  endRange.value = String(end);
  startTimeInput.value = timeLabel(start);
  endTimeInput.value = timeLabel(end);

  const left = (start / videoDuration) * 100;
  const right = 100 - (end / videoDuration) * 100;
  rangeFill.style.left = `${left}%`;
  rangeFill.style.right = `${right}%`;
  clipHint.textContent = `Selected: ${timeLabel(start)} - ${timeLabel(end)}`;
  rangeWrap.title = `Selected: ${timeLabel(start)} - ${timeLabel(end)}`;
}

function updateHoverTime(event) {
  const rect = rangeWrap.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const seconds = Math.round(pct * videoDuration);
  hoverMarker.style.left = `${pct * 100}%`;
  hoverMarker.classList.remove("hidden");
  clipHint.textContent = `Hover: ${timeLabel(seconds)} | Selected: ${timeLabel(Number(startRange.value))} - ${timeLabel(Number(endRange.value))}`;
}

function clearHoverTime() {
  hoverMarker.classList.add("hidden");
  updateClipUi({ fromRange: true });
}

async function postJson(path, data) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Something went wrong.");
  return body;
}

async function refreshStatus() {
  const response = await fetch("/api/status");
  const data = await response.json();
  const missing = [];

  if (!data.tools.ytdlp) missing.push("yt-dlp");
  if (!data.tools.ffmpeg) missing.push("ffmpeg");

  if (missing.length) {
    setNotice(`Missing ${missing.join(" and ")}. Install them to enable downloads.`, "warn");
  } else {
    setNotice(`Ready. Files will save to ${data.downloadDir}`, "ok");
  }
}

function syncFormatFields() {
  qualityField.classList.toggle("hidden", typeInput.value === "mp3");
}

function syncClipControls() {
  clipControls.classList.toggle("hidden", !clipEnabled.checked);
  updateClipUi({ fromRange: true });
}

async function checkVideo() {
  videoCard.classList.add("hidden");
  setDownloadLink(null);
  setLog("Reading video info...");

  try {
    const data = await postJson("/api/metadata", { url: urlInput.value.trim() });
    setClipDuration(data.duration || 120);
    const mp4Options = data.formats.mp4.length
      ? data.formats.mp4.map(format => format.label).join(", ")
      : "Best available";

    videoCard.innerHTML = `
      ${data.thumbnail ? `<img src="${data.thumbnail}" alt="">` : ""}
      <div>
        <h2>${data.title || "Untitled video"}</h2>
        <p>${[data.uploader, durationLabel(data.duration)].filter(Boolean).join(" · ")}</p>
        <p>MP4: ${mp4Options}</p>
        <p>MP3: ${data.formats.mp3 ? "Available" : "Not found"}</p>
      </div>
    `;
    videoCard.classList.remove("hidden");
    setLog("Video info loaded.");
  } catch (error) {
    setLog(error.message);
  }
}

async function pollJob(id) {
  clearInterval(activeTimer);

  activeTimer = setInterval(async () => {
    const response = await fetch(`/api/jobs/${id}`);
    const data = await response.json();
    if (!response.ok) {
      clearInterval(activeTimer);
      setLog(data.error || "Could not find download job.");
      setDownloadLink(null);
      return;
    }

    setLog(data.job.log);
    setDownloadLink(data.job.downloadUrl);
    if (!["running", "converting"].includes(data.job.status)) {
      clearInterval(activeTimer);
      await refreshStatus();
    }
  }, 1000);
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  setDownloadLink(null);
  setLog("Preparing download...");

  try {
    const data = await postJson("/api/download", {
      url: urlInput.value.trim(),
      type: typeInput.value,
      quality: qualityInput.value,
      clipEnabled: clipEnabled.checked,
      startTime: startTimeInput.value,
      endTime: endTimeInput.value
    });
    setLog(data.job.log);
    setDownloadLink(data.job.downloadUrl);
    pollJob(data.job.id);
  } catch (error) {
    setDownloadLink(null);
    setLog(error.message);
  }
});

infoButton.addEventListener("click", checkVideo);
typeInput.addEventListener("change", syncFormatFields);
clipEnabled.addEventListener("change", syncClipControls);
startRange.addEventListener("input", () => updateClipUi({ fromRange: true }));
endRange.addEventListener("input", () => updateClipUi({ fromRange: true }));
startTimeInput.addEventListener("change", () => updateClipUi());
endTimeInput.addEventListener("change", () => updateClipUi());
rangeWrap.addEventListener("mousemove", updateHoverTime);
rangeWrap.addEventListener("mouseleave", clearHoverTime);

syncFormatFields();
syncClipControls();
refreshStatus();
