# rdclient WebCodecs black-screen fix

Path: web-nodejs/public/js/rdclient/

## Root cause (black screen, 0 FPS on HTTPS / native RustDesk)
- On HTTPS (port 5443) browser is secure context -> WebCodecs VideoDecoder path (NOT JMuxer).
- VideoDecoder requires the FIRST chunk after configure() to be a keyframe. A leading
  delta/P-frame throws "A key frame is required after configure()" -> no output.
- Deltas kept resetting _lastVideoFrameTime, so the 3s stall-recovery never fired ->
  refresh_video keyframe never requested -> permanent black screen. 0x0 remote size
  also breaks input coordinate mapping (commands appear dead).

## Fix (commit 9c83917)
- video.js: `_needKeyframe` gate after configure() drops deltas until first key;
  dedicated `_decodeInputCount` for monotonic chunk timestamps; drop deltas when
  decodeQueueSize>30; `_handleError` rebuilds decoder with software fallback
  (`_softwareRetry`) + sets _needKeyframe; init() probes codec support without
  forcing prefer-hardware. `onNeedKeyframe` callback added.
- client.js _startSession: wires `video.onNeedKeyframe -> buildMisc('refreshVideo', true)`,
  sends initial keyframe request, stall-recovery also fires when peer frames arrive
  but decoder output (video.frameCount) stays 0 for >2s.

## Proto facts
- message.proto: `bool refresh_video = 10;` -> buildMisc('refreshVideo', true) is correct.
- Mouse mask must be TYPE | (BUTTON << 3) (RustDesk: button=mask>>3, type=mask&7).
- cacheVersion = appVersion + Date.now() (server.js) -> service restart busts browser cache.
