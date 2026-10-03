# Stereo Guard

Stereo Guard is a Discord voice plugin that watches the call and locally mutes anyone whose audio is not fully mono. Slight panning, stereo width, voices moving around the stereo field, and reverb tails all push a live score up. When the score stays over your threshold long enough, Stereo Guard mutes that person on your side, so you keep hearing everyone else.

## What it does

Discord voice normally arrives as mono, but some microphones, stereo enhancers, voice changers, and audio chains send a wider or panned signal. That can sound louder, echoey, or like the person is talking from both sides of your head at once. Stereo Guard listens to each incoming voice stream and measures how far it is from centered mono. Anything that is not centered triggers it, including:

- Slight panning: one channel a little louder than the other.
- Stereo width: the same voice spread across both channels with a phase or delay difference, also called side content.
- Panning around: the voice drifting left and right over time.
- Reverb tails: the tail spreads across the channels, so a heavily reverberated voice scores high.

Centered mono voice is never touched, no matter how loud it is.

The mute is local. Nobody else in the call sees it and Discord's servers are not told. It only changes what you hear.

## How the detection works

Every incoming voice stream is split into left and right and sampled 20 times per second in its own 48 kHz audio context. Three measurements are taken together:

1. **Stereo width.** Mid is `(L + R) / 2`, side is `(L - R) / 2`. The more side energy relative to mid energy, the higher the score. A voice with a delay or phase difference between the channels scores on this even when both channels are equally loud.
2. **Left/right imbalance.** The difference in level between the two channels. This catches hard panning.
3. **Panning swing.** The left/right balance is tracked over a rolling 4 second window. The range between the most left and the most right balance is the swing. This catches a voice that moves around instead of sitting in one spot.

The final score is the highest of the three, shown in dB relative to centered mono: -40 dB is the faintest stereo, 0 dB is full width. A noise gate ignores silence, so muted mics and pauses between words score zero.

A single stereo moment does not mute anyone. Evidence builds up while the score is over the threshold and decays slowly, 4% per tick, so short pauses between words never reset progress. The mute happens when the evidence reaches the sensitivity count and the trigger cooldown has passed.

A few safeguards prevent false mutes and stop the guard fighting you:

- **Join grace:** nobody is muted in the first second after their audio appears, so a person joining is always audible while their stream settles.
- **Unmute cooldown:** after the guard unmutes someone, or you unmute them by hand, including through Discord's mute icon, they are left alone for 5 seconds instead of being re-muted on the next scan.
- **Trigger cooldown:** at least 3 seconds between guard mutes for the same person.
- **Ignore list:** anyone on it is never muted. Your own user, bots, and optionally friends are ignored automatically.

If someone the guard muted is no longer muted, the guard treats that as an unmute and backs off for the cooldown instead of re-muting them.

## Settings

- **Enabled.** Turns the guard on and off. Default on.
- **Threshold.** The score in dB that counts as not mono. -40 catches even a hint of panning or reverb, -4 only heavy stereo. Lower is stricter. Default -22.
- **Sensitivity.** How much non-mono audio is needed before a mute. Higher reacts to shorter and quieter stereo bits. 1 to 10, default 7.
- **Auto unmute.** Seconds until a guard mute lifts. 0 keeps the person muted until you unmute them. Default 0.
- **Ignore friends.** Never mute people on your friends list. Default on.
- **Notify.** Show a toast when the guard mutes or unmutes someone. Default on.

## Live panel

Stereo Guard adds a panel to its plugin settings:

- **Live stereo scores** for everyone in the call, one bar per person with a thin line marking your threshold. Red bars are over the threshold.
- **Ignore / Allow** button per person to add or remove them from the never mute list.
- **Muted by the guard** list with an Unmute button per person and an Unmute all button.
- **Never muted** list with an Allow again button per person.

The ignore list is saved with Discord's DataStore, so it survives restarts.

## Installation

Stereo Guard is a user plugin for Vencord or Equicord, and it is built into Kurtcord, where it can be managed from Plugins, Stereo Guard.

For Vencord or Equicord:

1. Clone the plugin into the userplugins folder:
   ```
   git clone https://github.com/kurtzonaudio/stereo-guard src/userplugins/StereoGuard
   ```
2. Build the client:
   ```
   pnpm build
   ```
3. Restart Discord and enable Stereo Guard in Settings, Plugins.

If you use a prebuilt client, copy the repository folder into its source tree under `src/userplugins/StereoGuard` before building.

## Notes and limits

- The guard mutes locally. It does not report anyone, block them, or change what anyone else hears.
- It analyzes the audio after it is decoded, so it sees exactly what your ears get.
- A genuinely stereo microphone, a wide pitch shift, or a heavy reverb effect will trip it. That is the point, but use Ignore if you like how someone sounds.
- Panning swing needs a little history. A person who only pans briefly scores high while the window fills up, and a steady stereo voice scores for as long as it stays stereo.
- In Kurtcord, the allow list is also reachable by right-clicking a person and picking Allow through Stereo Guard.

## Kurtzon's Discord plugins

This plugin is part of the Kurtzon's Discord plugins set, which ships with [Kurtcord](https://github.com/kurtzonaudio/kurtcord) and also works in Vencord and Equicord:

- [Stereo Guard](https://github.com/kurtzonaudio/stereo-guard): locally mutes anyone whose audio is not fully mono.
- [Mic Spam Guard](https://github.com/kurtzonaudio/mic-spam-guard): locally mutes anyone who gets too loud or spams their mic.
- [Voice State Fix](https://github.com/kurtzonaudio/voice-state-fix): corrects stuck mute and deafen states on Discord's side.
- [Voice VU Meters](https://github.com/kurtzonaudio/voice-vu-meters): live volume meters next to everyone in a call.
- [Kurtcord Voice Panel](https://github.com/kurtzonaudio/kurtcord-voice-panel): a live Voice & Video panel in the user area.
- [Kurtcord Theme](https://github.com/kurtzonaudio/kurtcord-theme): the Kurtcord wallpaper theme.
- [Camera Unlock](https://github.com/kurtzonaudio/camera-unlock): unlocks the camera and Go Live buttons without the Stream permission.
- [Click To Unmute](https://github.com/kurtzonaudio/click-to-unmute): click a locally muted user's mute icon to unmute them.
- [Auto Cam Off](https://github.com/kurtzonaudio/auto-cam-off): turns your camera off when a staff member joins.

## License

MIT. Copyright (c) 2026 Kurtzon (Kurtzon Audio). See [LICENSE](LICENSE).

Built and maintained by Kurtzon.
