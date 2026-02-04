import 'dotenv/config';
import { Telegraf } from 'telegraf';
import pino from 'pino';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  IPC_POLL_INTERVAL,
  TIMEZONE
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import {
  initDatabase,
  storeMessage,
  getNewMessages,
  getRecentMessages,
  getAllTasks,
  searchMessages
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { loadJson, saveJson } from './utils.js';
import {
  loadModelPrefs,
  saveModelPrefs,
  stripTrigger,
  resolveModelSelection,
  getDefaultModels,
  ModelPreference,
  ModelMode
} from './model-routing.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const MAIN_GROUP: RegisteredGroup = {
  name: 'main',
  folder: MAIN_GROUP_FOLDER,
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString()
};

let telegramBot: Telegraf;
let lastTimestamp = '';
let sessions: Session = {};
let lastAgentTimestamp: Record<string, string> = {};
let modelPrefs: Record<string, ModelPreference> = {};

let ownerId = '';
let ownerChatJid = '';
let shuttingDown = false;

const DUPLICATE_WINDOW_MS = 5000;
const recentOutgoing: Record<string, { text: string; timestamp: number }> = {};
const JOURNAL_MAX_CHARS_PER_FIELD = 1200;
const RETRIEVAL_LIMIT = 8;
const RETRIEVAL_MAX_CHARS = 320;

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function acquireSingleInstanceLock(lockPath: string): () => void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
      fs.closeSync(fd);

      const release = () => {
        try {
          const raw = fs.readFileSync(lockPath, 'utf-8');
          const parsed = JSON.parse(raw) as { pid?: unknown };
          if (Number(parsed.pid) !== process.pid) return;
        } catch {
          // best effort
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
        }
      };

      process.once('exit', release);
      return release;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw err;

      let existingPid: number | null = null;
      try {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const parsed = JSON.parse(raw) as { pid?: unknown };
        const pid = Number(parsed.pid);
        existingPid = Number.isFinite(pid) ? pid : null;
      } catch {
        existingPid = null;
      }

      if (existingPid && isPidRunning(existingPid)) {
        throw new Error(`Another NanoClaw instance is already running (pid ${existingPid}). Stop it before starting a new one.`);
      }

      try {
        fs.unlinkSync(lockPath);
      } catch {
      }
    }
  }

  throw new Error('Failed to acquire single-instance lock.');
}

function parseEnvList(value?: string): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );
}

function loadOwnerId(): string {
  const direct = String(process.env.TELEGRAM_OWNER_ID || '').trim();
  if (direct) return direct;

  const allowed = parseEnvList(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowed.size === 1) return Array.from(allowed)[0];

  throw new Error('Set TELEGRAM_OWNER_ID or TELEGRAM_ALLOWED_USER_IDS (single id) to lock NanoClaw to your Telegram account.');
}

function getTelegramChatId(chatJid: string): string | null {
  if (!chatJid.startsWith('telegram:')) return null;
  return chatJid.slice('telegram:'.length);
}

async function setTyping(chatJid: string, isTyping: boolean): Promise<void> {
  if (!isTyping) return;
  const chatId = getTelegramChatId(chatJid);
  if (!chatId) return;
  try {
    await telegramBot.telegram.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ chatJid, err }, 'Failed to update typing status');
  }
}

function isDuplicateOutgoing(chatJid: string, text: string): boolean {
  const last = recentOutgoing[chatJid];
  if (!last) return false;
  if (Date.now() - last.timestamp > DUPLICATE_WINDOW_MS) return false;
  return last.text === text;
}

function trackOutgoing(chatJid: string, text: string): void {
  recentOutgoing[chatJid] = { text, timestamp: Date.now() };
}

