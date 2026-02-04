/**
 * NanoClaw Agent Runner (Codex)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import { spawn } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

type ScheduleType = 'cron' | 'interval' | 'once';
type ContextMode = 'group' | 'isolated';

type Action =
  | { type: 'send_message'; text: string }
  | { type: 'schedule_task'; prompt: string; schedule_type: ScheduleType; schedule_value: string; context_mode?: ContextMode }
  | { type: 'pause_task'; task_id: string }
  | { type: 'resume_task'; task_id: string }
  | { type: 'cancel_task'; task_id: string };

interface AgentResponse {
  reply: string;
  actions: Action[];
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const GROUP_WORKDIR = '/workspace/group';
const PROJECT_ROOT = '/workspace/project';
const NOTES_DIR = '/workspace/notes';
const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const IMAGE_SCHEMA_PATH = '/app/response-schema.json';
const HOST_SCHEMA_PATH = path.join(PROJECT_ROOT, 'container', 'agent-runner', 'response-schema.json');
const RESPONSE_SCHEMA_PATH = fs.existsSync(HOST_SCHEMA_PATH) ? HOST_SCHEMA_PATH : IMAGE_SCHEMA_PATH;

const MAX_MEMORY_CHARS = 12000;
const MAX_JOURNAL_TAIL_CHARS = 6000;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n…(truncated)\n';
}

function redactSensitive(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g, '[REDACTED OPENSSH PRIVATE KEY]'],
    [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
    [/\bsk-[A-Za-z0-9]{20,}\b/g, 'sk-[REDACTED]'],
    [/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_[REDACTED]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[REDACTED]'],
    [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED TELEGRAM TOKEN]']
  ];

  let out = text;
  for (const [re, sub] of replacements) out = out.replace(re, sub);
  return out;
}

function readOptionalFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    log(`Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function readOptionalFileTail(filePath: string, maxChars: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    const fileSize = stat.size;
    if (fileSize <= 0) return '';

    const bytesToRead = Math.min(fileSize, Math.max(1, maxChars));
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, fileSize - bytesToRead);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    log(`Failed to read tail ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function buildPrompt(input: ContainerInput): string {
  const groupMemoryPath = path.join(GROUP_WORKDIR, 'MEMORY.md');
  const soulDocPath = path.join(PROJECT_ROOT, 'docs', 'SOUL.md');
  const journalPath = path.join(NOTES_DIR, 'journal.md');

  const memorySections: string[] = [];
  const groupMemory = readOptionalFile(groupMemoryPath);
  if (groupMemory) {
    memorySections.push(`## Memory (${groupMemoryPath})\n${truncate(groupMemory, MAX_MEMORY_CHARS)}`);
  }
  const soulDoc = readOptionalFile(soulDocPath);
  if (soulDoc) {
    memorySections.push(`## Soul Doc (${soulDocPath})\n${truncate(soulDoc, MAX_MEMORY_CHARS)}`);
  }
  const journalTail = readOptionalFileTail(journalPath, MAX_JOURNAL_TAIL_CHARS);
  if (journalTail) {
    const redactedJournalTail = redactSensitive(journalTail);
    if (redactedJournalTail.trim()) {
      memorySections.push(`## Notes Journal Tail (${journalPath})\n${truncate(redactedJournalTail, MAX_JOURNAL_TAIL_CHARS)}`);
    }
  }

  const memoryBlock = memorySections.length > 0
    ? `\nMEMORY (authoritative, can be edited):\n${memorySections.join('\n\n')}\n`
    : '';

  const scheduledNote = input.isScheduledTask
    ? 'You are running as a scheduled task (not in direct response to a user). Use actions to message the user if needed.'
    : 'You are responding to a user message.';

  return [
    'You are NanoClaw, a Telegram assistant running inside a Linux container.',
    scheduledNote,
    '',
    'Output MUST be a single JSON object that matches the provided schema.',
    'For normal replies, use the "reply" field and do NOT call send_message.',
    'Use send_message only for additional follow-ups or scheduled tasks.',
    'Every action object MUST include all action fields; use null for fields that do not apply.',
    '- reply: the message to send back to the triggering chat (no assistant name prefix).',
    '- actions: array of side-effects to request from the host (can be empty).',
    'Do not include any extra text outside JSON.',
    '',
    'Context:',
    `- workspaceFolder: ${input.groupFolder}`,
    `- chatJid: ${input.chatJid}`,
    `- isMain: ${input.isMain}`,
    `- workspace: ${GROUP_WORKDIR} (read/write)`,
    `- notesDir: ${NOTES_DIR} (persistent, local-only)`,
    `- projectRoot: ${PROJECT_ROOT}`,
    `- tasks snapshot: ${path.join(IPC_DIR, 'current_tasks.json')}`,
    '',
    'Memory rules:',
    '- When the user says "remember this", update the memory file.',
    '- Use the notes directory for local-only running logs and scratch work (e.g. append to /workspace/notes/journal.md).',
    '',
    'Actions:',
    '- send_message: send a message to the current chat.',
    '- schedule_task: create a scheduled task (cron/interval/once). Use local time for "once" (no Z suffix). Include context_mode ("group" for continuous context, or "isolated" for a clean run).',
    '- pause_task / resume_task / cancel_task: manage tasks by id.',
    '',
    'Constraints:',
    '- Do not expose secrets in replies.',
    memoryBlock,
    '',
    'CONVERSATION:',
    input.prompt
  ].join('\n');
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function queueMessage(input: ContainerInput, text: string): void {
  const data = {
    type: 'message',
    chatJid: input.chatJid,
    text,
    groupFolder: input.groupFolder,
    timestamp: new Date().toISOString()
  };
  writeIpcFile(MESSAGES_DIR, data);
}

function validateSchedule(type: ScheduleType, value: string): string | null {
  if (type === 'cron') {
    try {
      CronExpressionParser.parse(value);
      return null;
    } catch {
      return `Invalid cron expression: "${value}"`;
    }
  }
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms <= 0) {
      return `Invalid interval: "${value}" (must be positive milliseconds)`;
    }
    return null;
  }
  if (type === 'once') {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return `Invalid timestamp: "${value}" (use local ISO like 2026-02-01T15:30:00)`;
    }
    return null;
  }
  return `Unknown schedule type: "${type}"`;
}

function processActions(actions: Action[], input: ContainerInput): string[] {
  const warnings: string[] = [];

  for (const action of actions) {
    if (!action || typeof action !== 'object' || !('type' in action)) {
      warnings.push('Ignored invalid action (missing type).');
      continue;
    }

    switch (action.type) {
      case 'send_message': {
        if (!('text' in action) || typeof action.text !== 'string' || !action.text.trim()) {
          warnings.push('send_message missing text.');
          break;
        }
        queueMessage(input, action.text.trim());
        break;
      }
      case 'schedule_task': {
        const { prompt, schedule_type, schedule_value } = action;
        if (!prompt || !schedule_type || !schedule_value) {
          warnings.push('schedule_task missing required fields.');
          break;
        }
        const validationError = validateSchedule(schedule_type, schedule_value);
        if (validationError) {
          warnings.push(validationError);
          break;
        }
        const data = {
          type: 'schedule_task',
          prompt,
          schedule_type,
          schedule_value,
          context_mode: action.context_mode === 'isolated' ? 'isolated' : 'group',
          chatJid: input.chatJid,
          timestamp: new Date().toISOString()
        };

        writeIpcFile(TASKS_DIR, data);
        break;
      }
      case 'pause_task':
      case 'resume_task':
      case 'cancel_task': {
        const taskId = (action as { task_id?: string }).task_id;
        if (!taskId) {
          warnings.push(`${action.type} missing task_id.`);
          break;
        }
        const data = {
          type: action.type,
          taskId,
          groupFolder: input.groupFolder,
          isMain: input.isMain,
          timestamp: new Date().toISOString()
        };
        writeIpcFile(TASKS_DIR, data);
        break;
      }
      default:
        warnings.push(`Unknown action type: ${(action as { type?: string }).type}`);
    }
  }

  return warnings;
}

function parseAgentResponse(raw: string): AgentResponse {
  const parsed = JSON.parse(raw) as { reply?: unknown; actions?: unknown };
  const reply = typeof parsed.reply === 'string' ? parsed.reply : '';
  const actions = Array.isArray(parsed.actions) ? parsed.actions as Action[] : [];
  return { reply, actions };
}

function runCodexCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: GROUP_WORKDIR,
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    const appendLimited = (current: string, chunk: string): string => {
      const max = 20000;
      if (current.length >= max) return current;
      const next = current + chunk;
      return next.length > max ? next.slice(0, max) : next;
    };

    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, chunk.toString());
    });
    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, chunk.toString());
    });

    child.on('error', err => reject(err));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function runCodex(prompt: string, model?: string, reasoningEffort?: 'low' | 'medium' | 'high'): Promise<AgentResponse> {
  const outputPath = path.join('/tmp', `codex-output-${crypto.randomUUID()}.json`);
  const args = [
    'exec',
    '--skip-git-repo-check',
    ...(model ? ['--model', model] : []),
    ...(reasoningEffort ? ['--config', `model_reasoning_effort="${reasoningEffort}"`] : []),
    '--output-schema', RESPONSE_SCHEMA_PATH,
    '--output-last-message', outputPath,
    '--dangerously-bypass-approvals-and-sandbox',
    '--',
    prompt
  ];

  const { code, stderr } = await runCodexCommand(args);

  if (stderr) {
    log(stderr.trim());
  }

  try {
    if (code !== 0) {
      throw new Error(`codex exited with code ${code}`);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('codex output file missing');
    }

    const raw = fs.readFileSync(outputPath, 'utf-8').trim();
    if (!raw) {
      throw new Error('codex output was empty');
    }

    return parseAgentResponse(raw);
  } finally {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
    }
  }
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for workspace: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const prompt = buildPrompt(input);
  try {
    const response = await runCodex(prompt, input.model, input.reasoningEffort);
    const replyTrimmed = (response.reply || '').trim();
    const suppressSendMessage = !input.isScheduledTask && replyTrimmed.length > 0;
    const actionsFiltered = (response.actions || []).filter(action => {
      if (action.type !== 'send_message') return true;
      if (suppressSendMessage) return false;
      if (!('text' in action)) return true;
      const actionText = typeof action.text === 'string' ? action.text.trim() : '';
      return !(replyTrimmed && actionText && actionText === replyTrimmed);
    });
    const warnings = processActions(actionsFiltered, input);

    const warningText = warnings.length > 0
      ? `\n\nWarnings:\n- ${warnings.join('\n- ')}`
      : '';

    const replyText = replyTrimmed + warningText;
    const result = replyText.trim() ? replyText.trim() : null;

    writeOutput({
      status: 'success',
      result,
      newSessionId: undefined
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
