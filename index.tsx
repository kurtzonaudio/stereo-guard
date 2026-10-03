/*
 * StereoGuard, a Vencord/Equicord user plugin
 * Copyright (c) 2026 Kurtzon (Kurtzon Audio)
 * SPDX-License-Identifier: MIT
 */

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { Button, MediaEngineStore, React, RelationshipStore, showToast, Toasts, UserStore, VoiceActions } from "@webpack/common";

const logger = new Logger("StereoGuard");

const IGNORED_KEY = "StereoGuard_ignored";
const POLL_MS = 50;
const SCAN_MS = 500;
const PAN_WINDOW_MS = 4000;
const TRIGGER_COOLDOWN_MS = 3000;
const NOISE_GATE = 0.01;
const RELEASE = 0.3;
// Slow decay so short pauses between words never erase the progress that
// already built up, even when a high certainty count is configured.
const EVIDENCE_DECAY = 0.96;
// Never mute someone within this long of their audio first appearing, so a
// person joining the call is always audible while their stream settles.
const JOIN_GRACE_MS = 1000;
// After the guard unmutes someone (auto or by hand, including a manual unmute
// through the mute icon), leave them alone for this long instead of muting
// them again on the next scan.
const REMUTE_COOLDOWN_MS = 5000;

interface AudioOutput {
    id: string;
    stream: MediaStream;
}

interface VoiceConnection {
    context: string;
    outputs: Record<string, AudioOutput>;
    localMutes: Record<string, boolean>;
    audioContext: AudioContext;
}

interface Meter {
    output: AudioOutput;
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    splitter: ChannelSplitterNode;
    left: AnalyserNode;
    right: AnalyserNode;
    silent: GainNode;
    bufLeft: Float32Array<ArrayBuffer>;
    bufRight: Float32Array<ArrayBuffer>;
    mono: boolean;
    score: number;
    pans: number[];
    panAt: number[];
    evidence: number;
    lastTriggerAt: number;
}

const meters = new Map<string, Meter>();
const meterContexts = new WeakMap<VoiceConnection, AudioContext>();
const mutedByUs = new Set<string>();
const unmuteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ignored = new Set<string>();
// userId -> when their output first appeared in the current call
const firstSeen = new Map<string, number>();
// userId -> don't mute before this timestamp (set on any unmute)
const unmuteCooldownUntil = new Map<string, number>();

let connection: VoiceConnection | null = null;
let intervalId: ReturnType<typeof setInterval> | undefined;
let lastScanAt = 0;

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Watch the call and mute anyone whose audio is not fully mono: slight panning, stereo width, panning around, or reverb tails.",
        default: true
    },
    threshold: {
        type: OptionType.SLIDER,
        description: "Mute when the stereo content passes this level, in dB relative to the center. -40 catches even a hint of panning or reverb; -4 only heavy stereo. Lower means stricter. Check the live scores above.",
        markers: [-40, -34, -28, -24, -20, -16, -12, -8, -4],
        default: -22,
        stickToMarkers: false
    },
    sensitivity: {
        type: OptionType.SLIDER,
        description: "How much non-mono audio is needed before a mute. Higher reacts to shorter and quieter bits.",
        markers: makeRange(1, 10, 1),
        default: 7,
        stickToMarkers: true
    },
    autoUnmute: {
        type: OptionType.SLIDER,
        description: "Seconds until a guard mute lifts. 0 keeps them muted until you unmute them.",
        markers: [0, 5, 10, 15, 30, 60, 120, 300],
        default: 0,
        stickToMarkers: false
    },
    ignoreFriends: {
        type: OptionType.BOOLEAN,
        description: "Never mute your friends.",
        default: true
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when the guard mutes or unmutes someone.",
        default: true
    }
});

function displayName(userId: string) {
    const user = UserStore.getUser(userId);
    return user?.globalName ?? user?.username ?? userId;
}

function isIgnored(userId: string) {
    if (ignored.has(userId)) return true;
    if (UserStore.getCurrentUser()?.id === userId) return true;

    const user = UserStore.getUser(userId);
    if (user?.bot) return true;

    return settings.store.ignoreFriends && RelationshipStore.isFriend(userId);
}

function isLocalMuted(userId: string) {
    return connection?.localMutes[userId] ?? MediaEngineStore.isLocalMute(userId);
}

function getConnection(): VoiceConnection | null {
    const engine = MediaEngineStore.getMediaEngine();
    if (!engine?.connections) return null;

    for (const conn of engine.connections as Iterable<VoiceConnection>) {
        if (conn?.context === "default" && conn.audioContext) return conn;
    }

    return null;
}

function channelCount(output: AudioOutput) {
    return output.stream.getAudioTracks()[0]?.getSettings?.().channelCount ?? 2;
}

