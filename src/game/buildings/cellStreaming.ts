// Distance to a cell's extent, not its center: large blocks must not switch beside the car.
export function cellDistance(x: number, z: number, focusX: number, focusZ: number, size: number) {
  return Math.hypot(Math.max(0,Math.abs(x-focusX)-size/2),Math.max(0,Math.abs(z-focusZ)-size/2));
}
export function deferCellReplacement(distance: number, sameStyle: boolean, exists: boolean, groundShift = 0) {
  if (groundShift >= 8) return false;
  return exists && sameStyle && distance < 260;
}
