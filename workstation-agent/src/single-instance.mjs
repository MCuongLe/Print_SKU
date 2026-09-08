import fs from "node:fs";
import path from "node:path";

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireSingleInstance(tempDir) {
  fs.mkdirSync(tempDir, { recursive: true });
  const lockFile = path.join(tempDir, "agent.lock");
  const create = () => {
    const handle = fs.openSync(lockFile, "wx");
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(handle);
  };
  try {
    create();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let ownerPid = 0;
    try { ownerPid = Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid); } catch { /* lock hỏng sẽ được thay */ }
    if (processExists(ownerPid)) throw new Error(`Agent đã chạy với PID ${ownerPid}`);
    fs.unlinkSync(lockFile);
    create();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (Number(current.pid) === process.pid) fs.unlinkSync(lockFile);
    } catch { /* không xóa lock của tiến trình khác */ }
  };
}
