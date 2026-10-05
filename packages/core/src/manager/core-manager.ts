// Manager: orchestrates the task-board workflow (sequence of use cases),
// delegating storage to Resource Access and board-move rules to the
// transition Engine. This is the one and only implementation of
// `CoreCommands`; frontends never see anything beneath this layer.

import type {
  CoreCommands,
  CreateTaskInput,
  MoveTaskOptions,
  UpdateTaskInput,
} from "../contracts/commands.js";
import type { BoardColumn, Task, TaskState } from "../contracts/model.js";
import { TASK_STATES } from "../contracts/model.js";
import type {
  Clock,
  IdGenerator,
  TaskStateAccess,
} from "../contracts/services.js";
import { groupColumnTasks } from "../engines/board-grouping.js";
import { assertAllowedTransition } from "../engines/task-transitions.js";
import type { CoreEventBus } from "../utilities/event-bus.js";

export interface CoreManagerDependencies {
  tasks: TaskStateAccess;
  clock: Clock;
  ids: IdGenerator;
  events: CoreEventBus;
}

const COLUMN_TITLES: Record<TaskState, string> = {
  backlog: "Backlog",
  dev: "Dev",
  awaiting: "Awaiting",
  done: "Done",
};

export class CoreManager implements CoreCommands {
  constructor(private readonly deps: CoreManagerDependencies) {}

  async listBoard(): Promise<BoardColumn[]> {
    const tasks = await this.deps.tasks.listTasks();
    return TASK_STATES.map((state) => {
      const columnTasks = tasks.filter((task) => task.state === state);
      return {
        state,
        title: COLUMN_TITLES[state],
        groups: groupColumnTasks(state, columnTasks),
      };
    });
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.deps.tasks.getTask(id);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const now = this.deps.clock.now().toISOString();
    const task: Task = {
      id: this.deps.ids.next(),
      kind: input.kind ?? "task",
      state: "backlog",
      title: input.title,
      initialPrompt: input.initialPrompt,
      ...(input.repositoryId !== undefined
        ? { repositoryId: input.repositoryId }
        : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.targetBranch !== undefined
        ? { targetBranch: input.targetBranch }
        : {}),
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
    };
    await this.deps.tasks.createTask(task);
    await this.publishTaskChange(task);
    return task;
  }

  async moveTask(
    id: string,
    state: TaskState,
    options?: MoveTaskOptions,
  ): Promise<Task> {
    const task = await this.requireTask(id);
    assertAllowedTransition(task.state, state);
    if (state === "awaiting" && !options?.awaiting) {
      throw new Error(
        'Moving a task to "awaiting" requires an awaiting reason',
      );
    }
    const now = this.deps.clock.now().toISOString();
    const stateChanged = task.state !== state;
    const next: Task = {
      ...task,
      state,
      updatedAt: now,
      stateChangedAt: stateChanged ? now : task.stateChangedAt,
      ...(state === "done" ? { completedAt: task.completedAt ?? now } : {}),
    };
    if (state === "awaiting" && options?.awaiting) {
      next.awaiting = options.awaiting;
    } else {
      delete next.awaiting;
    }
    await this.deps.tasks.replaceTask(next);
    await this.publishTaskChange(next);
    return next;
  }

  async updateTaskState(id: string, patch: UpdateTaskInput): Promise<Task> {
    const task = await this.requireTask(id);
    const now = this.deps.clock.now().toISOString();
    const next: Task = { ...task, ...patch, updatedAt: now };
    await this.deps.tasks.replaceTask(next);
    await this.publishTaskChange(next);
    return next;
  }

  async deleteTask(id: string): Promise<void> {
    await this.requireTask(id);
    await this.deps.tasks.removeTask(id);
    await this.publishBoard();
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.deps.tasks.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  private async publishTaskChange(task: Task): Promise<void> {
    this.deps.events.emit("task-changed", { task });
    await this.publishBoard();
  }

  private async publishBoard(): Promise<void> {
    const columns = await this.listBoard();
    this.deps.events.emit("board-changed", { columns });
  }
}
