/**
 * v1.25.1 Phase C-PR3: Command registry — wires `addCommand`, ribbon
 * icons, status bar, and wiki-engine callbacks.
 *
 * Extracted from main.ts `onload()` to keep the plugin lifecycle
 * hook focused on manager construction and startup orchestration.
 *
 * This is a plain function, NOT a mixin — it takes the plugin
 * instance and applies side effects.
 *
 * Dedicated module to avoid circular deps with main.ts.
 */

import { Notice } from 'obsidian';
import type { Plugin, TAbstractFile } from 'obsidian';
import type { AutoMaintainManager } from '../schema/auto-maintain';
import type { BatchProgress } from '../core/status-bar';
import type { IngestQueue } from '../core/ingest-queue';
import { getText } from '../core/i18n';
import { buildIngestStatusBarText, composeStatusBarUpdate } from '../core/status-bar';
import { TEXTS } from '../texts';
import { HistoryModal } from '../ui/history-modal';
import { LLMWikiSettingTab } from '../ui/settings';

/** Minimal host interface — only what registerWikiCommands touches. */
export interface CommandRegistryHost extends Plugin {
  settings: {
    language: string;
    wikiFolder?: string;
    hierarchicalNotes?: boolean;
  };
  wikiEngine: import('../wiki/wiki-engine').WikiEngine;
  autoMaintainManager: AutoMaintainManager;
  ingestQueue: IngestQueue;
  batchProgress: BatchProgress | null;
  ingestStatusBar: HTMLElement | null;
  selectSourceToIngest(): void;
  selectFolderToIngest(): void;
  selectMultipleFilesToIngest(): void;
  ingestActiveFile(): void;
  queryWiki(): void;
  lintWiki(trigger?: 'auto' | 'manual'): void;
  clearPdfCache(): Promise<void>;
  migrateApiKeyToSettings(): Promise<void>;
}

