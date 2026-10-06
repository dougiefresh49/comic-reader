# TMNT × MMPR — ElevenLabs casting handoff (2026-08-21)

Prepared by the voice-lab session. **Nothing in ElevenLabs or the DB has been replaced** except the one test clone (Raphael 1990 v3). The comic-reader agent owns the actual swap (IDs, registry, DB rows) — the owner says there are nuances there that this package does not attempt.

## Where things are

- Clone-source audio: in the voice-lab library on the owner's machine, one reel per character (all ≤ 1 MB, 31–90 s, owner trim notes already applied). Paths and file names stay out of this public repo.
- `elevenlabs-voices-snapshot.json` (this folder): every existing own voice — `voice_id`, category, **description, labels, settings** — fetched 2026-08-21. Replacement voices must carry the same description + labels so they are drop-in (owner rule). Voice-design voices keep their prompt in `description`, so they can be recreated later (archive-and-restore).
- Audition reels + owner verdicts: labeler `http://<mac>:4310/reels/tmnt` and `/reels/power-rangers` (verdicts in `clips/montage-verdicts.json`).
- Morphed Ranger voices: `docs/morphed-voice-modes.md` (one clone per actor; morphed = prompt register + v3 tags + helmet filter).

## Account state

- Creator tier, **30/30 voice slots used** (29 before the Raphael test). Every replacement is delete-old → add-new → copy description/labels → swap the ID in the DB. Deleting first is required — there is no free slot.
- All 30 voices are on default settings (stability 0.5 / similarity 0.75 / style 0 / speaker boost on). The settings the owner liked for Raphael 1990 v3 were set in the UI's generation panel and are **not persisted per voice** — ask the owner for the values before bulk-generating.
- Owner judged EL Audio Isolation on the Raph reel "good mostly, not great in parts" → clone from the raw files, `remove_background_noise=false`.
- API used for the test (key in comic-reader `.env`): `POST /v1/voices/add` multipart `name`, `files`, `description`, `labels` (JSON string), `remove_background_noise`; `POST /v1/voices/{id}/edit` for description/labels; `DELETE /v1/voices/{id}`.

## Status legend

`casting` = source/era still undecided or reel unjudged · `approved` = owner-approved reel, not scheduled for a slot · `ready to clone` = approved file + known target voice, just needs the swap · `cloned` = EL voice exists

## Cast

