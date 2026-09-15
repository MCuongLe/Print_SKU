import fs from "node:fs";
import path from "node:path";

// Khóa được coi là cũ (agent chủ đã chết/treo) nếu quá lâu không được "chạm" (touch).
// Agent còn sống chạm khóa mỗi vòng quét (< 35s), nên ngưỡng 3 phút là an toàn.
const STALE_MS = 180000;

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
  const takeOver = () => {
    try { fs.unlinkSync(lockFile); } catch { /* khóa có thể đã biến mất */ }
    create();
  };
  try {
    create();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let ownerPid = 0;
    let mtimeMs = 0;
    try { ownerPid = Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid); } catch { /* lock hỏng sẽ được thay */ }
    try { mtimeMs = fs.statSync(lockFile).mtimeMs; } catch { /* không đọc được mtime */ }
    // Coi là khóa cũ nếu: tiến trình chủ không còn, HOẶC khóa quá lâu không được chạm
    // (bao trùm cả trường hợp máy tắt đột ngột rồi PID cũ bị hệ điều hành cấp lại cho tiến trình khác).
    const stale = !processExists(ownerPid) || (mtimeMs > 0 && Date.now() - mtimeMs > STALE_MS);
    if (!stale) throw new Error(`Agent đã chạy với PID ${ownerPid}`);
    takeOver();
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (Number(current.pid) === process.pid) fs.unlinkSync(lockFile);
    } catch { /* không xóa lock của tiến trình khác */ }
  };
  // Giữ khóa "tươi" để bản khác biết agent này còn sống; gọi mỗi vòng quét.
  release.touch = () => {
    if (released) return;
    try { fs.utimesSync(lockFile, new Date(), new Date()); } catch { /* lock có thể đã bị xóa */ }
  };
  return release;
}
