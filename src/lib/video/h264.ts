/**
 * H.264 Annex-B <-> avc helpers shared by codecWorker.ts (phase 2 playback) and
 * App.svelte's probeWebCodecs debug hook (phase 1 verification) — one source of truth
 * for the NAL-splitting / AVCDecoderConfigurationRecord logic proven live against real
 * demux output in phase 1. See docs/design/webcodecs-video-path.md "Phase 1 results":
 * WebKitGTK's hardware (vah264dec) H.264 WebCodecs decode requires avc mode
 * (`description` + length-prefixed chunks) — raw Annex-B without a description decodes
 * zero frames on this app's real config.
 */

export interface Nal {
  type: number;
  bytes: Uint8Array;
}

/** One access unit as returned by media_server.rs's `/demux/<deck>/aus` binary framing. */
export interface Au {
  key: boolean;
  ptsUs: number;
  durUs: number;
  data: Uint8Array;
}

/**
 * Splits Annex-B byte-stream data (one or more start-code-delimited NAL units) into
 * individual NALs. Trims the zero_byte padding Annex-B allows before a start code —
 * spec-mandated, not a heuristic.
 */
export function splitAnnexBNals(data: Uint8Array): Nal[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) starts.push(i + 3);
  }
  const nals: Nal[] = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : data.length;
    while (end > start && data[end - 1] === 0) end--;
    if (end > start) nals.push({ type: data[start] & 0x1f, bytes: data.slice(start, end) });
  }
  return nals;
}

export function findSpsAndPps(nals: Nal[]): { sps: Nal | undefined; pps: Nal | undefined } {
  return { sps: nals.find((n) => n.type === 7), pps: nals.find((n) => n.type === 8) };
}

/**
 * Builds an AVCDecoderConfigurationRecord `description` from one SPS/PPS pair — the
 * format WebKitGTK's hardware H.264 WebCodecs decode path requires (see module doc
 * comment above).
 */
export function buildAvcDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const description = new Uint8Array(11 + sps.length + pps.length);
  let o = 0;
  description[o++] = 1; // configurationVersion
  description[o++] = sps[1]; // AVCProfileIndication
  description[o++] = sps[2]; // profile_compatibility
  description[o++] = sps[3]; // AVCLevelIndication
  description[o++] = 0xff; // reserved(6)=111111 | lengthSizeMinusOne=3 (4-byte length prefix)
  description[o++] = 0xe1; // reserved(3)=111 | numOfSequenceParameterSets=1
  description[o++] = (sps.length >> 8) & 0xff;
  description[o++] = sps.length & 0xff;
  description.set(sps, o);
  o += sps.length;
  description[o++] = 1; // numOfPictureParameterSets
  description[o++] = (pps.length >> 8) & 0xff;
  description[o++] = pps.length & 0xff;
  description.set(pps, o);
  return description;
}

/**
 * Re-muxes one Annex-B AU (start-code-delimited) to avc (length-prefixed, parameter-set
 * NALs stripped) — required per-chunk once `description` is configured. Done once per
 * chunk in the decode-ahead worker, not per-frame in a hot path.
 */
export function annexBToAvc(data: Uint8Array): Uint8Array {
  const slices = splitAnnexBNals(data).filter((n) => n.type === 1 || n.type === 5);
  const out = new Uint8Array(slices.reduce((n, s) => n + 4 + s.bytes.length, 0));
  let p = 0;
  for (const s of slices) {
    const len = s.bytes.length;
    out[p++] = (len >>> 24) & 0xff;
    out[p++] = (len >>> 16) & 0xff;
    out[p++] = (len >>> 8) & 0xff;
    out[p++] = len & 0xff;
    out.set(s.bytes, p);
    p += len;
  }
  return out;
}

/**
 * Parses the binary body of `GET /demux/<deck>/aus` (media_server.rs): concatenated
 * per-AU records `[u32 le length][u8 flags(bit0=key)][i64 le pts_us][i64 le dur_us][data...]`.
 */
export function parseAuFrames(bytes: Uint8Array): Au[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const aus: Au[] = [];
  let off = 0;
  while (off + 21 <= bytes.length) {
    const len = view.getUint32(off, true); off += 4;
    const flags = view.getUint8(off); off += 1;
    const ptsUs = Number(view.getBigInt64(off, true)); off += 8;
    const durUs = Number(view.getBigInt64(off, true)); off += 8;
    const data = bytes.slice(off, off + len); off += len;
    aus.push({ key: (flags & 1) !== 0, ptsUs, durUs, data });
  }
  return aus;
}