| Character | Source reel | s | Replaces | Carry over | Status | Notes |
|---|---|---|---|---|---|---|
| Raphael | TMNT 1990 | 38 | **Raph v2** `RbsOf5RuEmcgV4XgAWDA` (cloned) | labels: accent=en-new-york, language=en<br>desc: Young adult male. Thick Brooklyn / New York accent. Low-to-mid pitch with significant gravel and rasp. Aggressive, tough, and cynical tone. 'Street' tough quality. Sounds physically imposing and muscular. Sarcastic delivery. | **cloned** | NEW voice created, **owner-approved and tested in the room 2026-08-21** ("really good and clean"): **Raphael 1990 v3 = `66KaORPuFP0qLgNZk7im`** (owner set labels/description in the EL UI). Remaining: swap the ID in the DB/registry, then delete Raph v2 to free the slot. |
| Leonardo | TMNT 1990 | 32 | **Leonardo** `1sca4ecJ4XyU7M176Ei0` (generated) | labels: none<br>desc: A clear, young adult male voice with an American accent. It is disciplined and authoritative, reflecting his leadership role with a generally serious and focused tone. | **ready to clone** | Replaces the text-designed Leo. Only 32s (film has little clean Leo) — works for IVC; a Secret-of-the-Ooze top-up (same actor, Brian Tochi) is possible if it sounds thin. |
| April O'Neil | TMNT 1990 or TMNT 2012 | 83 | — (new) | — write new | **casting** | No April voice exists in EL. Both reels are owner-approved; pick the era (1990 Judith Hoag 83s / 2012 Mae Whitman 85s). Needs a fresh description + labels. |
| Bebop | TMNT 2012 (fallback) | 86 | **Bebop 2** `FCFJMCa9ZFu4325AUU3w` (generated) | labels: language=en<br>desc: A nasally, medium-pitched Mutated Warthog Humanoid male voice with a thick, exaggerated Brooklyn accent. It sounds like a street-smart but dim-witted punk goon from the 80s, blending roughness with a goofy quality. | **casting** | Owner wants the Bay *Out of the Shadows* (2016) Bebop — no source ripped yet. The 2012 reel (last clip dropped per owner note) is approved as a fallback. |
| Rocksteady | TMNT 2012 (fallback) | 46 | **Rocksteady** `FBptoKFxS8EhO4XO87xt` (generated) | labels: none<br>desc: A deep, gravelly, brutish male voice, characterized by a rough, unintelligent street-thug accent. It projects a tough, aggressive persona, befitting a powerful yet dim-witted henchman. | **casting** | Same as Bebop: Bay version wanted, source missing. 2012 reel trimmed (3–8s, 25–28s sfx removed) approved as fallback. |
| Master Splinter | TMNT 1990 (alternate) | 81 | **Master Splinter v2** `6G3IoJHUBafcI3SyzELE` (cloned) | labels: age=middle-aged, accent=en-japanese, language=en, gender=male<br>desc: Middle-aged to older male. Deep bass/baritone range. extremely resonant and chest-heavy. Commanding, stoic, and wise. Very slow, deliberate pacing. Slight Transatlantic or refined Asian-American accent influence. Warm but intimidating. | **approved** | Owner keeps the 2012 IVC. 1990 reel (Kevin Clash, 81s) is approved and staged only as an alternate. |
| Shredder | TMNT 1990 (alternate) | 31 | **Shredder v2** `zyz29XaJBhGHDfyrCD7d` (cloned) | labels: accent=en-japanese, language=en<br>desc: (empty) | **approved** | Owner keeps the 2012 IVC. 1990 reel staged as an alternate (31s). |
| Casey Jones | TMNT 1990 | 57 | — | — write new | **approved** | Approved reel, no registry character for this book — only if the script needs him. |
| Baxter Stockman | TMNT 2012 | 43 | — | — write new | **casting** | Registry lists 9 possible appearances, none voiced. 2012 reel exists but is NOT yet judged on the labeler. |
| Red Ranger (Jason) | MMPR 1993 | 88 | **Red Ranger** `R8tHGp6yBIKs45odIPD1` (generated) | labels: none<br>desc: A heroic and confident young adult male voice with a distinct American accent. It carries a natural leadership tone but is versatile enough to convey a range of emotions from casualness to intense desperation. | **ready to clone** | Civilian voice (Austin St. John). Morphed delivery = mode, not a second clone — see ../../../docs/morphed-voice-modes.md. |
| Blue Ranger (Billy) | MMPR 1993 | 88 | **Blue Ranger** `eggrlJySU29RodqjhIkX` (generated) | labels: none<br>desc: A youthful, intelligent male voice, clear and articulate, with a calm and measured delivery. Despite his composed demeanor, an underlying tone of concern often permeates his speech, reflecting his thoughtful and serious nature. | **ready to clone** |  |
| Black Ranger (Zack) | MMPR 1993 | 87 | **Black Ranger** `cuy9NDFuCyOdZU0vkcym` (generated) | labels: none<br>desc: A young adult male voice with a clear American accent. It has a smooth, confident, and engaging tone, reflecting his heroic and charismatic personality. | **ready to clone** |  |
| Pink Ranger (Kimberly) | MMPR 1993 | 90 | **Pink Ranger** `E8CavmYRhEEZqRb2s4nt` (generated) | labels: none<br>desc: A clear, youthful American female voice. It should sound articulate and natural, capable of conveying a range from calm and conversational to serious or slightly concerned tones. | **ready to clone** |  |
| Yellow Ranger (Trini) | MMPR 1993 | 90 | **Yellow Ranger** `hBYwgU1d9wzr397yTscG` (generated) | labels: none<br>desc: A young, energetic female voice with a clear American accent. She speaks with a lively and spirited tone, reflecting her youthful enthusiasm. | **ready to clone** |  |
| Green Ranger (Tommy) | MMPR 1993 | 86 | **Green Ranger** `fDCFh0Z04XCcSmBoHT4j` (generated) | labels: none<br>desc: A confident, heroic young adult male voice with an American accent. It possesses a strong, disciplined tone, capable of conveying both youthful energy and sincere determination, with a slight underlying rough edge. | **ready to clone** | Tommy is the clearest civilian-vs-morphed split; mix a few shouted lines into the IVC samples if the morphed mode sounds weak. |
| Zordon | MMPR 1993 | 89 | **Zordon** `NvO7pjO09CWuF87LH2iA` (generated) | labels: none<br>desc: Zordon's voice is deep, booming, resonant, and authoritative, embodying a wise male presence. It possesses a slight ethereal quality, hinting at his bodiless form, and occasionally carries a subtle electronic echo. | **ready to clone** | Source already has the tube reverb baked in — that is the character. |
| Alpha 5 | MMPR 1993 | 85 | **Alpha 5** `G4FycwjZbrUlO5rnrTGm` (generated) | labels: none<br>desc: A high-pitched, robotic voice with a distinct electronic filter, conveying a neurotic and anxious personality. | **ready to clone** |  |
| Rita Repulsa | MMPR 1993 | 84 | **Rita Repulsa** `fpszSg5AsrBuI5R9aidj` (generated) | labels: none<br>desc: A shrill, raspy female voice with a strong theatrical quality. It should convey a wicked, commanding, and sharp presence, embodying her villainous authority. | **ready to clone** |  |
| Lord Zedd | MMPR 1993 | 84 | **Lord Zedd** `xZHSfy1jtZKEX5ypvdGU` (generated) | labels: none<br>desc: A deep, gravelly, booming, and terrifying male voice with a commanding and authoritative tone. | **ready to clone** |  |
| Goldar | MMPR 1993 | 88 | — (new) | — write new | **ready to clone** | No existing EL voice or registry entry — new character, needs a description. |
| Bulk | MMPR 1993 | 90 | — | — write new | **casting** | Registry says needs_clips. Verified reel built 2026-08-21 from 999s of filed Bulk, NOT yet judged — listen on /reels/power-rangers. |
| Skull / Squatt | `—` | — | — | — write new | **casting** | Only ~66s filed each in the corpus, below the reel floor. Needs more episodes or a YouTube pull. |
| Krang | `—` | — | — | — write new | **casting** | No 1987 Krang in the corpus (2012 Kraang is a different voice). Needs a source. |

## Suggested order

1. Finish Raphael: DB/registry → `66KaORPuFP0qLgNZk7im`, delete **Raph v2** → 1 slot free.
2. Rangers ×6 + Zordon/Alpha/Rita/Zedd (10 swaps, each frees its own slot as it goes).
3. Leonardo (replace the voice-design), Goldar (new — needs a slot: delete an unused voice-design such as Warbunny/Rock Soldier/Armored Villain, prompts are in the snapshot).
4. April once the era is picked; Bebop/Rocksteady once the Bay source exists (or promote the 2012 fallbacks).

Unjudged reels to listen to first: Bulk, Baxter Stockman, and the two April options.