export function registerWikiCommands(plugin: CommandRegistryHost): void {
  const t = (TEXTS as unknown as Record<string, Record<string, string>>)[plugin.settings.language];

  let directoryTimer: number | undefined;
  let directoryRunning = false;
  let directoryDisposed = false;
  const rebuildLater = (): void => {
    window.clearTimeout(directoryTimer);
    directoryTimer = window.setTimeout(() => {
      if (directoryDisposed) return;
      if (plugin.wikiEngine.isIngesting() || directoryRunning) { rebuildLater(); return; }
      directoryRunning = true;
      void plugin.wikiEngine.generateIndexFromEngine().catch(error => {
        new Notice(error instanceof Error ? error.message : String(error));
      }).finally(() => { directoryRunning = false; });
    }, 1200);
  };
  const scheduleDirectory = (file: TAbstractFile, oldPath?: string): void => {
    const prefix = `${plugin.settings.wikiFolder || 'wiki'}/`;
    if (!plugin.settings.hierarchicalNotes || (!file.path.startsWith(prefix) && !oldPath?.startsWith(prefix)) || file.path.includes('/.jeans-wiki/')) return;
    rebuildLater();
  };
  plugin.registerEvent(plugin.app.vault.on('create', file => {if (file.name !== 'index.md') scheduleDirectory(file);}));
  plugin.registerEvent(plugin.app.vault.on('delete', scheduleDirectory));
  plugin.registerEvent(plugin.app.vault.on('rename', scheduleDirectory));
  plugin.register(() => {directoryDisposed = true; window.clearTimeout(directoryTimer);});

  plugin.addCommand({
    id: 'ingest-source',
    name: t.cmdIngestSource,
    callback: () => plugin.selectSourceToIngest()
  });

  plugin.addCommand({
    id: 'open-hierarchical-index',
    name: plugin.settings.language === 'zh' ? '打开层级知识目录' : 'Open hierarchical directory',
    callback: () => {
      void (async () => {
        try {
          if (plugin.wikiEngine.isIngesting()) throw new Error('请等待当前整理任务完成');
          await plugin.wikiEngine.generateIndexFromEngine();
          await plugin.app.workspace.openLinkText(`${plugin.settings.wikiFolder || 'wiki'}/index.md`, '', false);
        } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
      })();
    }
  });

  plugin.addCommand({
    id: 'ingest-folder',
    name: t.cmdIngestFolder,
    callback: () => plugin.selectFolderToIngest()
  });

  plugin.addCommand({
    id: 'ingest-multiple-files',
    name: t.cmdIngestMultipleFiles,
    callback: () => plugin.selectMultipleFilesToIngest()
  });

  plugin.addCommand({
    id: 'query-wiki',
    name: t.cmdQueryWiki,
    callback: () => plugin.queryWiki()
  });

  plugin.addCommand({
    id: 'lint-wiki',
    name: t.cmdLintWiki,
    callback: () => plugin.lintWiki()
  });

  plugin.addCommand({
    id: 'regenerate-index',
    name: t.cmdRegenerateIndex,
    callback: () => {
      void (async () => {
        new Notice(getText(plugin.settings.language, 'regenerateIndexCompleted') + '...');
        try {
          await plugin.wikiEngine.generateIndexFromEngine();
          new Notice(getText(plugin.settings.language, 'regenerateIndexCompleted'));
        } catch (err) {
          console.error('Regenerate index failed:', err);
          new Notice(getText(plugin.settings.language, 'operationFailed') + (err instanceof Error ? err.message : String(err)));
        }
      })();
    }
  });

  plugin.addCommand({
    id: 'cancel-ingestion',
    name: t.cmdCancelIngestion,
    callback: () => {
      if (plugin.wikiEngine.isIngesting()) {
        plugin.wikiEngine.cancelIngestion();
      } else if (plugin.wikiEngine.isLintRunning()) {
        plugin.wikiEngine.cancelLint();
      }
    }
  });

  plugin.addCommand({
    id: 'ingest-active-file',
    name: t.cmdIngestActiveFile,
    callback: () => plugin.ingestActiveFile()
  });

  plugin.addCommand({
    id: 'view-ingestion-history',
    name: t.cmdViewHistory,
    callback: () => {
      new HistoryModal(plugin.app, {
        language: plugin.settings.language,
        wikiFolder: plugin.settings.wikiFolder || 'wiki',
      }).open();
    }
  });

  plugin.addCommand({
    id: 'recreate-welcome-note',
    name: t.welcomeNoteRecreateCommand,
    callback: () => void plugin.autoMaintainManager.recreateWelcomeNote(),
  });

  plugin.addCommand({
    id: 'clear-pdf-cache',
    name: getText(plugin.settings.language, 'clearPdfCacheCommand'),
    icon: 'trash-2',
    callback: () => void plugin.clearPdfCache(),
  });

  plugin.addCommand({
    id: 'migrate-api-key-to-settings',
    name: getText(plugin.settings.language, 'apiKeyMigrateToSecretStorageButton'),
    callback: () => { void plugin.migrateApiKeyToSettings(); },
  });

  plugin.addRibbonIcon('sticker', t.cmdIngestActiveFile, () => {
    plugin.ingestActiveFile();
  });

  plugin.addRibbonIcon('message-circle', t.cmdQueryWiki, () => {
    plugin.queryWiki();
  });

  plugin.ingestStatusBar = plugin.addStatusBarItem();
  plugin.ingestStatusBar.addClass('llm-wiki-status-bar');
  plugin.ingestStatusBar.addClass('llm-wiki-status-bar-hidden');
  plugin.ingestStatusBar.setText('LLM wiki');
  plugin.ingestStatusBar.onclick = () => {
    if (plugin.wikiEngine.isIngesting()) {
      plugin.wikiEngine.cancelIngestion();
    } else if (plugin.wikiEngine.isLintRunning()) {
      plugin.wikiEngine.cancelLint();
    }
  };

  plugin.wikiEngine.setIngestionCallbacks(
    (filename?: string) => {
      const label = getText(plugin.settings.language, 'ingestionStatusBar');
      if (plugin.ingestStatusBar) {
        plugin.ingestStatusBar.setText(
          buildIngestStatusBarText(label, filename, plugin.batchProgress)
        );
        plugin.ingestStatusBar.removeClass('llm-wiki-status-bar-hidden');
      }
    },
    () => {
      if (plugin.ingestStatusBar) {
        plugin.ingestStatusBar.addClass('llm-wiki-status-bar-hidden');
      }
    }
  );

  plugin.wikiEngine.setLintCallbacks(
    (filename?: string) => {
      const label = getText(plugin.settings.language, 'lintStatusBar');
      if (plugin.ingestStatusBar) {
        const text = filename
          ? `${filename} · ${label}`
          : label;
        plugin.ingestStatusBar.setText(text);
        plugin.ingestStatusBar.removeClass('llm-wiki-status-bar-hidden');
      }
    },
    () => {
      if (plugin.ingestStatusBar) {
        plugin.ingestStatusBar.addClass('llm-wiki-status-bar-hidden');
      }
    }
  );

  plugin.wikiEngine.setStatusBarUpdateCallback(
    (text: string) => {
      if (plugin.ingestStatusBar) {
        // B2 fix (v1.26.3 PATCH follow-up): route the granular progress
        // text through composeStatusBarUpdate so the always-visible
        // "click to cancel" base label is preserved. Previously this
        // callback called setText(text) directly, dropping the cancel
        // affordance for the entire duration of long ingest/lint batches.
        // Returns null when neither is running (e.g., post-cancel) — in
        // that case we hide the bar instead of writing stale text.
        const composed = composeStatusBarUpdate({
          isIngesting: plugin.wikiEngine.isIngesting(),
          isLintRunning: plugin.wikiEngine.isLintRunning(),
          ingestLabel: getText(plugin.settings.language, 'ingestionStatusBar'),
          lintLabel: getText(plugin.settings.language, 'lintStatusBar'),
          updateText: text,
        });
        if (composed === null) {
          plugin.ingestStatusBar.addClass('llm-wiki-status-bar-hidden');
        } else {
          plugin.ingestStatusBar.setText(composed);
          plugin.ingestStatusBar.removeClass('llm-wiki-status-bar-hidden');
        }
      }
    }
  );

  plugin.addSettingTab(new LLMWikiSettingTab(plugin.app, plugin as never));
}
