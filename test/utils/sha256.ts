import { createHash } from "node:crypto";
import * as fs from "node:fs";

export const sha256 = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
