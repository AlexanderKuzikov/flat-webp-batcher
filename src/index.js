#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const sharp = require('sharp');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

async function main() {
  const configWrapper = await loadConfig(CONFIG_PATH);
  const runtime = buildRuntimeConfig(configWrapper);
  const reporter = createReporter();

  if (runtime.configMode === 'relaxed-json') {
    reporter.warn('config.json прочитан в tolerant-режиме. Для строгого JSON экранируй \\ как \\\\ или используй /.');
  }

  await ensureInputExists(runtime.inputDir);
  await fs.mkdir(runtime.outputDir, { recursive: true });

  const folders = [];
  await scanDirectory(runtime.inputDir, runtime, folders);

  const selectedFolders = folders.filter(folder => folder.images.length >= runtime.minImagesInFolder);
  const tasks = await buildTasks(selectedFolders, runtime);

  const stats = {
    scannedFolders: folders.length,
    selectedFolders: selectedFolders.length,
    totalFiles: tasks.length,
    processed: 0,
    failed: 0,
    renamedByCollision: tasks.filter(task => task.wasRenamed).length,
    inputDir: runtime.inputDir,
    outputDir: runtime.outputDir,
    concurrency: runtime.concurrency,
    configMode: runtime.configMode,
    errors: []
  };

  reporter.info(`Папок найдено: ${stats.scannedFolders}, подходят под фильтр: ${stats.selectedFolders}, файлов в очереди: ${stats.totalFiles}`);

  if (tasks.length === 0) {
    reporter.summary(stats);
    return;
  }

  sharp.cache(false);
  reporter.start(stats.totalFiles, runtime.concurrency);

  await runWithConcurrency(tasks, runtime.concurrency, async task => {
    try {
      await sharp(task.inputPath)
        .rotate()
        .resize({ width: runtime.maxWidth, withoutEnlargement: true })
        .webp({ quality: runtime.webpQuality })
        .toFile(task.outputPath);

      stats.processed += 1;
      reporter.tick({
        done: stats.processed + stats.failed,
        processed: stats.processed,
        failed: stats.failed,
        currentFile: task.inputPath
      });
    } catch (error) {
      stats.failed += 1;
      stats.errors.push({ file: task.inputPath, message: error.message });
      reporter.tick({
        done: stats.processed + stats.failed,
        processed: stats.processed,
        failed: stats.failed,
        currentFile: task.inputPath
      });
    }
  });

  reporter.finish();
  reporter.summary(stats);
}

async function loadConfig(configPath) {
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = parseConfigText(raw);
  validateConfig(parsed.data);
  return parsed;
}

function parseConfigText(rawText) {
  const raw = String(rawText).replace(/^\uFEFF/, '');

  try {
    return {
      data: JSON.parse(raw),
      configMode: 'strict-json'
    };
  } catch (_) {
    return {
      data: parseRelaxedConfig(raw),
      configMode: 'relaxed-json'
    };
  }
}

function parseRelaxedConfig(raw) {
  const source = stripComments(raw);
  const result = {
    inputDir: extractStringField(source, 'inputDir'),
    outputDir: extractStringField(source, 'outputDir'),
    maxWidth: extractIntegerField(source, 'maxWidth'),
    webpQuality: extractIntegerField(source, 'webpQuality'),
    minImagesInFolder: extractIntegerField(source, 'minImagesInFolder'),
    concurrency: extractIntegerField(source, 'concurrency'),
    supportedExtensions: extractArrayOfStringsField(source, 'supportedExtensions')
  };

  if (!result.inputDir || !result.outputDir) {
    throw new Error('Не удалось разобрать config.json даже в tolerant-режиме. Проверь ключи inputDir и outputDir.');
  }

  return result;
}

function stripComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function extractStringField(source, name) {
  const key = `"${name}"`;
  const keyIndex = source.indexOf(key);
  if (keyIndex === -1) {
    return undefined;
  }

  const colonIndex = source.indexOf(':', keyIndex + key.length);
  if (colonIndex === -1) {
    return undefined;
  }

  let i = colonIndex + 1;
  while (i < source.length && /\s/.test(source[i])) {
    i += 1;
  }

  if (source[i] !== '"') {
    return undefined;
  }

  i += 1;
  let value = '';

  while (i < source.length) {
    const ch = source[i];

    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) {
        j += 1;
      }
      if (j >= source.length || source[j] === ',' || source[j] === '}') {
        return value;
      }
    }

    value += ch;
    i += 1;
  }

  return value;
}

