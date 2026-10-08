import fs from "node:fs";
import os from "node:os";
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

// Giờ máy khởi động theo đồng hồ hiện tại. os.uptime() trên Windows (GetTickCount64) tính cả lúc
// máy ngủ nên mốc này không trôi sau khi máy ngủ dậy.
export const systemBootTime = () => Date.now() - os.uptime() * 1000;

const clock = (ms) => new Date(ms).toISOString();

export function acquireSingleInstance(tempDir, { logger, now = Date.now, bootTimeMs = systemBootTime(), isAlive = processExists } = {}) {
  fs.mkdirSync(tempDir, { recursive: true });
  const lockFile = path.join(tempDir, "agent.lock");
  const create = () => {
    const handle = fs.openSync(lockFile, "wx");
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() }));
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
    // Coi là khóa cũ nếu: tiến trình chủ không còn, HOẶC khóa quá lâu không được chạm, HOẶC (0.8.9)
    // khóa được chạm lần cuối TRƯỚC lần khởi động máy gần nhất — không tiến trình nào sống qua được
    // một lần khởi động lại. Điều kiện cuối cần cho trường hợp tắt máy rồi lên lại trong vòng 3 phút
    // (tối 07/10/2026: tắt 20:22:22, khởi động 20:22:35): khóa vẫn "tươi", và nếu Windows đã cấp PID
    // cũ cho tiến trình khác thì agent mới tưởng có bản khác đang chạy rồi tự thoát (mã 1).
    let reason = "";
    if (!isAlive(ownerPid)) reason = `tiến trình PID ${ownerPid || "?"} không còn`;
    else if (mtimeMs > 0 && mtimeMs < bootTimeMs) reason = `chạm lần cuối ${clock(mtimeMs)}, trước khi máy khởi động lúc ${clock(bootTimeMs)}`;
    else if (mtimeMs > 0 && now() - mtimeMs > STALE_MS) reason = `${Math.round((now() - mtimeMs) / 1000)}s không được chạm`;
    if (!reason) {
      throw new Error(`Agent đã chạy với PID ${ownerPid}${mtimeMs > 0 ? ` (khóa chạm lúc ${clock(mtimeMs)})` : ""}`);
    }
    logger?.warn?.(`Tiếp quản khóa agent cũ: ${reason}`);
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
