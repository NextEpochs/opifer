/**
 * Work (M3): goals, projects, tasks with atomic checkout and leases,
 * comments, results, wake-ups.
 */

export { WorkService, WorkError } from "./service.js";
export type { WorkServiceOptions } from "./service.js";
export type {
  Actor,
  ActorKind,
  CheckoutOutcome,
  Goal,
  GoalStatus,
  Project,
  ProjectStatus,
  Task,
  TaskComment,
  TaskPriority,
  TaskResult,
  TaskStatus,
  Wakeup,
  WakeupReason,
  WakeupStatus,
  WhyChain,
  WorkProduct,
  WorkProductKind,
} from "./types.js";
export { taskTools, describeTask, TASK_GUIDE } from "./tools.js";
