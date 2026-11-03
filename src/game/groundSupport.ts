export type GroundSample = { along: number; side: number; height: number };

// The car faces local -Z; local +X is its left side after the map heading transform.
export function supportAltitude(samples: GroundSample[], pitch: number, roll: number) {
  let minimum = -Infinity;
  for (const sample of samples) {
    const wheelRise = sample.along * Math.sin(pitch) - sample.side * Math.sin(roll) * Math.cos(pitch);
    minimum = Math.max(minimum, sample.height - wheelRise);
  }
  return minimum;
}
