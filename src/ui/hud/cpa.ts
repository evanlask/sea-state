// Closest point of approach between two vessels on straight courses, as an ARPA radar works
// it out: CPA (metres) and TCPA (seconds, negative once the closest point has passed).

export interface VesselTrack {
  x: number; // m east
  y: number; // m north
  vx: number; // m/s east
  vy: number; // m/s north
}

// A track from a bearing/range fix (relative to an origin) and a course and speed.
export function trackFrom(bearing: number, range: number, course: number, speed: number): VesselTrack {
  return {
    x: Math.sin(bearing) * range,
    y: Math.cos(bearing) * range,
    vx: Math.sin(course) * speed,
    vy: Math.cos(course) * speed,
  };
}

export interface Approach {
  cpa: number; // m
  tcpa: number; // s; 0 when the vessels are not moving relative to each other
  range: number; // m now
}

export function closestApproach(own: VesselTrack, other: VesselTrack): Approach {
  const rx = other.x - own.x;
  const ry = other.y - own.y;
  const vx = other.vx - own.vx;
  const vy = other.vy - own.vy;
  const range = Math.hypot(rx, ry);
  const v2 = vx * vx + vy * vy;
  if (v2 < 1e-9) return { cpa: range, tcpa: 0, range };
  const tcpa = -(rx * vx + ry * vy) / v2;
  return { cpa: Math.hypot(rx + vx * tcpa, ry + vy * tcpa), tcpa, range };
}
