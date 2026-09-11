import type { ReadingClaim, ReadingContext } from '../readings/types.ts';
import { toReadingContext } from '../readings/snapshot.ts';

export function contextForClaim(claim: ReadingClaim): ReadingContext {
  return toReadingContext(claim.snapshot);
}