function extractSearchTerms(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, ' ')
    .replace(/[^a-z0-9_\n ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stopwords = new Set([
    'this', 'that', 'these', 'those', 'with', 'from', 'when', 'what', 'where', 'which', 'their', 'there',
    'have', 'has', 'had', 'been', 'being', 'will', 'would', 'should', 'could', 'just', 'like', 'want',
    'need', 'into', 'onto', 'over', 'under', 'then', 'than', 'also', 'here', 'your', 'youre', 'yours',
    'about', 'please', 'thanks', 'thank', 'okay', 'ok', 'yeah', 'sure'
  ]);

  const terms: string[] = [];
  for (const token of cleaned.split(' ')) {
    if (token.length < 4) continue;
    if (stopwords.has(token)) continue;
    if (terms.includes(token)) continue;
    terms.push(token);
    if (terms.length >= 6) break;
  }
  return terms;
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

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n…(truncated)\n';
}

function appendJournalEntry(params: {
  groupFolder: string;
  chatJid: string;
  userText: string;
  replyText: string;
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  timestamp: string;
}): void {
  const notesDir = path.join(DATA_DIR, 'notes', params.groupFolder);
  const journalPath = path.join(notesDir, 'journal.md');

  try {
    fs.mkdirSync(notesDir, { recursive: true });
    const effort = params.reasoningEffort ? ` (reasoning ${params.reasoningEffort})` : '';
    const user = clampText(redactSensitive(params.userText.trim()), JOURNAL_MAX_CHARS_PER_FIELD);
    const reply = clampText(redactSensitive(params.replyText.trim()), JOURNAL_MAX_CHARS_PER_FIELD);

    const entry = [
      `## ${params.timestamp}`,
      `- chat: ${params.chatJid}`,
      `- model: ${params.model}${effort}`,
      `- user: ${user.replace(/\n/g, '\n  ')}`,
      `- reply: ${reply.replace(/\n/g, '\n  ')}`,
      ``
    ].join('\n');

    fs.appendFileSync(journalPath, entry, 'utf-8');
  } catch (err) {
    logger.debug({ err, groupFolder: params.groupFolder }, 'Failed to append journal entry');
  }
}

function shouldAutoReview(content: string): boolean {
  const lowered = content.toLowerCase();
  const keywords = [
    'write code',
    'edit code',
    'refactor',
    'fix ',
    'implement',
    'add feature',
    'evaluate code',
    'review code',
    'code review',
    'debug',
    'optimize',
    'performance',
    'security',
    'tests',
    'lint',
    'typecheck'
  ];
  const hasCodeFence = content.includes('```');
  const hasLikelyCode = /{[^}]*}|<\/?[a-z][\s\S]*>|=\s*[^=]|;\s*$/.test(content);
  return keywords.some(k => lowered.includes(k)) || hasCodeFence || hasLikelyCode;
}

