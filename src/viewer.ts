import axios from 'axios';
import { logger } from './logger';

const GQL_HEADERS = {
  'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const GQL_QUERY = `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value signature __typename}videoPlaybackAccessToken(id:$vodID,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isVod){value signature __typename}}`;

export class ViewerSimulator {
  private channelName: string;
  private isRunning: boolean = false;
  private playlistUrl: string | null = null;
  private interval: NodeJS.Timeout | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(channelName: string) {
    this.channelName = channelName;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    logger.info(`ViewerSim[${this.channelName}]: starting`);
    await this.refreshPlaylist();
    this.isRunning = true;
    // Fetch segment every 4s (standard HLS)
    this.interval = setInterval(() => this.fetchSegment(), 4000);
    // Refresh playlist token every 4 minutes
    this.refreshInterval = setInterval(() => this.refreshPlaylist().catch(() => {}), 240000);
    logger.info(`ViewerSim[${this.channelName}]: started`);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.isRunning = false;
    this.playlistUrl = null;
    logger.info(`ViewerSim[${this.channelName}]: stopped`);
  }

  get running(): boolean { return this.isRunning; }

  private async refreshPlaylist(): Promise<void> {
    // Get anonymous GQL token
    const tokenResp = await axios.post('https://gql.twitch.tv/gql', {
      operationName: 'PlaybackAccessToken_Template',
      query: GQL_QUERY,
      variables: { isLive: true, login: this.channelName, isVod: false, vodID: '', playerType: 'site' }
    }, { headers: GQL_HEADERS, timeout: 15000 });

    const td = tokenResp.data?.data?.streamPlaybackAccessToken;
    if (!td?.value) throw new Error('No GQL token for viewer sim');

    const masterUrl = `https://usher.ttvnw.net/api/channel/hls/${this.channelName}.m3u8`
      + `?client_id=kimne78kx3ncx6brgo4mv6wki5h1ko`
      + `&token=${encodeURIComponent(td.value)}&sig=${td.signature}`
      + `&allow_source=true&allow_spectre=true`;

    const masterResp = await axios.get(masterUrl, {
      responseType: 'text', timeout: 10000,
      headers: { 'User-Agent': GQL_HEADERS['User-Agent'] }
    });

    // Prefer audio_only, else take last (lowest quality)
    const lines = masterResp.data.split('\n');
    let chosen = '';
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l || l.startsWith('#')) continue;
      chosen = l;
      if (lines[i-1]?.includes('audio_only') || lines[i-2]?.includes('audio_only')) break;
    }
    if (!chosen) throw new Error('No variant found in master playlist');

    this.playlistUrl = chosen.startsWith('http') ? chosen
      : new URL(chosen, masterUrl).href;
    logger.info(`ViewerSim[${this.channelName}]: playlist refreshed`);
  }

  private async fetchSegment(): Promise<void> {
    if (!this.playlistUrl || !this.isRunning) return;
    try {
      const resp = await axios.get(this.playlistUrl, {
        responseType: 'text', timeout: 8000,
        headers: { 'User-Agent': GQL_HEADERS['User-Agent'] }
      });
      const lines = resp.data.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t && !t.startsWith('#') && (t.includes('.ts') || t.includes('.aac'))) {
          const segUrl = t.startsWith('http') ? t : new URL(t, this.playlistUrl!).href;
          // Just fetch first 2KB — enough for Twitch to count this as a viewer
          await axios.get(segUrl, {
            responseType: 'stream', timeout: 5000,
            headers: { 'User-Agent': GQL_HEADERS['User-Agent'], 'Range': 'bytes=0-2048' }
          }).then(r => r.data.destroy()).catch(() => {});
          break;
        }
      }
    } catch (_) {
      // Playlist expired — refresh
      try { await this.refreshPlaylist(); } catch (e) {
        logger.warn(`ViewerSim[${this.channelName}]: lost stream`);
        this.stop();
      }
    }
  }
}
