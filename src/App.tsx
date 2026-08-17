import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import confetti from "canvas-confetti";
import {
  BellRing,
  CalendarDays,
  CircleDollarSign,
  Crown,
  PartyPopper,
  Radio,
  Trophy,
  Volume2,
  VolumeX
} from "lucide-react";
// Real recorded celebration audio (bundled by Vite). Layered for a loud,
// natural "cheers + applause" — far better than the synth fallback below.
// Sources (no attribution required): applause = "277021 sandermotions
// applause-2.wav" (CC0); cheer = "Clapping hurray.ogg" (Public Domain),
// both from Wikimedia Commons.
import applauseUrl from "./assets/applause.wav";
import cheerUrl from "./assets/cheer.ogg";
import { maskLoanAccountNumber } from "./privacy";

type LeaderboardEntry = {
  rank: number;
  agentName: string;
  empId: string | null;
  emailId: string | null;
  photoUrl: string | null;
  totalPoints: number;
  collectionCount: number;
};

type CollectionRow = {
  id: number;
  clientName: string | null;
  bucketLabel: string | null;
  lenderName: string | null;
  loanNo: string | null;
  customerName: string | null;
  amountCollected: number;
  points: number;
  bucketWeight: number;
  agentName: string;
  empId: string | null;
  emailId: string | null;
  photoUrl: string | null;
  messageSentAt: string | null;
  dossierCode: string | null;
  targetPoints: number | null;
  qualifies: boolean;
};

type DashboardPayload = {
  latestBatchDate: string | null;
  latestSeenAt: string | null;
  metrics: {
    monthlyPoints: number;
    monthlyCollections: number;
    dailyPoints: number;
    dailyCollections: number;
    totalCollections: number;
    activeAgents: number;
    qualifiedCelebrations: number;
  };
  todayTopPerformer: LeaderboardEntry | null;
  monthlyTopPerformer: LeaderboardEntry | null;
  leaderboard: LeaderboardEntry[];
  recentCollections: CollectionRow[];
  celebrationQueue: CollectionRow[];
  celebrationCandidate: CollectionRow | null;
};

declare global {
  interface Window {
    __DASHBOARD_PAYLOAD__?: DashboardPayload & { error?: string };
  }
}

const DATA_REFRESH_MS = 10_000;
const CELEBRATION_MS = 60_000;
const API_BASE = "/api";
const LOGO_SRC = "/cgreen-logo-white.png";
const CONFETTI_COLORS = ["#ffcb04", "#ffd83a", "#7e92e0", "#4155a5", "#ffffff", "#dfe0e0"];
const RECENT_COLLECTIONS_SCROLL_PX_PER_SECOND = 100;
const RECENT_COLLECTIONS_TOP_PAUSE_MS = 3500;
const bootPayload =
  window.__DASHBOARD_PAYLOAD__ && !window.__DASHBOARD_PAYLOAD__.error
    ? (window.__DASHBOARD_PAYLOAD__ as DashboardPayload)
    : null;

function getPayloadVersion(payload: DashboardPayload) {
  return [
    payload.latestSeenAt ?? "none",
    payload.metrics.monthlyPoints,
    payload.metrics.monthlyCollections,
    payload.metrics.dailyPoints,
    payload.metrics.dailyCollections,
    payload.metrics.totalCollections,
    payload.metrics.activeAgents,
    payload.metrics.qualifiedCelebrations,
    payload.todayTopPerformer ? `${payload.todayTopPerformer.agentName}:${payload.todayTopPerformer.totalPoints}:${payload.todayTopPerformer.collectionCount}:${payload.todayTopPerformer.photoUrl ? "photo" : "no-photo"}` : "no-today-top",
    payload.monthlyTopPerformer ? `${payload.monthlyTopPerformer.agentName}:${payload.monthlyTopPerformer.totalPoints}:${payload.monthlyTopPerformer.collectionCount}:${payload.monthlyTopPerformer.photoUrl ? "photo" : "no-photo"}` : "no-monthly-top",
    payload.recentCollections.map((row) => `${row.id}:${row.messageSentAt ?? "no-message-date"}:${row.points}:${row.qualifies}:${row.photoUrl ? "photo" : "no-photo"}`).join(","),
    payload.leaderboard.map((entry) => `${entry.rank}:${entry.agentName}:${entry.totalPoints}:${entry.collectionCount}:${entry.photoUrl ? "photo" : "no-photo"}`).join(",")
  ].join("|");
}

async function loadDashboardPayload(): Promise<DashboardPayload> {
  const res = await fetch(`${API_BASE}/dashboard?ts=${Date.now()}`);
  if (!res.ok) {
    throw new Error("Dashboard feed is unavailable.");
  }
  const payload = await res.json();
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload;
}

const pointsCompact = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1
});

const pointsExact = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0
});

function formatCompactPoints(value: number) {
  return `${pointsCompact.format(value)} pts`;
}

function formatExactPoints(value: number) {
  return `${pointsExact.format(value)} pts`;
}

const timeLabel = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

const CELEBRATION_SOUND_SECONDS = 4;
// Whistle hits punctuating the cheer (start offsets in seconds).
const CHEER_WHISTLES = [0.25, 0.85, 1.55, 2.4, 3.1];

type AudioCapableWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function createCelebrationAudioContext() {
  const AudioContextClass = window.AudioContext ?? (window as AudioCapableWindow).webkitAudioContext;
  return AudioContextClass ? new AudioContextClass() : null;
}

function createNoiseBuffer(context: AudioContext, duration: number) {
  const sampleCount = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
  const samples = buffer.getChannelData(0);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = Math.random() * 2 - 1;
  }

  return buffer;
}

