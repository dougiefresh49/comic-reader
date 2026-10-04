# Morphed / alt-form voices (MMPR rangers and similar)

Status: idea + recommended approach, not built (2026-08-20). Came out of the
voice-lab casting work in room-of-devs / jellyfin-streamline.

## The observation

Every Power Ranger casting reel we pulled from the 1993 series is the
civilian ("teenager") voice only. The morphed lines exist in the audio, but
they never got a character name: the cluster-naming pass identifies speakers
by FACE, and in the suit there is no face. Morphed dialogue either stayed as
unnamed `SPEAKER_xx` clusters or got dumped on whoever leads fights on screen
(Jason — which is exactly why his first reel was "all noise").

It is also acoustically different, not just louder: the same actors, but
ADR'd — shouted, compressed, often helmet/radio-filtered. Tommy is the
clearest case: soft and gentle in human form, deeper and more forceful as
the Green Ranger. Embedding-wise the two forms cluster apart.

## Recommendation: one clone per actor, "morphed" is a MODE

Don't clone a second voice per ranger first. Treat morphed as a delivery
mode layered on the civilian clone:

1. **Clone source**: civilian reels (cleanest, most dialogue). Per
   ElevenLabs' own cloning guidance ("for expressive IVC voices, vary
   emotional tones across the recording — include both neutral and dynamic
   samples"), **mix a few morphed shouted
   lines into the IVC sample set** so the clone has the range for the tags
   below. Keep the ratio civilian-heavy (roughly 4:1).
2. **Text layer** (the rewrite prompt): a `mode: morphed` flag → command
   register: short imperative sentences, exclamations, team call-outs
   ("Zack, take the left!"), and audio tags such as `[shouting]`,
   `[intense]`, `[battle cry]` at the top of the line. Civilian mode keeps
   the character's normal register and softer tags. The tag rules live in
   `src/lib/cue-rules.ts`.
3. **Voice settings per mode** (per request, same voice id): morphed →
   lower `stability`; civilian → the base settings. eleven_v4 uses only
   `stability` and `similarity_boost` and ignores `style`
   (`docs/prompting-elevenlabs-v4.md`). Today's override is per voice
   (`voices.voice_settings`), so a per-mode one would need building.
4. **Audio layer**: a "helmet" post-effect on playback — light band-pass
   (~300 Hz–4 kHz), short room reverb, gentle compression. This is most of
   what the show's post did. ffmpeg sketch:
   `-af "highpass=f=300,lowpass=f=4000,acompressor=threshold=-18dB:ratio=3,aecho=0.8:0.6:18:0.25"`

Only if a mode-switched voice still sounds wrong to the owner: clone a
second "morphed" voice from suited audio. It costs a voice slot per ranger
and the source is noisier.

## If we do want suited audio labeled

The naming pass can identify suited clusters by **suit colour** instead of
face — a one-line change to the vision prompt ("if the speaker is a
Power Ranger in costume, name them by suit colour: red=Jason, blue=Billy,
black=Zack, pink=Kimberly, yellow=Trini, green=Tommy"). Then the normal
purity → prototype → reassign pipeline applies and morphed reels fall out
the same way the civilian ones did.

## Applies beyond MMPR

Same pattern for any character with a transformed form (He-Man/Prince Adam,
super-forms in Sonic, armored/helmeted anyone): one clone, delivery mode +
effect, and only escalate to a second clone on evidence.
