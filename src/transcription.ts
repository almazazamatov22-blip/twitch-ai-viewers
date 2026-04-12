import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Groq from 'groq-sdk';

export interface TranscriptResult {
  text: string;
  timestamp: number;
}

export class TranscriptionService {
  private groq: Groq;
  private channel: string;
  private language: string;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private tmpDir: string;
  private chunkDuration: number;
  private offlineRetryMs = 60000;
  private onlineRetryMs = 3000;

  /**
   * @param chunkSecs How many seconds per audio chunk.
   *   Main channel default: 60s. Learn channel: use LEARN_TRANSCRIPT_DURATION (min 10s).
   */
  constructor(groqKey: string, channel: string, language = 'ru', chunkSecs = 60) {
    this.groq = new Groq({ apiKey: groqKey });
    this.channel = channel;
    this.language = language;
    // Enforce minimum 10s so Whisper has enough audio to work with
    this.chunkDuration = Math.max(10, chunkSecs);
    this.tmpDir = os.tmpdir();
    this.checkDeps();
  }

  private checkDeps(): void {
    exec('which streamlink || streamlink --version', (err, stdout) => {
      if (err) {
        console.error('[transcription] streamlink NOT FOUND:', err.message);
        console.log('[transcription] Trying: pip3 install streamlink --break-system-packages');
        exec('pip3 install streamlink --break-system-packages 2>&1', (_e, out) => {
          console.log('[transcription] pip install result:', out?.slice(0, 200));
        });
      } else {
        console.log('[transcription] streamlink found:', stdout?.trim() || 'ok');
      }
    });
    exec('which ffmpeg || ffmpeg -version 2>&1 | head -1', (err, stdout) => {
      if (err) console.error('[transcription] ffmpeg NOT FOUND');
      else console.log('[transcription] ffmpeg found:', stdout?.trim()?.slice(0, 60) || 'ok');
    });
  }

  start(onTranscript: (result: TranscriptResult) => void): void {
    this.stopped = false;
    console.log('[transcription] Starting for channel:', this.channel, '(lang:', this.language + ')');
    this.scheduleCapture(onTranscript);
  }

  private scheduleCapture(onTranscript: (result: TranscriptResult) => void): void {
    if (this.stopped) return;
    this.captureAndTranscribe(onTranscript).then(wasOnline => {
      if (!this.stopped) {
        const delay = wasOnline ? this.onlineRetryMs : this.offlineRetryMs;
        this.timer = setTimeout(() => this.scheduleCapture(onTranscript), delay);
      }
    }).catch(err => {
      console.error('[transcription] Unhandled error:', err);
      if (!this.stopped) {
        this.timer = setTimeout(() => this.scheduleCapture(onTranscript), this.offlineRetryMs);
      }
    });
  }

  private async captureAndTranscribe(onTranscript: (result: TranscriptResult) => void): Promise<boolean> {
    const audioFile = path.join(this.tmpDir, `twitchboost_${this.channel}_${Date.now()}.mp3`);
    try {
      const success = await this.captureAudio(audioFile);
      if (!success) return false;

      if (!fs.existsSync(audioFile)) {
        console.log('[transcription][' + this.channel + '] Audio file missing after capture');
        return false;
      }

      const stat = fs.statSync(audioFile);
      console.log('[transcription][' + this.channel + '] Audio file size:', stat.size, 'bytes');

      if (stat.size < 8000) {
        console.log('[transcription][' + this.channel + '] Audio too small, stream likely offline');
        return false;
      }

      console.log('[transcription][' + this.channel + '] Sending to Groq Whisper...');
      const transcriptionReq: any = {
        file: fs.createReadStream(audioFile) as any,
        model: 'whisper-large-v3',
        response_format: 'text',
      };
      if (this.language && this.language !== 'auto') {
        transcriptionReq.language = this.language;
      }
      const transcription = await this.groq.audio.transcriptions.create(transcriptionReq);

      const text = (typeof transcription === 'string' ? transcription : (transcription as any).text || '').trim();

      if (text && text.length > 3) {
        console.log('[transcription][' + this.channel + '] Heard:', text.slice(0, 120));
        onTranscript({ text, timestamp: Date.now() });
        return true;
      } else {
        console.log('[transcription][' + this.channel + '] Empty transcription result');
        return true;
      }
    } catch (e: any) {
      console.error('[transcription][' + this.channel + '] Error:', e.message);
      return false;
    } finally {
      try { if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile); } catch { /* ignore */ }
    }
  }

  private captureAudio(outputFile: string): Promise<boolean> {
    return new Promise((resolve) => {
      const { execSync } = require('child_process');
      let streamlinkPath = 'streamlink';
      try {
        const p = execSync(
          'which streamlink 2>/dev/null || find /nix/store -name streamlink -type f -executable 2>/dev/null | grep -v completion | head -1',
          { encoding: 'utf8' }
        ).trim();
        if (p && !p.includes('which') && !p.includes('completion')) {
          streamlinkPath = p;
        }
      } catch {}

      const streamUrl = `https://twitch.tv/${this.channel}`;
      console.log('[transcription][' + this.channel + '] Capturing audio for', this.chunkDuration, 's...');

      const streamlink = spawn(streamlinkPath, [
        '--quiet',
        '--twitch-low-latency',
        streamUrl,
        'audio_only,worst',
        '--stdout',
      ], { timeout: (this.chunkDuration + 15) * 1000 });

      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-t', String(this.chunkDuration),
        '-vn', '-ar', '16000', '-ac', '1',
        '-f', 'mp3',
        outputFile, '-y',
      ]);

      let streamlinkErr = '';
      let streamlinkDone = false;
      let ffmpegDone = false;
      let timedOut = false;

      streamlink.stdout.pipe(ffmpeg.stdin);

      streamlink.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        streamlinkErr += s;
        if (s.includes('error') || s.includes('Error') || s.includes('offline') || s.includes('No playable')) {
          console.log('[streamlink][' + this.channel + ']', s.trim().slice(0, 200));
        }
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        try { streamlink.kill('SIGTERM'); } catch { /* ignore */ }
        try { ffmpeg.stdin.end(); ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
      }, (this.chunkDuration + 12) * 1000);

      const check = () => {
        if (streamlinkDone && ffmpegDone) {
          clearTimeout(timeout);
          const isOffline =
            streamlinkErr.includes('No playable streams') ||
            streamlinkErr.includes('No streams') ||
            streamlinkErr.includes('offline') ||
            streamlinkErr.includes('does not exist');
          resolve(isOffline ? false : true);
        }
      };

      streamlink.on('close', (code) => {
        streamlinkDone = true;
        if (code !== 0 && code !== null && !timedOut) {
          console.log('[streamlink][' + this.channel + '] code', code, streamlinkErr.slice(0, 200));
        }
        try { ffmpeg.stdin.end(); } catch { /* ignore */ }
        check();
      });

      ffmpeg.on('close', (code) => {
        ffmpegDone = true;
        if (code !== 0 && code !== null && !timedOut) {
          console.log('[ffmpeg][' + this.channel + '] code', code);
        }
        check();
      });

      streamlink.on('error', (e) => {
        console.error('[streamlink][' + this.channel + '] spawn error:', e.message);
        streamlinkDone = true;
        try { ffmpeg.stdin.end(); } catch { /* ignore */ }
        check();
      });

      ffmpeg.on('error', (e) => {
        console.error('[ffmpeg][' + this.channel + '] spawn error:', e.message);
        ffmpegDone = true;
        check();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
