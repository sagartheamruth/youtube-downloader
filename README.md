# YouTube Downloader

A minimal local web app for downloading YouTube videos as MP4 or MP3.

## Requirements

- Node.js 18+
- `yt-dlp`
- `ffmpeg` for MP3 conversion and high-quality MP4 merging

On macOS with Homebrew:

```sh
brew install yt-dlp ffmpeg
```

## Run

```sh
npm start
```

Then open:

```txt
http://localhost:3000
```

Downloads are saved in `youtube downloads/`.

## Render

The repo includes a Dockerfile for Render. It installs `yt-dlp` and `ffmpeg`, starts the Node server, and exposes a browser download button when each job finishes.
