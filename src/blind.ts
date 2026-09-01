/**
 * Invariant I2, enforced by construction.
 *
 * The blind pass must never see the spec. Making the prompt not mention it is
 * not enforcement — the next contributor adds one attachment and the invariant
 * is gone with nothing to notice it. So the blind pass does not accept an
 * Evidence object at all. It accepts a BlindPacket, and the only way to obtain
 * one is `blindPacket()`, which copies across exactly two fields.
 *
 * The brand matters: without it, TypeScript's structural typing would let a
 * full Evidence value satisfy the packet shape, since Evidence also has `diff`
 * and `transcript`. The brand makes that a compile error.
 */
import type { Evidence } from "./types.ts";
import type { Attachment } from "./judges/index.ts";

declare const blindPacketBrand: unique symbol;

export interface BlindPacket {
  readonly diff: string;
  readonly transcript: string | null;
  readonly [blindPacketBrand]: true;
}

/** The only constructor. Copies two fields; the spec is not one of them. */
export function blindPacket(ev: Evidence): BlindPacket {
  return { diff: ev.diff, transcript: ev.transcript } as BlindPacket;
}

/** The only attachment builder the blind pass uses. */
export function blindAttachments(packet: BlindPacket): Attachment[] {
  return [
    { name: "DIFF", content: packet.diff, lang: "diff" },
    { name: "TRANSCRIPT", content: packet.transcript ?? "" },
  ];
}
