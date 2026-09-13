// Retired entry point: fail closed, including direct invocations.
console.error(
  '网页 AI 任务与本机自动连接已停用。请在电脑上主动使用 AI 整理资料；此命令不会联网或启动 Codex。',
);
process.exitCode = 1;
export {};