function scheduleApplauseClap(
  context: AudioContext,
  output: GainNode,
  startTime: number,
  duration: number,
  volume: number
) {
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();

  source.buffer = createNoiseBuffer(context, duration);
  filter.type = "highpass";
  filter.frequency.setValueAtTime(950 + Math.random() * 850, startTime);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(output);
  source.start(startTime);
  source.stop(startTime + duration + 0.02);
}

function scheduleCrowdRoar(
  context: AudioContext,
  output: GainNode,
  startTime: number,
  duration: number,
  centerFrequency: number,
  volume: number
) {
  // A band-passed noise bed with an amplitude wobble — reads as a roaring crowd
  // rather than a musical tone, which is what made the old version sound bad.
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  const lfo = context.createOscillator();
  const lfoGain = context.createGain();

  source.buffer = createNoiseBuffer(context, duration + 0.2);
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(centerFrequency, startTime);
  filter.Q.setValueAtTime(0.9, startTime);

  // Swell in fast, hold, then fall away.
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.35);
  gain.gain.setValueAtTime(volume, startTime + duration * 0.62);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  // Wobble the level so it feels like a live, surging crowd.
  lfo.type = "sine";
  lfo.frequency.setValueAtTime(4.5 + Math.random() * 2.5, startTime);
  lfoGain.gain.setValueAtTime(volume * 0.22, startTime);
  lfo.connect(lfoGain);
  lfoGain.connect(gain.gain);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(output);

  source.start(startTime);
  source.stop(startTime + duration + 0.05);
  lfo.start(startTime);
  lfo.stop(startTime + duration + 0.05);
}

function scheduleWhistle(context: AudioContext, output: GainNode, startTime: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const base = 1900 + Math.random() * 700;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(base, startTime);
  oscillator.frequency.linearRampToValueAtTime(base + 520, startTime + 0.14);
  oscillator.frequency.linearRampToValueAtTime(base + 180, startTime + 0.32);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(0.18, startTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.34);

  oscillator.connect(gain);
  gain.connect(output);
  oscillator.start(startTime);
  oscillator.stop(startTime + 0.36);
}

async function playCelebrationCheer(context: AudioContext | null) {
  if (!context) return false;
  if (context.state === "suspended") {
    await context.resume();
  }
  if (context.state !== "running") return false;

  const start = context.currentTime + 0.04;
  const master = context.createGain();
  master.gain.setValueAtTime(0.0001, start);
  master.gain.exponentialRampToValueAtTime(1, start + 0.04);
  master.gain.setValueAtTime(1, start + CELEBRATION_SOUND_SECONDS - 0.4);
  master.gain.exponentialRampToValueAtTime(0.0001, start + CELEBRATION_SOUND_SECONDS);
  master.connect(context.destination);

  // Layered crowd roar across vocal formant bands for a full, loud cheer.
  scheduleCrowdRoar(context, master, start, CELEBRATION_SOUND_SECONDS, 750, 0.5);
  scheduleCrowdRoar(context, master, start, CELEBRATION_SOUND_SECONDS, 1500, 0.4);
  scheduleCrowdRoar(context, master, start + 0.05, CELEBRATION_SOUND_SECONDS - 0.1, 2400, 0.22);

  // Dense, loud applause.
  Array.from({ length: 150 }).forEach((_, index) => {
    const cluster = index < 36 ? Math.random() * 0.5 : Math.random() * (CELEBRATION_SOUND_SECONDS - 0.5);
    const volume = 0.32 + Math.random() * 0.42;
    scheduleApplauseClap(context, master, start + cluster, 0.05 + Math.random() * 0.07, volume);
  });

  CHEER_WHISTLES.forEach((offset) => {
    scheduleWhistle(context, master, start + offset + Math.random() * 0.15);
  });

  return true;
}

async function unlockAudioContext(context: AudioContext | null) {
  if (!context) return false;
  if (context.state === "suspended") {
    await context.resume();
  }

  const warmup = context.createBufferSource();
  const gain = context.createGain();
  warmup.buffer = context.createBuffer(1, 1, context.sampleRate);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  warmup.connect(gain);
  gain.connect(context.destination);
  warmup.start();

  return context.state === "running";
}

