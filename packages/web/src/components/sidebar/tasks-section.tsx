"use client";

import type { Task } from "@/types/session";
import { ClockIcon, CheckCircleIcon, EmptyCircleIcon } from "@/components/ui/icons";

interface TasksSectionProps {
  tasks: Task[];
  /**
   * Whether the agent is actively processing. An `in_progress` task only
   * animates while true; once the turn ends (idle or terminal session) the
   * indicator freezes so a failed/stopped session doesn't keep "spinning".
   */
  active: boolean;
}

export function TasksSection({ tasks, active }: TasksSectionProps) {
  if (tasks.length === 0) return null;

  return (
    <div className="space-y-2">
      {tasks.map((task, index) => (
        <TaskItem key={`${task.content}-${index}`} task={task} active={active} />
      ))}
    </div>
  );
}

function TaskItem({ task, active }: { task: Task; active: boolean }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <TaskStatusIcon status={task.status} active={active} />
      <span
        className={`flex-1 ${
          task.status === "completed" ? "text-secondary-foreground line-through" : "text-foreground"
        }`}
      >
        {task.status === "in_progress" && task.activeForm ? task.activeForm : task.content}
      </span>
    </div>
  );
}

function TaskStatusIcon({ status, active }: { status: Task["status"]; active: boolean }) {
  switch (status) {
    case "in_progress":
      return (
        <span className="mt-0.5 flex-shrink-0">
          <ClockIcon
            className={`w-4 h-4 ${active ? "text-accent animate-pulse" : "text-secondary-foreground"}`}
          />
        </span>
      );
    case "completed":
      return (
        <span className="mt-0.5 flex-shrink-0">
          <CheckCircleIcon className="w-4 h-4 text-success" />
        </span>
      );
    case "pending":
    default:
      return (
        <span className="mt-0.5 flex-shrink-0">
          <EmptyCircleIcon className="w-4 h-4 text-secondary-foreground" />
        </span>
      );
  }
}