function buildReviewPrompt(userContent: string, assistantDraft: string): string {
  return [
    'You are reviewing a draft response from the main agent.',
    'Focus on correctness, missing edge cases, unsafe changes, and test gaps.',
    'Be concise and actionable.',
    '',
    'User request:',
    userContent.trim(),
    '',
    'Assistant draft:',
    assistantDraft.trim(),
    '',
    'Return a short review with bullets. If no issues, say "no issues found".'
  ].join('\n');
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  modelPrefs = loadModelPrefs();
  logger.info('State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp, last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

async function processMessage(msg: NewMessage): Promise<void> {
  if (msg.chat_jid !== ownerChatJid) return;

  const content = msg.content.trim();
  const strippedContent = stripTrigger(content);
  const modelCommandHandled = await handleModelCommand(msg.chat_jid, strippedContent, msg.timestamp);
  if (modelCommandHandled) return;

  const recentMessages = getRecentMessages(msg.chat_jid, 40);
  const retrievalTerms = extractSearchTerms(strippedContent);
  const beforeTimestamp = recentMessages.length > 0 ? recentMessages[0].timestamp : undefined;
  const retrievedMessages = retrievalTerms.length > 0
    ? searchMessages(msg.chat_jid, retrievalTerms, beforeTimestamp, RETRIEVAL_LIMIT)
    : [];

  const escapeXml = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const lines = recentMessages.map(m => (
    `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`
  ));

  const retrievedLines = retrievedMessages.map(m => {
    const truncated = clampText(m.content, RETRIEVAL_MAX_CHARS).replace(/\n/g, ' ');
    return `<hit sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(truncated)}</hit>`;
  });

  const retrievedBlock = retrievedLines.length > 0
    ? `<retrieved terms="${retrievalTerms.join(', ')}">\n${retrievedLines.join('\n')}\n</retrieved>\n\n`
    : '';

  const prompt = `${retrievedBlock}<messages>\n${lines.join('\n')}\n</messages>`;
  if (!prompt) return;

  logger.info({ messageCount: recentMessages.length }, 'Processing message');

  await setTyping(msg.chat_jid, true);
  const modelSelection = resolveModelSelection(strippedContent, msg.chat_jid, modelPrefs);
  const response = await runAgent(prompt, msg.chat_jid, modelSelection);
  await setTyping(msg.chat_jid, false);

  if (!response) return;

  const sentAt = await sendMessage(msg.chat_jid, response);
  lastAgentTimestamp[msg.chat_jid] = sentAt || msg.timestamp;

  appendJournalEntry({
    groupFolder: MAIN_GROUP.folder,
    chatJid: msg.chat_jid,
    userText: strippedContent,
    replyText: response,
    model: modelSelection.model,
    reasoningEffort: modelSelection.reasoningEffort,
    timestamp: sentAt || msg.timestamp
  });

  const shouldReview = shouldAutoReview(strippedContent);
  if (!shouldReview) return;

  const reviewPrompt = buildReviewPrompt(strippedContent, response);
  const reviewModel = { model: 'gpt-5.2-codex', reasoningEffort: 'high' as const };
  const reviewResponse = await runAgent(
    reviewPrompt,
    msg.chat_jid,
    reviewModel,
    { sessionScope: 'review', trackSession: false }
  );

  if (!reviewResponse) return;
  const reviewText = reviewResponse.trim();
  if (!reviewText) return;
  const normalized = reviewText.toLowerCase();
  if (normalized.startsWith('no issues found')) return;
  const message = reviewText.toLowerCase().startsWith('review')
    ? reviewText
    : `review\n${reviewText}`;
  await sendMessage(msg.chat_jid, message);
}

async function runAgent(
  prompt: string,
  chatJid: string,
  modelSelection: { model: string; reasoningEffort?: 'low' | 'medium' | 'high' },
  options?: { sessionScope?: 'main' | 'review'; trackSession?: boolean }
): Promise<string | null> {
  const trackSession = options?.trackSession ?? true;
  const sessionId = trackSession ? sessions[MAIN_GROUP.folder] : undefined;

  const tasks = getAllTasks().filter(t => t.group_folder === MAIN_GROUP.folder);
  writeTasksSnapshot(MAIN_GROUP.folder, true, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  try {
    const output = await runContainerAgent(MAIN_GROUP, {
      prompt,
      sessionId,
      groupFolder: MAIN_GROUP.folder,
      chatJid,
      isMain: true,
      sessionScope: options?.sessionScope,
      model: modelSelection.model,
      reasoningEffort: modelSelection.reasoningEffort
    });

    if (trackSession && output.newSessionId) {
      sessions[MAIN_GROUP.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ error: output.error }, 'Container agent error');
      if (output.error && output.error.toLowerCase().includes('timed out')) {
        return 'timed out running codex. try again or narrow the request.';
      }
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ err }, 'Agent error');
    return null;
  }
}

async function sendMessage(chatJid: string, text: string): Promise<string | null> {
  const chatId = getTelegramChatId(chatJid);
  if (!chatId) {
    logger.warn({ chatJid }, 'Unknown chat id format; message not sent');
    return null;
  }
  try {
    const sent = await telegramBot.telegram.sendMessage(chatId, text);
    const timestamp = new Date((sent.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    trackOutgoing(chatJid, text);
    storeMessage({
      id: `out-${chatId}-${sent.message_id}`,
      chatJid,
      sender: `bot:${chatId}`,
      senderName: ASSISTANT_NAME,
      content: text,
      timestamp,
      isFromMe: true
    });
    logger.info({ chatJid, length: text.length }, 'Message sent');
    return timestamp;
  } catch (err) {
    logger.error({ chatJid, err }, 'Failed to send message');
    return null;
  }
}

function formatModelPref(pref: ModelPreference | undefined): string {
  if (!pref || pref.mode === 'auto') return 'auto (content-based)';
  if (pref.mode === 'custom') {
    const effort = pref.reasoningEffort ? `, reasoning ${pref.reasoningEffort}` : '';
    return `custom: ${pref.model}${effort}`;
  }
  return pref.mode;
}

function setModelPreference(chatJid: string, pref: ModelPreference): void {
  modelPrefs[chatJid] = pref;
  saveModelPrefs(modelPrefs);
}

function getModelHelp(): string {
  const defaults = getDefaultModels();
  return [
    'Model control:',
    '- `model auto` (default: detect code/chat/write)',
    `- \`model code\` → ${defaults.code.model} (reasoning ${defaults.code.reasoningEffort})`,
    `- \`model chat\` → ${defaults.chat.model}`,
    `- \`model write\` → ${defaults.write.model} (reasoning ${defaults.write.reasoningEffort})`,
    '- `model gpt-5.2` or `model gpt-5.2-codex high` (custom)',
    '- `model status` (show current)'
  ].join('\n');
}

async function handleModelCommand(chatJid: string, content: string, timestamp: string): Promise<boolean> {
  const lowered = content.toLowerCase();
  const isCommand =
    lowered.startsWith('model') ||
    lowered.startsWith('use model') ||
    lowered.startsWith('set model') ||
    lowered.startsWith('switch model') ||
    lowered.startsWith('model:') ||
    lowered.startsWith('use gpt-');

  if (!isCommand) return false;

  const tokens = content
    .replace(/^model\s*:?/i, '')
    .replace(/^(use|set|switch)\s+model\s*/i, '')
    .replace(/^use\s+/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0 || tokens[0].toLowerCase() === 'status' || tokens[0].toLowerCase() === 'help') {
    const current = formatModelPref(modelPrefs[chatJid]);
    await sendMessage(chatJid, `${getModelHelp()}\n\nCurrent: ${current}`);
    lastAgentTimestamp[chatJid] = timestamp;
    saveState();
    return true;
  }

  const first = tokens[0].toLowerCase();
  const modeMap: Record<string, ModelMode> = {
    auto: 'auto',
    default: 'auto',
    code: 'code',
    coding: 'code',
    chat: 'chat',
    conversation: 'chat',
    write: 'write',
    writing: 'write'
  };

  if (modeMap[first]) {
    const mode = modeMap[first];
    setModelPreference(chatJid, { mode });
    await sendMessage(chatJid, `Model mode set to ${mode}.`);
    lastAgentTimestamp[chatJid] = timestamp;
    saveState();
    return true;
  }

  const model = tokens[0];
  let reasoningEffort: ModelPreference['reasoningEffort'];
  for (const token of tokens.slice(1)) {
    const normalized = token.toLowerCase().replace('reasoning=', '');
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
      reasoningEffort = normalized;
    }
  }

  setModelPreference(chatJid, { mode: 'custom', model, reasoningEffort });
  const effortText = reasoningEffort ? ` with reasoning ${reasoningEffort}` : '';
  await sendMessage(chatJid, `Model set to ${model}${effortText}.`);
  lastAgentTimestamp[chatJid] = timestamp;
  saveState();
  return true;
}

function startIpcWatcher(): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', MAIN_GROUP.folder);
  const messagesDir = path.join(groupIpcDir, 'messages');
  const tasksDir = path.join(groupIpcDir, 'tasks');
  fs.mkdirSync(messagesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  const processIpcFiles = async () => {
    try {
      const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      for (const file of messageFiles) {
        const filePath = path.join(messagesDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (data.type === 'message' && data.chatJid && data.text) {
            const target = String(data.chatJid);
            if (target !== ownerChatJid) {
              logger.warn({ target }, 'IPC message to non-owner chat blocked');
            } else {
              const text = String(data.text).trim();
              if (text) {
                if (isDuplicateOutgoing(ownerChatJid, text)) {
                  logger.info('Duplicate IPC message suppressed');
                } else {
                  await sendMessage(ownerChatJid, text);
                  logger.info('IPC message sent');
                }
              }
            }
          }
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, err }, 'Error processing IPC message');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC messages directory');
    }

    try {
      const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
      for (const file of taskFiles) {
        const filePath = path.join(tasksDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          await processTaskIpc(data);
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, err }, 'Error processing IPC task');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC tasks directory');
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}

async function processTaskIpc(data: {
  type: string;
  taskId?: string;
  prompt?: string;
  schedule_type?: string;
  schedule_value?: string;
  context_mode?: string;
  chatJid?: string;
}): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const { createTask, updateTask, deleteTask, getTaskById: getTask } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task': {
      if (!data.prompt || !data.schedule_type || !data.schedule_value) return;
      const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

      let nextRun: string | null = null;
      if (scheduleType === 'cron') {
        try {
          const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
          nextRun = interval.next().toISOString();
        } catch {
          logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
          return;
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(data.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
          return;
        }
        nextRun = new Date(Date.now() + ms).toISOString();
      } else if (scheduleType === 'once') {
        const scheduled = new Date(data.schedule_value);
        if (isNaN(scheduled.getTime())) {
          logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
          return;
        }
        nextRun = scheduled.toISOString();
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
        ? data.context_mode
        : 'isolated';
      createTask({
        id: taskId,
        group_folder: MAIN_GROUP.folder,
        chat_jid: ownerChatJid,
        prompt: data.prompt,
        schedule_type: scheduleType,
        schedule_value: data.schedule_value,
        context_mode: contextMode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString()
      });
      logger.info({ taskId, contextMode }, 'Task created via IPC');
      return;
    }
    case 'pause_task': {
      if (!data.taskId) return;
      const task = getTask(data.taskId);
      if (!task || task.group_folder !== MAIN_GROUP.folder) return;
      updateTask(data.taskId, { status: 'paused' });
      logger.info({ taskId: data.taskId }, 'Task paused via IPC');
      return;
    }
    case 'resume_task': {
      if (!data.taskId) return;
      const task = getTask(data.taskId);
      if (!task || task.group_folder !== MAIN_GROUP.folder) return;
      updateTask(data.taskId, { status: 'active' });
      logger.info({ taskId: data.taskId }, 'Task resumed via IPC');
      return;
    }
    case 'cancel_task': {
      if (!data.taskId) return;
      const task = getTask(data.taskId);
      if (!task || task.group_folder !== MAIN_GROUP.folder) return;
      deleteTask(data.taskId);
      logger.info({ taskId: data.taskId }, 'Task cancelled via IPC');
      return;
    }
    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function startTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error('Missing TELEGRAM_BOT_TOKEN. Add it to .env and restart.');
    process.exit(1);
  }

  telegramBot = new Telegraf(token);

  telegramBot.on('message', async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;

    if (ctx.chat?.type !== 'private') return;

    const senderId = ctx.from?.id ? String(ctx.from.id) : '';
    if (!senderId || senderId !== ownerId) {
      logger.warn({ senderId }, 'Telegram message from unauthorized sender ignored');
      return;
    }

    const chatId = String(ctx.chat.id);
    const chatJid = `telegram:${chatId}`;
    if (chatJid !== ownerChatJid) {
      logger.warn({ chatJid }, 'Telegram message from unexpected chat ignored');
      return;
    }

    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const timestamp = new Date(ctx.message.date * 1000).toISOString();

    storeMessage({
      id: `${chatId}:${ctx.message.message_id}`,
      chatJid,
      sender: senderId,
      senderName,
      content: ctx.message.text,
      timestamp,
      isFromMe: false
    });
  });

  telegramBot.launch()
    .then(() => logger.info('Telegram bot started'))
    .catch((error) => {
      logger.error({ error }, 'Failed to start Telegram bot');
      process.exit(1);
    });
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running for owner ${ownerChatJid}`);

  while (!shuttingDown) {
    try {
      const { messages } = getNewMessages([ownerChatJid], lastTimestamp);

      if (messages.length > 0) logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error({ err, msg: msg.id }, 'Error processing message, will retry');
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      throw new Error('Apple Container system is required but failed to start');
    }
  }
}

function ensureCodexAuthSeeded(): void {
  const envPath = path.join(DATA_DIR, 'env', 'env');
  const codeKey = process.env.CODEX_API_KEY;
  if (codeKey) {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `CODEX_API_KEY=${codeKey}\n`);
    return;
  }
  const hostAuth = path.join(process.env.HOME || '', '.codex', 'auth.json');
  if (!fs.existsSync(hostAuth)) {
    logger.error('No CODEX_API_KEY in .env and no ~/.codex/auth.json found. Codex cannot authenticate.');
  }
}

async function main(): Promise<void> {
  ownerId = loadOwnerId();
  ownerChatJid = `telegram:${ownerId}`;

  const releaseLock = acquireSingleInstanceLock(path.join(DATA_DIR, 'nanoclaw.lock'));
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down NanoClaw');
    try {
      telegramBot?.stop(signal);
    } catch {
    }
    try {
      releaseLock();
    } catch {
    }
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  ensureCodexAuthSeeded();

  await startTelegramBot();
  startSchedulerLoop({
    sendMessage,
    getSessions: () => sessions,
    group: MAIN_GROUP
  });
  startIpcWatcher();
  startMessageLoop();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