function createCelebrationCheerDataUrl() {
  const sampleRate = 22050;
  const durationSeconds = CELEBRATION_SOUND_SECONDS;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let seed = 20260618;

  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const clapStarts = Array.from({ length: 150 }, (_, index) => ({
    start: index < 36 ? random() * 0.5 : random() * (durationSeconds - 0.5),
    duration: 0.05 + random() * 0.07,
    tone: 26 + random() * 24,
    volume: 0.35 + random() * 0.42
  }));

  const whistles = [0.25, 0.85, 1.55, 2.4, 3.1].map((offset) => ({
    start: offset + random() * 0.15,
    base: 1900 + random() * 700
  }));

  // Running-state filters used to band-limit white noise into a crowd "roar".
  let lowState = 0;
  let bandState = 0;

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const time = sample / sampleRate;
    let value = 0;

    clapStarts.forEach((clap) => {
      const localTime = time - clap.start;
      if (localTime < 0 || localTime > clap.duration) return;

      const attack = Math.min(1, localTime / 0.006);
      const release = Math.pow(Math.max(0, 1 - localTime / clap.duration), 2.2);
      const envelope = attack * release;
      const noise = random() * 2 - 1;
      const snap = Math.sin(2 * Math.PI * clap.tone * localTime) * 0.18;
      value += (noise + snap) * envelope * clap.volume;
    });

    // Crowd roar: band-limit white noise and wobble its level so it reads as a
    // cheering crowd rather than a tone.
    const noise = random() * 2 - 1;
    lowState += (noise - lowState) * 0.18;
    bandState += (lowState - bandState) * 0.06;
    const roarBand = lowState - bandState;
    const swell = Math.min(1, time / 0.35);
    const tail = Math.min(1, (durationSeconds - time) / 0.8);
    const wobble = 0.8 + 0.2 * Math.sin(2 * Math.PI * 5.5 * time);
    const roarEnvelope = Math.max(0, Math.min(swell, tail)) * wobble;
    value += roarBand * roarEnvelope * 2.6;

    whistles.forEach((whistle) => {
      const localTime = time - whistle.start;
      if (localTime < 0 || localTime > 0.34) return;

      const attack = Math.min(1, localTime / 0.05);
      const release = Math.min(1, (0.34 - localTime) / 0.08);
      const envelope = Math.max(0, Math.min(attack, release));
      const freq = whistle.base + 520 * Math.min(1, localTime / 0.14);
      value += Math.sin(2 * Math.PI * freq * localTime) * envelope * 0.18;
    });

    const fadeOut = Math.min(1, (durationSeconds - time) / 0.4);
    const pcmValue = Math.max(-1, Math.min(1, value * 0.42 * fadeOut));
    view.setInt16(44 + sample * 2, pcmValue * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return `data:audio/wav;base64,${btoa(binary)}`;
}

function formatBatchDate(value: string | null) {
  if (!value) return "Awaiting batch";
  const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    }).format(new Date(Number(year), Number(month) - 1, Number(day)));
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function getEmployeeInitial(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) return "?";
  return (Array.from(trimmedName)[0] ?? "?").toLocaleUpperCase("en-IN");
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(bootPayload);
  const [celebration, setCelebration] = useState<CollectionRow | null>(null);
  const [celebrationQueue, setCelebrationQueue] = useState<CollectionRow[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(window.__DASHBOARD_PAYLOAD__?.error ?? null);
  const [loading, setLoading] = useState(!bootPayload && !window.__DASHBOARD_PAYLOAD__?.error);
  const [audioReady, setAudioReady] = useState(false);
  const celebrationAudio = useRef<AudioContext | null>(null);
  const fallbackAudio = useRef<HTMLAudioElement | null>(null);
  const fallbackAudioUrl = useRef<string | null>(null);
  const recordedAudio = useRef<{ applause: HTMLAudioElement; cheer: HTMLAudioElement } | null>(null);
  const recordedFadeTimers = useRef<number[]>([]);
  const celebrateTimeout = useRef<number | null>(null);
  const confettiTimer = useRef<number | null>(null);
  const seenCollectionIds = useRef(new Set(bootPayload?.recentCollections.map((row) => row.id) ?? []));
  const seenCollectionsInitialized = useRef(Boolean(bootPayload));

  const getCelebrationAudio = useCallback(() => {
    if (!celebrationAudio.current) {
      celebrationAudio.current = createCelebrationAudioContext();
    }
    return celebrationAudio.current;
  }, []);

  const getFallbackAudio = useCallback(() => {
    if (!fallbackAudioUrl.current) {
      fallbackAudioUrl.current = createCelebrationCheerDataUrl();
    }
    if (!fallbackAudio.current) {
      fallbackAudio.current = new Audio(fallbackAudioUrl.current);
      fallbackAudio.current.preload = "auto";
      fallbackAudio.current.volume = 1;
    }
    return fallbackAudio.current;
  }, []);

  const playFallbackAudio = useCallback(
    async (warmup = false) => {
      const audio = getFallbackAudio();
      audio.pause();
      audio.currentTime = 0;
      audio.volume = warmup ? 0.01 : 1;
      await audio.play();

      if (warmup) {
        window.setTimeout(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = 1;
        }, 80);
      }

      return true;
    },
    [getFallbackAudio]
  );

  const getRecordedAudio = useCallback(() => {
    if (!recordedAudio.current) {
      const applause = new Audio(applauseUrl);
      const cheer = new Audio(cheerUrl);
      applause.preload = "auto";
      cheer.preload = "auto";
      recordedAudio.current = { applause, cheer };
    }
    return recordedAudio.current;
  }, []);

  // Play the real applause + cheer clips together. The cheer sits slightly
  // under the applause so the "hurray" accents the crowd rather than masking it.
  const playRecordedCheer = useCallback(
    async (warmup = false) => {
      const { applause, cheer } = getRecordedAudio();
      const clips = [
        { el: applause, vol: 1 },
        { el: cheer, vol: 0.85 }
      ];

      recordedFadeTimers.current.forEach((id) => window.clearInterval(id));
      recordedFadeTimers.current = [];

      await Promise.all(
        clips.map(async ({ el, vol }) => {
          el.pause();
          el.currentTime = 0;
          el.volume = warmup ? 0.01 : vol;
          await el.play();
        })
      );

      if (warmup) {
        window.setTimeout(() => {
          clips.forEach(({ el, vol }) => {
            el.pause();
            el.currentTime = 0;
            el.volume = vol;
          });
        }, 80);
      } else {
        // Let the burst run, then fade out so the overlay never trails silence.
        window.setTimeout(() => {
          clips.forEach(({ el, vol }) => {
            const fade = window.setInterval(() => {
              if (el.volume > 0.07) {
                el.volume = Math.max(0, el.volume - 0.07);
              } else {
                window.clearInterval(fade);
                el.pause();
                el.currentTime = 0;
                el.volume = vol;
              }
            }, 70);
            recordedFadeTimers.current.push(fade);
          });
        }, 6000);
      }

      return true;
    },
    [getRecordedAudio]
  );

  const playCelebrationSound = useCallback(
    async (warmup = false) => {
      // Prefer the real recordings; fall back to the synth only if they fail.
      try {
        if (await playRecordedCheer(warmup)) return true;
      } catch {
        // Recorded clips unavailable/blocked — drop to the synth fallbacks.
      }

      const context = getCelebrationAudio();
      if (context) {
        const played = warmup ? await unlockAudioContext(context) : await playCelebrationCheer(context);
        if (played) return true;
      }

      return playFallbackAudio(warmup);
    },
    [playRecordedCheer, getCelebrationAudio, playFallbackAudio]
  );

  const unlockCelebrationAudio = useCallback(async () => {
    const context = getCelebrationAudio();

    try {
      setAudioReady(context ? await playCelebrationSound(true) : await playFallbackAudio(true));
    } catch {
      setAudioReady(false);
    }
  }, [getCelebrationAudio, playCelebrationSound, playFallbackAudio]);

  const celebrateCollection = useCallback(
    (collection: CollectionRow) => {
      void unlockCelebrationAudio();

      if (celebration) {
        setCelebrationQueue((current) => [...current, collection]);
        return;
      }

      setCelebration(collection);
    },
    [celebration, unlockCelebrationAudio]
  );

  useEffect(() => {
    const unlock = () => {
      void unlockCelebrationAudio();
    };

    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [unlockCelebrationAudio]);

  useEffect(() => {
    let stopped = false;
    let fallbackInterval: number | null = null;
    let eventSource: EventSource | null = null;

    function enqueueNewCelebrations(payload: DashboardPayload) {
      if (!seenCollectionsInitialized.current) {
        payload.recentCollections.forEach((row) => seenCollectionIds.current.add(row.id));
        seenCollectionsInitialized.current = true;
        return;
      }

      const newCelebrations = payload.recentCollections
        .filter((row) => !seenCollectionIds.current.has(row.id))
        .filter((row) => row.qualifies)
        .sort((a, b) => a.id - b.id);

      payload.recentCollections.forEach((row) => seenCollectionIds.current.add(row.id));

      if (newCelebrations.length === 0) return;

      setCelebrationQueue((current) => [...current, ...newCelebrations]);
    }

    function applyDashboardPayload(payload: DashboardPayload) {
      if (stopped) return;
      setDashboard((current) => {
        if (current && getPayloadVersion(current) === getPayloadVersion(payload)) {
          return current;
        }
        return payload;
      });
      enqueueNewCelebrations(payload);
      setError(null);
      setLoading(false);
    }

    async function loadDashboard() {
      try {
        const payload = await loadDashboardPayload();
        applyDashboardPayload(payload);
      } catch (fetchError) {
        if (stopped) return;
        const message = fetchError instanceof Error ? fetchError.message : "Unable to load dashboard.";
        setError(message);
        setLoading(false);
      }
    }

    function startFallbackPolling() {
      if (fallbackInterval !== null) return;
      void loadDashboard();
      fallbackInterval = window.setInterval(loadDashboard, DATA_REFRESH_MS);
    }

    if (!bootPayload) {
      void loadDashboard();
    }

    if ("EventSource" in window) {
      eventSource = new EventSource(`${API_BASE}/dashboard/stream`);

      eventSource.addEventListener("dashboard", (event) => {
        try {
          applyDashboardPayload(JSON.parse((event as MessageEvent).data) as DashboardPayload);
        } catch {
          if (!stopped) {
            setError("Live dashboard update was unreadable.");
            setLoading(false);
          }
        }
      });

      eventSource.addEventListener("dashboard-error", (event) => {
        if (stopped) return;
        let message = "Unable to load dashboard data.";
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { error?: string };
          message = payload.error ?? message;
        } catch {
          // Keep the generic error message.
        }
        setError(message);
        setLoading(false);
      });

      eventSource.onopen = () => {
        if (fallbackInterval !== null) {
          window.clearInterval(fallbackInterval);
          fallbackInterval = null;
        }
      };

      eventSource.onerror = () => {
        startFallbackPolling();
      };
    } else {
      startFallbackPolling();
    }

    return () => {
      stopped = true;
      eventSource?.close();
      if (fallbackInterval !== null) window.clearInterval(fallbackInterval);
    };
  }, []);

  useEffect(() => {
    if (celebration || celebrationQueue.length === 0) return;

    const [nextCelebration, ...remainingCelebrations] = celebrationQueue;
    setCelebration(nextCelebration);
    setCelebrationQueue(remainingCelebrations);
  }, [celebration, celebrationQueue]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!celebration) return;

    void playCelebrationSound().then(setAudioReady).catch(() => setAudioReady(false));

    const shoot = () => {
      confetti({
        particleCount: 160,
        spread: 120,
        startVelocity: 42,
        ticks: 220,
        scalar: 1.15,
        origin: { y: 0.58 },
        colors: CONFETTI_COLORS
      });
      confetti({
        particleCount: 90,
        angle: 60,
        spread: 80,
        origin: { x: 0.1, y: 0.7 },
        colors: CONFETTI_COLORS
      });
      confetti({
        particleCount: 90,
        angle: 120,
        spread: 80,
        origin: { x: 0.9, y: 0.7 },
        colors: CONFETTI_COLORS
      });
    };

    shoot();
    confettiTimer.current = window.setInterval(shoot, 1800);
    celebrateTimeout.current = window.setTimeout(() => {
      setCelebration(null);
    }, CELEBRATION_MS);

    return () => {
      if (confettiTimer.current) window.clearInterval(confettiTimer.current);
      if (celebrateTimeout.current) window.clearTimeout(celebrateTimeout.current);
    };
  }, [celebration, playCelebrationSound]);

  const topPerformer = dashboard?.leaderboard[0] ?? null;
  const todayTopPerformer = dashboard?.todayTopPerformer ?? null;
  const monthlyTopPerformer = dashboard?.monthlyTopPerformer ?? null;
  const metrics = dashboard?.metrics;

  return (
    <div className="cg-stage-bg min-h-screen overflow-hidden text-[var(--text-primary)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:72px_72px] opacity-40" />
      <AnimatePresence>
        {celebration ? <CelebrationOverlay collection={celebration} /> : null}
      </AnimatePresence>

      <main className="relative z-10 flex min-h-screen w-full max-w-none flex-col gap-5 px-4 py-4 md:px-5 md:py-5 xl:h-screen xl:overflow-hidden 2xl:px-7">
        <motion.header
          initial={{ opacity: 0, y: -18 }}
          animate={{ opacity: 1, y: 0 }}
          className="panel-shell flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center md:justify-between"
        >
          <div className="flex items-center gap-4 md:gap-5">
            <img
              src={LOGO_SRC}
              alt="CGreen - Customer Collect Credit"
              className="h-14 w-auto shrink-0 md:h-16"
            />
            <div className="hidden h-12 w-px bg-[var(--border-strong)] md:block" />
            <h1 className="font-display text-3xl font-extrabold uppercase leading-none tracking-[0.04em] text-[var(--text-secondary)] md:whitespace-nowrap md:text-4xl xl:text-5xl">
              Live Collections Floor
            </h1>
          </div>

          <div className="flex flex-wrap items-start gap-3 md:justify-end">
            <div className="status-pill border-[var(--border-yellow)] bg-[var(--status-win-soft)] text-[var(--cg-yellow-bright)]">
              <Radio className="h-4 w-4" />
              Live floor
            </div>
            <div className="status-pill border-[var(--border-blue)] bg-[var(--status-live-soft)] text-[var(--cg-blue-bright)]">
              <BellRing className="h-4 w-4" />
              Latest batch {formatBatchDate(dashboard?.latestBatchDate ?? null)}
            </div>
            <button
              type="button"
              onClick={() => void unlockCelebrationAudio()}
              className={`status-pill transition ${
                audioReady
                  ? "border-[var(--border-yellow)] bg-[var(--status-win-soft)] text-[var(--cg-yellow-bright)]"
                  : "border-[var(--border-subtle)] bg-white/6 text-[var(--text-secondary)]"
              }`}
              title={audioReady ? "Celebration sound ready" : "Enable celebration sound"}
              aria-label={audioReady ? "Celebration sound ready" : "Enable celebration sound"}
            >
              {audioReady ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              {audioReady ? "Sound armed" : "Enable sound"}
            </button>
            <div className="rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-white/6 px-4 py-3 text-right shadow-[var(--shadow-inset-top)]">
              <p className="font-display text-3xl font-bold leading-none text-[var(--cg-blue-bright)] md:text-4xl">
                {timeLabel.format(now)}
              </p>
              <p className="label-kicker mt-1 text-[var(--text-muted)]">IST</p>
            </div>
          </div>
        </motion.header>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4"
        >
          <MetricCard
            icon={<CalendarDays className="h-5 w-5" />}
            label="Monthly points"
            value={formatCompactPoints(metrics?.monthlyPoints ?? 0)}
            accent="yellow"
            meta={`${metrics?.monthlyCollections ?? 0} collections this month`}
          />
          <MetricCard
            icon={<CircleDollarSign className="h-5 w-5" />}
            label="Daily points"
            value={formatCompactPoints(metrics?.dailyPoints ?? 0)}
            accent="blue"
            meta={`${metrics?.dailyCollections ?? 0} collections today`}
          />
          <MetricCard
            icon={<Crown className="h-5 w-5" />}
            label="Today Top performer"
            value={todayTopPerformer ? todayTopPerformer.agentName : "Awaiting data"}
            accent="grey"
            meta={todayTopPerformer ? formatCompactPoints(todayTopPerformer.totalPoints) : "No collections today"}
          />
          <MetricCard
            icon={<Trophy className="h-5 w-5" />}
            label="Monthly top performer"
            value={monthlyTopPerformer ? monthlyTopPerformer.agentName : "Awaiting data"}
            accent="yellow"
            meta={monthlyTopPerformer ? formatCompactPoints(monthlyTopPerformer.totalPoints) : "No collections this month"}
          />
        </motion.section>

        <div className="relative min-h-0 flex-1 overflow-hidden">
              <motion.div
                key="live-panels"
                initial={{ opacity: 0, x: -36 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.45, ease: "easeOut" }}
                className="grid h-full min-h-0 gap-5 xl:grid-cols-[1.05fr_0.95fr]"
              >
                <motion.section
                  initial={{ opacity: 0, x: -24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.12 }}
                  className="panel-shell min-h-0 overflow-hidden"
                >
                  <PanelHeader
                    title="Today's Top Performers"
                    subtitle="Leaderboard from today's collections"
                    accent="yellow"
                    icon={<Trophy className="h-8 w-8" />}
                  />
                  <div className="space-y-4 px-4 pb-4 pt-5 md:px-6 xl:h-[calc(100%-9rem)] xl:overflow-hidden">
                    <AnimatePresence initial={false} mode="popLayout">
                    {topPerformer ? (
                      <motion.article
                        layout
                        key={topPerformer.agentName}
                        initial={{ opacity: 0, y: 16, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -12, scale: 0.98 }}
                        transition={{ duration: 0.38, ease: "easeOut" }}
                        className="rounded-[var(--radius-xl)] border border-[var(--border-yellow)] bg-[linear-gradient(90deg,rgba(255,203,4,0.18),rgba(255,203,4,0.03))] px-5 py-5 shadow-[var(--glow-yellow)]"
                      >
                        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                          <div className="flex items-center gap-4">
                            <div className="relative shrink-0">
                              <EmployeeAvatar name={topPerformer.agentName} photoUrl={topPerformer.photoUrl} size="lg" accent="yellow" />
                              <span className="absolute -bottom-1 -right-1 flex h-7 min-w-7 items-center justify-center rounded-full border border-[var(--cg-yellow)] bg-[var(--cg-yellow)] px-2 font-display text-base font-extrabold text-[var(--text-on-yellow)] shadow-[var(--glow-yellow)]">
                                #{topPerformer.rank}
                              </span>
                            </div>
                            <div>
                              <p className="font-display text-4xl font-bold uppercase leading-none md:text-5xl">
                                {topPerformer.agentName}
                              </p>
                              <p className="label-kicker mt-2 text-[var(--text-secondary)]">
                                {topPerformer.collectionCount} successful collections
                              </p>
                            </div>
                          </div>
                          <p className="font-display text-5xl font-extrabold text-[var(--cg-yellow)] md:text-7xl">
                            {formatCompactPoints(topPerformer.totalPoints)}
                          </p>
                        </div>
                      </motion.article>
                    ) : null}
                    </AnimatePresence>

                    <motion.div layout className="space-y-3 xl:overflow-y-auto xl:pr-1">
                      <AnimatePresence initial={false} mode="popLayout">
                      {dashboard?.leaderboard.slice(1).map((entry) => (
                        <motion.article
                          layout
                          key={entry.agentName}
                          initial={{ opacity: 0, x: -18, scale: 0.98 }}
                          animate={{ opacity: 1, x: 0, scale: 1 }}
                          exit={{ opacity: 0, x: 18, scale: 0.98 }}
                          transition={{ duration: 0.32, ease: "easeOut" }}
                          className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white/[0.04] px-5 py-4 shadow-[var(--shadow-inset-top)]"
                        >
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex min-w-0 items-center gap-4">
                              <div className="relative shrink-0">
                                <EmployeeAvatar name={entry.agentName} photoUrl={entry.photoUrl} size="md" accent="blue" />
                                <span className="absolute -bottom-1 -right-1 flex h-6 min-w-6 items-center justify-center rounded-full border border-[var(--border-blue)] bg-[var(--cg-blue-bright)] px-1.5 font-display text-sm font-extrabold text-[var(--cg-ink-950)]">
                                  #{entry.rank}
                                </span>
                              </div>
                              <div className="min-w-0">
                                <p className="truncate font-display text-3xl font-bold uppercase leading-none md:text-4xl">
                                  {entry.agentName}
                                </p>
                                <p className="label-kicker mt-2 text-[var(--text-muted)]">
                                  {entry.collectionCount} collections posted
                                </p>
                              </div>
                            </div>
                            <p className="font-display text-4xl font-bold text-[var(--cg-blue-bright)] md:text-5xl">
                              {formatCompactPoints(entry.totalPoints)}
                            </p>
                          </div>
                        </motion.article>
                      ))}
                      </AnimatePresence>
                    </motion.div>
                  </div>
                </motion.section>

                <motion.section
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.16 }}
                  className="panel-shell min-h-0 overflow-hidden"
                >
                  <PanelHeader
                    title="Recent Collections"
                    accent="blue"
                    icon={<Radio className="h-8 w-8" />}
                  />
                  <div className="px-4 pb-4 pt-5 md:px-6 xl:h-[calc(100%-9rem)] xl:overflow-hidden">
                    {error ? (
                      <div className="rounded-[var(--radius-lg)] border border-[color:rgba(226,87,76,0.36)] bg-[var(--status-danger-soft)] p-5 text-[var(--cg-danger)]">
                        {error}
                      </div>
                    ) : null}

                    {loading ? (
                      <div className="space-y-3">
                        {Array.from({ length: 5 }).map((_, index) => (
                          <div key={index} className="h-28 animate-pulse rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white/[0.03]" />
                        ))}
                      </div>
                    ) : (
                      <RecentCollectionsRoll
                        items={dashboard?.recentCollections ?? []}
                        onCelebrate={celebrateCollection}
                      />
                    )}
                  </div>
                </motion.section>
              </motion.div>
        </div>
      </main>
    </div>
  );
}

