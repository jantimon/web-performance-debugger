// A stand-in for react-dom's server build: functions NAMED like the probe-verified server-phase
// anchors the `react` addon rolls self-time onto (renderWithHooks / renderElement / pushStartInstance)
// It resolves to package "react-dom" (its sibling package.json name), so the node-lane phase rollup
// attributes these frames the same way it would a real react-dom 19 production server build. The busy
// loop is INLINE in each anchor (not a shared helper), so the sampler bills self-time to the anchor
// name, not to a callee. Not real React

export function renderWithHooks() {
  let accumulator = 0;
  for (let index = 0; index < 4_000_000; index++) accumulator += Math.sqrt(index * 2.5) % 7;
  return accumulator;
}

export function renderElement() {
  let accumulator = 0;
  for (let index = 0; index < 2_000_000; index++) accumulator += Math.sqrt(index * 1.5) % 7;
  return accumulator;
}

export function pushStartInstance() {
  let accumulator = 0;
  for (let index = 0; index < 1_000_000; index++) accumulator += Math.sqrt(index * 3.5) % 7;
  return accumulator;
}
