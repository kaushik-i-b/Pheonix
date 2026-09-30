/**
 * `@phoenix/shared` — the contract layer.
 *
 * Every Phoenix package, app and artifact schema is defined here. Nothing in this package may
 * import from another Phoenix package: it is the root of the dependency graph, and keeping it
 * dependency-free (apart from zod) is what allows artifacts to be validated anywhere, including
 * inside the dashboard and the scoring scripts.
 */

export * from './primitives.js';
export * from './paths.js';
export * from './errors.js';
export * from './logging.js';
export * from './roles.js';
export * from './artifact.js';
export * from './run.js';
export * from './events.js';
export * from './agent.js';
export * from './llm.js';
export * from './discovery.js';
export * from './specification.js';
export * from './scenario.js';
export * from './characterization.js';
export * from './differential.js';
export * from './adversarial.js';
export * from './design.js';
export * from './evidence.js';
export * from './verification.js';