function extractIntegerField(source, name) {
  const pattern = new RegExp(`"${escapeRegExp(name)}"\\s*:\\s*(-?\\d+)`, 'm');
  const match = source.match(pattern);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function extractArrayOfStringsField(source, name) {
  const key = `"${name}"`;
  const keyIndex = source.indexOf(key);
  if (keyIndex === -1) {
    return undefined;
  }

  const colonIndex = source.indexOf(':', keyIndex + key.length);
  if (colonIndex === -1) {
    return undefined;
  }

  const openBracket = source.indexOf('[', colonIndex + 1);
  if (openBracket === -1) {
    return undefined;
  }

  let depth = 0;
  let closeBracket = -1;
  for (let i = openBracket; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        closeBracket = i;
        break;
      }
    }
  }

  if (closeBracket === -1) {
    return undefined;
  }

  const body = source.slice(openBracket, closeBracket + 1);

  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
  }

  const items = [];
  const valuePattern = /"([^"]*)"/g;
  let itemMatch;
  while ((itemMatch = valuePattern.exec(body)) !== null) {
    items.push(itemMatch[1]);
  }
  return items;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('config.json должен содержать объект конфигурации.');
  }

  assertNonEmptyString(config.inputDir, 'inputDir');
  assertNonEmptyString(config.outputDir, 'outputDir');
  assertPositiveInteger(config.maxWidth, 'maxWidth');
  assertIntegerInRange(config.webpQuality, 'webpQuality', 1, 100);
  assertPositiveInteger(config.minImagesInFolder, 'minImagesInFolder');

  if (!Number.isInteger(config.concurrency) || config.concurrency < 0) {
    throw new Error('concurrency должен быть целым числом >= 0.');
  }

  if (!Array.isArray(config.supportedExtensions) || config.supportedExtensions.length === 0) {
    throw new Error('supportedExtensions должен быть непустым массивом строк.');
  }

  for (const ext of config.supportedExtensions) {
    if (typeof ext !== 'string' || ext.trim() === '') {
      throw new Error('Каждый элемент supportedExtensions должен быть непустой строкой.');
    }
  }
}

function buildRuntimeConfig(configWrapper) {
  const config = configWrapper.data;
  const inputDir = resolveFlexiblePath(config.inputDir, PROJECT_ROOT);
  const outputDir = resolveFlexiblePath(config.outputDir, PROJECT_ROOT);

  if (samePath(inputDir, outputDir)) {
    throw new Error('inputDir и outputDir не должны совпадать.');
  }

  const autoConcurrency = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (os.cpus()?.length || 1);

  return {
    inputDir,
    outputDir,
    maxWidth: config.maxWidth,
    webpQuality: config.webpQuality,
    minImagesInFolder: config.minImagesInFolder,
    concurrency: Math.max(1, config.concurrency || autoConcurrency),
    supportedExtensions: new Set(config.supportedExtensions.map(ext => normalizeExtension(ext))),
    configMode: configWrapper.configMode || 'strict-json'
  };
}

function resolveFlexiblePath(targetPath, baseDir) {
  const prepared = normalizeSlashes(String(targetPath).trim());
  const normalized = path.normalize(prepared);
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(baseDir, normalized);
}

function normalizeSlashes(value) {
  if (process.platform === 'win32') {
    return value.replace(/\//g, '\\');
  }
  return value.replace(/\\/g, '/');
}

function normalizeExtension(ext) {
  const trimmed = ext.trim().toLowerCase();
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);

  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }

  return left === right;
}

function isChildOrSamePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function ensureInputExists(inputDir) {
  const stat = await fs.stat(inputDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Входная папка не существует или не является директорией: ${inputDir}`);
  }
}

async function scanDirectory(currentDir, runtime, folders) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const images = [];
  const subdirs = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (samePath(fullPath, runtime.outputDir) || isChildOrSamePath(fullPath, runtime.outputDir)) {
      continue;
    }

    if (entry.isDirectory()) {
      subdirs.push(fullPath);
      continue;
    }

    if (entry.isFile() && runtime.supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      images.push(fullPath);
    }
  }

  folders.push({ dir: currentDir, images });

  for (const subdir of subdirs) {
    await scanDirectory(subdir, runtime, folders);
  }
}

async function buildTasks(selectedFolders, runtime) {
  const reservedNames = await loadExistingOutputNames(runtime.outputDir);
  const tasks = [];

  for (const folder of selectedFolders) {
    for (const imagePath of folder.images) {
      const originalName = path.parse(imagePath).name;
      const assigned = assignUniqueWebpName(originalName, reservedNames);
      tasks.push({
        inputPath: imagePath,
        outputPath: path.join(runtime.outputDir, assigned.fileName),
        wasRenamed: assigned.wasRenamed
      });
    }
  }

  return tasks;
}

async function loadExistingOutputNames(outputDir) {
  const reserved = new Set();
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (entry.isFile()) {
      reserved.add(normalizeNameKey(entry.name));
    }
  }

  return reserved;
}

function assignUniqueWebpName(baseName, reservedNames) {
  const safeBase = sanitizeBaseName(baseName);
  let counter = 1;
  let candidate = `${safeBase}.webp`;

  while (reservedNames.has(normalizeNameKey(candidate))) {
    counter += 1;
    candidate = `${safeBase}__${counter}.webp`;
  }

  reservedNames.add(normalizeNameKey(candidate));

  return {
    fileName: candidate,
    wasRenamed: counter > 1
  };
}

function sanitizeBaseName(value) {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return cleaned || 'image';
}

function normalizeNameKey(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

async function runWithConcurrency(items, limit, worker) {
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let index = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = index;
        index += 1;

        if (currentIndex >= items.length) {
          return;
        }

        await worker(items[currentIndex], currentIndex);
      }
    })
  );
}

function createReporter() {
  const stdout = process.stdout;
  const stderr = process.stderr;
  const isTTY = Boolean(stdout.isTTY);
  let active = false;
  let renderedLines = 0;
  let total = 0;
  let concurrency = 0;
  let lastRenderAt = 0;
  let latestState = null;

  return {
    info(message) {
      flushActive();
      stdout.write(`${message}\n`);
    },

    warn(message) {
      flushActive();
      stderr.write(`[WARN] ${message}\n`);
    },

    start(totalFiles, concurrencyValue) {
      total = totalFiles;
      concurrency = concurrencyValue;
      active = true;
      latestState = { done: 0, processed: 0, failed: 0, currentFile: '' };
      render(true);
    },

    tick(state) {
      latestState = state;
      render(false);
    },

    finish() {
      if (!active) {
        return;
      }
      render(true);
      clearActiveBlock();
      active = false;
      latestState = null;
    },

    summary(stats) {
      const lines = [
        '',
        'Готово.',
        `Режим конфига : ${stats.configMode}`,
        `Input         : ${stats.inputDir}`,
        `Output        : ${stats.outputDir}`,
        `Concurrency   : ${stats.concurrency}`,
        `Папок найдено : ${stats.scannedFolders}`,
        `Папок прошло  : ${stats.selectedFolders}`,
        `Файлов всего  : ${stats.totalFiles}`,
        `Успешно       : ${stats.processed}`,
        `Ошибок        : ${stats.failed}`,
        `Коллизий имен : ${stats.renamedByCollision}`
      ];

      stdout.write(lines.join('\n') + '\n');

      if (stats.errors.length > 0) {
        const preview = stats.errors.slice(0, 10);
        stdout.write('\nОшибки:\n');
        for (const item of preview) {
          stdout.write(`- ${item.file} :: ${item.message}\n`);
        }
        if (stats.errors.length > preview.length) {
          stdout.write(`- ... и ещё ${stats.errors.length - preview.length}\n`);
        }
      }
    }
  };

  function render(force) {
    if (!active || !latestState) {
      return;
    }

    const now = Date.now();
    if (!force && now - lastRenderAt < 80) {
      return;
    }
    lastRenderAt = now;

    const done = latestState.done;
    const processed = latestState.processed;
    const failed = latestState.failed;
    const percent = total > 0 ? Math.floor((done / total) * 100) : 100;

    const columns = stdout.columns || 120;
    const barWidth = Math.max(12, Math.min(28, columns - 70));
    const filled = total > 0 ? Math.round((done / total) * barWidth) : barWidth;
    const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, barWidth - filled))}`;

    const line1 = `flat-webp-batcher | ${padLeft(done, String(total).length)}/${total} | ${padLeft(percent, 3)}% | ${bar} | ok:${processed} fail:${failed} | c:${concurrency}`;
    const line2 = `Текущий файл: ${fitText(latestState.currentFile || '—', columns - 2)}`;

    if (!isTTY) {
      if (force || done === total) {
        stdout.write(`${line1}\n${line2}\n`);
      }
      return;
    }

    clearActiveBlock();
    stdout.write(`${line1}\n${line2}`);
    renderedLines = 2;
  }

  function flushActive() {
    if (!active) {
      return;
    }
    clearActiveBlock();
    active = false;
  }

  function clearActiveBlock() {
    if (!isTTY || renderedLines === 0) {
      return;
    }

    readline.cursorTo(stdout, 0);
    for (let i = 0; i < renderedLines; i += 1) {
      readline.clearLine(stdout, 0);
      if (i < renderedLines - 1) {
        readline.moveCursor(stdout, 0, 1);
      }
    }
    readline.moveCursor(stdout, 0, -Math.max(0, renderedLines - 1));
    readline.cursorTo(stdout, 0);
    renderedLines = 0;
  }
}

function fitText(value, width) {
  if (width <= 8) {
    return value.slice(0, Math.max(0, width));
  }
  if (value.length <= width) {
    return value;
  }
  return `…${value.slice(-(width - 1))}`;
}

function padLeft(value, width) {
  return String(value).padStart(width, ' ');
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} должен быть непустой строкой.`);
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} должен быть целым числом > 0.`);
  }
}

function assertIntegerInRange(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} должен быть целым числом от ${min} до ${max}.`);
  }
}

main().catch(error => {
  process.stderr.write(`[FATAL] ${error.message}\n`);
  process.exitCode = 1;
});
