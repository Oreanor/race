export type CameraView = {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  elevation: number;
};

/** Starts at the visible frame, with zero speed and acceleration at both ends. */
export function cameraTransition(from: CameraView, to: CameraView, progress: number): CameraView {
  const t = Math.max(0, Math.min(1, progress));
  const eased = t * t * t * (t * (t * 6 - 15) + 10);
  const mix = (a: number, b: number) => a + (b - a) * eased;
  const turn = ((to.bearing - from.bearing + 180) % 360 + 360) % 360 - 180;
  return {
    center: [mix(from.center[0], to.center[0]), mix(from.center[1], to.center[1])],
    zoom: mix(from.zoom, to.zoom),
    pitch: mix(from.pitch, to.pitch),
    bearing: from.bearing + turn * eased,
    elevation: mix(from.elevation, to.elevation),
  };
}
