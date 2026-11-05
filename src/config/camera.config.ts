export const cameraConfig = {
  distance: 15,
  minDistance: 8,
  /** zoom out far enough to spot bots a few blocks ahead */
  maxDistance: 110,
  /** while holding fire, chase distance eases toward this (m) */
  aimDistance: 9,
  pitch: 73,
  minPitch: 28,
  maxPitch: 74,
  lookAheadFactor: 1.32,
  maxZoom: 20.85,
  minZoom: 15.6,
  zoomAtDefault: 20.55,
};

// Vector tiles stop at zoom 14. A true 14 m camera asks MapLibre for zoom 22,
// and fill-extrusion then disappears. Keep the chase distance in meters, but
// map it into the zoom band where streets and buildings still draw.
// The chase zoom was tuned near 40° N. Mercator packs high latitudes tighter,
// so the same zoom puts the camera in front of the car and hides it.
const REFERENCE_LATITUDE = 40 * Math.PI / 180;

export function zoomForDistance(distance: number, latitude = 40) {
  const zoom = cameraConfig.zoomAtDefault - Math.log2(distance / cameraConfig.distance) * 0.92;
  const latitudeScale = Math.cos(latitude * Math.PI / 180) / Math.cos(REFERENCE_LATITUDE);
  const adjusted = zoom + Math.log2(Math.max(0.08, latitudeScale));
  return Math.min(cameraConfig.maxZoom, Math.max(cameraConfig.minZoom, adjusted));
}
