// src/index.js
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer');
const ytdlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());

// ---------- Folders ----------
const DATA_DIR = path.join(__dirname, '..', 'data');
const SS_DIR = path.join(DATA_DIR, 'screenshots');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const RESULT_DIR = path.join(DATA_DIR, 'results');
[DATA_DIR, SS_DIR, AUDIO_DIR, RESULT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
app.use('/files', express.static(DATA_DIR));

// ---------- Mongo ----------
const MONGO = process.env.MONGODB_URI;
if (!MONGO) { console.error('Missing MONGODB_URI'); process.exit(1); }
mongoose.connect(MONGO)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => { console.error('Mongo error:', err.message); process.exit(1); });

// ---------- Model ----------
const JobSchema = new mongoose.Schema({
  youtubeUrl: { type: String, required: true },
  status: { type: String, enum: ['queued','processing','done','error'], default: 'queued' },
  publicId: { type: String, default: () => uuidv4() },
  screenshotPath: String,
  audioPath: String,
  transcriptPath: String,
  resultJsonPath: String,
  error: String,
}, { timestamps: true });
const Job = mongoose.model('Job', JobSchema);

// ---------- Helpers ----------
const YT_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ffmpegFileToWav(inPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav')
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}

async function downloadBestAudioToFile(url, outPath) {
  // Downloads best audio track (webm/m4a/etc.) to a local file via yt-dlp
  await ytdlp(url, { output: outPath, format: 'bestaudio/best', quiet: true });
}

// ---------- ElevenLabs upload + STT ----------
const ELEVEN_BASE = 'https://api.elevenlabs.io';

async function elUploadFile(localPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const form = new FormData();
  form.append('file', fs.createReadStream(localPath), {
    contentType: 'audio/wav',
    filename: path.basename(localPath),
  });

  const resp = await axios.post(`${ELEVEN_BASE}/v1/upload`, form, {
    headers: { ...form.getHeaders(), 'xi-api-key': apiKey },
    timeout: 300000,
  });

  const data = resp.data || {};
  const url = data.upload_url || data.file_url || data.url;
  if (!url) throw new Error(`Upload response missing url: ${JSON.stringify(data)}`);
  return url;
}

async function transcribeWithElevenLabs(wavPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const sttUrl = process.env.ELEVENLABS_STT_URL || `${ELEVEN_BASE}/v1/speech-to-text`;
  if (!apiKey) return { text: null, words: null, note: 'ELEVENLABS_API_KEY not set' };

  try {
    const audioUrl = await elUploadFile(wavPath); // 1) upload file

    // 2) request transcription with JSON body
    const resp = await axios.post(
      sttUrl,
      {
        model_id: 'scribe',
        audio_url: audioUrl,
        // Optional if supported by your plan:
        // timestamps: 'word',
        // diarize: true,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'xi-api-key': apiKey,
        },
        timeout: 300000,
      }
    );

    const data = resp.data || {};
    const text =
      data.text ||
      data.transcript ||
      (Array.isArray(data.segments) ? data.segments.map(s => s.text).join(' ') : null);

    const words =
      data.words ||
      (Array.isArray(data.segments) ? data.segments.flatMap(s => s.words || []) : null);

    if (!text) {
      return { text: null, words: words || null, raw: data, note: 'No text in response' };
    }
    return { text, words: words || null, raw: data };
  } catch (err) {
    const body = err?.response?.data;
    const msg = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : (err.message || String(err));
    return { text: null, words: null, error: `ElevenLabs error: ${msg}` };
  }
}

// ---------- Worker ----------
async function processJob(jobId) {
  const job = await Job.findById(jobId);
  if (!job) return;

  try {
    job.status = 'processing'; job.error = undefined; await job.save();

    const stamp = Date.now();
    const base = `${jobId}-${stamp}`;

    // 1) Screenshot
    const ssPathDisk = path.join(SS_DIR, `${base}.png`);
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(job.youtubeUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
    try {
      await page.waitForSelector('button:has-text("I agree"), button:has-text("Accept all"), form[action*="consent"] button', { timeout: 3000 });
      await page.click('button:has-text("I agree"), button:has-text("Accept all"), form[action*="consent"] button');
      await sleep(1000);
    } catch {}
    try {
      await page.waitForSelector('button[aria-label*="Play"], button[title*="Play"]', { timeout: 4000 });
      await page.click('button[aria-label*="Play"], button[title*="Play"]');
    } catch {}
    await sleep(3000);
    await page.screenshot({ path: ssPathDisk });
    await browser.close();

    // 2) Audio download → WAV
    const tmpSrc = path.join(AUDIO_DIR, `${base}.src`);
    const wavPathDisk = path.join(AUDIO_DIR, `${base}.wav`);
    try {
      await downloadBestAudioToFile(job.youtubeUrl, tmpSrc);
      await ffmpegFileToWav(tmpSrc, wavPathDisk);
    } finally {
      try { await fsp.unlink(tmpSrc); } catch {}
    }

    // 3) Transcribe (ElevenLabs)
    const scribe = await transcribeWithElevenLabs(wavPathDisk);

    // 4) Save result JSON
    const result = {
      youtubeUrl: job.youtubeUrl,
      processedAt: new Date().toISOString(),
      screenshot: `/files/screenshots/${path.basename(ssPathDisk)}`,
      audioWav: `/files/audio/${path.basename(wavPathDisk)}`,
      transcript: scribe?.text ?? null,
      words: scribe?.words ?? null,
      notes: { scribeError: scribe?.error, scribeNote: scribe?.note },
    };
    const resultPathDisk = path.join(RESULT_DIR, `${base}.json`);
    await fsp.writeFile(resultPathDisk, JSON.stringify(result, null, 2));

    // 5) Update DB
    job.screenshotPath = result.screenshot;
    job.audioPath = result.audioWav;
    job.resultJsonPath = `/files/results/${path.basename(resultPathDisk)}`;
    job.status = 'done';
    await job.save();
  } catch (err) {
    const msg = (err && (err.message || err.stderr || err.stdout)) || String(err);
    console.error('Process error:', msg);
    job.status = 'error';
    job.error = msg;
    await job.save();
  }
}

// ---------- Routes ----------
app.post('/analyze', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !YT_REGEX.test(url)) {
      return res.status(400).json({ error: 'Provide a valid YouTube URL in { "url": "..." }' });
    }
    const job = await Job.create({ youtubeUrl: url, status: 'queued' });
    processJob(job._id).catch(e => console.error('Worker crash:', e));
    res.status(202).json({ message: 'Job queued', id: job._id.toString(), publicId: job.publicId, check: `/result/${job._id}` });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/result/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
  } catch { res.status(400).json({ error: 'Invalid id' }); }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`🚀 Server running on http://0.0.0.0:${port}`));
