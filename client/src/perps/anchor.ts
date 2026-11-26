/**
 * Anchor loader that works from Node (NodeNext ESM, where the CJS build only
 * exposes `default`) and from Vite (ESM build, named exports). No DOM access.
 */
import * as anchorNs from "@coral-xyz/anchor";

type Anchor = typeof anchorNs;
export const anchor: Anchor = ((anchorNs as unknown as { default?: Anchor }).default ?? anchorNs) as Anchor;
export const BN = anchor.BN;
export type BN = anchorNs.BN;
export type Idl = anchorNs.Idl;
