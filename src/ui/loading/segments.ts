// Groups loading tasks into progress-bar segments, one per kind, in load order. Pure, so
// the loading screen's DOM code only has to draw what this returns.

import { TASK_KINDS, type TaskKind, type TaskState } from '../../app/loading/types';

type SegmentState = 'pending' | 'active' | 'done' | 'failed';

export interface Segment {
  readonly kind: TaskKind;
  readonly label: string;
  // Share of the bar's width, 0..1; segments sum to 1.
  readonly share: number;
  // How full this segment is, 0..1.
  readonly fill: number;
  readonly state: SegmentState;
  // Active, but nothing running in it can report progress, so it shimmers.
  readonly indeterminate: boolean;
}

const SEGMENT_LABELS: Readonly<Record<TaskKind, string>> = {
  download: 'Downloads',
  decode: 'Decoding',
  compile: 'Shaders',
  compute: 'Simulation setup',
  warmup: 'Warm-up',
};

export function buildSegments(tasks: readonly TaskState[]): Segment[] {
  const groups = TASK_KINDS.map((kind) => ({
    kind,
    tasks: tasks.filter((task) => task.kind === kind),
  })).filter((group) => group.tasks.length > 0);
  const weightOf = (group: (typeof groups)[number]): number =>
    group.tasks.reduce((sum, task) => sum + task.weight, 0);
  const totalWeight = groups.reduce((sum, group) => sum + weightOf(group), 0);

  return groups.map((group) => {
    const weight = weightOf(group);
    const running = group.tasks.filter((task) => task.status === 'running');
    let filled = 0;
    for (const task of group.tasks) {
      if (task.status === 'done') filled += task.weight;
      else if (task.status !== 'pending') filled += task.weight * (task.progress ?? 0);
    }
    const state: SegmentState = group.tasks.some((task) => task.status === 'failed')
      ? 'failed'
      : running.length > 0
        ? 'active'
        : group.tasks.every((task) => task.status === 'done')
          ? 'done'
          : 'pending';
    return {
      kind: group.kind,
      label: SEGMENT_LABELS[group.kind],
      // Zero weights everywhere would collapse the bar; share it evenly instead.
      share: totalWeight > 0 ? weight / totalWeight : 1 / groups.length,
      fill: state === 'done' ? 1 : weight > 0 ? Math.min(1, filled / weight) : 0,
      state,
      indeterminate: state === 'active' && running.every((task) => task.progress === null),
    };
  });
}
