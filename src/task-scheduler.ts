import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, logTaskRun, getTaskById, getAllTasks } from './db.js';
import { ScheduledTask, RegisteredGroup } from './types.js';
import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, DATA_DIR, MAIN_GROUP_FOLDER, TIMEZONE } from './config.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { loadModelPrefs, resolveModelSelection } from './model-routing.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

export interface SchedulerDependencies {
  sendMessage: (jid: string, text: string) => Promise<string | null>;
  getSessions: () => Record<string, string>;
  group: RegisteredGroup;
}

async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');

  const group = deps.group;
  if (task.group_folder !== group.folder) {
    logger.warn({ taskId: task.id, taskGroup: task.group_folder, configuredGroup: group.folder }, 'Task group does not match configured group; skipping');
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId = task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  try {
    const modelSelection = resolveModelSelection(task.prompt, task.chat_jid, loadModelPrefs());
    const output = await runContainerAgent(group, {
      prompt: task.prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: task.chat_jid,
      isMain,
      isScheduledTask: true,
      model: modelSelection.model,
      reasoningEffort: modelSelection.reasoningEffort
    });

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else {
      result = output.result;
    }

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error ? `Error: ${error}` : (result ? result.slice(0, 200) : 'Completed');
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        await runTask(currentTask, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
