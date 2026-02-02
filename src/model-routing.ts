import path from 'path';
import { DATA_DIR, TRIGGER_PATTERN } from './config.js';
import { loadJson, saveJson } from './utils.js';

export type ModelMode = 'auto' | 'code' | 'chat' | 'write' | 'custom';
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelPreference {
  mode: ModelMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ModelSelection {
  mode: ModelMode;
  model: string;
  reasoningEffort?: ReasoningEffort;
  source: 'auto' | 'preference';
}

const MODEL_PREFS_PATH = path.join(DATA_DIR, 'model_prefs.json');

const DEFAULT_MODELS: Record<'code' | 'chat' | 'write', { model: string; reasoningEffort?: ReasoningEffort }> = {
  code: { model: 'gpt-5.2-codex', reasoningEffort: 'high' },
  chat: { model: 'gpt-5.2' },
  write: { model: 'gpt-5.2', reasoningEffort: 'high' }
};

const CODE_KEYWORDS = [
  'code', 'bug', 'fix', 'implement', 'repo', 'pull request', 'pr', 'build', 'compile',
  'typescript', 'javascript', 'python', 'node', 'error', 'stack', 'trace', 'function',
  'class', 'method', 'file', 'log', 'database', 'sql', 'schema', 'migrate', 'config',
  'regex', 'git', 'commit', 'branch', 'test', 'lint', 'ci', 'deploy'
];

const WRITING_KEYWORDS = [
  'write', 'draft', 'rewrite', 'edit', 'polish', 'copy', 'blog', 'post', 'article',
  'newsletter', 'email', 'proposal', 'memo', 'press release', 'summary', 'outline',
  'story', 'script', 'pitch', 'brief'
];

export function loadModelPrefs(): Record<string, ModelPreference> {
  return loadJson<Record<string, ModelPreference>>(MODEL_PREFS_PATH, {});
}

export function saveModelPrefs(prefs: Record<string, ModelPreference>): void {
  saveJson(MODEL_PREFS_PATH, prefs);
}

export function stripTrigger(content: string): string {
  return content.replace(TRIGGER_PATTERN, '').trim();
}

export function classifyMode(content: string): 'code' | 'write' | 'chat' {
  const lowered = content.toLowerCase();
  if (WRITING_KEYWORDS.some(k => lowered.includes(k))) return 'write';
  if (CODE_KEYWORDS.some(k => lowered.includes(k))) return 'code';
  return 'chat';
}

export function resolveModelSelection(
  content: string,
  chatJid: string,
  prefs: Record<string, ModelPreference>
): ModelSelection {
  const pref = prefs[chatJid];

  if (pref && pref.mode !== 'auto') {
    if (pref.mode === 'custom' && pref.model) {
      return {
        mode: 'custom',
        model: pref.model,
        reasoningEffort: pref.reasoningEffort,
        source: 'preference'
      };
    }

    if (pref.mode === 'code' || pref.mode === 'chat' || pref.mode === 'write') {
      const defaults = DEFAULT_MODELS[pref.mode];
      return {
        mode: pref.mode,
        model: defaults.model,
        reasoningEffort: defaults.reasoningEffort,
        source: 'preference'
      };
    }
  }

  const detected = classifyMode(content);
  const defaults = DEFAULT_MODELS[detected];
  return {
    mode: detected,
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    source: 'auto'
  };
}

export function getDefaultModels(): typeof DEFAULT_MODELS {
  return DEFAULT_MODELS;
}
