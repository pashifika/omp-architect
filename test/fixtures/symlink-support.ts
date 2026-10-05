import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Windows may require Developer Mode or elevated link privileges. Skip only
// that known capability failure; every other failure must fail the tests.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-symlink-probe-"));
export const supportsSymlinks = await (async () => {
  try {
    await fs.writeFile(path.join(root, "target"), "");
    await fs.symlink("target", path.join(root, "link"), "file");
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
      return false;
    throw error;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})();
