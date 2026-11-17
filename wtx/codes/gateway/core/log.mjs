/**
 * gateway/core/log.mjs
 * 轻量结构化日志。分级、可注入输出，便于测试断言与后续接入文件日志（FR-5.1）。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** 默认输出：error 走 stderr，其余走 stdout；注入 sink 时完全交给 sink（测试用） */
function defaultSink(entry) {
  const line = `${entry.level.toUpperCase()} [${entry.scope}] ${entry.msg}`;
  if (entry.level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger({ level = 'info', sink = null, scope = 'gw' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const lines = [];

  function write(lvl, msg, meta) {
    if ((LEVELS[lvl] ?? 100) < threshold) return;
    const entry = { at: Date.now(), level: lvl, scope, msg, meta };
    lines.push(entry);
    (sink ?? defaultSink)(entry);
  }

  const logger = {
    level,
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    child: (childScope) => createLogger({ level, sink, scope: `${scope}/${childScope}` }),
    /** 测试用：取出缓冲区 */
    entries: () => lines.slice(),
    clear: () => {
      lines.length = 0;
    },
  };
  return logger;
}
