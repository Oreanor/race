export type GroundSample = { along: number; side: number; height: number };

/** Losing a large support drop is a fall even at rest or at walking speed. */
export function leavesSupport(altitude: number, ground: number, velocity: number, dt: number, speed: number, ramp: boolean) {
  const predicted = altitude + velocity * dt - 0.5 * 9.81 * dt * dt;
  return ground < predicted - 0.3 && (altitude - ground > 0.75 || speed > 5 || ramp);
}

/** Gravity for other vehicles, rather than snapping them to a new ground height. */
export function fallingVehicle(altitude: number, velocity: number, ground: number | null, dt: number) {
  if (ground == null) return { altitude, velocity, falling: false, landed: false };
  if (altitude - ground <= 0.3 && velocity >= 0) return { altitude: ground, velocity: 0, falling: false, landed: false };
  const next = altitude + velocity * dt - 0.5 * 9.81 * dt * dt;
  if (next <= ground) return { altitude: ground, velocity: 0, falling: false, landed: true };
  return { altitude: next, velocity: velocity - 9.81 * dt, falling: true, landed: false };
}

// The car faces local -Z; local +X is its left side after the map heading transform.
export function supportAltitude(samples: GroundSample[], pitch: number, roll: number) {
  let minimum = -Infinity;
  for (const sample of samples) {
    const wheelRise = sample.along * Math.sin(pitch) - sample.side * Math.sin(roll) * Math.cos(pitch);
    minimum = Math.max(minimum, sample.height - wheelRise);
  }
  return minimum;
}
