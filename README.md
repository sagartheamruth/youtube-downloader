# Video Downloader

A minimal local web app for downloading YouTube, public Instagram, X, and yt-dlp supported video links as MP4 or MP3.

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

Instagram and X support work best with public posts that contain video. The Any Link tab uses yt-dlp's supported sites, so DRM, private, or login-gated links can fail unless yt-dlp is configured with the right account access.

## YouTube bot checks

YouTube can block hosted servers with "Sign in to confirm you're not a bot." The app supports optional yt-dlp cookies:

- Render password gate: set `APP_PASSWORD` so the hosted downloader is not public.
- Render: set `YTDLP_COOKIES_BASE64` to a base64-encoded Netscape cookies export.
- Local Mac: run with `YTDLP_COOKIES_FROM_BROWSER=chrome npm start`, or place a `cookies.txt` file in the project root.

Treat cookies like a password. Do not commit them.

## Render

The repo includes a Dockerfile for Render. It installs `yt-dlp` and `ffmpeg`, starts the Node server, and exposes a browser download button when each job finishes.