// Discord closes and replaces its own audio context in some clients, which used
// to freeze every meter. The meters get their own context so they cannot die
// with it, and 48 kHz avoids the high sample rate stalls on 192 kHz devices.
function getMeterContext(conn: VoiceConnection) {
    let context = meterContexts.get(conn);
    if (!context || context.state === "closed") {
        context = new AudioContext({ sampleRate: 48000 });
        meterContexts.set(conn, context);
    }
    return context;
}

function closeMeterContext(conn: VoiceConnection) {
    const context = meterContexts.get(conn);
    if (context && context.state !== "closed") context.close();
    meterContexts.delete(conn);
}

function createMeter(conn: VoiceConnection, userId: string) {
    const output = conn.outputs[userId];
    if (!output?.stream?.getAudioTracks().length) return;

    const context = getMeterContext(conn);
    const source = context.createMediaStreamSource(output.stream);
    const splitter = context.createChannelSplitter(2);
    const left = context.createAnalyser();
    const right = context.createAnalyser();
    left.fftSize = 1024;
    right.fftSize = 1024;
    left.smoothingTimeConstant = 0;
    right.smoothingTimeConstant = 0;

    const silent = context.createGain();
    silent.gain.value = 0;

    source.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    left.connect(silent);
    right.connect(silent);
    silent.connect(context.destination);

    meters.set(userId, {
        output,
        stream: output.stream,
        source,
        splitter,
        left,
        right,
        silent,
        bufLeft: new Float32Array(left.fftSize),
        bufRight: new Float32Array(right.fftSize),
        mono: channelCount(output) === 1,
        score: 0,
        pans: [],
        panAt: [],
        evidence: 0,
        lastTriggerAt: 0
    });
}

function dropMeter(userId: string) {
    const meter = meters.get(userId);
    if (!meter) return;

    meters.delete(userId);

    try {
        meter.source.disconnect();
        meter.splitter.disconnect();
        meter.left.disconnect();
        meter.right.disconnect();
        meter.silent.disconnect();
    } catch (e) {
        logger.error("failed to release a meter", e);
    }
}

function syncMeters(conn: VoiceConnection) {
    const now = Date.now();
    for (const userId of Object.keys(conn.outputs)) {
        if (!firstSeen.has(userId)) firstSeen.set(userId, now);
        const output = conn.outputs[userId];
        const meter = meters.get(userId);
        // Discord swaps the stream on the same output object after every
        // renegotiation. Rebuild the meter then too, or the guard watches a dead
        // stream while the person keeps talking.
        if (!meter || meter.output !== output || meter.stream !== output.stream) {
            dropMeter(userId);
            createMeter(conn, userId);
        } else {
            meter.mono = channelCount(output) === 1;
        }
    }

    for (const userId of [...meters.keys()]) {
        if (!conn.outputs[userId]) dropMeter(userId);
    }

    for (const userId of [...firstSeen.keys()]) {
        if (!conn.outputs[userId]) firstSeen.delete(userId);
    }
}

function readScore(meter: Meter, now: number) {
    if (meter.mono) return 0;

    meter.left.getFloatTimeDomainData(meter.bufLeft);
    meter.right.getFloatTimeDomainData(meter.bufRight);

    const { length } = meter.bufLeft;
    let sumLL = 0;
    let sumRR = 0;
    for (let i = 0; i < length; i++) {
        const l = meter.bufLeft[i];
        const r = meter.bufRight[i];
        sumLL += l * l;
        sumRR += r * r;
    }

    const rmsL = Math.sqrt(sumLL / length);
    const rmsR = Math.sqrt(sumRR / length);
    const total = rmsL + rmsR;
    if (total < NOISE_GATE) return 0;

    const pan = (rmsR - rmsL) / total;
    const imbalance = Math.abs(pan);

    let sumMid = 0;
    let sumSide = 0;
    for (let i = 0; i < length; i++) {
        const mid = (meter.bufLeft[i] + meter.bufRight[i]) * 0.5;
        const side = (meter.bufLeft[i] - meter.bufRight[i]) * 0.5;
        sumMid += mid * mid;
        sumSide += side * side;
    }

    const midRms = Math.sqrt(sumMid / length);
    const sideRms = Math.sqrt(sumSide / length);
    const stereo = midRms + sideRms > 0 ? Math.min(1, (sideRms / (midRms + sideRms)) * 2) : 0;

    meter.pans.push(pan);
    meter.panAt.push(now);
    while (meter.panAt.length && now - meter.panAt[0] > PAN_WINDOW_MS) {
        meter.pans.shift();
        meter.panAt.shift();
    }

    let min = 1;
    let max = -1;
    for (const value of meter.pans) {
        if (value < min) min = value;
        if (value > max) max = value;
    }

    const swing = meter.pans.length > 1 ? Math.min(1, (max - min) / 2) : 0;

    return Math.max(stereo, imbalance, swing);
}

