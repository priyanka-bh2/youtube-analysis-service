# YouTube Analysis Service

A Node.js service that:
- Downloads audio from a YouTube video
- Takes a thumbnail screenshot
- Converts audio to WAV (16 kHz, mono, 16-bit)
- Saves results (JSON + screenshot path)
- Exposes a REST API to retrieve results

---

## Features
- **POST** `/analyze` – Start processing a YouTube URL
- **GET** `/result/:id` – Retrieve the JSON result
- **Dockerized** for one-line startup
- Example output provided

---

## Setup
**1. Clone the Repository**

git clone https://github.com/priyanka-bh2/youtube-analysis-service.git

cd youtube-analysis-service

**2. Install Dependencies**

npm install

**3. Environment Variables**


Create a .env file in the root directory:

PORT=8080

MONGO_URI=mongodb://localhost:27017/youtube_analysis

---

## Running Locally

node src/index.js

Then open: POST /analyze with JSON:

{ "youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }

Response:

{ "message": "Job queued", "id": "<mongoId>", "check": "/result/<mongoId>" }

GET /result/:id

Returns job state and, when done, the file paths.

Sample output

See /sample-output/output.json and /sample-output/screenshot.png (or use the ones generated under data/ after running).

---

## Docker Deployment
Build & Run with Docker Compose

docker-compose up --build

This starts:
Node.js API service
MongoDB database

---

## Example Output

{

  "youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  
  "processedAt": "2025-08-09T04:47:53.503Z",
  
  "screenshot": "/files/screenshots/example.png",
  
  "audioWav": "/files/audio/example.wav",
  
  "transcript": "Sample transcription text...",
  
}

---

## Design Decisions
- Puppeteer used for headless browser control to start video playback and take screenshots

- ytdl-core for YouTube audio extraction

- FFmpeg for audio conversion

- MongoDB for storing results

- Express for REST API

- .gitignore excludes node_modules, .env, and large data files

---

## Deliverables Checklist
✅ Public GitHub repository

✅ Clean commit history

✅ README with setup, env vars, design decisions

✅ Dockerfile + docker-compose.yml

✅ Sample JSON output + screenshot

✅ Short 90s video demo (record using OBS or any screen recorder)


## Screenshots
<img width="1280" height="720" alt="689808dcab06024e8f5bfb09-1754794204622" src="https://github.com/user-attachments/assets/1064d565-2192-4a54-a9fa-3ae8406365c6" />

{

  "youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  
  "processedAt": "2025-08-10T02:50:33.807Z",
  
  "screenshot": "/files/screenshots/689808dcab06024e8f5bfb09-1754794204622.png",
  
  "audioWav": "/files/audio/689808dcab06024e8f5bfb09-1754794204622.wav",
  
}
