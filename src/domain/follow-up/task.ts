// Follow-up Task aggregate (stream task-<taskId>). FHIR-Task-style: a task starts in status
// "requested" (the status is derived by the visit_schedule read model; the event carries none).
// Pure and idempotent: creating the same task again decides nothing.
import { z } from "zod";
import { DomainError, type Aggregate } from "../aggregate";
import type { DomainEvent } from "../events";
import { invalidCommand } from "../patient/patient";

const id = z.string().min(1).max(200);

export const taskStreamId = (taskId: string) => `task-${taskId}`;
/** One follow-up task per visit (derived from the visit id so it cannot collide across visits). */
export const followUpTaskId = (visitId: string) => `fu-${visitId}`;

export const CreateFollowUpTaskSchema = z.object({ taskId: id, patientId: id, visitId: id });
export type CreateFollowUpTask = { type: "CreateFollowUpTask" } & z.input<
  typeof CreateFollowUpTaskSchema
>;

export interface TaskState {
  created: boolean;
  patientId: string | null;
  visitId: string | null;
}
export const taskInitialState: TaskState = { created: false, patientId: null, visitId: null };

export function evolveTask(state: TaskState, event: DomainEvent): TaskState {
  if (event.type !== "FollowUpTaskCreated" || state.created) return state;
  return { created: true, patientId: event.data.patientId, visitId: event.data.visitId ?? null };
}

export function decideTask(state: TaskState, command: CreateFollowUpTask): DomainEvent[] {
  const { type: _type, ...payload } = command;
  void _type;
  const parsed = CreateFollowUpTaskSchema.safeParse(payload);
  if (!parsed.success) invalidCommand(parsed.error);
  const c = parsed.data;
  if (state.created) {
    if (state.patientId === c.patientId && state.visitId === c.visitId) return [];
    throw new DomainError("TASK_CONFLICT", "task id already used for a different visit");
  }
  return [
    {
      type: "FollowUpTaskCreated",
      data: { v: 1, taskId: c.taskId, patientId: c.patientId, visitId: c.visitId },
    },
  ];
}

export const taskAggregate: Aggregate<TaskState, CreateFollowUpTask> = {
  initialState: taskInitialState,
  decide: decideTask,
  evolve: evolveTask,
};
