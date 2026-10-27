// 优雅退出
process.on("SIGINT", () => {
  console.log("Received SIGINT. Exiting gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM. Exiting gracefully...");
  process.exit(0);
});

process