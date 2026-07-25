# Upstream WebKitGTK bug report drafts

Three draft reports for https://bugs.webkit.org (product: WebKit, component: Media),
written 2026-07-25 from the investigations recorded in
`docs/design/pcm-buffer-playback.md` (Ninth/Tenth mechanisms) and the WebCodecs
feasibility spike. File them as three separate bugs — they are distinct defects.

All three occurred on:
- WebKitGTK **2.52.3** (`libwebkit2gtk-4.1-0 2.52.3-0ubuntu0.24.04.1`), Ubuntu 24.04
- GStreamer 1.24.2 (distro packages)
- Wayland session; app runs with `WEBKIT_DISABLE_DMABUF_RENDERER=1`

| Draft | Severity | Reproducibility |
|---|---|---|
| `videoencoder-crash.md` | Web process SIGABRT | 100%, minimal standalone script included |
| `mediaplayer-seek-deadlock.md` | Permanent main-thread deadlock | Intermittent (probabilistic race); gdb backtrace evidence |
| `nonunity-rate-eos-stall.md` | Video element stalls near EOS | ~2/3 at rate 0.87; control at 1.0 never fails |

Filing notes:
- The deadlock report is much stronger with the full 39-thread `gdb` backtrace from
  the 2026-07-24 incident attached. If the pasted transcript from that session was
  saved anywhere, attach it verbatim; the draft contains the load-bearing frames.
- The encoder-crash report can be verified by any triager in under a minute — file
  that one first; a confirmed account helps the other two get attention.
