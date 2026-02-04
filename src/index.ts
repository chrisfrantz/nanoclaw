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
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
  IPC_POLL_INTERVAL,
  TIMEZONE
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import { initDatabase, storeMessage, storeChatMetadata, getNewMessages, getRecentMessages, getAllTasks, getAllChats, searchMessages } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
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

let telegramBot: Telegraf;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let modelPrefs: Record<string, ModelPreference> = {};
const DUPLICATE_WINDOW_MS = 5000;
const recentOutgoing: Record<string, { text: string; timestamp: number }> = {};
const JOURNAL_MAX_CHARS_PER_FIELD = 1200;
const RETRIEVAL_LIMIT = 8;
const RETRIEVAL_MAX_CHARS = 320;

function getTelegramChatId(chatJid: string): string | null {
  if (!chatJid.startsWith('telegram:')) return null;
  return chatJid.slice('telegram:'.length);
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
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  modelPrefs = loadModelPrefs();
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp, last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(c => c.jid !== '__group_sync__')
    .map(c => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid)
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  const strippedContent = stripTrigger(content);
  const modelCommandHandled = await handleModelCommand(msg.chat_jid, strippedContent, msg.timestamp);
  if (modelCommandHandled) return;

  // Build a rolling window of recent messages for context
  const recentMessages = getRecentMessages(msg.chat_jid, 40);
  const retrievalTerms = extractSearchTerms(strippedContent);
  const beforeTimestamp = recentMessages.length > 0 ? recentMessages[0].timestamp : undefined;
  const retrievedMessages = retrievalTerms.length > 0
    ? searchMessages(msg.chat_jid, retrievalTerms, beforeTimestamp, RETRIEVAL_LIMIT)
    : [];

  const lines = recentMessages.map(m => {
    // Escape XML special characters in content
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });

  const retrievedLines = retrievedMessages.map(m => {
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const truncated = clampText(m.content, RETRIEVAL_MAX_CHARS).replace(/\n/g, ' ');
    return `<hit sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(truncated)}</hit>`;
  });

  const retrievedBlock = retrievedLines.length > 0
    ? `<retrieved terms="${retrievalTerms.join(', ')}">\n${retrievedLines.join('\n')}\n</retrieved>\n\n`
    : '';

  const prompt = `${retrievedBlock}<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: recentMessages.length }, 'Processing message');

  await setTyping(msg.chat_jid, true);
  const modelSelection = resolveModelSelection(strippedContent, msg.chat_jid, modelPrefs);
  const response = await runAgent(group, prompt, msg.chat_jid, modelSelection);
  await setTyping(msg.chat_jid, false);

  if (response) {
    const sentAt = await sendMessage(msg.chat_jid, response);
    if (sentAt) {
      lastAgentTimestamp[msg.chat_jid] = sentAt;
    } else {
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    }

    appendJournalEntry({
      groupFolder: group.folder,
      chatJid: msg.chat_jid,
      userText: strippedContent,
      replyText: response,
      model: modelSelection.model,
      reasoningEffort: modelSelection.reasoningEffort,
      timestamp: sentAt || msg.timestamp
    });

    const shouldReview = isMainGroup && shouldAutoReview(strippedContent);
    logger.info({ shouldReview, chatJid: msg.chat_jid }, 'Review check');
    if (shouldReview) {
      const reviewPrompt = buildReviewPrompt(strippedContent, response);
      const reviewModel = { model: 'gpt-5.2-codex', reasoningEffort: 'high' as const };
      const reviewResponse = await runAgent(
        group,
        reviewPrompt,
        msg.chat_jid,
        reviewModel,
        { sessionScope: 'review', trackSession: false }
      );
      if (reviewResponse) {
        const reviewText = reviewResponse.trim();
        const message = reviewText.toLowerCase().startsWith('review')
          ? reviewText
          : `review\n${reviewText}`;
        await sendMessage(msg.chat_jid, message);
      }
    }
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  modelSelection: { model: string; reasoningEffort?: 'low' | 'medium' | 'high' },
  options?: { sessionScope?: 'main' | 'review'; trackSession?: boolean }
): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const trackSession = options?.trackSession ?? true;
  const sessionId = trackSession ? sessions[group.folder] : undefined;

  // Update tasks snapshot for container to read (filtered by group)
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      sessionScope: options?.sessionScope,
      model: modelSelection.model,
      reasoningEffort: modelSelection.reasoningEffort
    });

    if (trackSession && output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      if (output.error && output.error.toLowerCase().includes('timed out')) {
        return 'timed out running codex. try again or narrow the request.';
      }
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
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
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  const text = data.text.trim();
                  if (isDuplicateOutgoing(data.chatJid, text)) {
                    logger.info({ chatJid: data.chatJid, sourceGroup }, 'Duplicate IPC message suppressed');
                  } else {
                    await sendMessage(data.chatJid, text);
                    logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
                  }
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,  // Verified identity from IPC directory
  isMain: boolean       // Verified from directory path
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const { createTask, updateTask, deleteTask, getTaskById: getTask } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup
        )?.[0];

        if (!targetJid) {
          logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode
          : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        const { writeGroupsSnapshot: writeGroups } = await import('./container-runner.js');
        writeGroups(sourceGroup, true, availableGroups, new Set(Object.keys(registeredGroups)));
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
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

function isAllowedTelegramSender(ctx: any): boolean {
  const allowedIds = parseEnvList(process.env.TELEGRAM_ALLOWED_USER_IDS);
  const allowedNames = parseEnvList(process.env.TELEGRAM_ALLOWED_USERNAMES);

  if (allowedIds.size === 0 && allowedNames.size === 0) return true;

  const senderId = ctx.from?.id ? String(ctx.from.id) : '';
  const senderUsername = ctx.from?.username ? String(ctx.from.username) : '';

  if (senderId && allowedIds.has(senderId)) return true;
  if (senderUsername && allowedNames.has(senderUsername)) return true;
  return false;
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

    if (!isAllowedTelegramSender(ctx)) {
      logger.warn({ chatId: ctx.chat?.id }, 'Telegram message from unauthorized sender ignored');
      return;
    }

    const chatId = String(ctx.chat.id);
    const chatJid = `telegram:${chatId}`;
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const senderId = String(ctx.from?.id || chatId);
    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const chatName = ctx.chat.type === 'private'
      ? senderName
      : (ctx.chat.title || senderName);

    const timestamp = new Date(ctx.message.date * 1000).toISOString();

    storeChatMetadata(chatJid, timestamp, chatName);

    if (!registeredGroups[chatJid]) {
      const autoRegisterEnabled = process.env.TELEGRAM_AUTO_REGISTER !== 'false';
      const isFirstRegistration = Object.keys(registeredGroups).length === 0;

      if (autoRegisterEnabled && !isGroup && isFirstRegistration) {
        registerGroup(chatJid, {
          name: 'main',
          folder: MAIN_GROUP_FOLDER,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString()
        });
        logger.info({ chatJid }, 'Auto-registered first Telegram DM as main');
      } else {
        logger.info({ chatJid }, 'Message from unregistered Telegram chat ignored');
        return;
      }
    }

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

  process.once('SIGINT', () => {
    logger.info('Shutting down Telegram bot');
    telegramBot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    logger.info('Shutting down Telegram bot');
    telegramBot.stop('SIGTERM');
  });
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp);

      if (messages.length > 0) logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error({ err, msg: msg.id }, 'Error processing message, will retry');
          // Stop processing this batch - failed message will be retried next loop
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
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Apple Container system failed to start                 ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without Apple Container. To fix:           ║');
      console.error('║  1. Install from: https://github.com/apple/container/releases ║');
      console.error('║  2. Run: container system start                               ║');
      console.error('║  3. Restart NanoClaw                                          ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
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
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  ensureCodexAuthSeeded();
  await startTelegramBot();
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions
  });
  startIpcWatcher();
  startMessageLoop();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