function RecentCollectionsRoll({
  items,
  onCelebrate
}: {
  items: CollectionRow[];
  onCelebrate: (collection: CollectionRow) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || items.length === 0) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTop = 0;
    if (prefersReducedMotion) return;

    let animationFrame: number | null = null;
    let pauseTimer: number | null = null;
    let lastTimestamp = 0;
    let stopped = false;

    const getMaxScrollTop = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);

    const startAfterPause = () => {
      pauseTimer = window.setTimeout(() => {
        if (stopped) return;
        lastTimestamp = 0;
        animationFrame = window.requestAnimationFrame(scrollStep);
      }, RECENT_COLLECTIONS_TOP_PAUSE_MS);
    };

    const scrollStep = (timestamp: number) => {
      if (stopped) return;

      const maxScrollTop = getMaxScrollTop();
      if (maxScrollTop <= 1) return;

      if (lastTimestamp === 0) {
        lastTimestamp = timestamp;
      }

      const elapsedSeconds = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      scroller.scrollTop = Math.min(
        maxScrollTop,
        scroller.scrollTop + RECENT_COLLECTIONS_SCROLL_PX_PER_SECOND * elapsedSeconds
      );

      if (scroller.scrollTop >= maxScrollTop - 1) {
        scroller.scrollTop = 0;
        startAfterPause();
        return;
      }

      animationFrame = window.requestAnimationFrame(scrollStep);
    };

    startAfterPause();

    return () => {
      stopped = true;
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (pauseTimer !== null) window.clearTimeout(pauseTimer);
    };
  }, [items]);

  if (items.length === 0) {
    return <p className="label-kicker px-1 text-[var(--text-muted)]">Awaiting collections feed</p>;
  }

  return (
    <motion.div
      layout
      ref={scrollerRef}
      className="relative space-y-3 overflow-hidden pr-1 xl:h-full"
      aria-live="polite"
    >
      <AnimatePresence initial={false} mode="popLayout">
      {items.map((row) => (
        <motion.article
          layout
          key={row.id}
          initial={{ opacity: 0, y: -18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 18, scale: 0.98 }}
          transition={{ duration: 0.34, ease: "easeOut" }}
          className={`rounded-[var(--radius-lg)] border px-5 py-4 shadow-[var(--shadow-inset-top)] ${
            row.qualifies
              ? "border-[var(--border-yellow)] bg-[linear-gradient(90deg,rgba(255,203,4,0.14),rgba(255,255,255,0.03))]"
              : "border-[var(--border-subtle)] bg-white/[0.04]"
          }`}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 gap-4">
              <EmployeeAvatar
                name={row.agentName}
                photoUrl={row.photoUrl}
                size="md"
                accent={row.qualifies ? "yellow" : "blue"}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`status-pill px-3 py-1 ${row.qualifies ? "border-[var(--border-yellow)] bg-[var(--status-win-soft)] text-[var(--cg-yellow-bright)]" : "border-[var(--border-blue)] bg-[var(--status-live-soft)] text-[var(--cg-blue-bright)]"}`}>
                    <Radio className="h-3.5 w-3.5" />
                    {row.bucketLabel ?? "Unmapped"}
                  </span>
                  <span className="label-kicker text-[var(--text-muted)]">
                    Trigger above {formatExactPoints(row.targetPoints ?? 500)}
                  </span>
                </div>
                <p className="mt-4 font-display text-3xl font-bold uppercase leading-none md:text-4xl">
                  {row.agentName}
                </p>
                <p className="mt-2 text-lg text-[var(--text-secondary)] md:text-xl">
                  {row.clientName ?? "Unknown client"}
                  {row.loanNo ? (
                    <span className="whitespace-nowrap">{` | ${maskLoanAccountNumber(row.loanNo)}`}</span>
                  ) : null}
                </p>
                <p className="mt-2 label-kicker text-[var(--text-muted)]">
                  {row.lenderName ?? "Unmapped lender"} | Multiplier {pointsExact.format(row.bucketWeight)}
                  {" | "}
                  {row.messageSentAt ? new Date(row.messageSentAt).toLocaleString("en-IN") : "Pending message timestamp"}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-start sm:items-end sm:text-right">
              <p className={`font-display text-4xl font-bold md:text-5xl ${row.qualifies ? "text-[var(--cg-yellow)]" : "text-[var(--cg-blue-bright)]"}`}>
                {formatCompactPoints(row.points)}
              </p>
              <button
                type="button"
                onClick={() => onCelebrate(row)}
                className="status-pill mt-3 border-[var(--cg-yellow)] bg-[var(--cg-yellow)] px-3 py-1 text-[var(--text-on-yellow)] transition hover:brightness-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-[color:rgba(255,203,4,0.45)]"
                title={`Celebrate ${row.agentName}'s collection`}
                aria-label={`Celebrate ${row.agentName}'s collection`}
              >
                <PartyPopper className="h-3.5 w-3.5" />
                Celebrate
              </button>
            </div>
          </div>
        </motion.article>
      ))}
      </AnimatePresence>
    </motion.div>
  );
}

