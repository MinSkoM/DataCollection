# Liveness Detection — Data Collector

A mobile-first web app for collecting multimodal biometric data to train and evaluate face liveness detection models. Built as part of the **GSync Liveness Detection** research project at KBTG.

---

## What it collects

Each recording session captures synchronized, per-frame data:

| Signal | Source | Detail |
|---|---|---|
| **Face Mesh** | MediaPipe FaceMesh | 28 key landmarks (x, y, z) from a 468-point mesh |
| **Optical Flow** | OpenCV.js (Lucas-Kanade) | Background point tracking to isolate camera motion vs. face motion |
| **IMU Sensors** | Device Motion API | Accelerometer (x, y, z) + Gyroscope (α, β, γ), interpolated per frame |
| **Video Frame** | Canvas capture | JPEG at 480 px width per frame |

---

## Data labels

Before recording, the operator tags each session with three labels:

**Type** — whether the subject is a real person or a spoof attempt:
- `REAL`
- `Spoof_2DScreen` — photo displayed on a screen
- `Spoof_VideoReplay` — video played back on a screen
- `Spoof_TimeShift` — delayed video replay

**Scenario** — environmental condition:
- `Normal`, `WhiteWall`

**Motion** — camera movement pattern during recording:
- `orbital_RL`, `orbital_LR` — side-to-side orbital sweep
- `push-pull`, `pull-push` — depth axis movement
- `THT_R`, `THT_L` — tilt/head-turn right or left

---

## Architecture

```
Browser (React + TypeScript + Vite)
  ├── MediaPipe FaceMesh        — real-time 468-point landmark detection
  ├── OpenCV.js                 — background optical flow (goodFeaturesToTrack + calcOpticalFlowPyrLK)
  ├── DeviceMotion API          — IMU data buffered at ~60 Hz, interpolated to frame timestamps
  └── Canvas capture            — JPEG frames at 480 px

Flask Server (Python)
  └── /upload                   — receives JSON payload, decodes Base64 frames, saves to disk
        collected_data/
          {type}_{scenario}_{motion}_{timestamp}/
            images/
              frame_0000.jpg
              frame_0001.jpg
              ...
            data.json
```

---

## Setup

**Prerequisites:** Node.js, Python 3

### Frontend

```bash
npm install
npm run dev
```

Set the API endpoint in `.env.local`:

```
VITE_API_URL=http://<your-server-ip>:8000
```

### Backend

```bash
pip install flask flask-cors
python server.py
```

The server listens on `0.0.0.0:8000` and saves sessions under `collected_data/`.

---

## Tech stack

- **React 19** + **TypeScript** + **Vite**
- **MediaPipe FaceMesh** (via CDN)
- **OpenCV.js** (WASM build)
- **Flask** + **flask-cors**

---

## Notes

- On iOS, the app requests `DeviceMotionEvent` permission before starting the camera.
- When using the **rear camera**, accelerometer X is inverted so left/right directions stay consistent with the front-camera coordinate frame.
- Sessions are only uploaded after the operator reviews the frame count — discard or confirm before data leaves the device.
- The server accepts up to **500 MB** per upload to handle long sessions.
