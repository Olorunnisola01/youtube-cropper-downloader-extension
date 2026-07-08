# YouTube Cropper

A Chrome extension + local companion server that lets you trim a YouTube video to a start/end range and download the cropped clip at the highest available quality.

Chrome extensions can't run `ffmpeg`/`yt-dlp` themselves (sandboxed, no filesystem/process access), so the extension is just the UI: it sends your chosen URL + time range to a small local server, which does the actual download and crop.

## 1. Install prerequisites

You need two command-line tools on your PATH:

- **yt-dlp** — downloads the video/audio streams: https://github.com/yt-dlp/yt-dlp#installation
  - Easiest on Windows: `winget install yt-dlp` or `pip install -U yt-dlp`
- **ffmpeg** — merges streams and trims the clip: https://www.gyan.dev/ffmpeg/builds/ (Windows builds) or `winget install ffmpeg`

Verify both work from a terminal:

```
yt-dlp --version
ffmpeg -version
```

## 2. Run the local server

```
cd YouTubeCropper/server
npm install
npm start
```

It listens on `http://127.0.0.1:8783` and must stay running whenever you use the extension. Cropped clips are saved to `YouTubeCropper/downloads`.

### Auto-start at login (no terminal needed)

A shortcut has already been added to your Windows Startup folder
(`shell:startup` → `YouTubeCropperServer.lnk`) that runs
`server/start-hidden.vbs` at login. This launches `node server.js` with no
visible console window — logs go to `server/server.log` instead.

- To start it right now without rebooting, double-click `start-hidden.vbs`.
- To check it's running: visit `http://127.0.0.1:8783/health` in a browser, or run
  `Get-Content server\server.log -Tail 20` in PowerShell.
- To stop it: `taskkill /F /IM node.exe` (this kills all Node processes).
- To remove auto-start: delete the shortcut at
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\YouTubeCropperServer.lnk`.

## 3. Load the Chrome extension

1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `YouTubeCropper/extension` folder

## 4. Use it

1. Open a YouTube video in Chrome.
2. Click the YouTube Cropper icon in the toolbar — it opens a **side panel** docked to the browser window (not a popup), so it stays open while you browse and switch tabs/videos.
3. The dot next to the title shows server health: green = reachable, red = not running.
4. Each crop is its own **tab** in the tab strip at the top (`+ New` starts another). Tabs run fully independently — you can queue up several crops at once and switch between them without one interfering with another. Each tab's dot shows its own status (amber pulsing = downloading, green = done, red = error, grey = cancelled), and shows live % while downloading.
5. In the active tab: the URL, title, and total duration auto-fill from the active YouTube tab (only for a tab that hasn't started a job yet), and refresh as you navigate to different videos. Set Start/End (seconds or `mm:ss`), pick a quality cap, and click "Download Cropped Clip".
6. A progress bar and status line update live (download %, merging, finalizing) until the clip is done.
7. **Cancel This Job** stops just the job in the active tab. **Stop All** (top right) kills every running job at once.
8. Once a job is done, click **Save As...** to pick where the finished clip goes via Chrome's native save dialog — it defaults to a name based on the video title. The clip also always lands in `YouTubeCropper/downloads` regardless, so Save As is just a convenient copy-to-location step.

## Notes & limitations

- The server uses `yt-dlp --download-sections` to fetch only the requested time range, not the entire source video — so a short clip from a long video downloads quickly instead of pulling the whole thing first.
- "Highest quality available" downloads video and audio as separate high-res streams and merges them with `ffmpeg` (this is how YouTube serves 1080p+), so you get the best quality actually offered for that video.
- `--force-keyframes-at-cuts` is used for reasonably accurate cut points; exact frame-accuracy may still snap slightly depending on the source's keyframe spacing.
- Cancelling a job kills its yt-dlp/ffmpeg process tree (`taskkill /T /F`) and deletes any partial output for that job.
- Only download videos you own or otherwise have the rights/permission to download — respect YouTube's Terms of Service and copyright law.
- This is a local-only tool: nothing is uploaded anywhere, it just calls `yt-dlp`/`ffmpeg` on your machine.
