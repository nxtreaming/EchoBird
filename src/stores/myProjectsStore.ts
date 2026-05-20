// MyProjects store — user-authored AI projects added via the "我的AI项目"
// page. The page treats this as a config table: each entry records a
// project's name, icon, launcher, and models.json. Reversi + AI Translator
// arrive as seeded entries on first run so the user sees something useful
// before they author anything; after that the seed is indistinguishable
// from a custom project (delete it, edit its paths, etc.).
//
// Persistence is localStorage-only for now; this keeps the experimental
// feature from widening the Rust AppSettings struct in echobird_core. When
// the feature stabilises and we need cross-device sync or richer launch
// metadata, we can migrate to ~/.echobird/projects.json via a Tauri command
// without changing the public API of this store.
import { create } from 'zustand';
import type { LocalTool } from '../api/types';
import * as api from '../api/tauri';

export interface MyProject {
  id: string;
  name: string;
  /** Path to icon. Vite-served relative paths (./icons/...) and absolute
   *  filesystem paths (with or without file://) are both accepted; an empty
   *  string falls back to a default placeholder. */
  iconPath: string;
  /** Path to launcher entry. For seeded built-ins this is the tool's bundled
   *  directory (e.g. .../tools/reversi); for user projects it's whatever
   *  executable they pick. */
  launcherPath: string;
  /** Absolute path to the project's models.json (model-field read/write mapping). */
  modelsJsonPath: string;
  createdAt: number;
  /** Set when this entry was seeded from a bundled tool (reversi / translator).
   *  Selecting the card on the page will use this id to drive AppManager's
   *  right-side model panel + launch button — the user gets the App Manager
   *  flow for free on seeded entries. */
  linkedToolId?: string;
}

export type MyProjectInput = Omit<MyProject, 'id' | 'createdAt'>;

const LS_KEY = 'echobird_my_projects';
const SEED_FLAG_KEY = 'echobird_my_projects_seeded';

// Append a filename to a directory path using whichever separator the
// directory already speaks (Windows-style backslashes if the path looks
// like Windows, forward slashes otherwise).
const joinPath = (dir: string, file: string): string => {
  if (!dir) return '';
  const trimmed = dir.replace(/[\\/]$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}${file}`;
};

// Bundled tools we drop into the project list on the user's first visit.
// Order here is the order rendered on the page.
const SEED_TOOL_IDS = ['reversi', 'translator'] as const;

const loadFromStorage = (): MyProject[] => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop entries missing required fields rather than crashing on a bad LS write.
    return parsed.filter(
      (p): p is MyProject =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as MyProject).id === 'string' &&
        typeof (p as MyProject).name === 'string' &&
        typeof (p as MyProject).launcherPath === 'string' &&
        typeof (p as MyProject).modelsJsonPath === 'string'
    );
  } catch {
    return [];
  }
};

const saveToStorage = (projects: MyProject[]) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(projects));
  } catch {
    /* private mode / quota — silently drop */
  }
};

// Slug-from-name id is human-readable in localStorage and easy to debug, but we
// append a short random suffix so two projects with the same name don't collide.
const makeId = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const rnd = Math.random().toString(36).slice(2, 8);
  return slug ? `${slug}-${rnd}` : `project-${rnd}`;
};

// Pick the best display name for a tool given the current UI locale.
const pickToolName = (tool: LocalTool, locale: string): string => {
  if (locale === 'en' || !tool.names) return tool.name;
  const direct = tool.names[locale];
  if (direct) return direct;
  const base = locale.split('-')[0];
  if (tool.names[base]) return tool.names[base];
  const fuzzy = Object.entries(tool.names).find(([k]) => k.startsWith(base));
  return fuzzy?.[1] || tool.name;
};

interface MyProjectsState {
  projects: MyProject[];
  addProject: (input: MyProjectInput) => MyProject;
  updateProject: (id: string, patch: Partial<MyProjectInput>) => void;
  deleteProject: (id: string) => void;
  init: () => void;
  /** Idempotent — only runs once per device (tracks a localStorage flag).
   *  Pass the live tool-scan results so we can confirm the built-ins are
   *  scanned before seeding (we don't actually need their paths anymore —
   *  the Rust `seed_builtin_to_user_dir` command copies files from the
   *  bundle into the user's home and returns the destination directory).
   *  Returns silently without seeding if the scan hasn't surfaced the
   *  built-ins yet; page will call again on the next render. */
  seedBuiltins: (tools: LocalTool[], locale: string) => Promise<void>;
}

export const useMyProjectsStore = create<MyProjectsState>((set, get) => ({
  projects: [],
  addProject: (input) => {
    const project: MyProject = {
      ...input,
      id: makeId(input.name),
      createdAt: Date.now(),
    };
    const next = [...get().projects, project];
    saveToStorage(next);
    set({ projects: next });
    return project;
  },
  updateProject: (id, patch) => {
    const next = get().projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
    saveToStorage(next);
    set({ projects: next });
  },
  deleteProject: (id) => {
    const next = get().projects.filter((p) => p.id !== id);
    saveToStorage(next);
    set({ projects: next });
  },
  init: () => {
    set({ projects: loadFromStorage() });
  },
  seedBuiltins: async (tools, locale) => {
    // First-run seed only. Once the flag is set, this is a no-op — even if
    // the user deleted Reversi from the list. (Deleted entries can be
    // brought back by clearing the flag manually; resurrecting them every
    // launch would override the user's explicit delete.)
    if (localStorage.getItem(SEED_FLAG_KEY) === '1') return;

    // Need at least one of each seed tool present in the scan before we run.
    // Pre-tool-scan renders should be a no-op so we can retry next render.
    const presentIds = SEED_TOOL_IDS.filter((id) => tools.some((t) => t.id === id));
    if (presentIds.length < SEED_TOOL_IDS.length) return;

    const seeded: MyProject[] = [];
    for (const id of SEED_TOOL_IDS) {
      const tool = tools.find((t) => t.id === id)!;
      let userDir: string;
      try {
        // Rust copies the bundle (paths.json, models.json, game.html, <id>.svg,
        // README.txt) to ~/.echobird/<id>/ and returns the absolute dest path.
        // Files that already exist are NOT overwritten — respects any prior
        // edits the user made before deleting / re-seeding.
        userDir = await api.seedBuiltinToUserDir(id);
      } catch (e) {
        console.error(`[MyProjects] Failed to seed ${id}:`, e);
        // Abort the whole seed — partial seeding would leave the page in a
        // half-baked state. User can try again on next launch.
        return;
      }
      seeded.push({
        id: `builtin-${id}-${Math.random().toString(36).slice(2, 8)}`,
        name: pickToolName(tool, locale),
        iconPath: joinPath(userDir, `${id}.svg`),
        launcherPath: joinPath(userDir, 'game.html'),
        modelsJsonPath: joinPath(userDir, 'models.json'),
        createdAt: Date.now(),
        linkedToolId: id,
      });
    }

    const next = [...seeded, ...get().projects];
    saveToStorage(next);
    set({ projects: next });
    try {
      localStorage.setItem(SEED_FLAG_KEY, '1');
    } catch {
      /* private mode — accept that we'll re-seed next launch */
    }
  },
}));
