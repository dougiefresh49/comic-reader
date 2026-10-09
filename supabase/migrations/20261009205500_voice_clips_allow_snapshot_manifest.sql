-- Casting moves (#786): let comic-voice-clips hold the snapshot manifest.
--
-- snapshotSample writes <voices.id>/snapshot.json next to the samples it
-- archives (writeManifest in src/lib/voice-slots/bucket.ts, as
-- application/json), and restore reads it back. The bucket allowed audio
-- types only, so every snapshot failed at the manifest upload and an archive
-- with backup on stopped before its DELETE. Found by the PR's live check.
-- Adds one MIME type; the audio types and the size limit are unchanged.

update storage.buckets
set allowed_mime_types = array['audio/mpeg', 'audio/mp4', 'audio/wav', 'application/json']
where id = 'comic-voice-clips';