function mute(userId: string, score: number) {
    if (isLocalMuted(userId)) return;

    VoiceActions.toggleLocalMute(userId);
    mutedByUs.add(userId);
    logger.debug(`muted ${userId} at ${Math.round(score > 0 ? 20 * Math.log10(score) : -60)} dB stereo`);

    const seconds = settings.store.autoUnmute;
    if (seconds > 0) {
        unmuteTimers.set(userId, setTimeout(() => unmute(userId, true), seconds * 1000));
    }

    if (settings.store.notify) {
        showToast(`StereoGuard muted ${displayName(userId)} for obnoxious stereo (${Math.round(score > 0 ? 20 * Math.log10(score) : -60)} dB).`, Toasts.Type.MESSAGE);
    }
}

function unmute(userId: string, automatic: boolean) {
    const timer = unmuteTimers.get(userId);
    if (timer !== undefined) {
        clearTimeout(timer);
        unmuteTimers.delete(userId);
    }

    if (!mutedByUs.delete(userId)) return;

    if (isLocalMuted(userId)) VoiceActions.toggleLocalMute(userId);

    unmuteCooldownUntil.set(userId, Date.now() + REMUTE_COOLDOWN_MS);

    if (!automatic && settings.store.notify) {
        showToast(`StereoGuard unmuted ${displayName(userId)}.`, Toasts.Type.MESSAGE);
    }
}

function sample(userId: string, meter: Meter, now: number, needed: number) {
    const score = readScore(meter, now);
    meter.score = score >= meter.score ? score : meter.score + (score - meter.score) * RELEASE;

    // If someone the guard muted is no longer muted (the user unmuted them by
    // hand or through the mute icon, or the call reconnected), respect that and
    // back off for a while instead of re-muting them.
    if (mutedByUs.has(userId) && !isLocalMuted(userId)) {
        const timer = unmuteTimers.get(userId);
        if (timer !== undefined) {
            clearTimeout(timer);
            unmuteTimers.delete(userId);
        }
        mutedByUs.delete(userId);
        unmuteCooldownUntil.set(userId, now + REMUTE_COOLDOWN_MS);
    }

    const coolingDown = (unmuteCooldownUntil.get(userId) ?? 0) > now;
    const settled = now - (firstSeen.get(userId) ?? now) >= JOIN_GRACE_MS;
    const counts = meter.score >= Math.pow(10, settings.store.threshold / 20) && !isIgnored(userId) && !isLocalMuted(userId) && !coolingDown && settled;

    // Evidence builds up over the stereo bits and only decays slowly, so short
    // pauses between words never wipe out progress the way back-to-back ticks did.
    meter.evidence = counts ? meter.evidence + 1 : meter.evidence * EVIDENCE_DECAY;

    if (meter.evidence >= needed && now - meter.lastTriggerAt > TRIGGER_COOLDOWN_MS) {
        meter.evidence = 0;
        meter.lastTriggerAt = now;
        mute(userId, meter.score);
    }
}

function poll() {
    try {
        const conn = getConnection();
        if (conn !== connection) {
            for (const userId of [...meters.keys()]) dropMeter(userId);
            if (connection) closeMeterContext(connection);
            mutedByUs.clear();
            for (const timer of unmuteTimers.values()) clearTimeout(timer);
            unmuteTimers.clear();
            firstSeen.clear();
            connection = conn;
            lastScanAt = 0;
        }

        if (!connection) return;

        const now = Date.now();
        if (now - lastScanAt >= SCAN_MS) {
            lastScanAt = now;
            syncMeters(connection);
        }

        const { enabled, sensitivity } = settings.store;
        if (!enabled) return;

        const needed = Math.max(1, 11 - Math.round(sensitivity));
        for (const [userId, meter] of meters) sample(userId, meter, now, needed);
    } catch (e) {
        logger.error("poll failed", e);
    }
}

// The web build's DataStore stub can return promises that never settle, which
// would leave start()(and every plugin after it) waiting forever. Cap the wait
// so startup always continues with the stored value or a default.
function storeWithTimeout<T>(p: Promise<T>, ms = 1200): Promise<T | null> {
    return Promise.race([
        p.catch(() => null),
        new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
    ]);
}

async function saveIgnored() {
    try {
        await storeWithTimeout(DataStore.set(IGNORED_KEY, [...ignored]));
    } catch (e) {
        logger.error("failed to save the ignore list", e);
    }
}

function toggleIgnored(userId: string) {
    if (!ignored.delete(userId)) ignored.add(userId);
    void saveIgnored();
}

function unmuteAll() {
    for (const userId of [...mutedByUs]) unmute(userId, false);
}