function EmployeeAvatar({
  name,
  photoUrl,
  size,
  accent
}: {
  name: string;
  photoUrl?: string | null;
  size: "sm" | "md" | "lg" | "xl" | "celebration";
  accent: "yellow" | "blue";
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc = imageFailed ? undefined : photoUrl ?? undefined;
  const showPhoto = Boolean(imageSrc);
  const sizeClass = {
    sm: "h-10 w-10 text-xl",
    md: "h-14 w-14 text-3xl",
    lg: "h-16 w-16 text-4xl",
    xl: "h-28 w-28 text-6xl",
    celebration: "h-84 w-84 text-[12rem]"
  }[size];
  const accentClass = {
    yellow: "border-[var(--border-yellow)] bg-[var(--status-win-soft)] text-[var(--cg-yellow)] shadow-[var(--glow-yellow)]",
    blue: "border-[var(--border-blue)] bg-[var(--status-live-soft)] text-[var(--cg-blue-bright)] shadow-[var(--glow-blue)]"
  }[accent];

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border font-display font-bold uppercase ${sizeClass} ${accentClass}`}
      title={name}
      aria-label={`${name} profile image placeholder`}
    >
      {showPhoto ? (
        <img
          src={imageSrc}
          alt={`${name} profile`}
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span>{getEmployeeInitial(name)}</span>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  meta,
  icon,
  accent
}: {
  label: string;
  value: string;
  meta: string;
  icon: React.ReactNode;
  accent: "yellow" | "blue" | "grey";
}) {
  const accentStyles = {
    yellow: "border-[var(--border-yellow)] shadow-[var(--glow-yellow)] text-[var(--cg-yellow)]",
    blue: "border-[var(--border-blue)] shadow-[var(--glow-blue)] text-[var(--cg-blue-bright)]",
    grey: "border-[var(--border-subtle)] text-[var(--text-secondary)]"
  }[accent];

  return (
    <article className={`panel-shell min-w-0 px-5 py-4 ${accentStyles}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="label-kicker">{label}</p>
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-white/6 p-2">{icon}</div>
      </div>
      <AnimatePresence initial={false} mode="wait">
        <motion.p
          key={value}
          title={value}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.24, ease: "easeOut" }}
          className="metric-card-value mt-4 font-display text-[clamp(2rem,2.8vw,3rem)] font-bold uppercase leading-none"
        >
          {value}
        </motion.p>
      </AnimatePresence>
      <p className="label-kicker mt-3 text-[var(--text-muted)]">{meta}</p>
    </article>
  );
}