function ScoreRow({ userId }: { userId: string; }) {
    const raw = meters.get(userId)?.score ?? 0;
    const db = raw > 0 ? Math.max(-60, 20 * Math.log10(raw)) : -60;
    const { threshold } = settings.store;
    const hot = db >= threshold;
    const ignoredUser = isIgnored(userId);
    const muted = mutedByUs.has(userId);
    const pct = Math.max(0, Math.min(100, (db + 40) / 40 * 100));
    const thresholdPct = Math.max(0, Math.min(100, (threshold + 40) / 40 * 100));

    return (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
            <div style={{ width: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--header-primary)" }}>
                {displayName(userId)}
            </div>
            <div style={{ position: "relative", flex: 1, height: 10, borderRadius: 5, background: "var(--background-modifier-accent)", overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: hot ? "var(--status-danger)" : "var(--status-positive)" }} />
                <div style={{ position: "absolute", top: 0, left: `${thresholdPct}%`, width: 2, height: "100%", background: "var(--text-muted)" }} />
            </div>
            <div style={{ width: 68, color: ignoredUser ? "var(--text-muted)" : "var(--header-secondary)", fontVariantNumeric: "tabular-nums" }}>
                {Math.round(db)} dB
            </div>
            <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => toggleIgnored(userId)}>
                {ignored.has(userId) ? "Allow" : "Ignore"}
            </Button>
            {muted && <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => unmute(userId, false)}>Unmute</Button>}
        </div>
    );
}

function GuardPanel() {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);

    React.useEffect(() => {
        const id = setInterval(forceUpdate, 250);
        return () => clearInterval(id);
    }, []);

    const live = [...meters.keys()];

    return (
        <div style={{ marginBottom: 16 }}>
            <div style={{ color: "var(--header-primary)", fontWeight: 600, fontSize: 16 }}>Live stereo scores</div>
            <div style={{ color: "var(--header-secondary)", fontSize: 13, marginBottom: 8 }}>
                Anything not centered mono shows up here in dB: slight panning, stereo width, panning around, and reverb all push the score up. -40 dB is the faintest stereo, 0 dB is full width. The thin line is your threshold.
            </div>

            {live.length === 0
                ? <div style={{ color: "var(--text-muted)" }}>Join a voice channel to see scores.</div>
                : live.map(userId => <ScoreRow key={userId} userId={userId} />)}

            {mutedByUs.size > 0 && (
                <div style={{ marginTop: 12 }}>
                    <div style={{ color: "var(--header-primary)", fontWeight: 600, fontSize: 16, marginBottom: 4 }}>Muted by the guard</div>
                    {[...mutedByUs].map(userId => (
                        <div key={userId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "4px 0" }}>
                            <span style={{ color: "var(--status-danger)" }}>{displayName(userId)}</span>
                            <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => unmute(userId, false)}>Unmute</Button>
                        </div>
                    ))}
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={unmuteAll} style={{ marginTop: 4 }}>Unmute all</Button>
                </div>
            )}

            {ignored.size > 0 && (
                <div style={{ marginTop: 12 }}>
                    <div style={{ color: "var(--header-primary)", fontWeight: 600, fontSize: 16, marginBottom: 4 }}>Never muted</div>
                    {[...ignored].map(userId => (
                        <div key={userId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "4px 0" }}>
                            <span>{displayName(userId)}</span>
                            <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => toggleIgnored(userId)}>Allow again</Button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default definePlugin({
    name: "StereoGuard",
    description: "Locally mutes anyone whose audio is not fully mono: slight panning, stereo width, panning around, or reverb tails. Centered mono voice is never touched.",
    authors: [{ name: "Kurtzon", id: 0n }],
    tags: ["Voice", "Utility"],
    settings,
    settingsAboutComponent: GuardPanel,

    async start() {
        try {
            const saved = await storeWithTimeout(DataStore.get(IGNORED_KEY));
            if (Array.isArray(saved)) {
                for (const userId of saved) if (typeof userId === "string") ignored.add(userId);
            }
        } catch (e) {
            logger.error("failed to load the ignore list", e);
        }

        // Older builds stored a positive percent threshold. Thresholds in dB
        // are never positive, so anything above zero is an old value.
        if (settings.store.threshold > 0) settings.store.threshold = -22;

        intervalId = setInterval(poll, POLL_MS);
    },

    stop() {
        if (intervalId !== undefined) {
            clearInterval(intervalId);
            intervalId = undefined;
        }

        for (const timer of unmuteTimers.values()) clearTimeout(timer);
        unmuteTimers.clear();

        for (const userId of [...meters.keys()]) dropMeter(userId);
        if (connection) closeMeterContext(connection);
        connection = null;

        for (const userId of [...mutedByUs]) unmute(userId, true);
        mutedByUs.clear();
        firstSeen.clear();
        unmuteCooldownUntil.clear();
    }
});