function PanelHeader({
  title,
  subtitle,
  accent,
  icon
}: {
  title: string;
  subtitle?: string;
  accent: "yellow" | "blue";
  icon: React.ReactNode;
}) {
  const colorClass = accent === "yellow" ? "text-[var(--cg-yellow)]" : "text-[var(--cg-blue-bright)]";
  const borderClass = accent === "yellow" ? "border-[var(--border-yellow)]" : "border-[var(--border-blue)]";

  return (
    <div className={`flex items-center gap-4 border-b ${borderClass} bg-white/[0.04] px-4 py-4 md:px-6`}>
      <div className={`flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-white/6 ${colorClass}`}>
        {icon}
      </div>
      <div>
        {subtitle ? <p className="label-kicker text-[var(--text-muted)]">{subtitle}</p> : null}
        <h2 className={`font-display text-[clamp(2rem,3vw,2.625rem)] font-extrabold uppercase leading-none ${colorClass}`}>
          {title}
        </h2>
      </div>
    </div>
  );
}

function CelebrationOverlay({ collection }: { collection: CollectionRow }) {
  const detailText = collection.qualifies
    ? `Points trigger hit for dossier ${collection.dossierCode ?? "unmapped"} in ${collection.bucketLabel ?? "unknown bucket"}`
    : `Collection posted for dossier ${collection.dossierCode ?? "unmapped"} in ${collection.bucketLabel ?? "unknown bucket"}`;

  return (
    <motion.section
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.04 }}
      className="absolute inset-0 z-50 flex items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_center,rgba(255,203,4,0.28),transparent_20%),radial-gradient(circle_at_top_right,rgba(126,146,224,0.24),transparent_28%),linear-gradient(140deg,rgba(5,7,13,0.94)_0%,rgba(13,17,31,0.98)_100%)]"
    >
      <motion.div
        aria-hidden="true"
        animate={{ rotate: 360 }}
        transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
        className="absolute h-[130vmax] w-[130vmax] bg-[conic-gradient(from_0deg,transparent_0deg,rgba(255,203,4,0.16)_18deg,transparent_38deg,transparent_110deg,rgba(126,146,224,0.14)_132deg,transparent_158deg,transparent_360deg)] opacity-80"
      />
      <motion.div
        initial={{ opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative flex w-full max-w-[1500px] flex-col items-center px-6 text-center"
      >
        <div className="relative mb-8 w-fit md:mb-10">
          <div className="absolute inset-[-28px] rounded-full border border-[color:rgba(255,203,4,0.24)] bg-[radial-gradient(circle,rgba(255,203,4,0.22),transparent_68%)] blur-sm" />
          <EmployeeAvatar name={collection.agentName} photoUrl={collection.photoUrl} size="celebration" accent="yellow" />
          <div className="absolute bottom-4 right-4 flex h-20 w-20 items-center justify-center rounded-full border border-[var(--border-yellow)] bg-[var(--cg-ink-900)] text-[var(--cg-yellow)] shadow-[var(--glow-yellow)] md:h-24 md:w-24">
            <Trophy className="h-11 w-11 md:h-13 md:w-13" />
          </div>
        </div>
        <motion.h2
          animate={{ scale: [1, 1.02, 1] }}
          transition={{ duration: 1.6, repeat: Infinity }}
          className="max-w-[18ch] text-balance font-display text-4xl font-black uppercase leading-none text-[var(--text-primary)] drop-shadow-[0_0_35px_rgba(255,203,4,0.34)] md:text-6xl xl:text-[6.5rem]"
        >
          {collection.agentName}
        </motion.h2>
        <motion.p
          animate={{ scale: [1, 1.045, 1] }}
          transition={{ duration: 1.3, repeat: Infinity }}
          className="mt-5 font-display text-6xl font-black leading-none text-[var(--cg-yellow)] drop-shadow-[0_0_42px_rgba(255,203,4,0.55)] md:text-8xl xl:text-[8.5rem]"
        >
          {formatExactPoints(collection.points)}
        </motion.p>
        <p className="mt-5 max-w-[34ch] text-balance font-display text-2xl font-bold uppercase tracking-[0.12em] text-[var(--cg-blue-bright)] md:text-4xl">
          {collection.clientName ?? "Client not mapped"}
        </p>
        <p className="mt-4 max-w-[52rem] text-lg text-[var(--text-secondary)] md:text-2xl">
          {detailText}
        </p>
      </motion.div>
    </motion.section>
  );
}

export default App;
